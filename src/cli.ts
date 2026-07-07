#!/usr/bin/env node
/**
 * tinbase CLI — a Docker-free Supabase-compatible backend.
 *
 *   tinbase start     start the server (applies pending migrations first)
 *   tinbase migrate   apply pending migrations and exit
 *   tinbase status    show applied migrations
 *   tinbase keys      print anon/service_role keys for the JWT secret
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createBackend, generateTypes, createPgmemEngine } from './index.js'
import { computeDbDiff, shadowNativeDataDir } from './node/db-diff.js'
import { createNativeEngine } from './node/native/engine.js'
import { FsStorageDriver } from './node/fs-driver.js'
import { loadFunctions } from './node/load-functions.js'
import { loadOAuthProviders } from './node/load-oauth.js'
import { loadSupabaseProject } from './node/project.js'
import { serve } from './node/server.js'
import { serveBun } from './node/bun-server.js'

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
// single-file builds ship without the WASM engine; native is the default there
const IS_BINARY = process.env.TINBASE_SINGLE_BINARY === '1'
import { signJwt } from './jwt.js'
import { DEFAULT_JWT_SECRET } from './types.js'

interface CliOptions {
  command: string
  /** positional args after the command, e.g. `db reset` → ['reset'] */
  positionals: string[]
  port: number
  host: string
  dir: string
  dataDir: string | undefined
  storageDir: string
  jwtSecret: string
  memory: boolean
  engine: 'wasm' | 'native' | 'pgmem'
  diffFile?: string
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv]
  const command = args[0] && !args[0].startsWith('-') ? args.shift()! : 'start'
  const opts: CliOptions = {
    command,
    positionals: [],
    // deploy platforms inject PORT; TINBASE_PORT wins if both are set
    port: parseInt(process.env.TINBASE_PORT ?? process.env.PORT ?? '54321', 10),
    host: '127.0.0.1',
    dir: process.cwd(),
    dataDir: undefined,
    storageDir: '',
    jwtSecret: process.env.TINBASE_JWT_SECRET ?? DEFAULT_JWT_SECRET,
    memory: false,
    engine: (process.env.TINBASE_ENGINE as 'wasm' | 'native' | 'pgmem') ?? (IS_BINARY ? 'native' : 'wasm'),
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = () => args[++i]
    if (a === '--port' || a === '-p') opts.port = parseInt(next(), 10)
    else if (a === '--host') opts.host = next()
    else if (a === '--dir') opts.dir = resolve(next())
    else if (a === '--data-dir') opts.dataDir = resolve(next())
    else if (a === '--storage-dir') opts.storageDir = resolve(next())
    else if (a === '--jwt-secret') opts.jwtSecret = next()
    else if (a === '--memory') opts.memory = true
    else if (a === '-f' || a === '--file') opts.diffFile = next()
    else if (a === '--engine') {
      const v = next()
      if (v !== 'wasm' && v !== 'native' && v !== 'pgmem') {
        console.error(`--engine must be wasm, native, or pgmem, got: ${v}`)
        process.exit(1)
      }
      opts.engine = v as 'wasm' | 'native' | 'pgmem'
    }
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else if (!a.startsWith('-')) {
      opts.positionals.push(a)
    } else {
      console.error(`unknown option: ${a}`)
      process.exit(1)
    }
  }
  if (!opts.dataDir && !opts.memory) opts.dataDir = join(opts.dir, '.tinbase', 'db')
  if (!opts.storageDir) opts.storageDir = join(opts.dir, '.tinbase', 'storage')
  return opts
}

