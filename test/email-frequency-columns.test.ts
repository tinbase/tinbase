import { describe, expect, it } from 'vitest'
import { createBackend, type MailMessage } from '../src/index.js'

/**
 * `max_frequency` measured GoTrue's way: against the timestamp the flow last
 * wrote on the user row, rather than one budget shared by every flow.
 *
 * The mapping is GoTrue's, quirks included - a magic link and a password
 * recovery share `recovery_sent_at` because GoTrue mints both from the
 * recovery token, while a signup confirmation has `confirmation_sent_at` to
 * itself. An app that sets max_frequency in config.toml then gets the pacing
 * Supabase documents.
 */
describe('max_frequency is per flow, as GoTrue measures it', () => {
  const boot = async (autoconfirm = false, maxEmailFrequencySeconds = 60) => {
    const outbox: MailMessage[] = []
    const backend = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      authSettings: { autoconfirm, maxEmailFrequencySeconds },
    })
    const post = (path: string, body: unknown) =>
      backend.fetch(
        new Request(`http://localhost:54321/auth/v1/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: backend.anonKey },
          body: JSON.stringify(body),
        })
      )
    const signup = (email: string) => post('signup', { email, password: 'password123' })
    const sentAt = async (email: string) => {
      const r = await backend.db.query(
        `select confirmation_sent_at, recovery_sent_at from auth.users where email = $1`,
        [email]
      )
      return r.rows[0] as { confirmation_sent_at: Date | null; recovery_sent_at: Date | null } | undefined
    }
    return { backend, outbox, post, signup, sentAt }
  }

  it('records the send on the column that flow owns', async () => {
    // These columns are in the mirrored GoTrue schema and were never written,
    // so they read NULL no matter how much mail had gone out.
    const { backend, signup, post, sentAt } = await boot()
    try {
      await signup('columns@example.com')
      const afterSignup = await sentAt('columns@example.com')
      expect(afterSignup?.confirmation_sent_at, 'signup writes confirmation_sent_at').toBeTruthy()
      expect(afterSignup?.recovery_sent_at, 'and leaves recovery_sent_at alone').toBeNull()

      await post('recover', { email: 'columns@example.com' })
      const afterRecover = await sentAt('columns@example.com')
      expect(afterRecover?.recovery_sent_at, 'recovery writes recovery_sent_at').toBeTruthy()
    } finally {
      await backend.close()
    }
  })

  it('does not let a confirmation spend the recovery window', async () => {
    // The budgets are separate columns, so a signup must not block the reset
    // the same person asks for a moment later.
    const { backend, outbox, signup, post } = await boot()
    try {
      expect((await signup('separate@example.com')).status).toBe(200)
      expect(outbox.length).toBe(1)

      const recover = await post('recover', { email: 'separate@example.com' })
      expect(recover.status).toBe(200)
      expect(outbox.length, 'the recovery mail went out too').toBe(2)
    } finally {
      await backend.close()
    }
  })

  it('shares one window between a magic link and a recovery, as GoTrue does', async () => {
    const { backend, outbox, post } = await boot()
    try {
      expect((await post('otp', { email: 'shared@example.com' })).status).toBe(200)
      expect(outbox.length).toBe(1)

      // Both are measured by recovery_sent_at, so the second is refused.
      const recover = await post('recover', { email: 'shared@example.com' })
      expect(recover.status).toBe(429)
      expect(await recover.json()).toMatchObject({ error_code: 'over_email_send_rate_limit' })
      expect(outbox.length).toBe(1)
    } finally {
      await backend.close()
    }
  })

  it('refuses a repeat inside the window and allows it after', async () => {
    const { backend, outbox, post } = await boot(false, 1)
    try {
      expect((await post('otp', { email: 'window@example.com' })).status).toBe(200)
      expect((await post('otp', { email: 'window@example.com' })).status).toBe(429)
      await new Promise((r) => setTimeout(r, 1200))
      expect((await post('otp', { email: 'window@example.com' })).status).toBe(200)
      expect(outbox.length).toBe(2)
    } finally {
      await backend.close()
    }
  })

  it('throttles an address with no account the same as one with, so a 429 proves nothing', async () => {
    // GoTrue has no row to measure here and lets the request through, which
    // makes a 429 proof that the account exists - handing back the enumeration
    // that answering 200 for an unknown address is there to prevent.
    const { backend, post } = await boot()
    try {
      expect((await post('recover', { email: 'ghost@example.com' })).status).toBe(200)
      const second = await post('recover', { email: 'ghost@example.com' })
      expect(second.status).toBe(429)
      expect(await second.json()).toMatchObject({ error_code: 'over_email_send_rate_limit' })
    } finally {
      await backend.close()
    }
  })

  it('spends nothing when the signup sends no mail', async () => {
    const { backend, outbox, signup, post, sentAt } = await boot(true)
    try {
      expect((await signup('auto@example.com')).status).toBe(200)
      expect(outbox.length).toBe(0)
      expect((await sentAt('auto@example.com'))?.confirmation_sent_at).toBeNull()

      expect((await post('recover', { email: 'auto@example.com' })).status).toBe(200)
      expect(outbox.length, 'the recovery mail was not blocked by the signup').toBe(1)
    } finally {
      await backend.close()
    }
  })
})
