#!/usr/bin/env node
/**
 * tinbase CLI - a Docker-free Supabase-compatible backend.
 *
 *   tinbase start     start the server (applies pending migrations first)
 *   tinbase migrate   apply pending migrations and exit
 *   tinbase status    show applied migrations
 *   tinbase keys      print anon/service_role keys for the JWT secret
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createBackend, generateTypes, createPgmemEngine, inspectDb } from './index.js'
import { computeDbDiff, pullSchema, shadowNativeDataDir } from './node/db-diff.js'
import { attachNativeEngine, createNativeEngine, readRunningPostmaster } from './node/native/engine.js'
import type { DbEngine } from './db/engine.js'
import { readServerLock, removeServerLock, writeServerLock, type ServerLock } from './node/server-lock.js'
import { FsStorageDriver } from './node/fs-driver.js'
import { ResendMailer } from './auth/resend.js'
import { SmtpMailer } from './node/smtp-mailer.js'
import type { Mailer } from './types.js'
import { loadProjectConfig } from './node/load-config.js'
import { loadFunctions, loadFunctionEnv } from './node/load-functions.js'
import { loadSupabaseProject } from './node/project.js'
import { serve, findAvailablePort } from './node/server.js'
import { serveBun } from './node/bun-server.js'

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
// single-file builds ship without the WASM engine; native is the default there
const IS_BINARY = process.env.TINBASE_SINGLE_BINARY === '1'
// Native (embedded Postgres) is the default where it's supported - macOS/Linux
// on x64/arm64. Elsewhere (e.g. Windows) fall back to the WASM (PGlite) engine.
const NATIVE_SUPPORTED =
  (process.platform === 'darwin' || process.platform === 'linux') &&
  (process.arch === 'arm64' || process.arch === 'x64')
import { deriveApiKeys } from './jwt.js'
import { isNetworkExposed } from './security.js'
import { DEFAULT_JWT_SECRET, TINBASE_VERSION } from './types.js'

/** Parsed command + flags for one CLI invocation. */
interface CliOptions {
  /** subcommand to run (defaults to `start`) */
  command: string
  /** positional args after the command, e.g. `db reset` → ['reset'] */
  positionals: string[]
  /** port to listen on for `start` */
  port: number
  /** host/interface to bind */
  host: string
  /** project directory containing supabase/ */
  dir: string
  /**
   * Data directory as explicitly requested via `--data-dir`, or undefined to
   * use the engine's default. Read through {@link resolveDataDir} rather than
   * directly - the default is engine-dependent.
   */
  dataDir: string | undefined
  /** directory for storage object bytes */
  storageDir: string
  /** secret used to sign/verify JWTs */
  jwtSecret: string
  /** run the database in memory with no persistence */
  memory: boolean
  /** database engine: native embedded Postgres, wasm (PGlite), or pgmem (in-memory subset) */
  engine: 'wasm' | 'native' | 'pgmem'
  /** connect to an external Postgres instead of the embedded engine */
  databaseUrl?: string
  /** output migration name for `db diff -f`, if given */
  diffFile?: string
}

/**
 * Parse argv (already sliced past `node cli.js`) into {@link CliOptions}. The
 * command defaults to `start`; env vars provide defaults for port, JWT secret,
 * and engine. Exits the process on an unknown flag or `--help`.
 */
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
    engine: (process.env.TINBASE_ENGINE as 'wasm' | 'native' | 'pgmem') ?? (IS_BINARY || NATIVE_SUPPORTED ? 'native' : 'wasm'),
    databaseUrl: process.env.TINBASE_DATABASE_URL || process.env.DATABASE_URL || undefined,
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
    else if (a === '--database-url') opts.databaseUrl = next()
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
  if (!opts.storageDir) opts.storageDir = join(opts.dir, '.tinbase', 'storage')
  return opts
}

/**
 * The data directory the selected engine actually uses, or undefined when there
 * is no directory to speak of (`--memory`, `--database-url`, or the in-memory
 * pgmem subset).
 *
 * The engines keep their clusters apart - native embedded Postgres in
 * `.tinbase/pgdata`, PGlite in `.tinbase/db` - so the default is
 * engine-dependent and every command has to agree on it. Resolving it here, in
 * one place, is what keeps `db reset` wiping the directory `start` later
 * reopens: when reset defaulted on its own it wiped and rebuilt `.tinbase/db`
 * while native `start` kept serving `.tinbase/pgdata`, so a reset reported
 * success without touching the live database (#76). An explicit `--data-dir`
 * wins for either engine; it used to be silently ignored by the native one.
 */
function resolveDataDir(opts: CliOptions): string | undefined {
  if (opts.memory || opts.databaseUrl || opts.engine === 'pgmem') return undefined
  if (opts.dataDir) return opts.dataDir
  return join(opts.dir, '.tinbase', opts.engine === 'native' ? 'pgdata' : 'db')
}

