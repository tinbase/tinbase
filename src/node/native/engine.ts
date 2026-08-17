/**
 * Native embedded Postgres engine - PocketBase-class footprint with real
 * Postgres semantics. Downloads platform binaries once (~12 MB from
 * theseus-rs/postgresql-binaries), runs initdb with memory-lean settings,
 * and manages the postgres child process. Trust auth over a private unix
 * socket directory (0700), never TCP.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbEngine } from '../../db/engine.js'
import { PgWireClient } from './wire.js'
import { buildWireEngine } from './wire-engine.js'

const DEFAULT_PG_VERSION = '17.7.0'

/** Positive integer from an env var, or the fallback. */
const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** How long to wait for the postmaster to start accepting connections. */
const startupTimeoutMs = (): number => envMs('TINBASE_PG_STARTUP_TIMEOUT_MS', 20_000)

/**
 * How long to wait once postgres has answered "starting up". Generous on
 * purpose: this is crash recovery, and giving up mid-recovery leaves a database
 * that would have opened fine unreachable.
 */
const recoveryTimeoutMs = (): number => envMs('TINBASE_PG_RECOVERY_TIMEOUT_MS', 300_000)

/** Options for {@link createNativeEngine}. */
export interface NativeEngineOptions {
  /** Postgres data directory (created + initdb'd if missing). */
  dataDir: string
  /** Postgres version tag from theseus-rs/postgresql-binaries. */
  version?: string
  /** Where downloaded binaries are cached. Default ~/.cache/tinbase */
  cacheDir?: string
  /** sink for progress lines (download, install); no-op when omitted */
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

/**
 * Pinned SHA-256 digests for the tarballs we download, keyed by
 * `postgresql-<version>-<target>`. A pinned entry is enforced offline (strongest
 * integrity). For versions/targets not listed here we fall back to the checksum
 * the release publishes alongside the tarball, which still defends against
 * truncated downloads and mismatched redirects.
 */
const PINNED_SHA256: Record<string, string> = {
  // theseus-rs/postgresql-binaries 17.7.0 (the DEFAULT_PG_VERSION). Refresh
  // these from the release *.sha256 files whenever DEFAULT_PG_VERSION changes.
  'postgresql-17.7.0-x86_64-unknown-linux-gnu': '66ad03281a43624f955c8e16ac975cb0ab751e7edf8ba35308e3b08dd7d065c3',
  'postgresql-17.7.0-aarch64-unknown-linux-gnu': '89cc2f089880cc8e5e6b7a29387829ec4e4779427855bc0b9fa187c8fce33c8b',
  'postgresql-17.7.0-x86_64-apple-darwin': '0dd8c25173524bad4ae8ef6b970da1ac40f4c1f231150c416ccb8cd06feff8f2',
  'postgresql-17.7.0-aarch64-apple-darwin': '727ac08d20a704014a0d51eb3300aa0c8e292c1cf0a1c99d4f4b1002e1420220',
}

/** Verify `tarball` against a pinned digest, else the release's published .sha256. */
async function verifyTarball(tarball: string, key: string, url: string): Promise<void> {
  const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const pinned = PINNED_SHA256[key]
  if (pinned) {
    if (actual !== pinned) {
      throw new Error(`postgres binary checksum mismatch for ${key}: expected ${pinned}, got ${actual}`)
    }
    return
  }
  // No local pin - verify against the checksum the release publishes.
  const res = await fetch(`${url}.sha256`)
  if (!res.ok) throw new Error(`could not fetch checksum for ${key}: HTTP ${res.status}`)
  const expected = (await res.text()).trim().split(/\s+/)[0].toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`malformed published checksum for ${key}`)
  if (actual !== expected) {
    throw new Error(`postgres binary checksum mismatch for ${key}: expected ${expected}, got ${actual}`)
  }
}