/** Optional webhooks config at supabase/webhooks.json: [{ table, events?, url, headers? }]. */
function loadWebhooks(dir: string): import('./webhooks/service.js').WebhookConfig[] {
  try {
    const raw = readFileSync(join(dir, 'supabase', 'webhooks.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function printHelp(): void {
  console.log(`tinbase — Supabase-compatible backend on PGlite (no Docker)

Usage: tinbase [command] [options]

Commands:
  start      start the server (default)
  migrate    apply pending supabase/migrations/*.sql and exit
  status     list applied migrations
  keys       print anon and service_role keys
  gen types  print a TypeScript Database type for the current schema
  db reset   wipe the database + storage and re-run migrations and seed
  db diff    print DDL for schema changes not yet in migrations (-f <name> to write a migration)

Options:
  -p, --port <n>        port to listen on (default 54321; also TINBASE_PORT/PORT env)
      --host <host>     host to bind (default 127.0.0.1)
      --dir <path>      project directory containing supabase/ (default cwd)
      --data-dir <path> PGlite data directory (default <dir>/.tinbase/db)
      --storage-dir <p> storage files directory (default <dir>/.tinbase/storage)
      --jwt-secret <s>  JWT secret (or TINBASE_JWT_SECRET env var)
      --memory          in-memory database (no persistence, wasm engine only)
      --engine <e>      wasm (PGlite, default), native (embedded Postgres),
                        or pgmem (ultralight in-memory subset — no RLS/realtime,
                        local dev / preview only)
`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.command === 'db' && opts.positionals[0] === 'diff') {
    // `tinbase db diff [-f name]` — DDL for schema changes not yet in migrations
    const project = await loadSupabaseProject(opts.dir)
    const nativeLive =
      opts.engine === 'native'
        ? await createNativeEngine({ dataDir: join(opts.dir, '.tinbase', 'pgdata') })
        : undefined
    const ddl = await computeDbDiff({
      liveEngine: nativeLive,
      liveDataDir: opts.engine === 'native' ? undefined : join(opts.dir, '.tinbase', 'db'),
      migrations: project.migrations,
      makeShadowEngine:
        opts.engine === 'native' ? () => createNativeEngine({ dataDir: shadowNativeDataDir() }) : undefined,
    })
    if (ddl.length === 0) {
      console.error('No schema changes found.')
      return
    }
    const body = ddl.join('\n\n') + '\n'
    if (opts.diffFile) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const path = join(opts.dir, 'supabase', 'migrations', `${stamp}_${opts.diffFile}.sql`)
      await mkdir(join(opts.dir, 'supabase', 'migrations'), { recursive: true })
      await writeFile(path, body)
      console.error(`Wrote ${path}`)
    } else {
      process.stdout.write(body)
    }
    return
  }

  if (opts.command === 'db') {
    const sub = opts.positionals[0]
    if (sub !== 'reset') {
      console.error(`unknown db subcommand: ${sub ?? '(none)'} (supported: reset, diff)`)
      process.exit(1)
    }
    // `tinbase db reset` — wipe data + storage and re-run migrations + seed fresh
    const dataDir = opts.dataDir ?? join(opts.dir, '.tinbase', opts.engine === 'native' ? 'pgdata' : 'db')
    const storageDir = opts.storageDir || join(opts.dir, '.tinbase', 'storage')
    await rm(dataDir, { recursive: true, force: true })
    await rm(storageDir, { recursive: true, force: true })
    console.log('  wiped database and storage')

    const project = await loadSupabaseProject(opts.dir)
    const engine =
      opts.engine === 'native'
        ? await createNativeEngine({ dataDir, log: (m) => console.log(`  ${m}`) })
        : undefined
    if (opts.engine !== 'native') await mkdir(dataDir, { recursive: true })
    await mkdir(storageDir, { recursive: true })
    const backend = await createBackend({
      engine,
      dataDir: opts.engine === 'native' ? undefined : dataDir,
      jwtSecret: opts.jwtSecret,
      migrations: project.migrations,
      seedSql: project.seedSql,
      storageDriver: new FsStorageDriver(storageDir),
      log: (m) => console.log(`  ${m}`),
    })
    const applied = await backend.db.listAppliedMigrations()
    console.log(`  reset complete — ${applied.length} migration(s) applied${project.seedSql ? ' + seed' : ''}`)
    await backend.close()
    return
  }

  if (opts.command === 'gen') {
    // `tinbase gen types [typescript]` — emit a Supabase-shaped Database type to stdout
    const project = await loadSupabaseProject(opts.dir)
    const backend = await createBackend({
      migrations: project.migrations,
      seedSql: project.seedSql,
      jwtSecret: opts.jwtSecret,
    })
    process.stdout.write(await generateTypes(backend.db, 'public'))
    await backend.close()
    return
  }

  if (opts.command === 'keys') {
    const now = Math.floor(Date.now() / 1000)
    const exp = now + 10 * 365 * 24 * 3600
    console.log('anon key:')
    console.log(await signJwt({ iss: 'supabase', ref: 'tinbase', role: 'anon', iat: now, exp }, opts.jwtSecret))
    console.log('\nservice_role key:')
    console.log(
      await signJwt({ iss: 'supabase', ref: 'tinbase', role: 'service_role', iat: now, exp }, opts.jwtSecret)
    )
    return
  }

  const project = await loadSupabaseProject(opts.dir)
  const functions = await loadFunctions(opts.dir)
  const oauthProviders = loadOAuthProviders(opts.dir)
  const webhooks = loadWebhooks(opts.dir)
  if (opts.dataDir) await mkdir(opts.dataDir, { recursive: true })
  await mkdir(opts.storageDir, { recursive: true })

  const engine =
    opts.engine === 'native'
      ? await createNativeEngine({
          dataDir: join(opts.dir, '.tinbase', 'pgdata'),
          log: (msg) => console.log(`  ${msg}`),
        })
      : opts.engine === 'pgmem'
        ? await createPgmemEngine()
        : undefined
  if (opts.engine === 'pgmem') {
    console.log('  ⚠ pg-mem engine: in-memory, no RLS/realtime/functions — local dev / preview only')
  }

  const backend = await createBackend({
    engine,
    dataDir: opts.memory ? undefined : opts.dataDir,
    jwtSecret: opts.jwtSecret,
    siteUrl: `http://${opts.host}:${opts.port}`,
    migrations: project.migrations,
    seedSql: project.seedSql,
    functions,
    oauthProviders,
    webhooks,
    storageDriver: new FsStorageDriver(opts.storageDir),
    log: (msg) => console.log(`  ${msg}`),
  })

  if (opts.command === 'migrate') {
    const applied = await backend.db.listAppliedMigrations()
    console.log(`${applied.length} migration(s) applied.`)
    await backend.close()
    return
  }

  if (opts.command === 'status') {
    const applied = await backend.db.listAppliedMigrations()
    if (applied.length === 0) console.log('no migrations applied')
    for (const m of applied) console.log(`${m.version}  ${m.name ?? ''}`)
    await backend.close()
    return
  }

  if (opts.command !== 'start') {
    console.error(`unknown command: ${opts.command}`)
    printHelp()
    process.exit(1)
  }

  const server = IS_BUN
    ? await serveBun(backend, { port: opts.port, host: opts.host })
    : await serve(backend, { port: opts.port, host: opts.host })
  console.log(`
  tinbase running

           API URL: ${server.url}
          Admin UI: ${server.url}/_/
            Engine: ${opts.engine === 'native' ? 'native postgres' : opts.engine === 'pgmem' ? 'pg-mem (in-memory, lite)' : `PGlite (${opts.memory ? 'in-memory' : opts.dataDir})`}
           Storage: ${opts.storageDir}
        Migrations: ${project.migrations.length} file(s)
         Functions: ${functions.size > 0 ? [...functions.keys()].join(', ') : 'none'}
    OAuth providers: ${Object.keys(oauthProviders).length ? Object.keys(oauthProviders).join(', ') : 'none'}
          Webhooks: ${webhooks.length ? webhooks.map((w) => w.table).join(', ') : 'none'}

          anon key: ${backend.anonKey}
  service_role key: ${backend.serviceRoleKey}

  Use with supabase-js:
    const supabase = createClient('${server.url}', '<anon key>')
`)

  const shutdown = async () => {
    console.log('\nshutting down…')
    await server.close().catch(() => {})
    await backend.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
