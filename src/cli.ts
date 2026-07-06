#!/usr/bin/env node
/**
 * tinbase CLI — a Docker-free Supabase-compatible backend.
 *
 *   tinbase start     start the server (applies pending migrations first)
 *   tinbase migrate   apply pending migrations and exit
 *   tinbase status    show applied migrations
 *   tinbase keys      print anon/service_role keys for the JWT secret
 */
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createBackend } from './index.js'
import { createNativeEngine } from './node/native/engine.js'
import { FsStorageDriver } from './node/fs-driver.js'
import { loadFunctions } from './node/load-functions.js'
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
  port: number
  host: string
  dir: string
  dataDir: string | undefined
  storageDir: string
  jwtSecret: string
  memory: boolean
  engine: 'wasm' | 'native'
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv]
  const command = args[0] && !args[0].startsWith('-') ? args.shift()! : 'start'
  const opts: CliOptions = {
    command,
    // deploy platforms inject PORT; TINBASE_PORT wins if both are set
    port: parseInt(process.env.TINBASE_PORT ?? process.env.PORT ?? '54321', 10),
    host: '127.0.0.1',
    dir: process.cwd(),
    dataDir: undefined,
    storageDir: '',
    jwtSecret: process.env.TINBASE_JWT_SECRET ?? DEFAULT_JWT_SECRET,
    memory: false,
    engine: (process.env.TINBASE_ENGINE as 'wasm' | 'native') ?? (IS_BINARY ? 'native' : 'wasm'),
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
    else if (a === '--engine') {
      const v = next()
      if (v !== 'wasm' && v !== 'native') {
        console.error(`--engine must be wasm or native, got: ${v}`)
        process.exit(1)
      }
      opts.engine = v
    }
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`unknown option: ${a}`)
      process.exit(1)
    }
  }
  if (!opts.dataDir && !opts.memory) opts.dataDir = join(opts.dir, '.tinbase', 'db')
  if (!opts.storageDir) opts.storageDir = join(opts.dir, '.tinbase', 'storage')
  return opts
}

function printHelp(): void {
  console.log(`tinbase — Supabase-compatible backend on PGlite (no Docker)

Usage: tinbase [command] [options]

Commands:
  start      start the server (default)
  migrate    apply pending supabase/migrations/*.sql and exit
  status     list applied migrations
  keys       print anon and service_role keys

Options:
  -p, --port <n>        port to listen on (default 54321; also TINBASE_PORT/PORT env)
      --host <host>     host to bind (default 127.0.0.1)
      --dir <path>      project directory containing supabase/ (default cwd)
      --data-dir <path> PGlite data directory (default <dir>/.tinbase/db)
      --storage-dir <p> storage files directory (default <dir>/.tinbase/storage)
      --jwt-secret <s>  JWT secret (or TINBASE_JWT_SECRET env var)
      --memory          in-memory database (no persistence, wasm engine only)
      --engine <e>      wasm (PGlite, default) or native (embedded Postgres,
                        ~4x lighter memory; downloads binaries on first run)
`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

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
  if (opts.dataDir) await mkdir(opts.dataDir, { recursive: true })
  await mkdir(opts.storageDir, { recursive: true })

  const engine =
    opts.engine === 'native'
      ? await createNativeEngine({
          dataDir: join(opts.dir, '.tinbase', 'pgdata'),
          log: (msg) => console.log(`  ${msg}`),
        })
      : undefined

  const backend = await createBackend({
    engine,
    dataDir: opts.memory ? undefined : opts.dataDir,
    jwtSecret: opts.jwtSecret,
    siteUrl: `http://${opts.host}:${opts.port}`,
    migrations: project.migrations,
    seedSql: project.seedSql,
    functions,
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
            Engine: ${opts.engine === 'native' ? 'native postgres' : `PGlite (${opts.memory ? 'in-memory' : opts.dataDir})`}
           Storage: ${opts.storageDir}
        Migrations: ${project.migrations.length} file(s)
         Functions: ${functions.size > 0 ? [...functions.keys()].join(', ') : 'none'}

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
