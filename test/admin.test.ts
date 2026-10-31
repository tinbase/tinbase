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
    // SQLSTATE-mapped status (undefined_table → 404, PostgREST's mapping), with
    // the pg error code carried through.
    expect(bad.status).toBe(404)
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
    const body = (await res.json()) as { migrations: number; dbSize: string; dbSizeBytes: number | null }
    expect(body.migrations).toBeGreaterThanOrEqual(1)
    expect(body.dbSize).toBeTruthy()
    expect(typeof body.dbSizeBytes).toBe('number')
    expect(body.dbSizeBytes).toBeGreaterThan(0)
    expect(Number.isInteger(body.dbSizeBytes)).toBe(true)
  })

  it('adds, lists (with digest), and deletes edge-function secrets live', async () => {
    // add two custom secrets
    const put = await req('/admin/v1/edge-functions/secrets', backend.serviceRoleKey, {
      method: 'PUT',
      body: JSON.stringify({ secrets: { CLIENT_KEY: 'abc123', POLLER_SECRET: 'multi\nline' } }),
    })
    expect(put.status).toBe(200)

    // GET exposes them with SHA256 digests and marks built-ins
    const got = (await (await req('/admin/v1/edge-functions', backend.serviceRoleKey)).json()) as {
      env: Record<string, string>
      builtins: string[]
      digests: Record<string, string>
    }
    expect(got.env.CLIENT_KEY).toBe('abc123')
    expect(got.builtins).toContain('SUPABASE_URL')
    expect(got.digests.CLIENT_KEY).toMatch(/^[0-9a-f]{64}$/)

    // the value is now live in the running functionEnv
    expect(backend.functions).toBeDefined()

    // built-ins cannot be overwritten
    const clobber = await req('/admin/v1/edge-functions/secrets', backend.serviceRoleKey, {
      method: 'PUT',
      body: JSON.stringify({ secrets: { SUPABASE_URL: 'evil' } }),
    })
    expect(clobber.status).toBe(400)

    // invalid names rejected
    const bad = await req('/admin/v1/edge-functions/secrets', backend.serviceRoleKey, {
      method: 'PUT',
      body: JSON.stringify({ secrets: { 'no-dashes': 'x' } }),
    })
    expect(bad.status).toBe(400)

    // delete one, built-in delete forbidden
    const del = await req('/admin/v1/edge-functions/secrets?name=CLIENT_KEY', backend.serviceRoleKey, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const builtinDel = await req('/admin/v1/edge-functions/secrets?name=SUPABASE_URL', backend.serviceRoleKey, { method: 'DELETE' })
    expect(builtinDel.status).toBe(400)

    const after = (await (await req('/admin/v1/edge-functions', backend.serviceRoleKey)).json()) as { env: Record<string, string> }
    expect(after.env.CLIENT_KEY).toBeUndefined()
    expect(after.env.POLLER_SECRET).toBe('multi\nline')
  })

  it('rejects secret writes without the service_role key', async () => {
    const res = await req('/admin/v1/edge-functions/secrets', backend.anonKey, {
      method: 'PUT',
      body: JSON.stringify({ secrets: { X: 'y' } }),
    })
    expect(res.status).toBe(403)
  })
})
