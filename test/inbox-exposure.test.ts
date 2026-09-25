import { describe, expect, it } from 'vitest'
import { createBackend } from '../src/index.js'

/**
 * The dev inbox shows every captured message in full, including reset links and
 * OTP codes, and it has no authentication. That is right for local development
 * and wrong for anything a stranger can reach - the same distinction
 * enforceRedirectAllowList already makes, drawn on the same signal.
 */
describe('the dev inbox is not reachable from a network-exposed host', () => {
  it('serves /inbox on a loopback bind', async () => {
    const b = await createBackend({ jwtSecret: 'test-secret-at-least-32-characters-long' })
    try {
      const res = await b.fetch(new Request('http://127.0.0.1:54321/inbox'))
      expect(res.status).toBe(200)
    } finally {
      await b.close()
    }
  })

  it('does not serve /inbox when bound to a non-loopback host', async () => {
    const b = await createBackend({
      host: '0.0.0.0',
      jwtSecret: 'test-secret-at-least-32-characters-long',
    })
    try {
      const res = await b.fetch(new Request('https://db.example.dev/inbox'))
      expect(res.status, 'an unauthenticated view of every reset link must not be public').not.toBe(200)
    } finally {
      await b.close()
    }
  })

  it('still captures messages when exposed, so nothing silently stops working', async () => {
    const b = await createBackend({
      host: '0.0.0.0',
      jwtSecret: 'test-secret-at-least-32-characters-long',
    })
    try {
      const hdr = { 'content-type': 'application/json', apikey: b.anonKey }
      await b.fetch(new Request('https://db.example.dev/auth/v1/signup', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ email: 'captured@example.com', password: 'password123' }),
      }))
      await b.fetch(new Request('https://db.example.dev/auth/v1/recover', {
        method: 'POST', headers: hdr, body: JSON.stringify({ email: 'captured@example.com' }),
      }))
      // Reachable in-process (tests, an embedder), just not over HTTP.
      expect(b.inbox!.messages.length).toBeGreaterThan(0)
    } finally {
      await b.close()
    }
  })
})
