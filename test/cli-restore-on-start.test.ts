import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `tinbase start` restores an export left at .tinbase/restore.tar.gz before it
 * opens the database. This is how a host (orchd) restores a project whose server
 * runs as the container's main process: it cannot stop the server to run
 * `db import`, so it leaves the archive and starts the container.
 */
const CLI = join(process.cwd(), 'dist', 'cli.js')
const BUILT = existsSync(CLI)
const NATIVE_SUPPORTED =
  (process.platform === 'darwin' || process.platform === 'linux') && (process.arch === 'arm64' || process.arch === 'x64')

let server: ChildProcess | undefined

afterEach(async () => {
  server?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 2000))
  server?.kill('SIGKILL')
  server = undefined
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tb-restore-'))
  mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'supabase', 'migrations', '001_init.sql'), 'create table notes (id serial primary key, body text);')
  writeFileSync(join(dir, 'supabase', 'seed.sql'), "insert into notes (body) values ('seed');")
  return dir
}

const run = (dir: string, ...args: string[]) =>
  execFileSync('node', [CLI, ...args, '--dir', dir, '--engine', 'native'], { encoding: 'utf8', stdio: 'pipe' })

/** Start the server; resolve with its output once it serves, or reject when it exits first. */
function start(dir: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    server = spawn('node', [CLI, 'start', '--dir', dir, '--engine', 'native', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout!.on('data', (d) => (out += d))
    server.stderr!.on('data', (d) => (out += d))
    server.on('exit', (code) => reject(Object.assign(new Error(`exited ${code}`), { out })))
    const poll = async () => {
      for (let i = 0; i < 120; i++) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/rest/v1/`)).status > 0) return resolve(out)
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      reject(Object.assign(new Error('server did not come up'), { out }))
    }
    void poll()
  })
}

describe.skipIf(!BUILT || !NATIVE_SUPPORTED)('start restores .tinbase/restore.tar.gz', () => {
  it('loads the archive, removes it, and serves the restored data', { timeout: 240000 }, async () => {
    const dir = project()
    run(dir, 'migrate')
    run(dir, 'db', 'pristine') // opens the database once more; must stay pristine-capable
    const archive = join(dir, 'export.tar.gz')
    execFileSync('node', [
      CLI, 'db', 'export', '-o', archive, '--dir', dir, '--engine', 'native',
    ])
    // what orchd does: wipe the data directory, leave the archive, start
    rmSync(join(dir, '.tinbase', 'pgdata'), { recursive: true, force: true })
    renameSync(archive, join(dir, '.tinbase', 'restore.tar.gz'))

    const port = 54500 + Math.floor(process.pid % 200)
    const out = await start(dir, port)
    expect(out).toContain('restored')
    expect(existsSync(join(dir, '.tinbase', 'restore.tar.gz'))).toBe(false)

    const serviceRole = run(dir, 'keys').trim().split('\n').pop()!.trim()
    const res = await fetch(`http://127.0.0.1:${port}/rest/v1/notes?select=body`, {
      headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
    })
    expect(await res.json()).toEqual([{ body: 'seed' }])
  })

  it('refuses to start, and keeps the archive, when it does not load', { timeout: 240000 }, async () => {
    const dir = project()
    mkdirSync(join(dir, '.tinbase'), { recursive: true })
    writeFileSync(join(dir, '.tinbase', 'restore.tar.gz'), 'not an archive')
    const port = 54700 + Math.floor(process.pid % 200)
    const err = (await start(dir, port).then(
      () => null,
      (e) => e
    )) as { out?: string } | null
    expect(err).not.toBeNull()
    expect(err!.out).toContain('restore failed')
    expect(existsSync(join(dir, '.tinbase', 'restore.tar.gz'))).toBe(true)
  })
})
