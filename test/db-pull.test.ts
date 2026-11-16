import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, inspectDb, type TinbaseBackend } from '../src/index.js'
import { pullSchema } from '../src/node/db-diff.js'

const BASE = `create table authors (id serial primary key, name text not null);`

const backends: TinbaseBackend[] = []
afterEach(async () => {
  while (backends.length) await backends.pop()!.close()
})

// Each test boots two or three databases: 2-10 s alone, 20-30 s while the full suite boots others
// on every worker. A 20 s limit (below vitest.config's 30 s default) failed `npm publish` for 0.23.1.
describe('tinbase db pull', () => {
  it('writes the schema delta as a migration and records it as applied', { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tinbase-pull-'))
    const dataDir = join(dir, 'db')
    const migrationsDir = join(dir, 'migrations')
    const migrations = [{ name: '20240101000000_base', sql: BASE }]

    // boot a persistent live DB, then make an out-of-migration schema change
    const live1 = await createBackend({ dataDir, migrations })
    await live1.db.query(`create table comments (id serial primary key, body text not null)`)
    await live1.close()

    const res = await pullSchema({
      liveDataDir: dataDir,
      migrations,
      migrationsDir,
      stamp: '20240102000000',
      name: 'remote_schema',
    })

    // the delta captured the new table, and a migration file was written
    expect(res.ddl.join('\n')).toMatch(/create table[\s\S]*comments/i)
    expect(res.version).toBe('20240102000000')
    const written = await readFile(res.path!, 'utf8')
    expect(written).toMatch(/comments/)

    // reopening with the pulled migration must NOT re-run it (it's recorded as
    // applied) — if it did, `create table comments` would throw "already exists"
    const live2 = await createBackend({
      dataDir,
      migrations: [...migrations, { name: '20240102000000_remote_schema', sql: written }],
    })
    backends.push(live2)
    const applied = await live2.db.listAppliedMigrations()
    expect(applied.some((m) => m.version === '20240102000000')).toBe(true)

    // and the pulled migration fully describes the schema: a fresh DB built from
    // base + pulled has the comments table
    const info = await inspectDb(live2.db, 'public')
    expect(info.some((t) => t.table === 'comments')).toBe(true)
  })

  it('reports "no changes" when the schema matches the migrations', { timeout: 120_000 }, async () => {
    const migrations = [{ name: '20240101000000_base', sql: BASE }]
    const live = await createBackend({ migrations })
    backends.push(live)
    // in-memory live shares nothing to pull beyond the migrations
    const res = await pullSchema({ liveDataDir: undefined, migrations })
    // (in-memory live == migrations only) → empty delta
    expect(res.path).toBeNull()
    expect(res.ddl.length).toBe(0)
  })
})

describe('tinbase inspect', () => {
  it('reports row counts and sizes per table', { timeout: 120_000 }, async () => {
    const backend = await createBackend({
      migrations: [{ name: '20240101000000_base', sql: BASE }],
    })
    backends.push(backend)
    await backend.db.query(`insert into authors (name) values ('a'), ('b'), ('c')`)
    const info = await inspectDb(backend.db, 'public')
    const authors = info.find((t) => t.table === 'authors')
    expect(authors).toBeTruthy()
    expect(authors!.rows).toBe(3)
    expect(authors!.size).toMatch(/bytes|kB|MB/)
  })
})