/**
 * The engine to read `dataDir` through, reusing a server that is already running
 * for it rather than trying to start a second postmaster on the same directory.
 *
 * Two postmasters cannot share a data directory, so migrate/status/inspect/db
 * diff/db pull all failed with `lock file "postmaster.pid" already exists` while
 * a server was up - exactly when you would reach for them. Attaching also keeps
 * the reader consistent with what the running server is serving.
 */
async function openNativeForReading(dataDir: string, log?: (m: string) => void): Promise<DbEngine> {
  const attached = await attachNativeEngine(dataDir)
  if (attached) {
    log?.('using the server already running on this data directory')
    return attached
  }
  return createNativeEngine({ dataDir, log })
}

/**
 * Refuse to run when a server holds `dataDir`, for commands that would delete it.
 *
 * `db reset` used to go ahead: the wipe removed postmaster.pid along with
 * everything else, which is the very lock that should have stopped it, so a second
 * postmaster then initialised a fresh cluster on the same path. The running
 * server was left serving `connection closed` on every request with its database
 * deleted from under it - and reset reported success.
 */
function refuseIfServerRunning(dataDir: string | undefined, command: string): void {
  if (!dataDir) return
  const running = readRunningPostmaster(dataDir)
  if (!running) return
  console.error(
    `\n  \u2716 ${command} would delete a data directory that a running server is using.\n` +
      `    A server is live on ${dataDir} (pid ${running.pid}).\n` +
      `    Stop it first, then run ${command} again.\n`
  )
  process.exit(1)
}

/**
 * Refuse to run when a server is up on an engine this process cannot share.
 *
 * Only the native engine can be joined: it runs a real postmaster reachable over a
 * socket. PGlite is an in-process embedded build, so a second process opening the
 * same directory is two writers on one set of files - that produced a ledger row
 * for a migration whose table was missing, unrepairable by re-running `migrate`
 * because the ledger already said applied. pgmem holds everything in memory, so a
 * second process shares nothing and its migration is a no-op that claims success.
 * Both are worse than stopping, so stop is what we ask for.
 */
function refuseIfUnshareableServer(opts: CliOptions, command: string): void {
  if (opts.engine === 'native' || opts.databaseUrl) return
  const running = readServerLock(opts.dir)
  if (!running) return
  // migrate/status/inspect go through the running server instead (see
  // runViaServer); only what cannot be delegated gets here.

  const why =
    opts.engine === 'pgmem'
      ? 'the pgmem engine keeps the database in memory, so this process shares nothing with it'
      : 'the wasm engine (PGlite) runs in-process, and two processes writing one data directory corrupt it'
  console.error(
    `\n  \u2716 Cannot run ${command} while a server is running on the ${opts.engine} engine.\n` +
      `    ${why}.\n` +
      `    A server is live for this project (pid ${running.pid}${running.port ? `, port ${running.port}` : ''}).\n` +
      `    Stop it and run ${command} again${opts.engine === 'pgmem' ? '; restarting applies migrations on boot' : ''}.\n`
  )
  process.exit(1)
}

/** True when `candidate` is a higher release than `current`, prerelease tags ignored. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.split('-')[0].split('.').map((n) => parseInt(n, 10))
  const a = parse(candidate)
  const b = parse(current)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * Print one line when a newer tinbase has been published.
 *
 * Deliberately a notice and not a self-updater: replacing a running binary means
 * an atomic swap, signature checks, and a way to ship an install that cannot
 * repair itself. This is the part that carries most of the value - you find out -
 * with none of that surface.
 *
 * Never allowed to affect the command it is attached to. It is not awaited before
 * the server serves, it times out quickly, and every failure path is silent:
 * offline, a proxy, a slow registry and a garbled response all just mean no
 * notice. Skipped under CI and NODE_ENV=production, where nobody is reading
 * startup chatter, and suppressible with TINBASE_NO_UPDATE_CHECK=1.
 */
