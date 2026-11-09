import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBackend } from '../src/index.js'
import { checkPristine } from '../src/db/pristine.js'
import { createNativeEngine } from '../src/node/native/engine.js'
import { exportProject, importProject, readManifest, rolesSql } from '../src/node/native/dump.js'

const NATIVE_SUPPORTED =
  (process.platform === 'darwin' || process.platform === 'linux') && (process.arch === 'arm64' || process.arch === 'x64')

const MIGRATION = {
  name: '20240101000000_items',
  sql: `create table items (id serial primary key, name text);
        alter table items enable row level security;
        create policy "read items" on items for select using (true);`,
}
const SEED = `insert into items (name) values ('a'), ('b');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'demo@example.com');`

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'tb-dump-'))
  return { root, dataDir: join(root, 'pgdata'), storageDir: join(root, 'storage') }
}

async function open(dataDir: string, migrations = [MIGRATION], seedSql: string | undefined = SEED) {
  return createBackend({ engine: await createNativeEngine({ dataDir }), migrations, seedSql })
}

describe('rolesSql', () => {
  it('drops only the bootstrap superuser a new cluster already has', () => {
    const out = rolesSql('CREATE ROLE anon;\nCREATE ROLE postgres;\nALTER ROLE postgres WITH SUPERUSER;\n')
    expect(out).toBe('CREATE ROLE anon;\nALTER ROLE postgres WITH SUPERUSER;\n')
  })
})

describe.skipIf(!NATIVE_SUPPORTED)('seed snapshot', () => {
  it('is pristine after migrations and seed, and stays so as more of the files apply', { timeout: 120000 }, async () => {
    const { dataDir } = dirs()
    const backend = await open(dataDir)
    try {
      const engine = backend.db.engine
      expect(await checkPristine(engine)).toEqual({ pristine: true, state: 'pristine' })

      await backend.migrate([MIGRATION, { name: '20240102000000_more', sql: `create table tags (id int primary key)` }])
      expect((await checkPristine(engine)).pristine).toBe(true)

      // signing in touches auth.users and sessions; that is not data worth keeping
      await engine.query(`update auth.users set last_sign_in_at = now(), updated_at = now()`)
      expect((await checkPristine(engine)).pristine).toBe(true)
    } finally {
      await backend.close()
    }
  })

  it('diverges for good once something other than the files writes', { timeout: 120000 }, async () => {
    const { dataDir } = dirs()
    const backend = await open(dataDir)
    try {
      const engine = backend.db.engine
      await engine.query(`insert into items (name) values ('mine')`)
      const s = await checkPristine(engine)
      expect(s.pristine).toBe(false)
      expect(s.reason).toBe('public.items has 3 rows, was 2')

      // later migrations must not launder the user's row into the baseline
      await backend.migrate([MIGRATION, { name: '20240102000000_more', sql: `create table tags (id int primary key)` }])
      await engine.query(`delete from items where name = 'mine'`)
      expect((await checkPristine(engine)).state).toBe('diverged')
    } finally {
      await backend.close()
    }
  })

  it('counts a new account, an upload and schema changed outside migrations', { timeout: 120000 }, async () => {
    for (const write of [
      `insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000002', 'real@example.com')`,
      `insert into storage.buckets (id, name) values ('avatars', 'avatars')`,
      `alter table items add column note text`,
    ]) {
      const { dataDir } = dirs()
      const backend = await open(dataDir)
      try {
        await backend.db.engine.query(write)
        expect((await checkPristine(backend.db.engine)).pristine, write).toBe(false)
      } finally {
        await backend.close()
      }
    }
  })

  it('marks a database that held data before snapshots existed as diverged', { timeout: 120000 }, async () => {
    const { dataDir } = dirs()
    const first = await open(dataDir)
    await first.db.engine.exec(`drop table tinbase.seed_snapshot`)
    await first.close()

    const again = await open(dataDir)
    try {
      const s = await checkPristine(again.db.engine)
      expect(s.state).toBe('diverged')
      expect(s.reason).toMatch(/existed before/)
    } finally {
      await again.close()
    }
  })
})

