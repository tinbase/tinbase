/**
 * Native embedded Postgres engine — PocketBase-class footprint with real
 * Postgres semantics. Downloads platform binaries once (~12 MB from
 * theseus-rs/postgresql-binaries), runs initdb with memory-lean settings,
 * and manages the postgres child process. Trust auth over a private unix
 * socket directory (0700), never TCP.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbEngine, EngineResults, EngineTx } from '../../db/engine.js'
import { Mutex } from '../../db/engine.js'
import { PgWireClient } from './wire.js'

const DEFAULT_PG_VERSION = '17.7.0'

export interface NativeEngineOptions {
  /** Postgres data directory (created + initdb'd if missing). */
  dataDir: string
  /** Postgres version tag from theseus-rs/postgresql-binaries. */
  version?: string
  /** Where downloaded binaries are cached. Default ~/.cache/tinbase */
  cacheDir?: string
  log?: (msg: string) => void
}

function target(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null
  if (!arch) throw new Error(`unsupported architecture for native engine: ${process.arch}`)
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (process.platform === 'linux') return `${arch}-unknown-linux-gnu`
  throw new Error(`unsupported platform for native engine: ${process.platform} (use the default PGlite engine)`)
}

/** A binary install is only usable if both the server and its catalog seed are present. */
function isCompleteInstall(dir: string): boolean {
  return existsSync(join(dir, 'bin', 'postgres')) && existsSync(join(dir, 'share', 'postgres.bki'))
}

/** Download + unpack Postgres binaries if not already cached (concurrency-safe). Returns the install dir. */
export async function ensurePostgres(version = DEFAULT_PG_VERSION, cacheDir?: string, log?: (m: string) => void): Promise<string> {
  const t = target()
  const root = cacheDir ?? join(homedir(), '.cache', 'tinbase')
  const dir = join(root, `postgresql-${version}-${t}`)
  if (isCompleteInstall(dir)) return dir

  // Concurrency-safe: multiple test workers / processes may call this at once on
  // a cold cache. Each downloads + extracts to unique temp paths, then atomically
  // renames into place — so no worker ever sees a half-written tarball or a
  // partially-extracted install dir.
  const url = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${version}/postgresql-${version}-${t}.tar.gz`
  mkdirSync(root, { recursive: true })
  const uniq = `${process.pid}-${randomBytes(6).toString('hex')}`
  const tarball = join(root, `pg-${version}-${uniq}.tar.gz`)
  const tmpDir = join(root, `.tmp-${version}-${t}-${uniq}`)

  try {
    if (isCompleteInstall(dir)) return dir // another worker finished while we started
    log?.(`downloading postgres ${version} (${t})…`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`failed to download ${url}: HTTP ${res.status}`)
    await writeFile(tarball, Buffer.from(await res.arrayBuffer()))
    mkdirSync(tmpDir, { recursive: true })
    execFileSync('tar', ['xzf', tarball, '-C', tmpDir, '--strip-components=1'])
    if (!isCompleteInstall(tmpDir)) throw new Error('postgres archive extracted incompletely')

    // publish atomically; if another worker already did (or a stale dir exists), reconcile
    try {
      renameSync(tmpDir, dir)
    } catch {
      if (!isCompleteInstall(dir)) {
        rmSync(dir, { recursive: true, force: true })
        renameSync(tmpDir, dir)
      }
    }
    log?.(`postgres installed to ${dir}`)
    return dir
  } finally {
    rmSync(tarball, { force: true })
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

const TUNED_CONF = `
# tinbase: memory-lean settings for an embedded, single-app Postgres
listen_addresses = ''
shared_buffers = 16MB
dynamic_shared_memory_type = posix
max_connections = 10
wal_level = minimal
max_wal_senders = 0
synchronous_commit = off
logging_collector = off
`

export async function createNativeEngine(opts: NativeEngineOptions): Promise<DbEngine> {
  const installDir = await ensurePostgres(opts.version, opts.cacheDir, opts.log)
  const bin = (name: string) => join(installDir, 'bin', name)

  // initdb on first boot
  if (!existsSync(join(opts.dataDir, 'PG_VERSION'))) {
    mkdirSync(opts.dataDir, { recursive: true })
    try {
      execFileSync(bin('initdb'), ['-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '-D', opts.dataDir], {
        stdio: 'pipe',
      })
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? ''
      throw new Error(`initdb failed:\n${stderr || (e as Error).message}`)
    }
    appendFileSync(join(opts.dataDir, 'postgresql.conf'), TUNED_CONF)
  }

  // A stale postmaster.pid (from a crashed run) makes postgres refuse to start.
  // Remove it if the process it names is no longer alive.
  removeStalePidFile(join(opts.dataDir, 'postmaster.pid'))

  // private socket dir — trust auth is safe because only this user can reach it.
  // Keep the path short: macOS caps unix socket paths at ~104 chars.
  const sockDir = mkdtempSync(join(tmpdir(), 'tb-'))
  chmodSync(sockDir, 0o700)

  const child: ChildProcess = spawn(bin('postgres'), ['-D', opts.dataDir, '-k', sockDir], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  })
  let childExited = false
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000)
  })
  child.on('exit', () => (childExited = true))

  const socketPath = join(sockDir, '.s.PGSQL.5432')
  const connect = async (): Promise<PgWireClient> => {
    const deadline = Date.now() + 20_000
    for (;;) {
      try {
        return await PgWireClient.connect({ socketPath, user: 'postgres', database: 'postgres' })
      } catch (e) {
        if (childExited) {
          const detail = stderr.trim()
          throw new Error(
            `embedded postgres failed to start${detail ? `:\n${detail}` : ' (no output)'}\n\n` +
              `data dir: ${opts.dataDir}\n` +
              `If a previous run is still holding it, stop it; or delete the data dir to start fresh.`
          )
        }
        if (Date.now() > deadline) throw e
        await new Promise((r) => setTimeout(r, 150))
      }
    }
  }

  const main = await connect()
  const listener = await connect()

  const mutex = new Mutex()
  const listeners = new Map<string, Set<(payload: string) => void>>()
  listener.onNotification = (channel, payload) => {
    for (const cb of listeners.get(channel) ?? []) cb(payload)
  }

  const tx: EngineTx = {
    async query<T>(sql: string, params?: unknown[]): Promise<EngineResults<T>> {
      const res = await main.query<T>(sql, normalizeParams(params))
      return { rows: res.rows, affectedRows: res.affectedRows }
    },
    async exec(sql: string): Promise<void> {
      await main.exec(sql)
    },
  }

  return {
    query<T>(sql: string, params?: unknown[]): Promise<EngineResults<T>> {
      return mutex.run(() => tx.query<T>(sql, params))
    },
    exec(sql: string): Promise<void> {
      return mutex.run(() => tx.exec(sql))
    },
    transaction<T>(fn: (t: EngineTx) => Promise<T>): Promise<T> {
      return mutex.run(async () => {
        await main.exec('begin')
        try {
          const result = await fn(tx)
          await main.exec('commit')
          return result
        } catch (e) {
          await main.exec('rollback').catch(() => {})
          throw e
        }
      })
    },
    async listen(channel: string, cb: (payload: string) => void): Promise<() => void> {
      if (!listeners.has(channel)) {
        listeners.set(channel, new Set())
        await listener.exec(`listen "${channel.replaceAll('"', '""')}"`)
      }
      listeners.get(channel)!.add(cb)
      return () => listeners.get(channel)?.delete(cb)
    },
    async close(): Promise<void> {
      await main.close().catch(() => {})
      await listener.close().catch(() => {})
      if (!childExited) {
        child.kill('SIGINT') // fast shutdown
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            child.kill('SIGKILL')
            resolve()
          }, 5000)
          child.on('exit', () => {
            clearTimeout(t)
            resolve()
          })
        })
      }
      rmSync(sockDir, { recursive: true, force: true })
    },
  }
}

