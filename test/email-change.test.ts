import { describe, expect, it } from 'vitest'
import { createBackend, type MailMessage, type TinbaseBackend } from '../src/index.js'

/**
 * Changing the address on an account, GoTrue's way: the new address is parked
 * until it is confirmed, and with secure_email_change_enabled the address that
 * is losing the account has to agree too.
 *
 * Before this, `updateUser({ email })` wrote straight to auth.users.email and
 * stamped it confirmed, so a session was all it took to move an account
 * somewhere else with nothing sent to either address.
 */
describe('email change', () => {
  const boot = async (opts: { secure?: boolean; autoconfirm?: boolean } = {}) => {
    const outbox: MailMessage[] = []
    const backend = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      authSettings: {
        autoconfirm: opts.autoconfirm ?? true,
        secureEmailChange: opts.secure ?? true,
        maxEmailFrequencySeconds: 0,
      },
    })
    const post = (path: string, body: unknown, token?: string) =>
      backend.fetch(
        new Request(`http://localhost:54321/auth/v1/${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apikey: backend.anonKey,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        })
      )
    const putUser = (body: unknown, token: string) =>
      backend.fetch(
        new Request('http://localhost:54321/auth/v1/user', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', apikey: backend.anonKey, authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        })
      )
    const signIn = async (email: string) => {
      await post('signup', { email, password: 'password123' })
      // With confirmations on, signup leaves the account unconfirmed and
      // password login is refused. Confirm it directly: these tests are about
      // what happens after someone is signed in, not about getting there.
      await backend.db.query(`update auth.users set email_confirmed_at = now() where email = $1`, [email])
      const r = await post('token?grant_type=password', { email, password: 'password123' })
      return ((await r.json()) as { access_token: string }).access_token
    }
    const row = async (email: string) =>
      (
        await backend.db.query(
          `select email, email_change, email_change_confirm_status from auth.users where email = $1 or email_change = $1`,
          [email]
        )
      ).rows[0] as { email: string; email_change: string; email_change_confirm_status: number } | undefined
    const linkTo = (to: string) => {
      const m = [...outbox].reverse().find((x) => x.to === to)
      return m?.text.match(/(https?:\S+verify\S+)/)?.[1]
    }
    return { backend, outbox, post, putUser, signIn, row, linkTo }
  }

  const clickLink = (backend: TinbaseBackend, link: string) =>
    backend.fetch(new Request(link, { redirect: 'manual' }))

  it('parks the new address instead of taking it, and mails both ends', async () => {
    const { backend, outbox, putUser, signIn, row } = await boot({ autoconfirm: false })
    try {
      const token = await signIn('old@example.com')
      outbox.length = 0

      const res = await putUser({ email: 'new@example.com' }, token)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { email: string; new_email?: string }
      expect(body.email, 'the account is still on its old address').toBe('old@example.com')
      expect(body.new_email, 'and reports the one it is moving to').toBe('new@example.com')

      const r = await row('old@example.com')
      expect(r?.email).toBe('old@example.com')
      expect(r?.email_change).toBe('new@example.com')

      // One to the address gaining the account, one to the address losing it.
      expect(outbox.map((m) => m.to).sort()).toEqual(['new@example.com', 'old@example.com'])
    } finally {
      await backend.close()
    }
  })

  it('needs both sides before the address moves', async () => {
    const { backend, outbox, putUser, signIn, row, linkTo } = await boot({ autoconfirm: false })
    try {
      const token = await signIn('one@example.com')
      outbox.length = 0
      await putUser({ email: 'two@example.com' }, token)

      // Only the new address answers.
      const first = await clickLink(backend, linkTo('two@example.com')!)
      expect(first.status).toBe(303)
      expect(first.headers.get('location')).toContain('#message=')
      expect(first.headers.get('location'), 'no session while it is half done').not.toContain('access_token')

      let r = await row('one@example.com')
      expect(r?.email, 'still the old address').toBe('one@example.com')
      expect(r?.email_change_confirm_status).toBe(1)

      // Then the current one.
      const second = await clickLink(backend, linkTo('one@example.com')!)
      expect(second.status).toBe(303)
      expect(second.headers.get('location')).toContain('#access_token=')

      r = await row('two@example.com')
      expect(r?.email, 'the address has moved').toBe('two@example.com')
      expect(r?.email_change, 'and nothing is left pending').toBe('')
      expect(r?.email_change_confirm_status).toBe(0)
    } finally {
      await backend.close()
    }
  })

  it('does not care which side answers first', async () => {
    const { backend, outbox, putUser, signIn, row, linkTo } = await boot({ autoconfirm: false })
    try {
      const token = await signIn('a@example.com')
      outbox.length = 0
      await putUser({ email: 'b@example.com' }, token)

      expect((await clickLink(backend, linkTo('a@example.com')!)).headers.get('location')).toContain('#message=')
      expect((await clickLink(backend, linkTo('b@example.com')!)).headers.get('location')).toContain('#access_token=')
      expect((await row('b@example.com'))?.email).toBe('b@example.com')
    } finally {
      await backend.close()
    }
  })

  it('asks only the new address when secure email change is off', async () => {
    const { backend, outbox, putUser, signIn, row, linkTo } = await boot({ autoconfirm: false, secure: false })
    try {
      const token = await signIn('solo@example.com')
      outbox.length = 0
      await putUser({ email: 'moved@example.com' }, token)

      expect(outbox.map((m) => m.to)).toEqual(['moved@example.com'])
      const res = await clickLink(backend, linkTo('moved@example.com')!)
      expect(res.headers.get('location'), 'one click is the whole change').toContain('#access_token=')
      expect((await row('moved@example.com'))?.email).toBe('moved@example.com')
    } finally {
      await backend.close()
    }
  })

  it('replaces a change already in flight rather than leaving two live', async () => {
    const { backend, outbox, putUser, signIn, row, linkTo } = await boot({ autoconfirm: false })
    try {
      const token = await signIn('start@example.com')
      outbox.length = 0
      await putUser({ email: 'first@example.com' }, token)
      const stale = linkTo('first@example.com')!

      await putUser({ email: 'second@example.com' }, token)
      expect((await row('start@example.com'))?.email_change).toBe('second@example.com')

      // The superseded link must not still be able to land.
      const res = await clickLink(backend, stale)
      expect(res.headers.get('location')).toContain('error_code=otp_expired')
      expect((await row('start@example.com'))?.email).toBe('start@example.com')
    } finally {
      await backend.close()
    }
  })

  it('redeems exactly once, so a link cannot be replayed', async () => {
    const { backend, outbox, putUser, signIn, linkTo } = await boot({ autoconfirm: false })
    try {
      const token = await signIn('once@example.com')
      outbox.length = 0
      await putUser({ email: 'twice@example.com' }, token)
      const link = linkTo('twice@example.com')!

      expect((await clickLink(backend, link)).headers.get('location')).toContain('#message=')
      const replay = await clickLink(backend, link)
      expect(replay.headers.get('location')).toContain('error_code=otp_expired')
    } finally {
      await backend.close()
    }
  })

  it('refuses an address that belongs to someone else', async () => {
    const { backend, putUser, signIn } = await boot({ autoconfirm: false })
    try {
      await signIn('taken@example.com')
      const token = await signIn('mover@example.com')
      const res = await putUser({ email: 'taken@example.com' }, token)
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error_code: 'email_exists' })
    } finally {
      await backend.close()
    }
  })

  it('still changes on the spot under autoconfirm, which sends no mail at all', async () => {
    const { backend, outbox, putUser, signIn } = await boot({ autoconfirm: true })
    try {
      const token = await signIn('auto@example.com')
      outbox.length = 0
      const res = await putUser({ email: 'instant@example.com' }, token)
      const body = (await res.json()) as { email: string; new_email?: string }
      expect(body.email).toBe('instant@example.com')
      expect(body.new_email).toBeUndefined()
      expect(outbox.length).toBe(0)
    } finally {
      await backend.close()
    }
  })

  it('carries the new address onto the email identity', async () => {
    // getUser reads the address back through user.identities; left alone it
    // would keep naming the address the account no longer uses.
    const { backend, outbox, putUser, signIn, linkTo } = await boot({ autoconfirm: false, secure: false })
    try {
      const token = await signIn('ident@example.com')
      outbox.length = 0
      await putUser({ email: 'ident2@example.com' }, token)
      await clickLink(backend, linkTo('ident2@example.com')!)

      const r = await backend.db.query(
        `select identity_data->>'email' as email from auth.identities where provider = 'email'
          and user_id = (select id from auth.users where email = $1)`,
        ['ident2@example.com']
      )
      expect((r.rows[0] as { email: string }).email).toBe('ident2@example.com')
    } finally {
      await backend.close()
    }
  })
})
