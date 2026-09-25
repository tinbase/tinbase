import { describe, expect, it } from 'vitest'
import { createBackend, type MailMessage, type TinbaseBackend } from '../src/index.js'
import { DEFAULT_AUTH_RATE_LIMITS, type RateLimitRule } from '../src/auth/rate-limit.js'

/**
 * What bounds guessing a one-time code.
 *
 * Scoping a code to its address (see verify-token-scope.test.ts) is what stops
 * one guess from being tried against every account at once. These cover the two
 * limits that stand behind it: the per-address attempt cap, which only became
 * reachable once a code had to carry its email, and the rate limit on the
 * endpoint itself, whose config key existed with nothing reading it.
 */

const HDR = (b: TinbaseBackend) => ({ 'content-type': 'application/json', apikey: b.anonKey })

async function boot(authRateLimits?: Record<string, RateLimitRule>) {
  const outbox: MailMessage[] = []
  const backend = await createBackend({
    mailer: { send: async (m) => void outbox.push(m) },
    ...(authRateLimits ? { authRateLimits } : {}),
  })
  const post = (path: string, body: unknown) =>
    backend.fetch(
      new Request(`http://localhost:54321/auth/v1/${path}`, {
        method: 'POST',
        headers: HDR(backend),
        body: JSON.stringify(body),
      })
    )
  return { backend, outbox, post }
}

/** The 6-digit login code, read from the table rather than parsed out of the mail. */
async function loginCodeFor(backend: TinbaseBackend, email: string): Promise<string> {
  const res = await backend.db.query(
    `select token from auth.one_time_tokens where email = $1 and token_type = 'otp' and token ~ '^[0-9]{6}$'`,
    [email]
  )
  return (res.rows[0] as { token: string }).token
}

describe('verify: the per-address attempt cap', () => {
  it('burns the code after five wrong guesses, so the real one no longer works', async () => {
    const { backend, post } = await boot()
    try {
      await post('otp', { email: 'capped@example.com' })
      const code = await loginCodeFor(backend, 'capped@example.com')

      // Wrong guesses, each carrying the address - which is the only way to
      // guess at all now, and therefore the only way the counter ever moves.
      for (let i = 0; i < 5; i++) {
        const wrong = await post('verify', { email: 'capped@example.com', token: '000000', type: 'email' })
        expect(wrong.status).toBe(403)
      }

      // The cap is on the code, not on the guess: the correct one is gone too.
      const real = await post('verify', { email: 'capped@example.com', token: code, type: 'email' })
      expect(real.status).toBe(403)
      expect(await real.json()).not.toHaveProperty('access_token')

      const left = await backend.db.query(`select 1 from auth.one_time_tokens where email = $1`, [
        'capped@example.com',
      ])
      expect(left.rows.length, 'the cap deletes the tokens rather than leaving them to expire').toBe(0)
    } finally {
      await backend.close()
    }
  })

  it('does not let an unscoped guess burn someone else’s code', async () => {
    const { backend, post } = await boot()
    try {
      await post('otp', { email: 'untouched@example.com' })
      const code = await loginCodeFor(backend, 'untouched@example.com')

      // Refused before the query, so these cost the victim nothing. Were they
      // counted, anyone could lock any address out of its own code by guessing
      // at the whole table - a denial of service that needs no knowledge of who
      // they are guessing against.
      for (let i = 0; i < 10; i++) {
        const blind = await post('verify', { token: '000000' })
        expect(blind.status).toBe(403)
      }

      const real = await post('verify', { email: 'untouched@example.com', token: code, type: 'email' })
      expect(real.status).toBe(200)
      expect(await real.json()).toHaveProperty('access_token')
    } finally {
      await backend.close()
    }
  })
})

describe('verify: the endpoint rate limit', () => {
  it('carries a default, matching what Supabase calls token_verifications', () => {
    expect(DEFAULT_AUTH_RATE_LIMITS.verify).toEqual({ limit: 30, windowMs: 5 * 60 * 1000 })
  })

  it('answers 429 over_request_rate_limit once the window is spent', async () => {
    // A small window makes the boundary the subject of the test rather than a
    // thousand requests; the default is asserted above.
    const { backend, post } = await boot({ verify: { limit: 3, windowMs: 60_000 } })
    try {
      for (let i = 0; i < 3; i++) {
        expect((await post('verify', { email: 'rl@example.com', token: '000000', type: 'email' })).status).toBe(403)
      }
      const limited = await post('verify', { email: 'rl@example.com', token: '000000', type: 'email' })
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBeTruthy()
      expect(await limited.json()).toMatchObject({ error_code: 'over_request_rate_limit' })
    } finally {
      await backend.close()
    }
  })

  it('still lets the emailed link through, which is not a guessing surface', async () => {
    const { backend, outbox, post } = await boot({ verify: { limit: 1, windowMs: 60_000 } })
    try {
      await post('otp', { email: 'linkstillworks@example.com' })
      const link = outbox[outbox.length - 1].text.match(/(https?:\S+verify\S+)/)?.[1]
      expect(link).toBeTruthy()

      // Spend the POST budget, then click the link: the GET path carries 24
      // random bytes, so it is deliberately not throttled alongside the codes.
      await post('verify', { email: 'linkstillworks@example.com', token: '000000', type: 'email' })
      await post('verify', { email: 'linkstillworks@example.com', token: '000000', type: 'email' })

      const res = await backend.fetch(new Request(link!, { redirect: 'manual' }))
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toContain('#access_token=')
    } finally {
      await backend.close()
    }
  })
})
