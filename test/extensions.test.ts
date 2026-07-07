import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'

/**
 * Supabase enables uuid-ossp, pgcrypto, citext, etc. by default and real
 * migrations call these unqualified. tinbase guarantees uuid_generate_v4()
 * on every engine/platform (via the real extension, or a gen_random_uuid()
 * shim when uuid-ossp's system lib isn't loadable — e.g. the theseus Linux
 * binary has no libuuid). Other extensions are asserted only when the engine
 * actually loaded them, since native availability is platform-dependent.
 */
let backend: TinbaseBackend
let loaded = new Set<string>()

beforeAll(async () => {
  let engine
  if (process.env.TINBASE_TEST_ENGINE === 'native') {
    const { createNativeEngine } = await import('../src/node/native/engine.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    engine = await createNativeEngine({ dataDir: join(mkdtempSync(join(tmpdir(), 'tinbase-ext-')), 'pg') })
  }
  // uuid_generate_v4() is guaranteed on every engine/platform
  backend = await createBackend({
    engine,
    migrations: [
      { name: '20240101000000_uuid', sql: `create table w (id uuid primary key default uuid_generate_v4(), n int)` },
    ],
  })
  const ext = await backend.db.query<{ extname: string }>(`select extname from pg_extension`)
  loaded = new Set(ext.rows.map((r) => r.extname))
})

afterAll(async () => {
  await backend?.close()
})

describe('default extensions', () => {
  it('uuid_generate_v4() resolves unqualified in migrations (always)', async () => {
    const res = await backend.db.query<{ id: string }>(`insert into w (n) values (1) returning id`)
    expect(res.rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('citext is case-insensitive when loaded', async () => {
    if (!loaded.has('citext')) return // not available in this engine build
    await backend.db.query(`create table ci (code citext unique)`)
    await backend.db.query(`insert into ci (code) values ('ABC')`)
    const res = await backend.db.query(`select * from ci where code = 'abc'`)
    expect(res.rows.length).toBe(1)
  })

  it('pgcrypto functions work when loaded', async () => {
    if (!loaded.has('pgcrypto')) return
    const res = await backend.db.query<{ tok: string; h: string }>(
      `select encode(gen_random_bytes(8), 'hex') as tok, crypt('secret', gen_salt('bf')) as h`
    )
    expect(res.rows[0].tok).toMatch(/^[0-9a-f]{16}$/)
    expect(res.rows[0].h.startsWith('$2')).toBe(true)
  })
})
