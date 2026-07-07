import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

/**
 * Local email inbox: with no custom mailer, auth emails (OTP, magic link,
 * recovery) are captured in memory and served at /inbox — the tinbase
 * equivalent of Supabase local's Inbucket. Verified via backend.inbox and the
 * JSON/HTML routes.
 */
let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

describe('local email inbox', () => {
  it('exposes an inbox when using the default mailer', () => {
    expect(env.backend.inbox).not.toBeNull()
  })

  it('captures a magic-link/OTP email with an extractable code and link', async () => {
    env.backend.inbox!.clear()
    const email = `inbox-${Date.now()}@example.com`
    const { error } = await env.supabase.auth.signInWithOtp({ email })
    expect(error).toBeNull()

    const msgs = env.backend.inbox!.list()
    expect(msgs.length).toBe(1)
    expect(msgs[0].to).toBe(email)
    expect(msgs[0].subject).toBe('Your login code')
    expect(msgs[0].code).toMatch(/^\d{6}$/)
    expect(msgs[0].link).toContain('/auth/v1/verify?token=')
  })

  it('serves the captured message over the JSON API', async () => {
    const res = await env.backend.fetch(new Request('http://localhost:54321/inbox/api/messages'))
    expect(res.status).toBe(200)
    const { messages } = (await res.json()) as { messages: { subject: string }[] }
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages[0].subject).toBe('Your login code')
  })

  it('serves the inbox HTML page and supports clearing', async () => {
    const page = await env.backend.fetch(new Request('http://localhost:54321/inbox'))
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('Inbox')

    const del = await env.backend.fetch(new Request('http://localhost:54321/inbox/api/messages', { method: 'DELETE' }))
    expect(del.status).toBe(204)
    expect(env.backend.inbox!.list().length).toBe(0)
  })
})
