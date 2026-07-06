import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'

// Supabase enables uuid-ossp, pgcrypto, citext, etc. by default; real
// migrations call these unqualified. Regression guard for both engines.
const MIGRATION = `
create table widgets (
  id uuid primary key default uuid_generate_v4(),
  code citext unique,
  token text default encode(gen_random_bytes(8), 'hex'),
  hashed text default crypt('secret', gen_salt('bf'))
);
`

let backend: TinbaseBackend

beforeAll(async () => {
  let engine
  if (process.env.TINBASE_TEST_ENGINE === 'native') {
    const { createNativeEngine } = await import('../src/node/native/engine.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    engine = await createNativeEngine({ dataDir: join(mkdtempSync(join(tmpdir(), 'tinbase-ext-')), 'pg') })
  }
  backend = await createBackend({ engine, migrations: [{ name: '20240101000000_widgets', sql: MIGRATION }] })
})

afterAll(async () => {
  await backend.close()
})

describe('default extensions', () => {
  it('uuid_generate_v4() resolves unqualified in migrations', async () => {
    const res = await backend.db.query<{ id: string }>(
      `insert into widgets (code) values ('ABC') returning id`
    )
    expect(res.rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('citext columns are case-insensitive', async () => {
    const res = await backend.db.query(`select * from widgets where code = 'abc'`)
    expect(res.rows.length).toBe(1)
  })

  it('pgcrypto functions (crypt, gen_random_bytes) are available', async () => {
    const res = await backend.db.query<{ token: string; hashed: string }>(`select token, hashed from widgets`)
    expect(res.rows[0].token).toMatch(/^[0-9a-f]{16}$/)
    expect(res.rows[0].hashed.startsWith('$2')).toBe(true)
  })
})