async function printUpdateNotice(current: string): Promise<void> {
  if (process.env.TINBASE_NO_UPDATE_CHECK || process.env.CI || process.env.NODE_ENV === 'production') return
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    // unref so a pending check can never hold the process open on its own
    ;(timer as unknown as { unref?: () => void }).unref?.()
    // No abbreviated-metadata accept header: that content type applies to the
    // full packument and makes /latest answer with an empty body, which then
    // failed to parse and was swallowed by the catch below - the check silently
    // never worked.
    const res = await fetch('https://registry.npmjs.org/tinbase/latest', { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return
    const body = (await res.json()) as { version?: unknown }
    const latest = typeof body.version === 'string' ? body.version : null
    if (!latest || !isNewerVersion(latest, current)) return
    console.log(
      `\n  A newer tinbase is available: ${current} \u2192 ${latest}\n` +
        `    npm i -g tinbase@latest   (or npx tinbase@latest)\n` +
        `    Set TINBASE_NO_UPDATE_CHECK=1 to silence this.\n`
    )
  } catch {
    // offline, blocked, slow, or unparseable - a version notice is never worth
    // surfacing an error for
  }
}

/**
 * Call the admin API of the server already serving this project.
 *
 * This is how migrate/status/inspect work on the wasm and pgmem engines, which no
 * second process can open: PGlite runs in-process and pgmem holds the database in
 * memory, so the only route to the live database is through the process that owns
 * it. The native engine does not come here - it attaches to its postmaster
 * directly, which needs no key and works with any secret.
 *
 * Exits with an explanation rather than returning, because every caller wants to
 * stop: reaching the server is the only way for them to do the right thing.
 */
async function callRunningServer<T>(opts: CliOptions, lock: ServerLock, path: string, init?: RequestInit): Promise<T> {
  // Same derivation the server used, so no key needs to be passed around. In
  // production the server signs unique keys per start, which cannot be re-derived.
  if (process.env.NODE_ENV === 'production') {
    console.error(
      `\n  \u2716 Cannot reach the running server under NODE_ENV=production.\n` +
        `    Keys are unique per start there, so this command cannot authenticate.\n` +
        `    Stop the server and run it again.\n`
    )
    process.exit(1)
  }
  const { serviceRoleKey } = await deriveApiKeys(opts.jwtSecret, 'deterministic')
  const url = `http://${lock.host}:${lock.port}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        'content-type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
  } catch (e) {
    console.error(
      `\n  \u2716 A server is recorded for this project (pid ${lock.pid}) but ${url} did not answer.\n` +
        `    ${(e as Error)?.message ?? e}\n` +
        `    If it has since stopped, delete .tinbase/server.json and try again.\n`
    )
    process.exit(1)
  }
  if (res.status === 401 || res.status === 403) {
    console.error(
      `\n  \u2716 The running server rejected this command's key.\n` +
        `    It was most likely started with a different --jwt-secret (or TINBASE_JWT_SECRET).\n` +
        `    Pass the same secret, or stop the server and run this again.\n`
    )
    process.exit(1)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    console.error(`\n  \u2716 The running server returned ${res.status}: ${body?.error ?? 'unknown error'}\n`)
    process.exit(1)
  }
  return (await res.json()) as T
}

/**
 * Run `command` through the server already serving this project, when the engine
 * leaves no other way in.
 *
 * PGlite is in-process and pgmem is in-memory, so the process that owns the
 * database is the only one that can touch it. Rather than refusing, the commands
 * that have an admin equivalent are delegated to it: migrations still go through
 * `Database.runMigrations` on the server, so ordering, transactions, ledger
 * bookkeeping, seed hashing and the pgmem skip behaviour are the same code that
 * `start` runs - not a reimplementation behind an endpoint.
 *
 * Returns false when there is nothing to delegate to, leaving the caller to open
 * the database itself. The native engine never gets here: attaching to its
 * postmaster is better, needing no key and working with any secret.
 */
