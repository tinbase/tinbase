import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

/**
 * Server log buffer + /admin/v1/logs (the Studio Logs pane's data source):
 * captures HTTP requests and internal events (mail, webhooks, migrations),
 * readable only with the service_role key.
 */
let env: TestEnv
const url = (p: string) => `http://localhost:54321${p}`

beforeAll(async () => {
  env = await createTestEnv()
})
afterAll(async () => {
  await env.close()
})

describe('server logs', () => {
  it('exposes a log buffer on the backend', () => {
    expect(env.backend.logs).toBeTruthy()
    expect(typeof env.backend.logs.list).toBe('function')
  })

  it('captures HTTP requests', async () => {
    env.backend.logs.clear()
    await env.supabase.from('categories').select('*').limit(1)
    const lines = env.backend.logs.list().map((l) => l.msg)
    expect(lines.some((m) => m.includes('/rest/v1/categories') && m.includes('→'))).toBe(true)
  })

  it('captures internal events (a sent email)', async () => {
    env.backend.logs.clear()
    await env.supabase.auth.signInWithOtp({ email: `log-${Date.now()}@example.com` })
    expect(env.backend.logs.list().some((l) => l.msg.startsWith('[mail]'))).toBe(true)
  })

  it('serves logs to the service_role and forbids anon', async () => {
    const ok = await env.backend.fetch(
      new Request(url('/admin/v1/logs'), {
        headers: { apikey: env.backend.serviceRoleKey, authorization: `Bearer ${env.backend.serviceRoleKey}` },
      })
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { logs: { msg: string }[] }
    expect(Array.isArray(body.logs)).toBe(true)

    const denied = await env.backend.fetch(
      new Request(url('/admin/v1/logs'), {
        headers: { apikey: env.backend.anonKey, authorization: `Bearer ${env.backend.anonKey}` },
      })
    )
    expect(denied.status).toBe(403)
  })
})