/** Download + unpack Postgres binaries if not already cached (concurrency-safe). Returns the install dir. */
export async function ensurePostgres(version = DEFAULT_PG_VERSION, cacheDir?: string, log?: (m: string) => void): Promise<string> {
  const t = target()
  const root = cacheDir ?? join(homedir(), '.cache', 'tinbase')
  const dir = join(root, `postgresql-${version}-${t}`)
  if (isCompleteInstall(dir)) return dir

  // Concurrency-safe: multiple test workers / processes may call this at once on
  // a cold cache. Each downloads + extracts to unique temp paths, then atomically
  // renames into place - so no worker ever sees a half-written tarball or a
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
    // Integrity-check the tarball before executing anything it contains.
    await verifyTarball(tarball, `postgresql-${version}-${t}`, url)
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
timezone = 'UTC'
`

/**
 * Boot the embedded Postgres child (initdb on first run) and return a {@link DbEngine}
 * backed by two wire connections: one for queries/transactions (serialized by a mutex),
 * one dedicated to LISTEN/NOTIFY.
 */
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
  removeStalePidFile(join(opts.dataDir, 'postmaster.pid'), opts.dataDir)

  // private socket dir - trust auth is safe because only this user can reach it.
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

  // Best-effort: if this Node process exits without a clean close() (crash,
  // uncaught signal), take the postgres child down with it so it doesn't
  // orphan and hold the data dir. Removed in close().
  const killChild = (): void => {
    if (!childExited) child.kill('SIGTERM')
  }
  process.once('exit', killChild)

  const socketPath = join(sockDir, '.s.PGSQL.5432')
  const connect = async (): Promise<PgWireClient> => {
    // Two different waits. A socket that refuses connections means the
    // postmaster has not opened it yet — quick, and bounded tightly. A 57P03
    // ("the database system is starting up") is a *reply*: postgres is alive
    // and running crash recovery, which after an unclean shutdown of a busy
    // database can legitimately take minutes on a loaded host. Holding both to
    // 20s meant recovery that would have finished at 25s surfaced as a fatal
    // startup error, and the database never came up again.
    const deadline = Date.now() + startupTimeoutMs()
    const recoveryDeadline = Date.now() + recoveryTimeoutMs()
    let announcedRecovery = false
    for (;;) {
      try {
        return await PgWireClient.connect({ socketPath, user: 'postgres', database: 'postgres' })
      } catch (e) {
        const starting = (e as { code?: string })?.code === '57P03'
        if (starting) {
          if (!announcedRecovery) {
            announcedRecovery = true
            console.warn('  postgres is starting up (crash recovery); waiting…')
          }
          if (Date.now() > recoveryDeadline) throw e
          await new Promise((r) => setTimeout(r, 250))
          continue
        }
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

  return buildWireEngine({
    connect,
    onClose: async () => {
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
  })
}

/**
 * A live postmaster already serving `dataDir`, read from its own pid file.
 *
 * Postgres records everything needed to reach it - pid, port and the socket
 * directory - so no separate state file is needed, and the file is maintained by
 * postgres rather than by us. Returns null when there is no server, when the pid
 * it names is dead (a crashed run leaves the file behind), or when it has not
 * reported "ready".
 */
export interface RunningPostmaster {
  pid: number
  port: number
  socketDir: string
}

export function readRunningPostmaster(dataDir: string): RunningPostmaster | null {
  const pidPath = join(dataDir, 'postmaster.pid')
  if (!existsSync(pidPath)) return null
  try {
    // Format is positional and stable across supported versions:
    // 1 pid, 2 data dir, 3 start time, 4 port, 5 socket dir, ... 8 status.
    const lines = readFileSync(pidPath, 'utf8').split('\n')
    const pid = parseInt(lines[0]?.trim() ?? '', 10)
    const port = parseInt(lines[3]?.trim() ?? '', 10)
    const socketDir = lines[4]?.trim()
    if (!pid || !port || !socketDir) return null
    try {
      process.kill(pid, 0) // throws when the process is gone
    } catch {
      return null // stale file from a crashed run
    }
    // Line 8 is "ready" once it is accepting connections; anything else (e.g.
    // "starting") means connecting would race the boot.
    if ((lines[7]?.trim() ?? '') !== 'ready') return null
    return { pid, port, socketDir }
  } catch {
    return null
  }
}

/**
 * Attach to a postmaster that another process already started for `dataDir`,
 * as a client, without starting one of our own.
 *
 * Two postmasters cannot share a data directory, so every command that opened
 * the engine directly - migrate, status, inspect, db diff, db pull - failed with
 * `lock file "postmaster.pid" already exists` whenever a server was running,
 * which is precisely when you would want to run them. The socket is 0700 and
 * same-uid, so reaching it grants nothing that access to the data directory did
 * not already grant.
 *
 * Returns null when nothing is running, leaving the caller to start its own.
 */
export async function attachNativeEngine(dataDir: string): Promise<DbEngine | null> {
  const running = readRunningPostmaster(dataDir)
  if (!running) return null
  const socketPath = join(running.socketDir, `.s.PGSQL.${running.port}`)
  if (!existsSync(socketPath)) return null
  return buildWireEngine({
    connect: () => PgWireClient.connect({ socketPath, user: 'postgres', database: 'postgres' }),
    // We did not start it, so closing must not stop it - only drop our client.
    onClose: async () => {},
  })
}

/**
 * Postgres refuses to boot if a postmaster.pid names a live process. When the
 * previous run crashed the pid is stale; postgres usually clears it, but if the
 * data dir moved or the boot ID differs it may not - remove it when the named
 * pid is dead so a fresh start succeeds.
 */
/**
 * Decide whether a postmaster.pid describes a postmaster that is really still
 * running, given the file's contents and two probes (injected so this is
 * testable without spawning processes).
 *
 * "Is some process holding this PID?" is not the same question. PIDs are
 * recycled, and in a container they are recycled immediately: every start
 * numbers processes from 1, so a pid file left by a killed container names a
 * PID that the *new* container has almost certainly reissued — often to node
 * itself. Postgres then refuses to start ("lock file postmaster.pid already
 * exists"), and because the collision recurs on every boot, the database never
 * comes up again. So the PID must be confirmed to belong to a postgres process
 * for this data directory before the file is treated as live.
 *
 * Unknowable cases stay conservative: if the process is alive and we cannot
 * identify it, the file is left alone and postgres reports the conflict itself.
 */
export function pidFileIsStale(
  contents: string,
  dataDir: string,
  isAlive: (pid: number) => boolean,
  describe: (pid: number) => string | null
): boolean {
  const [pidLine, dirLine] = contents.split('\n')
  const pid = parseInt(pidLine?.trim() ?? '', 10)
  if (!pid || pid < 1) return true

  // Line 2 is the data directory the postmaster was started with. A different
  // one means this file was left by another cluster entirely.
  const recorded = dirLine?.trim()
  if (recorded && resolve(recorded) !== resolve(dataDir)) return true

  if (!isAlive(pid)) return true

  const cmd = describe(pid)
  if (cmd === null) return false // cannot identify: let postgres decide
  return !cmd.includes('postgres')
}

/** What is running as `pid`, or null if that cannot be determined. */
function describeProcess(pid: number): string | null {
  try {
    // Linux: the canonical source, and the only one available in the slim
    // container images tinbase ships in (no ps).
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
  } catch {
    /* not Linux, or the process vanished between the liveness check and here */
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { stdio: 'pipe' })
      .toString()
      .trim()
  } catch {
    return null
  }
}

function removeStalePidFile(pidPath: string, dataDir: string): void {
  if (!existsSync(pidPath)) return
  try {
    const contents = readFileSync(pidPath, 'utf8')
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0) // throws if the process does not exist
        return true
      } catch {
        return false
      }
    }
    if (pidFileIsStale(contents, dataDir, isAlive, describeProcess)) {
      rmSync(pidPath, { force: true })
    }
  } catch {
    // unreadable pid file - let postgres decide
  }
}

