import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freePort, freshFetch } from './helpers.js'

/**
 * Commands run against a project whose server is already up.
 *
 * Two postmasters cannot share a data directory, so every command that opened the
 * engine itself failed with `lock file "postmaster.pid" already exists` while a
 * server was running - which is exactly when you reach for migrate or status. They
 * now attach to the running postmaster over the socket it advertises in its own
 * pid file.
 *
 * `db reset` is the opposite case and must refuse: its wipe removes
 * postmaster.pid, the lock that should have prevented a second cluster on the
 * path, so it used to succeed and leave the running server serving
 * `connection closed` with its database deleted underneath - while reporting
 * success.
 */
const CLI = join(process.cwd(), 'dist', 'cli.js')
const BUILT = existsSync(CLI)
const NATIVE_SUPPORTED =
  (process.platform === 'darwin' || process.platform === 'linux') && (process.arch === 'arm64' || process.arch === 'x64')

let dir: string
let server: ChildProcess | undefined
let port: number

function run(...args: string[]): string {
  return execFileSync('node', [CLI, ...args, '--dir', dir, '--engine', 'native'], { encoding: 'utf8' })
}

/** Run expecting a non-zero exit; returns combined output. */
function runExpectingFailure(...args: string[]): string {
  try {
    execFileSync('node', [CLI, ...args, '--dir', dir, '--engine', 'native'], { encoding: 'utf8', stdio: 'pipe' })
    return '__SUCCEEDED__'
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await freshFetch(`http://127.0.0.1:${port}/rest/v1/`)
      if (res.status > 0) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

describe.skipIf(!BUILT || !NATIVE_SUPPORTED)('cli against a running server', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tb-conc-'))
    mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
    writeFileSync(join(dir, 'supabase', 'migrations', '001_init.sql'), 'create table notes (id serial primary key, body text);')
    run('migrate')

    port = await freePort()
    server = spawn('node', [CLI, 'start', '--dir', dir, '--engine', 'native', '--port', String(port)], {
      stdio: 'ignore',
    })
    const up = await waitForServer()
    expect(up).toBe(true)
  }, 240000)

  afterAll(async () => {
    server?.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 3000))
    server?.kill('SIGKILL')
  })

  it('migrate applies into the live database', { timeout: 120000 }, async () => {
    writeFileSync(join(dir, 'supabase', 'migrations', '002_add.sql'), 'create table tags (id serial primary key, label text);')
    const out = run('migrate')
    expect(out).toContain('2 migration(s) applied')

    // the running server serves the new table immediately - so the migration went
    // into the database it is serving, not into a second cluster
    const keys = run('keys')
    const serviceRole = keys.trim().split('\n').pop()!.trim()
    const res = await freshFetch(`http://127.0.0.1:${port}/rest/v1/tags?select=*`, {
      headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('status lists the applied migrations', { timeout: 120000 }, () => {
    const out = run('status')
    expect(out).toContain('001_init')
    expect(out).toContain('002_add')
  })

  it('inspect reports the tables', { timeout: 120000 }, () => {
    const out = run('inspect')
    expect(out).toContain('notes')
    expect(out).toContain('tags')
  })

  it('db diff runs instead of failing on the data-directory lock', { timeout: 120000 }, () => {
    // Either "no changes" or a diff is fine; what must not happen is the lock error.
    const out = runExpectingFailure('db', 'diff')
    const combined = out === '__SUCCEEDED__' ? '' : out
    expect(combined).not.toContain('postmaster.pid')
    expect(combined).not.toContain('already exists')
  })

  it('db reset refuses rather than deleting the running server’s data', { timeout: 120000 }, () => {
    const out = runExpectingFailure('db', 'reset')
    expect(out).not.toBe('__SUCCEEDED__')
    expect(out).toContain('running server')

    // the cluster is untouched and the server still answers
    expect(existsSync(join(dir, '.tinbase', 'pgdata', 'PG_VERSION'))).toBe(true)
  })

  it('the server is still healthy after all of that', { timeout: 120000 }, async () => {
    const keys = run('keys')
    const serviceRole = keys.trim().split('\n').pop()!.trim()
    const res = await freshFetch(`http://127.0.0.1:${port}/rest/v1/notes?select=*`, {
      headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
    })
    expect(res.status).toBe(200)
  })
})