describe.skipIf(!NATIVE_SUPPORTED)('db export / import', () => {
  it('round-trips data, accounts, stored files and the snapshot state', { timeout: 180000 }, async () => {
    const src = dirs()
    const backend = await open(src.dataDir)
    await backend.db.engine.query(`insert into items (name) values ('kept')`)
    await backend.close()
    mkdirSync(join(src.storageDir, 'avatars'), { recursive: true })
    writeFileSync(join(src.storageDir, 'avatars', 'me.png'), 'png-bytes')

    // no server running: export starts postgres for itself
    const archive = join(src.root, 'export.tar.gz')
    const { bytes, manifest } = await exportProject({ dataDir: src.dataDir, storageDir: src.storageDir, outFile: archive })
    expect(bytes).toBeGreaterThan(0)
    expect(bytes).toBeLessThan(200_000)
    expect(manifest.pristine.state).toBe('diverged')
    expect((await readManifest(archive)).createdAt).toBe(manifest.createdAt)

    const dst = dirs()
    await importProject({ dataDir: dst.dataDir, storageDir: dst.storageDir, file: archive })
    expect(readFileSync(join(dst.storageDir, 'avatars', 'me.png'), 'utf8')).toBe('png-bytes')

    const restored = await open(dst.dataDir)
    try {
      const engine = restored.db.engine
      const rows = await engine.query<{ name: string }>(`select name from items order by id`)
      expect(rows.rows.map((r) => r.name)).toEqual(['a', 'b', 'kept'])
      const users = await engine.query<{ email: string }>(`select email from auth.users`)
      expect(users.rows.map((r) => r.email)).toEqual(['demo@example.com'])
      // roles came back, so RLS policies granted to them still resolve
      const pol = await engine.query(`select 1 from pg_policies where tablename = 'items'`)
      expect(pol.rows.length).toBe(1)
      expect((await checkPristine(engine)).state).toBe('diverged')
      // migrations are recorded, so a restart re-applies nothing
      expect(await restored.migrate([MIGRATION], SEED)).toEqual([])
    } finally {
      await restored.close()
    }
  })

  it('hashes the same contents the same, and a write differently', { timeout: 180000 }, async () => {
    const src = dirs()
    const backend = await open(src.dataDir)
    try {
      const out = (n: number) => join(src.root, `e${n}.tar.gz`)
      const a = await exportProject({ dataDir: src.dataDir, storageDir: src.storageDir, outFile: out(1) })
      const b = await exportProject({ dataDir: src.dataDir, storageDir: src.storageDir, outFile: out(2) })
      expect(a.manifest.contentHash).toMatch(/^[0-9a-f]{64}$/)
      expect(b.manifest.contentHash).toBe(a.manifest.contentHash)

      await backend.db.engine.query(`insert into items (name) values ('new')`)
      const c = await exportProject({ dataDir: src.dataDir, storageDir: src.storageDir, outFile: out(3) })
      expect(c.manifest.contentHash).not.toBe(a.manifest.contentHash)

      mkdirSync(src.storageDir, { recursive: true })
      writeFileSync(join(src.storageDir, 'f.txt'), 'x')
      const d = await exportProject({ dataDir: src.dataDir, storageDir: src.storageDir, outFile: out(4) })
      expect(d.manifest.contentHash).not.toBe(c.manifest.contentHash)
    } finally {
      await backend.close()
    }
  })

  it('exports from a running server and keeps a pristine database pristine', { timeout: 180000 }, async () => {
    const src = dirs()
    const backend = await open(src.dataDir)
    const archive = join(src.root, 'export.tar.gz')
    try {
      const { manifest } = await exportProject({ dataDir: src.dataDir, storageDir: src.storageDir, outFile: archive })
      expect(manifest.pristine).toEqual({ pristine: true, state: 'pristine' })
      // the server is untouched and still serving
      expect((await backend.db.engine.query(`select count(*)::int as n from items`)).rows[0].n).toBe(2)
    } finally {
      await backend.close()
    }

    const dst = dirs()
    await importProject({ dataDir: dst.dataDir, storageDir: dst.storageDir, file: archive })
    const restored = await open(dst.dataDir)
    try {
      expect((await checkPristine(restored.db.engine)).pristine).toBe(true)
    } finally {
      await restored.close()
    }
  })

  it('refuses to import over a database unless forced', { timeout: 180000 }, async () => {
    const src = dirs()
    const backend = await open(src.dataDir)
    await backend.close()
    const archive = join(src.root, 'export.tar.gz')
    await exportProject({ dataDir: src.dataDir, storageDir: src.storageDir, outFile: archive })

    await expect(importProject({ dataDir: src.dataDir, storageDir: src.storageDir, file: archive })).rejects.toThrow(
      /already holds a database/
    )
    await importProject({ dataDir: src.dataDir, storageDir: src.storageDir, file: archive, force: true })
    expect(existsSync(join(src.dataDir, 'PG_VERSION'))).toBe(true)
  })

  it('leaves the existing database alone when a forced import fails', { timeout: 180000 }, async () => {
    const src = dirs()
    const backend = await open(src.dataDir)
    await backend.db.engine.query(`insert into items (name) values ('precious')`)
    await backend.close()
    mkdirSync(src.storageDir, { recursive: true })
    writeFileSync(join(src.storageDir, 'keep.txt'), 'keep')

    await expect(
      importProject({ dataDir: src.dataDir, storageDir: src.storageDir, file: join(src.root, 'missing.tar.gz'), force: true })
    ).rejects.toThrow()

    // an archive whose dump does not load
    const bad = join(src.root, 'bad')
    mkdirSync(join(bad, 'storage'), { recursive: true })
    writeFileSync(join(bad, 'manifest.json'), JSON.stringify({ format: 'tinbase-dump', version: 1 }))
    writeFileSync(join(bad, 'globals.sql'), '')
    writeFileSync(join(bad, 'dump.sql'), 'this is not sql;')
    const { execFileSync } = await import('node:child_process')
    execFileSync('tar', ['-czf', join(src.root, 'bad.tar.gz'), '-C', bad, '.'])
    await expect(
      importProject({ dataDir: src.dataDir, storageDir: src.storageDir, file: join(src.root, 'bad.tar.gz'), force: true })
    ).rejects.toThrow()

    expect(readFileSync(join(src.storageDir, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(`${src.dataDir}.importing`)).toBe(false)
    const again = await open(src.dataDir)
    try {
      const rows = await again.db.engine.query<{ name: string }>(`select name from items order by id`)
      expect(rows.rows.map((r) => r.name)).toEqual(['a', 'b', 'precious'])
    } finally {
      await again.close()
    }
  })

  it('rejects an archive that is not a tinbase export', { timeout: 60000 }, async () => {
    const d = dirs()
    mkdirSync(join(d.root, 'junk'))
    writeFileSync(join(d.root, 'junk', 'manifest.json'), '{"format":"other"}')
    const { execFileSync } = await import('node:child_process')
    const archive = join(d.root, 'junk.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', join(d.root, 'junk'), '.'])
    await expect(importProject({ dataDir: d.dataDir, storageDir: d.storageDir, file: archive })).rejects.toThrow(
      /not a tinbase export/
    )
    expect(existsSync(d.dataDir)).toBe(false)
  })
})