async function runViaServer(opts: CliOptions): Promise<boolean> {
  if (opts.engine === 'native' || opts.databaseUrl) return false
  const lock = readServerLock(opts.dir)
  if (!lock) return false

  const note = `  using the server already running on port ${lock.port} (${lock.engine} engine)`

  if (opts.command === 'migrate') {
    const project = await loadSupabaseProject(opts.dir)
    console.log(note)
    const body = { migrations: project.migrations, seedSql: project.seedSql }
    const { applied } = await callRunningServer<{ applied: string[] }>(opts, lock, '/admin/v1/migrate', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (applied.length > 0) console.log(`  applied migrations: ${applied.join(', ')}`)
    const { migrations } = await callRunningServer<{ migrations: unknown[] }>(opts, lock, '/admin/v1/migrations')
    console.log(`${migrations.length} migration(s) applied.`)
    return true
  }

  if (opts.command === 'status') {
    console.log(note)
    const { migrations } = await callRunningServer<{ migrations: { version: string; name: string | null }[] }>(
      opts,
      lock,
      '/admin/v1/migrations'
    )
    if (migrations.length === 0) console.log('no migrations applied')
    for (const m of migrations) console.log(`${m.version}  ${m.name ?? ''}`)
    return true
  }

  if (opts.command === 'inspect') {
    console.log(note)
    const { tables } = await callRunningServer<{ tables: { name: string; rowCount: number }[] }>(
      opts,
      lock,
      '/admin/v1/tables?schema=public'
    )
    if (tables.length === 0) {
      console.log('No tables in schema "public".')
      return true
    }
    const pad = Math.max(5, ...tables.map((t) => t.name.length))
    console.log(`${'table'.padEnd(pad)}  ${'rows'.padStart(10)}`)
    for (const t of tables) console.log(`${t.name.padEnd(pad)}  ${String(t.rowCount).padStart(10)}`)
    return true
  }

  return false
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

/** Print usage (commands + options) to stdout. */
function printHelp(): void {
  console.log(`tinbase - Supabase-compatible backend, no Docker (embedded Postgres / PGlite)

Usage: tinbase [command] [options]

Commands:
  start      start the server (default)
  migrate    apply pending supabase/migrations/*.sql and exit
  status     list applied migrations
  keys       print anon and service_role keys
  gen types  print a TypeScript Database type for the current schema
  db reset   wipe the database + storage and re-run migrations and seed
  db diff    print DDL for schema changes not yet in migrations (-f <name> to write a migration)
  db pull    write the current schema delta as a migration and mark it applied ([name] optional)
  inspect    per-table row counts and on-disk size

Options:
  -p, --port <n>        port to listen on (default 54321; also TINBASE_PORT/PORT env)
      --host <host>     host to bind (default 127.0.0.1)
      --dir <path>      project directory containing supabase/ (default cwd)
      --data-dir <path> database data directory (default <dir>/.tinbase/pgdata
                        for the native engine, <dir>/.tinbase/db for wasm)
      --storage-dir <p> storage files directory (default <dir>/.tinbase/storage)
      --jwt-secret <s>  JWT secret (or TINBASE_JWT_SECRET env var)

Email (env):
  TINBASE_RESEND_API_KEY  deliver auth emails through Resend; without it they land
                          in the dev inbox at /inbox and are never sent
  TINBASE_MAIL_FROM       sender for Resend, e.g. "My App <noreply@example.com>"
  TINBASE_RESEND_ENDPOINT send through a Resend-compatible gateway instead of
                          api.resend.com (a platform gateway that holds the real
                          key and meters each tenant)

SMTP (env, mirroring GOTRUE_SMTP_*):
  TINBASE_SMTP_HOST         mail server to send through - any SMTP provider
  TINBASE_SMTP_PORT         default 587
  TINBASE_SMTP_USER
  TINBASE_SMTP_PASS
  TINBASE_SMTP_ADMIN_EMAIL  address mail is sent from
  TINBASE_SMTP_SENDER_NAME  display name beside it

A project overrides all of the above with [auth.email.smtp] in
supabase/config.toml (host, port, user, pass, admin_email, sender_name).
  TINBASE_SITE_URL        public URL of the APP: the default redirect for
                          emailed links (overrides config.toml auth.site_url
                          and the bound address)
  TINBASE_API_EXTERNAL_URL
                          public URL of THIS SERVER, which emailed links are
                          built on and tokens are issued by. Defaults to the
                          site URL. GOTRUE_API_EXTERNAL_URL and API_EXTERNAL_URL
                          are accepted too.
  TINBASE_URI_ALLOW_LIST  comma-separated redirect targets to allow in addition
                          to config.toml auth.additional_redirect_urls (globs,
                          e.g. https://app.example.com/**)
      --memory          in-memory database (no persistence, wasm engine only)
      --engine <e>      native (embedded Postgres, default on macOS/Linux),
                        wasm (PGlite - default on Windows, browser-ready), or
                        pgmem (ultralight in-memory subset - no RLS, cron, or
                        pgmq; local dev / preview only)
      --database-url <url>  connect to an external Postgres you already run
                        (postgres://user:pass@host:5432/db; or DATABASE_URL env).
                        Treated as shared: bootstrap runs idempotently.
`)
}

/** CLI entry point: parse args, dispatch the subcommand, and (for `start`) run the server until SIGINT/SIGTERM. */
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.command === 'db' && opts.positionals[0] === 'diff') {
    refuseIfUnshareableServer(opts, 'db diff')
    // `tinbase db diff [-f name]` - DDL for schema changes not yet in migrations
    const project = await loadSupabaseProject(opts.dir)
    const liveDataDir = resolveDataDir(opts)
    const nativeLive = opts.engine === 'native' ? await openNativeForReading(liveDataDir!, (m) => console.error(`  ${m}`)) : undefined
    const ddl = await computeDbDiff({
      liveEngine: nativeLive,
      liveDataDir: opts.engine === 'native' ? undefined : liveDataDir,
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

  if (opts.command === 'db' && opts.positionals[0] === 'pull') {
    refuseIfUnshareableServer(opts, 'db pull')
    // `tinbase db pull [name]` - write the current schema delta as a migration
    // and record it as already applied (so `start` won't re-run it)
    const project = await loadSupabaseProject(opts.dir)
    const liveDataDir = resolveDataDir(opts)
    const nativeLive = opts.engine === 'native' ? await openNativeForReading(liveDataDir!, (m) => console.error(`  ${m}`)) : undefined
    const res = await pullSchema({
      liveEngine: nativeLive,
      liveDataDir: opts.engine === 'native' ? undefined : liveDataDir,
      migrations: project.migrations,
      makeShadowEngine:
        opts.engine === 'native' ? () => createNativeEngine({ dataDir: shadowNativeDataDir() }) : undefined,
      migrationsDir: join(opts.dir, 'supabase', 'migrations'),
      name: opts.positionals[1] || 'remote_schema',
    })
    if (!res.path) {
      console.error('No schema changes to pull.')
      return
    }
    console.error(`Wrote ${res.path} and recorded it as applied (version ${res.version}).`)
    return
  }

  if (opts.command === 'inspect') {
    if (await runViaServer(opts)) return
    refuseIfUnshareableServer(opts, 'inspect')
    // `tinbase inspect` - per-table row counts and on-disk size
    const project = await loadSupabaseProject(opts.dir)
    const inspectDataDir = resolveDataDir(opts)
    const engine = opts.engine === 'native' ? await openNativeForReading(inspectDataDir!, (m) => console.log(`  ${m}`)) : undefined
    const backend = await createBackend({
      engine,
      dataDir: opts.engine === 'native' ? undefined : inspectDataDir,
      migrations: project.migrations,
    })
    const rows = await inspectDb(backend.db, 'public')
    if (rows.length === 0) {
      console.log('No tables in schema "public".')
    } else {
      const pad = Math.max(5, ...rows.map((r) => r.table.length))
      console.log(`${'table'.padEnd(pad)}  ${'rows'.padStart(10)}  size`)
      for (const r of rows) {
        console.log(`${r.table.padEnd(pad)}  ${String(r.rows).padStart(10)}  ${r.size}`)
      }
    }
    await backend.close()
    return
  }

  if (opts.command === 'db') {
    const sub = opts.positionals[0]
    if (sub !== 'reset') {
      console.error(`unknown db subcommand: ${sub ?? '(none)'} (supported: reset, diff, pull)`)
      process.exit(1)
    }
    // `tinbase db reset` - wipe data + storage and re-run migrations + seed fresh
    const dataDir = resolveDataDir(opts)
    // Checked before anything is deleted: the wipe would take postmaster.pid with
    // it, which is the lock that should have prevented a second cluster here.
    refuseIfServerRunning(dataDir, 'db reset')
    refuseIfUnshareableServer(opts, 'db reset')
    const storageDir = opts.storageDir || join(opts.dir, '.tinbase', 'storage')
    if (dataDir) await rm(dataDir, { recursive: true, force: true })
    await rm(storageDir, { recursive: true, force: true })
    console.log('  wiped database and storage')

    const project = await loadSupabaseProject(opts.dir)
    const engine =
      opts.engine === 'native'
        ? await createNativeEngine({ dataDir: dataDir!, log: (m) => console.log(`  ${m}`) })
        : opts.engine === 'pgmem'
          ? await createPgmemEngine()
          : undefined
    if (opts.engine === 'wasm' && dataDir) await mkdir(dataDir, { recursive: true })
    await mkdir(storageDir, { recursive: true })
    const backend = await createBackend({
      engine,
      dataDir: opts.engine === 'native' ? undefined : dataDir,
      jwtSecret: opts.jwtSecret,
      migrations: project.migrations,
      seedSql: project.seedSql,
      authSettings: loadProjectConfig(opts.dir).auth.settings,
      storageDriver: new FsStorageDriver(storageDir),
      log: (m) => console.log(`  ${m}`),
    })
    const applied = await backend.db.listAppliedMigrations()
    console.log(`  reset complete - ${applied.length} migration(s) applied${project.seedSql ? ' + seed' : ''}`)
    await backend.close()
    return
  }

  if (opts.command === 'gen') {
    // `tinbase gen types [typescript]` - emit a Supabase-shaped Database type to stdout
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
    // Same derivation as the server: deterministic in dev (stable across runs,
    // demo-identical with the default secret), unique per run in production.
    const { anonKey, serviceRoleKey } = await deriveApiKeys(
      opts.jwtSecret,
      process.env.NODE_ENV === 'production' ? 'unique' : 'deterministic'
    )
    console.log('anon key:')
    console.log(anonKey)
    console.log('\nservice_role key:')
    console.log(serviceRoleKey)
    return
  }

  const cfg = loadProjectConfig(opts.dir)
  const project = await loadSupabaseProject(opts.dir, { enabled: cfg.seed.enabled, paths: cfg.seed.paths })
  const functions = await loadFunctions(opts.dir, cfg.functions)
  const functionEnv = await loadFunctionEnv(opts.dir)
  const webhooks = loadWebhooks(opts.dir)
  const dataDir = resolveDataDir(opts)
  // The native engine initializes its own cluster directory; only PGlite needs
  // the directory to exist up front.
  if (dataDir && opts.engine === 'wasm') await mkdir(dataDir, { recursive: true })
  await mkdir(opts.storageDir, { recursive: true })

  // --database-url takes over engine selection: createBackend builds the
  // external-Postgres engine from the URL.
  // `start` has to own its postmaster; migrate/status only read, so they attach to
  // one already running rather than failing on the data-directory lock.
  const readOnlyCommand = opts.command === 'migrate' || opts.command === 'status'
  if (readOnlyCommand) {
    if (await runViaServer(opts)) return
    refuseIfUnshareableServer(opts, opts.command)
  }
  const engine = opts.databaseUrl
    ? undefined
    : opts.engine === 'native'
      ? readOnlyCommand
        ? await openNativeForReading(dataDir!, (msg) => console.log(`  ${msg}`))
        : await createNativeEngine({
            dataDir: dataDir!,
            log: (msg) => console.log(`  ${msg}`),
          })
      : opts.engine === 'pgmem'
        ? await createPgmemEngine()
        : undefined
  if (opts.databaseUrl) {
    console.log('  ⚠ using an external Postgres (--database-url): treated as shared — bootstrap runs idempotently.')
  }
  if (opts.engine === 'pgmem') {
    console.log('  ⚠ pg-mem engine: in-memory subset - no RLS, cron, or pgmq (realtime is unfiltered) - local dev / preview only')
  }

  // For `start`, pick a free port up front (skipping one already in use, e.g. a
  // tinbase already running) so the URL, keys, and siteUrl all reflect it -
  // instead of crashing later with EADDRINUSE.
  let port = opts.port
  if (opts.command === 'start') {
    const free = await findAvailablePort(opts.port, opts.host)
    if (free === null) {
      console.error(
        `\n  ✖ No free port found near ${opts.port} (tried ${opts.port}–${opts.port + 19}).\n` +
          `    Stop whatever is using it, or pass --port <n>.\n`
      )
      process.exit(1)
    }
    if (free !== opts.port) {
      console.log(`  ⚠ Port ${opts.port} is in use - starting on ${free} instead (use --port to choose).`)
    }
    port = free
  }

  // Outgoing auth email. With TINBASE_RESEND_API_KEY set, mail goes out through
  // Resend and the dev /inbox is not mounted (it is unauthenticated and would
  // expose every reset link). Without it, the in-memory inbox stays - right for
  // local dev, wrong for anything reachable by real users, so the banner says
  // which one is active. The key alone is not enough: Resend needs a verified
  // sender, so a missing/invalid TINBASE_MAIL_FROM is a startup error rather
  // than a silently dropped email later.
  // Who sends this project's auth email, in precedence order:
  //
  //   1. the project's own [auth.email.smtp]  - it asked to send its own mail
  //   2. the deployment's transport (env)     - a platform sending for its tenants
  //   3. neither                              - the dev inbox, delivered nowhere
  //
  // A project's own block wins because it is the more specific statement of
  // intent, and because the addresses differ: sending as the project's address
  // is only legitimate when the project's own credentials carry it. On the
  // platform path the sender stays whatever the deployment set, so a tenant
  // cannot mail as someone else on the deployment's reputation.
  // The hook replaces rendering as well as delivery, so it outranks every
  // transport below: if an endpoint is going to compose and send the mail,
  // there is nothing here left to do.
  const hookCfg = cfg.auth.sendEmailHook
  const sendEmailHook =
    hookCfg?.uri && hookCfg.enabled !== false
      ? { uri: hookCfg.uri, ...(hookCfg.secret ? { secret: hookCfg.secret } : {}) }
      : undefined
  if (sendEmailHook) {
    try {
      new URL(sendEmailHook.uri)
    } catch {
      console.error(`auth.hook.send_email: uri is not a valid URL: ${sendEmailHook.uri}`)
      process.exit(1)
    }
  }

  // SMTP from two places, project first. The names mirror GoTrue's
  // (GOTRUE_SMTP_* -> TINBASE_SMTP_*) so an operator moving between the two
  // configures the same things by the same names.
  //
  // Env exists because a deployment configures containers through the
  // environment, not by writing into each project's committed files - and a
  // platform that edited a tenant's config.toml would be editing something the
  // tenant owns. config.toml still wins: a project asking to send its own mail
  // is the more specific instruction.
  const envSmtpHost = process.env.TINBASE_SMTP_HOST
  const smtpCfg = cfg.auth.smtp?.host
    ? cfg.auth.smtp
    : envSmtpHost
      ? {
          enabled: true,
          host: envSmtpHost,
          port: process.env.TINBASE_SMTP_PORT ? parseInt(process.env.TINBASE_SMTP_PORT, 10) : 587,
          user: process.env.TINBASE_SMTP_USER,
          pass: process.env.TINBASE_SMTP_PASS,
          adminEmail: process.env.TINBASE_SMTP_ADMIN_EMAIL,
          senderName: process.env.TINBASE_SMTP_SENDER_NAME,
        }
      : undefined
  const useProjectSmtp = !sendEmailHook && !!smtpCfg?.host && smtpCfg.enabled !== false
  const resendApiKey = process.env.TINBASE_RESEND_API_KEY
  const mailFrom = process.env.TINBASE_MAIL_FROM
  const resendEndpoint = process.env.TINBASE_RESEND_ENDPOINT || undefined
  let mailer: Mailer | undefined
  let mailDescription = sendEmailHook ? `send-email hook \u2192 ${new URL(sendEmailHook.uri).host}` : ''
  if (useProjectSmtp) {
    try {
      const m = new SmtpMailer({
        host: smtpCfg!.host!,
        port: smtpCfg!.port ?? 587,
        user: smtpCfg!.user,
        pass: smtpCfg!.pass,
        adminEmail: smtpCfg!.adminEmail ?? '',
        senderName: smtpCfg!.senderName,
        secure: smtpCfg!.secure,
      })
      mailer = m
      mailDescription = `SMTP ${smtpCfg!.host}:${smtpCfg!.port ?? 587} (from ${m.from})${cfg.auth.smtp?.host ? '' : ' [env]'}`
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      if (cfg.auth.smtp?.host) {
        // The project's own config.toml: its author is looking at this output,
        // and a typo should stop them now rather than surface as mail that
        // never arrives.
        console.error(`auth.email.smtp: ${detail}`)
        process.exit(1)
      }
      // Injected by a platform for its tenants. Exiting here would take the
      // database down with the mail settings - and since one platform pushes
      // the same values to every tenant, a single bad address would stop every
      // app it hosts, not just their email. A misconfiguration that breaks
      // email should break email.
      console.error(
        `TINBASE_SMTP_*: ${detail}\n` +
          '  Auth email is DISABLED for this instance; everything else is running. ' +
          'Fix the platform SMTP settings and restart to enable it.'
      )
    }
  } else if (resendApiKey && !sendEmailHook) {
    if (!mailFrom) {
      console.error('TINBASE_RESEND_API_KEY is set but TINBASE_MAIL_FROM is not (e.g. "My App <noreply@example.com>")')
      process.exit(1)
    }
    // Fail here rather than on the first email: a typo in the gateway URL would
    // otherwise look like mail simply never arriving.
    if (resendEndpoint !== undefined) {
      try {
        new URL(resendEndpoint)
      } catch {
        console.error(`TINBASE_RESEND_ENDPOINT is not a valid URL: ${resendEndpoint}`)
        process.exit(1)
      }
    }
    try {
      // TINBASE_RESEND_ENDPOINT points the transport at a Resend-compatible API
      // other than Resend itself. A platform running many tenants uses this to
      // send through its own gateway: the gateway holds the real provider
      // credential, so no tenant's container does, and it can attribute and cap
      // each tenant's sending - which a shared credential going straight to the
      // provider cannot. The payload shape is unchanged either way.
      mailer = new ResendMailer({ apiKey: resendApiKey, from: mailFrom, endpoint: resendEndpoint })
      mailDescription = `${resendEndpoint ? new URL(resendEndpoint).host : 'Resend'} (from ${mailFrom})`
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
  }

  // Load the bodies named by [auth.email.template.*].content_path. Read here
  // rather than in load-config because that module is shared with the browser
  // build, which has no filesystem. A missing or unreadable file is a startup
  // error: silently falling back to the default would mail a template the
  // project believes it replaced.
  const emailTemplates: Record<string, { subject?: string; content?: string }> = {}
  for (const [name, t] of Object.entries(cfg.auth.emailTemplates ?? {})) {
    const entry: { subject?: string; content?: string } = {}
    if (t.subject !== undefined) entry.subject = t.subject
    if (t.contentPath) {
      const file = resolve(opts.dir, t.contentPath)
      try {
        entry.content = readFileSync(file, 'utf8')
      } catch (e) {
        console.error(`auth.email.template.${name}: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`)
        process.exit(1)
      }
    }
    emailTemplates[name] = entry
  }

  const siteUrl = process.env.TINBASE_SITE_URL || cfg.auth.siteUrl || `http://${opts.host}:${port}`

  // Where this server itself answers. Emailed links are built on it, so it has
  // to be reachable from a mail client - while siteUrl above is the app, which
  // is somewhere else entirely once a platform is hosting both. GOTRUE_ and
  // bare API_EXTERNAL_URL are accepted too, so a GoTrue .env works unchanged.
  // Defaults to siteUrl: a deployment that has not separated them keeps the
  // behaviour it has today.
  const apiExternalUrl =
    process.env.TINBASE_API_EXTERNAL_URL ||
    process.env.GOTRUE_API_EXTERNAL_URL ||
    process.env.API_EXTERNAL_URL ||
    cfg.auth.apiExternalUrl ||
    siteUrl

  // Allowed redirect targets for emailed links, merged from two sources: the
  // project's own `additional_redirect_urls`, and TINBASE_URI_ALLOW_LIST, which
  // a platform sets to the origins it already knows this project is served on.
  // Both are needed: the allowlist is enforced once bound to a network-exposed
  // host, and a project deployed behind a platform cannot be expected to list
  // hostnames the platform minted for it.
  const uriAllowList = [
    ...(process.env.TINBASE_URI_ALLOW_LIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(cfg.auth.uriAllowList ?? []),
  ]

  const backend = await createBackend({
    engine,
    databaseUrl: opts.databaseUrl,
    dataDir: opts.engine === 'native' ? undefined : dataDir,
    jwtSecret: opts.jwtSecret,
    mailer,
    emailTemplates,
    sendEmailHook,
    // The public URL emailed links and redirects are built on. TINBASE_SITE_URL
    // wins (a platform injects the workload's public route - the bound address
    // inside a container is meaningless to a user's mail client), then
    // config.toml's site_url, then the bound address for plain local dev.
    siteUrl,
    apiExternalUrl,
    host: opts.host,
    jwtExpiry: cfg.auth.jwtExpiry,
    uriAllowList,
    authEnabled: cfg.auth.enabled,
    authSettings: cfg.auth.settings,
    authRateLimits: cfg.auth.rateLimits,
    sessionTimeboxSeconds: cfg.auth.sessionTimeboxSeconds,
    oauthProviders: cfg.auth.oauthProviders,
    dbSchemas: cfg.api.schemas,
    maxRows: cfg.api.maxRows,
    storageFileSizeLimit: cfg.storage.fileSizeLimit,
    buckets: cfg.storage.buckets,
    migrations: project.migrations,
    seedSql: project.seedSql,
    functions,
    functionEnv,
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
    ? await serveBun(backend, { port, host: opts.host })
    : await serve(backend, { port, host: opts.host })
  console.log(`
  tinbase running

           API URL: ${server.url}
          Admin UI: ${server.url}/_/
             Email: ${sendEmailHook || mailer ? mailDescription : isNetworkExposed(opts.host) ? 'NOT CONFIGURED - no auth email is sent, and /inbox is off on a network-exposed host' : `dev inbox at ${server.url}/inbox (not delivered)`}
    Mail templates: ${Object.keys(emailTemplates).length ? Object.keys(emailTemplates).join(', ') : 'built-in defaults'}
          Site URL: ${siteUrl}${apiExternalUrl === siteUrl ? '' : `\n      API external: ${apiExternalUrl}`}
    Redirects to: ${uriAllowList.length ? uriAllowList.join(', ') : 'the site URL origin only'}
            Engine: ${opts.engine === 'native' ? `native postgres (${dataDir})` : opts.engine === 'pgmem' ? 'pg-mem (in-memory, lite)' : `PGlite (${opts.memory ? 'in-memory' : dataDir})`}
           Storage: ${opts.storageDir}
        Migrations: ${project.migrations.length} file(s)
         Functions: ${functions.size > 0 ? [...functions.keys()].join(', ') : 'none'}
    OAuth providers: ${Object.keys(cfg.auth.oauthProviders).length ? Object.keys(cfg.auth.oauthProviders).join(', ') : 'none'}
          Webhooks: ${webhooks.length ? webhooks.map((w) => w.table).join(', ') : 'none'}

          anon key: ${backend.anonKey}
  service_role key: ${backend.serviceRoleKey}

  ${
    process.env.NODE_ENV === 'production'
      ? 'Keys are unique per start (NODE_ENV=production). For your env:'
      : 'Same keys every start - safe to commit. Drop into .env.local:'
  }
    SUPABASE_URL=${server.url}
    SUPABASE_ANON_KEY=${backend.anonKey}
    SUPABASE_SERVICE_ROLE_KEY=${backend.serviceRoleKey}

  Use with supabase-js:
    const supabase = createClient('${server.url}', '<anon key>')
`)

  // Lets the other commands see that this project is being served, on engines that
  // advertise nothing themselves (wasm, pgmem). The native engine is discoverable
  // through postgres's own postmaster.pid, but writing it for every engine keeps
  // one answer to "is a server up?".
  writeServerLock(opts.dir, { engine: opts.engine, host: opts.host, port })

  // Fired after the server is already serving and deliberately not awaited, so a
  // slow or unreachable registry delays nothing.
  void printUpdateNotice(TINBASE_VERSION)

  const shutdown = async () => {
    console.log('\nshutting down…')
    removeServerLock(opts.dir)
    await server.close().catch(() => {})
    await backend.close().catch(() => {})
    process.exit(0)
  }
  // A hard exit (uncaught crash) would otherwise leave the marker behind; readers
  // check the pid so it is not fatal, but clearing it keeps things tidy.
  process.once('exit', () => removeServerLock(opts.dir))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