/**
 * Postgres refuses to boot if a postmaster.pid names a live process. When the
 * previous run crashed the pid is stale; postgres usually clears it, but if the
 * data dir moved or the boot ID differs it may not — remove it when the named
 * pid is dead so a fresh start succeeds.
 */
function removeStalePidFile(pidPath: string): void {
  if (!existsSync(pidPath)) return
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf8').split('\n')[0]?.trim() ?? '', 10)
    if (!pid) {
      rmSync(pidPath, { force: true })
      return
    }
    try {
      process.kill(pid, 0) // throws if the process does not exist
      // process is alive — leave the pid file; postgres will report the conflict
    } catch {
      rmSync(pidPath, { force: true })
    }
  } catch {
    // unreadable pid file — let postgres decide
  }
}

/** Match PGlite's param serialization: arrays → pg literals, objects → JSON. */
function normalizeParams(params?: unknown[]): unknown[] | undefined {
  return params?.map((p) => {
    if (p === null || p === undefined) return null
    if (Array.isArray(p)) return toPgArrayLiteral(p)
    if (p instanceof Date) return p.toISOString()
    if (typeof p === 'object') return JSON.stringify(p)
    return p
  })
}

function toPgArrayLiteral(arr: unknown[]): string {
  const items = arr.map((el): string => {
    if (el === null || el === undefined) return 'NULL'
    if (Array.isArray(el)) return toPgArrayLiteral(el)
    if (typeof el === 'number' || typeof el === 'boolean') return String(el)
    const s = typeof el === 'object' ? JSON.stringify(el) : String(el)
    return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  })
  return `{${items.join(',')}}`
}
