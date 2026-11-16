import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freePort, freshFetch } from './helpers.js'

/**
 * The wasm and pgmem engines cannot be opened by a second process - PGlite runs
 * in-process, pgmem holds the database in memory - so the process serving the
 * project is the only one that can reach it. Commands are routed through its admin
 * API rather than opening the database themselves.
 *
 * What used to happen was worse than the native engine's lock error:
 *
 * - wasm: `migrate` reported success while two PGlite instances wrote the same
 *   directory. The ledger recorded the migration as applied but its table was
 *   missing, and re-running `migrate` could never repair that, because the ledger
 *   already said applied. Only `db reset` recovered, losing the data.
 * - pgmem: `migrate` reported success against its own throwaway in-memory database,
 *   leaving the running server untouched. A no-op that claimed to have worked.
 *
 * `db reset` still refuses: it deletes the data directory, which is not something to
 * do under a live server whatever the engine.
 */
const CLI = join(process.cwd(), 'dist', 'cli.js')
const BUILT = existsSync(CLI)

/** Run expecting success; returns stdout. */
function ok(dir: string, engine: string, ...args: string[]): string {
  return execFileSync('node', [CLI, ...args, '--dir', dir, '--engine', engine], { encoding: 'utf8' })
}

/** Run expecting a non-zero exit; returns combined output. */
function failing(dir: string, engine: string, ...args: string[]): string {
  try {
    execFileSync('node', [CLI, ...args, '--dir', dir, '--engine', engine], { encoding: 'utf8', stdio: 'pipe' })
    return '__SUCCEEDED__'
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

for (const engine of ['wasm', 'pgmem'] as const) {
  describe.skipIf(!BUILT)(`cli against a running ${engine} server`, () => {
    let dir: string
    let server: ChildProcess | undefined
    let port: number

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), `tb-${engine}-`))
      mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
      writeFileSync(join(dir, 'supabase', 'migrations', '001_init.sql'), 'create table notes (id text primary key);')

      port = await freePort()
      server = spawn('node', [CLI, 'start', '--dir', dir, '--engine', engine, '--port', String(port)], {
        stdio: 'ignore',
      })
      for (let i = 0; i < 120; i++) {
        try {
          const res = await freshFetch(`http://127.0.0.1:${port}/rest/v1/`)
          if (res.status > 0) break
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      writeFileSync(join(dir, 'supabase', 'migrations', '002_add.sql'), 'create table tags (id text primary key);')
    }, 240000)

    afterAll(async () => {
      server?.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 2500))
      server?.kill('SIGKILL')
    })

    it('records that a server is running', () => {
      expect(existsSync(join(dir, '.tinbase', 'server.json'))).toBe(true)
    })

    it('migrate applies through the running server', { timeout: 120000 }, async () => {
      const out = ok(dir, engine, 'migrate')
      expect(out).toContain('using the server already running')
      expect(out).toContain('002_add')

      // The live server serves the new table straight away, which is the whole
      // point: previously the migration went to a database nobody was serving.
      const keys = ok(dir, engine, 'keys')
      const serviceRole = keys.trim().split('\n').pop()!.trim()
      const res = await freshFetch(`http://127.0.0.1:${port}/rest/v1/tags?select=*`, {
        headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
    })

    it('status reads the ledger through the server', { timeout: 120000 }, () => {
      const out = ok(dir, engine, 'status')
      expect(out).toContain('using the server already running')
      expect(out).toContain('001_init')
      expect(out).toContain('002_add')
    })

    it('inspect lists the tables through the server', { timeout: 120000 }, () => {
      const out = ok(dir, engine, 'inspect')
      expect(out).toContain('notes')
      expect(out).toContain('tags')
    })

    it('db reset still refuses, since it deletes the data directory', { timeout: 120000 }, () => {
      const out = failing(dir, engine, 'db', 'reset')
      expect(out).not.toBe('__SUCCEEDED__')
      expect(out).toContain('Cannot run db reset')
      expect(out).toContain(engine)
    })

    it('leaves the running server serving', { timeout: 120000 }, async () => {
      const res = await freshFetch(`http://127.0.0.1:${port}/rest/v1/`)
      expect(res.status).toBeGreaterThan(0)
    })
  })
}
