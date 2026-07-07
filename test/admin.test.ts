import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { TEST_MIGRATION, TEST_SEED } from './helpers.js'

let backend: TinbaseBackend

const req = (path: string, key: string, init: RequestInit = {}) =>
  backend.fetch(
    new Request(`http://localhost:54321${path}`, {
      ...init,
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    })
  )

beforeAll(async () => {
  backend = await createBackend({
    migrations: [{ name: '20240101000000_test_schema', sql: TEST_MIGRATION }],
    seedSql: TEST_SEED,
  })
})

afterAll(async () => {
  await backend.close()
})

describe('admin', () => {
  it('serves the dashboard at /_/', async () => {
    const res = await backend.fetch(new Request('http://localhost:54321/_/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('tinbase studio')
  })

  it('rejects the admin API without service_role', async () => {
    const res = await req('/admin/v1/stats', backend.anonKey)
    expect(res.status).toBe(403)
  })

  it('lists tables with columns and row counts', async () => {
    const res = await req('/admin/v1/tables', backend.serviceRoleKey)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tables: { name: string; rowCount: number; primaryKey: string[] }[] }
    const posts = body.tables.find((t) => t.name === 'posts')!
    expect(posts.rowCount).toBe(4)
    expect(posts.primaryKey).toEqual(['id'])
  })

  it('runs SQL and reports errors with pg fields', async () => {
    const ok = await req('/admin/v1/sql', backend.serviceRoleKey, {
      method: 'POST',
      body: JSON.stringify({ query: 'select count(*)::int as n from posts' }),
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { rows: { n: number }[] }).rows[0].n).toBe(4)

    const bad = await req('/admin/v1/sql', backend.serviceRoleKey, {
      method: 'POST',
      body: JSON.stringify({ query: 'select * from nope' }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { code: string }).code).toBe('42P01')
  })

  it('lists, creates, and drops RLS policies', async () => {
    // secrets table has RLS enabled with a policy in the test schema
    const list = await req('/admin/v1/policies', backend.serviceRoleKey)
    const body = (await list.json()) as { policies: { table: string; name: string }[] }
    expect(body.policies.some((p) => p.table === 'secrets')).toBe(true)

    const created = await req('/admin/v1/policies', backend.serviceRoleKey, {
      method: 'POST',
      body: JSON.stringify({ table: 'secrets', name: 'admin_temp', command: 'SELECT', roles: 'authenticated', using: 'true' }),
    })
    expect(created.status).toBe(200)

    const drop = await req('/admin/v1/policies?table=secrets&name=admin_temp', backend.serviceRoleKey, { method: 'DELETE' })
    expect(drop.status).toBe(200)
  })

  it('lists functions and triggers', async () => {
    const fns = (await (await req('/admin/v1/functions', backend.serviceRoleKey)).json()) as { functions: any[] }
    expect(fns.functions.some((f) => f.name === 'add_numbers')).toBe(true)

    const trg = (await (await req('/admin/v1/triggers', backend.serviceRoleKey)).json()) as { triggers: any[] }
    expect(Array.isArray(trg.triggers)).toBe(true)
  })

  it('returns stats', async () => {
    const res = await req('/admin/v1/stats', backend.serviceRoleKey)
    const body = (await res.json()) as { migrations: number; dbSize: string }
    expect(body.migrations).toBeGreaterThanOrEqual(1)
    expect(body.dbSize).toBeTruthy()
  })
})
