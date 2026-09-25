import { describe, expect, it } from 'vitest'
import { createBackend, type MailMessage } from '../src/index.js'

/**
 * `auth.admin.inviteUserByEmail` - create an account and mail a link that
 * signs the recipient in so they can set a password.
 *
 * Without it an app has to fake an invite: create the user with a password
 * nobody knows, then tell them to use "forgot password" - which mails a reset
 * for an account they have never heard of.
 */
describe('admin invite', () => {
  const boot = async () => {
    const outbox: MailMessage[] = []
    const backend = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      authSettings: { autoconfirm: false },
    })
    const invite = (body: unknown) =>
      backend.fetch(
        new Request('http://localhost:54321/auth/v1/admin/invite', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apikey: backend.serviceRoleKey,
            authorization: `Bearer ${backend.serviceRoleKey}`,
          },
          body: JSON.stringify(body),
        })
      )
    const post = (path: string, body: unknown) =>
      backend.fetch(
        new Request(`http://localhost:54321/auth/v1/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: backend.anonKey },
          body: JSON.stringify(body),
        })
      )
    return { backend, outbox, invite, post }
  }

  it('creates a passwordless account and mails an invitation', async () => {
    const { backend, outbox, invite } = await boot()
    try {
      const res = await invite({ email: 'newhire@example.com', data: { role: 'editor' } })
      expect(res.status).toBe(200)
      const user = (await res.json()) as { email: string; user_metadata: Record<string, unknown> }
      expect(user.email).toBe('newhire@example.com')
      expect(user.user_metadata, 'data rides along, as GoTrue does').toMatchObject({ role: 'editor' })

      expect(outbox.length).toBe(1)
      expect(outbox[0].to).toBe('newhire@example.com')
      expect(outbox[0].subject).toBe("You've been invited")
      expect(outbox[0].text, 'link only - they have no account yet, so nowhere to type a code').not.toMatch(/\b\d{6}\b/)

      const row = await backend.db.query(
        `select encrypted_password, invited_at, confirmation_sent_at from auth.users where email = $1`,
        ['newhire@example.com']
      )
      const r = row.rows[0] as Record<string, unknown>
      expect(r.encrypted_password, 'no password is set').toBeNull()
      expect(r.invited_at, 'stamped so the row can be told from a self-signup').toBeTruthy()
      expect(r.confirmation_sent_at).toBeTruthy()
    } finally {
      await backend.close()
    }
  })

  it('the invitation link signs them in', async () => {
    const { backend, outbox, invite } = await boot()
    try {
      await invite({ email: 'accept@example.com' })
      const link = outbox[0].text.match(/(https?:\S+verify\S+)/)?.[1]
      const res = await backend.fetch(new Request(link!, { redirect: 'manual' }))
      expect(res.status).toBe(303)
      expect(res.headers.get('location'), 'a session, so they can set a password').toContain('#access_token=')
    } finally {
      await backend.close()
    }
  })

  it('refuses an address that already belongs to a confirmed account', async () => {
    const { backend, invite, post } = await boot()
    try {
      await post('signup', { email: 'taken@example.com', password: 'password123' })
      await backend.db.query(`update auth.users set email_confirmed_at = now() where email = $1`, ['taken@example.com'])

      const res = await invite({ email: 'taken@example.com' })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error_code: 'email_exists' })
    } finally {
      await backend.close()
    }
  })

  it('re-invites an address nobody has proved they hold', async () => {
    // An unconfirmed row means the first invite may simply have been lost.
    const { backend, outbox, invite } = await boot()
    try {
      await invite({ email: 'again@example.com' })
      const second = await invite({ email: 'again@example.com' })
      expect(second.status).toBe(200)
      expect(outbox.length).toBe(2)
    } finally {
      await backend.close()
    }
  })

  it('is service_role only', async () => {
    const { backend } = await boot()
    try {
      const res = await backend.fetch(
        new Request('http://localhost:54321/auth/v1/admin/invite', {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: backend.anonKey },
          body: JSON.stringify({ email: 'anon@example.com' }),
        })
      )
      expect(res.status).toBe(403)
    } finally {
      await backend.close()
    }
  })
})
