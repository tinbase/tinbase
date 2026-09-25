import { describe, expect, it } from 'vitest'
import { createBackend, type MailMessage } from '../src/index.js'

/**
 * POST /auth/v1/resend - repeat a confirmation the address has already been
 * sent. It used to alias /magiclink, which is a different email entirely.
 */
describe('/auth/v1/resend', () => {
  const boot = async () => {
    const outbox: MailMessage[] = []
    const backend = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      authSettings: { autoconfirm: false, maxEmailFrequencySeconds: 60 },
    })
    const post = (path: string, body: unknown) =>
      backend.fetch(
        new Request(`http://localhost:54321/auth/v1/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: backend.anonKey },
          body: JSON.stringify(body),
        })
      )
    const users = (email: string) => backend.db.query(`select id from auth.users where email = $1`, [email])
    return { backend, outbox, post, users }
  }

  it('does not sign up an address it has never seen', async () => {
    // The old alias ran the magic-link flow, which creates the user when it
    // has no account - so a resend for a stranger's address enrolled them and
    // mailed them a way in.
    const { backend, outbox, post, users } = await boot()
    try {
      const res = await post('resend', { type: 'signup', email: 'stranger@example.com' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({})
      expect(outbox.length, 'no mail to an address with no account').toBe(0)
      expect((await users('stranger@example.com')).rows.length, 'and no account created').toBe(0)
    } finally {
      await backend.close()
    }
  })

  it('answers an already-confirmed address exactly the same way', async () => {
    // Identical to the unknown-address answer on purpose: the response must
    // not report which addresses have accounts.
    const { backend, outbox, post } = await boot()
    try {
      await post('signup', { email: 'done@example.com', password: 'password123' })
      await backend.db.query(`update auth.users set email_confirmed_at = now() where email = $1`, ['done@example.com'])
      const before = outbox.length

      const res = await post('resend', { type: 'signup', email: 'done@example.com' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({})
      expect(outbox.length, 'nothing to confirm, so nothing sent').toBe(before)
    } finally {
      await backend.close()
    }
  })

  it('resends the confirmation for an unconfirmed account, on its own window', async () => {
    const { backend, outbox, post } = await boot()
    try {
      await post('signup', { email: 'pending@example.com', password: 'password123' })
      expect(outbox.length).toBe(1)
      expect(outbox[0].subject).toBe('Confirm your email')

      // Signup has just spent confirmation_sent_at, so the immediate resend is
      // refused - by the confirmation window, not the recovery one.
      const tooSoon = await post('resend', { type: 'signup', email: 'pending@example.com' })
      expect(tooSoon.status).toBe(429)
      expect(await tooSoon.json()).toMatchObject({ error_code: 'over_email_send_rate_limit' })

      await backend.db.query(`update auth.users set confirmation_sent_at = now() - interval '1 hour' where email = $1`, [
        'pending@example.com',
      ])
      const sent = await post('resend', { type: 'signup', email: 'pending@example.com' })
      expect(sent.status).toBe(200)
      expect(outbox.length).toBe(2)
      expect(outbox[1].subject, 'a confirmation, not a login link').toBe('Confirm your email')
    } finally {
      await backend.close()
    }
  })

  it('is not paced by the magic-link window', async () => {
    // /magiclink is measured by recovery_sent_at; a resend is a confirmation.
    // Sharing one window would let either block the other.
    const { backend, outbox, post } = await boot()
    try {
      await post('signup', { email: 'both@example.com', password: 'password123' })
      await backend.db.query(`update auth.users set confirmation_sent_at = now() - interval '1 hour' where email = $1`, [
        'both@example.com',
      ])
      expect((await post('magiclink', { email: 'both@example.com' })).status).toBe(200)
      const count = outbox.length

      const res = await post('resend', { type: 'signup', email: 'both@example.com' })
      expect(res.status).toBe(200)
      expect(outbox.length).toBe(count + 1)
    } finally {
      await backend.close()
    }
  })

  it('requires a type, and refuses the ones this server cannot serve', async () => {
    const { backend, post } = await boot()
    try {
      expect((await post('resend', { email: 'x@example.com' })).status).toBe(400)
      for (const type of ['sms', 'phone_change', 'email_change', 'nonsense']) {
        const res = await post('resend', { type, email: 'x@example.com' })
        expect(res.status, `type=${type}`).toBe(400)
      }
    } finally {
      await backend.close()
    }
  })
})
