import { describe, expect, it } from 'vitest'
import { createBackend, type MailMessage } from '../src/index.js'

/**
 * A short code is a credential only together with the address it was sent to.
 * These cover the shape of the check rather than the wording of the error: what
 * matters is that no session comes back.
 */
describe('verify: a guessable code must be scoped to its owner', () => {
  const boot = async () => {
    const outbox: MailMessage[] = []
    const b = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      siteUrl: 'https://db.example.dev',
      jwtSecret: 'test-secret-at-least-32-characters-long',
    })
    return { b, outbox, hdr: { 'content-type': 'application/json', apikey: b.anonKey } }
  }

  it('refuses a recovery code presented without its email', async () => {
    const { b, hdr } = await boot()
    try {
      await b.fetch(new Request('https://db.example.dev/auth/v1/signup', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ email: 'victim@example.com', password: 'password123' }),
      }))
      await b.fetch(new Request('https://db.example.dev/auth/v1/recover', {
        method: 'POST', headers: hdr, body: JSON.stringify({ email: 'victim@example.com' }),
      }))
      const r = await b.db.query(
        `select token from auth.one_time_tokens where email = 'victim@example.com' and token_type = 'recovery'`
      )
      const code = (r.rows as { token: string }[]).map((x) => x.token).find((t) => /^\d{6}$/.test(t))
      expect(code, 'a 6-digit recovery code is minted alongside the link').toBeTruthy()

      const res = await b.fetch(new Request('https://db.example.dev/auth/v1/verify', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ token: code, type: 'recovery' }), // no email
      }))
      expect(res.status).not.toBe(200)
      expect(await res.json()).not.toHaveProperty('access_token')
    } finally {
      await b.close()
    }
  })

  it('still accepts that code when the email scopes it', async () => {
    const { b, hdr } = await boot()
    try {
      await b.fetch(new Request('https://db.example.dev/auth/v1/signup', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ email: 'owner@example.com', password: 'password123' }),
      }))
      await b.fetch(new Request('https://db.example.dev/auth/v1/recover', {
        method: 'POST', headers: hdr, body: JSON.stringify({ email: 'owner@example.com' }),
      }))
      const r = await b.db.query(
        `select token from auth.one_time_tokens where email = 'owner@example.com' and token_type = 'recovery'`
      )
      const code = (r.rows as { token: string }[]).map((x) => x.token).find((t) => /^\d{6}$/.test(t))!
      const res = await b.fetch(new Request('https://db.example.dev/auth/v1/verify', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ email: 'owner@example.com', token: code, type: 'recovery' }),
      }))
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveProperty('access_token')
    } finally {
      await b.close()
    }
  })

  it('burns the code after five wrong guesses, now that every guess carries an email', async () => {
    // The lockout existed before but could not fire: attempts only increment on
    // the scoped branch, and an unscoped guess never reached it. With scoping
    // required, five wrong tries actually burn the code.
    const { b, hdr } = await boot()
    try {
      await b.fetch(new Request('https://db.example.dev/auth/v1/signup', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ email: 'locked@example.com', password: 'password123' }),
      }))
      await b.fetch(new Request('https://db.example.dev/auth/v1/recover', {
        method: 'POST', headers: hdr, body: JSON.stringify({ email: 'locked@example.com' }),
      }))
      const r = await b.db.query(
        `select token from auth.one_time_tokens where email = 'locked@example.com' and token_type = 'recovery'`
      )
      const code = (r.rows as { token: string }[]).map((x) => x.token).find((t) => /^\d{6}$/.test(t))!
      const wrong = code === '000000' ? '111111' : '000000'

      for (let i = 0; i < 5; i++) {
        const bad = await b.fetch(new Request('https://db.example.dev/auth/v1/verify', {
          method: 'POST', headers: hdr,
          body: JSON.stringify({ email: 'locked@example.com', token: wrong, type: 'recovery' }),
        }))
        expect(bad.status).not.toBe(200)
      }

      const res = await b.fetch(new Request('https://db.example.dev/auth/v1/verify', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ email: 'locked@example.com', token: code, type: 'recovery' }),
      }))
      expect(res.status, 'the real code is dead once the cap is hit').not.toBe(200)
    } finally {
      await b.close()
    }
  })

  it('accepts a link token when the client sends an empty email alongside it', async () => {
    // `email: ''` is absent, not an address to match on. Treating it as one
    // filters on `email = ''`, which matches nothing, and a perfectly good link
    // token is refused.
    const { b, outbox, hdr } = await boot()
    try {
      await b.fetch(new Request('https://db.example.dev/auth/v1/signup', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ email: 'blank@example.com', password: 'password123' }),
      }))
      await b.fetch(new Request('https://db.example.dev/auth/v1/recover', {
        method: 'POST', headers: hdr, body: JSON.stringify({ email: 'blank@example.com' }),
      }))
      const link = outbox[outbox.length - 1].text.match(/token=([^&\s]+)/)?.[1]
      const res = await b.fetch(new Request('https://db.example.dev/auth/v1/verify', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ token_hash: link, type: 'recovery', email: '' }),
      }))
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveProperty('access_token')
    } finally {
      await b.close()
    }
  })

  it('leaves the emailed link working, which carries no email of its own', async () => {
    const { b, outbox, hdr } = await boot()
    try {
      await b.fetch(new Request('https://db.example.dev/auth/v1/signup', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ email: 'link@example.com', password: 'password123' }),
      }))
      await b.fetch(new Request('https://db.example.dev/auth/v1/recover', {
        method: 'POST', headers: hdr, body: JSON.stringify({ email: 'link@example.com' }),
      }))
      const link = outbox[outbox.length - 1].text.match(/(https?:\S+verify\S+)/)?.[1]
      const res = await b.fetch(new Request(link!, { redirect: 'manual' }))
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toContain('#access_token=')
    } finally {
      await b.close()
    }
  })
})
