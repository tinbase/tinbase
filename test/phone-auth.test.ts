import { createClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type SmsMessage, type TinbaseBackend } from '../src/index.js'

/**
 * Phone auth (SMS OTP) to GoTrue parity: `signInWithOtp({ phone })`,
 * `verifyOtp({ phone, token, type: 'sms' })`, `signUp({ phone, password })`,
 * `updateUser({ phone })` + `type: 'phone_change'`, `resend`, and the
 * settings that govern them. Texts go to a fake sender, like the mail tests.
 */
let backend: TinbaseBackend | undefined
afterEach(async () => {
  await backend?.close()
  backend = undefined
})

async function boot(settings: Record<string, unknown> = {}, opts: { sender?: boolean } = {}) {
  const outbox: SmsMessage[] = []
  backend = await createBackend({
    ...(opts.sender === false ? {} : { smsSender: { send: async (m) => void outbox.push(m) } }),
    authSettings: { phoneEnabled: true, maxSmsFrequencySeconds: 0, ...settings },
  })
  const client = () =>
    createClient('http://localhost:54321', backend!.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
    })
  const supabase = client()
  const post = (path: string, body: unknown, bearer?: string) =>
    backend!.fetch(
      new Request(`http://localhost:54321/auth/v1/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: backend!.anonKey,
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
      })
    )
  const lastCode = () => outbox[outbox.length - 1].body.match(/\d{6,10}/)![0]
  return { supabase, client, outbox, post, lastCode }
}

describe('phone auth is off until enabled', () => {
  it('answers phone_provider_disabled on every phone endpoint, as GoTrue does', async () => {
    const { supabase, outbox } = await boot({ phoneEnabled: false })
    const otp = await supabase.auth.signInWithOtp({ phone: '+15005550006' })
    expect(otp.error?.code).toBe('phone_provider_disabled')
    const up = await supabase.auth.signUp({ phone: '+15005550006', password: 'password123' })
    expect(up.error?.code).toBe('phone_provider_disabled')
    const pw = await supabase.auth.signInWithPassword({ phone: '+15005550006', password: 'password123' })
    expect(pw.error?.code).toBe('phone_provider_disabled')
    expect(outbox).toHaveLength(0)
    const settings = await (await backend!.fetch(new Request('http://localhost:54321/auth/v1/settings', { headers: { apikey: backend!.anonKey } }))).json()
    expect(settings.external.phone).toBe(false)
  })

  it('reports phone in /settings once on', async () => {
    await boot({ smsAutoconfirm: false })
    const settings = await (await backend!.fetch(new Request('http://localhost:54321/auth/v1/settings', { headers: { apikey: backend!.anonKey } }))).json()
    expect(settings.external.phone).toBe(true)
    expect(settings.phone_autoconfirm).toBe(false)
    expect(settings.sms_provider).toBe('custom')
  })
})

describe('signInWithOtp({ phone }) + verifyOtp type sms', () => {
  it('texts a code and the code returns a session for a user stored by bare digits', async () => {
    const { supabase, outbox, lastCode } = await boot()
    const sent = await supabase.auth.signInWithOtp({ phone: '+1 (500) 555-0006' })
    expect(sent.error).toBeNull()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].to).toBe('+15005550006')
    expect(outbox[0].body).toMatch(/^Your code is \d{6}$/)

    const verified = await supabase.auth.verifyOtp({ phone: '+15005550006', token: lastCode(), type: 'sms' })
    expect(verified.error).toBeNull()
    expect(verified.data.session?.access_token).toBeTruthy()
    // GoTrue stores and returns the number without the leading +
    expect(verified.data.user?.phone).toBe('15005550006')
    expect(verified.data.user?.phone_confirmed_at).toBeTruthy()
    expect(verified.data.user?.app_metadata.provider).toBe('phone')
    expect(verified.data.user?.identities?.some((i) => i.provider === 'phone')).toBe(true)
    await supabase.auth.signOut()
  })

  it('a code is single use, and a wrong one is refused', async () => {
    const { supabase, lastCode } = await boot()
    await supabase.auth.signInWithOtp({ phone: '+15005550007' })
    const code = lastCode()
    const bad = await supabase.auth.verifyOtp({ phone: '+15005550007', token: '000000', type: 'sms' })
    expect(bad.error?.code).toBe('otp_expired')
    const good = await supabase.auth.verifyOtp({ phone: '+15005550007', token: code, type: 'sms' })
    expect(good.error).toBeNull()
    await supabase.auth.signOut()
    const replay = await supabase.auth.verifyOtp({ phone: '+15005550007', token: code, type: 'sms' })
    expect(replay.error?.code).toBe('otp_expired')
  })

  it('locks the code after five wrong guesses', async () => {
    const { supabase, lastCode } = await boot()
    await supabase.auth.signInWithOtp({ phone: '+15005550008' })
    const code = lastCode()
    for (let i = 0; i < 5; i++) {
      await supabase.auth.verifyOtp({ phone: '+15005550008', token: '111111', type: 'sms' })
    }
    const late = await supabase.auth.verifyOtp({ phone: '+15005550008', token: code, type: 'sms' })
    expect(late.error?.code).toBe('otp_expired')
  })

  it('a code is only good with the number it was texted to', async () => {
    const { supabase, lastCode } = await boot()
    await supabase.auth.signInWithOtp({ phone: '+15005550009' })
    const code = lastCode()
    const other = await supabase.auth.verifyOtp({ phone: '+15005550010', token: code, type: 'sms' })
    expect(other.error?.code).toBe('otp_expired')
  })

  it('refuses a number that is not E.164', async () => {
    const { supabase, outbox } = await boot()
    const r = await supabase.auth.signInWithOtp({ phone: 'five five five' })
    expect(r.error?.code).toBe('validation_failed')
    expect(r.error?.message).toMatch(/E\.164/)
    expect(outbox).toHaveLength(0)
  })

  it('honours shouldCreateUser: false for an unknown number', async () => {
    const { supabase, outbox } = await boot()
    const r = await supabase.auth.signInWithOtp({ phone: '+15005550011', options: { shouldCreateUser: false } })
    expect(r.error?.code).toBe('otp_disabled')
    expect(outbox).toHaveLength(0)
  })

  it('uses the configured code length and template', async () => {
    const outbox: SmsMessage[] = []
    backend = await createBackend({
      smsSender: { send: async (m) => void outbox.push(m) },
      smsTemplate: 'Acme: {{ .Code }} is your login code',
      authSettings: { phoneEnabled: true, smsOtpLength: 8, maxSmsFrequencySeconds: 0 },
    })
    const supabase = createClient('http://localhost:54321', backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
    })
    await supabase.auth.signInWithOtp({ phone: '+15005550012' })
    expect(outbox[0].body).toMatch(/^Acme: \d{8} is your login code$/)
  })

  it('returns the provider message id when the sender gives one', async () => {
    backend = await createBackend({
      smsSender: { send: async () => 'SM123' },
      authSettings: { phoneEnabled: true, maxSmsFrequencySeconds: 0 },
    })
    const supabase = createClient('http://localhost:54321', backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
    })
    const r = await supabase.auth.signInWithOtp({ phone: '+15005550013' })
    expect(r.error).toBeNull()
    expect(r.data.messageId).toBe('SM123')
  })
})

describe('signUp({ phone, password })', () => {
  it('returns a session under SMS autoconfirm (the default) and signs in by phone + password', async () => {
    const { supabase, outbox } = await boot()
    const up = await supabase.auth.signUp({ phone: '+15005550020', password: 'password123', options: { data: { name: 'Pat' } } })
    expect(up.error).toBeNull()
    expect(up.data.session?.access_token).toBeTruthy()
    expect(up.data.user?.phone).toBe('15005550020')
    expect(up.data.user?.user_metadata).toEqual({ name: 'Pat' })
    expect(outbox).toHaveLength(0)
    await supabase.auth.signOut()

    const ok = await supabase.auth.signInWithPassword({ phone: '+15005550020', password: 'password123' })
    expect(ok.error).toBeNull()
    await supabase.auth.signOut()
    const bad = await supabase.auth.signInWithPassword({ phone: '+15005550020', password: 'nope' })
    expect(bad.error?.code).toBe('invalid_credentials')
  })

  it('with confirmations on: no session until the texted code comes back', async () => {
    const { supabase, outbox, lastCode } = await boot({ smsAutoconfirm: false })
    const up = await supabase.auth.signUp({ phone: '+15005550021', password: 'password123' })
    expect(up.error).toBeNull()
    expect(up.data.session).toBeNull()
    expect(up.data.user?.phone_confirmed_at).toBeFalsy()
    expect(outbox).toHaveLength(1)

    const early = await supabase.auth.signInWithPassword({ phone: '+15005550021', password: 'password123' })
    expect(early.error?.code).toBe('phone_not_confirmed')

    const verified = await supabase.auth.verifyOtp({ phone: '+15005550021', token: lastCode(), type: 'sms' })
    expect(verified.error).toBeNull()
    expect(verified.data.user?.phone_confirmed_at).toBeTruthy()
    await supabase.auth.signOut()

    const later = await supabase.auth.signInWithPassword({ phone: '+15005550021', password: 'password123' })
    expect(later.error).toBeNull()
  })

  it('refuses a number that already has an account, and a missing password', async () => {
    const { supabase } = await boot()
    await supabase.auth.signUp({ phone: '+15005550022', password: 'password123' })
    await supabase.auth.signOut()
    const dup = await supabase.auth.signUp({ phone: '+15005550022', password: 'password123' })
    expect(dup.error?.code).toBe('user_already_exists')
    const nopw = await supabase.auth.signUp({ phone: '+15005550023', password: '' })
    expect(nopw.error?.code).toBe('validation_failed')
  })

  it('resend type sms texts the confirmation again, and says nothing about unknown or confirmed numbers', async () => {
    const { supabase, outbox } = await boot({ smsAutoconfirm: false })
    await supabase.auth.signUp({ phone: '+15005550024', password: 'password123' })
    expect(outbox).toHaveLength(1)
    const again = await supabase.auth.resend({ phone: '+15005550024', type: 'sms' })
    expect(again.error).toBeNull()
    expect(outbox).toHaveLength(2)
    const ghost = await supabase.auth.resend({ phone: '+15005550025', type: 'sms' })
    expect(ghost.error).toBeNull()
    expect(outbox).toHaveLength(2)
  })
})

describe('updateUser({ phone })', () => {
  it('parks the new number until its code is verified, then moves it in', async () => {
    const { supabase, outbox, lastCode } = await boot({ smsAutoconfirm: false })
    await supabase.auth.signUp({ email: 'mover@example.com', password: 'password123' })
    const upd = await supabase.auth.updateUser({ phone: '+15005550030' })
    expect(upd.error).toBeNull()
    expect(upd.data.user.phone).toBe('')
    expect(upd.data.user.new_phone).toBe('15005550030')
    expect(outbox).toHaveLength(1)
    expect(outbox[0].to).toBe('+15005550030')

    const verified = await supabase.auth.verifyOtp({ phone: '+15005550030', token: lastCode(), type: 'phone_change' })
    expect(verified.error).toBeNull()
    expect(verified.data.user?.phone).toBe('15005550030')
    expect(verified.data.user?.phone_confirmed_at).toBeTruthy()
    expect(verified.data.user?.new_phone).toBeUndefined()
    expect(verified.data.user?.identities?.some((i) => i.provider === 'phone')).toBe(true)
    await supabase.auth.signOut()
  })

  it('takes effect at once under SMS autoconfirm', async () => {
    const { supabase, outbox } = await boot()
    await supabase.auth.signUp({ email: 'direct@example.com', password: 'password123' })
    const upd = await supabase.auth.updateUser({ phone: '+15005550031' })
    expect(upd.error).toBeNull()
    expect(upd.data.user.phone).toBe('15005550031')
    expect(outbox).toHaveLength(0)
    await supabase.auth.signOut()
  })

  it('refuses a number another account holds', async () => {
    const { supabase, client } = await boot()
    await supabase.auth.signUp({ phone: '+15005550032', password: 'password123' })
    const other = client()
    await other.auth.signUp({ email: 'other@example.com', password: 'password123' })
    const upd = await other.auth.updateUser({ phone: '+15005550032' })
    expect(upd.error?.code).toBe('phone_exists')
  })

  it('resend type phone_change texts the pending number again', async () => {
    const { supabase, outbox } = await boot({ smsAutoconfirm: false })
    await supabase.auth.signUp({ email: 'resend@example.com', password: 'password123' })
    await supabase.auth.updateUser({ phone: '+15005550033' })
    expect(outbox).toHaveLength(1)
    const again = await supabase.auth.resend({ phone: '+15005550033', type: 'phone_change' })
    expect(again.error).toBeNull()
    expect(outbox).toHaveLength(2)
    expect(outbox[1].to).toBe('+15005550033')
  })

  it('upgrades an anonymous user to a phone account', async () => {
    const { supabase } = await boot()
    await supabase.auth.signInAnonymously()
    const upd = await supabase.auth.updateUser({ phone: '+15005550034' })
    expect(upd.error).toBeNull()
    expect(upd.data.user.is_anonymous).toBe(false)
    expect(upd.data.user.phone).toBe('15005550034')
  })
})

describe('max_frequency for SMS', () => {
  it('refuses a second text to the same number inside the window, with the SMS error code', async () => {
    const { supabase, outbox } = await boot({ maxSmsFrequencySeconds: 60 })
    const first = await supabase.auth.signInWithOtp({ phone: '+15005550040' })
    expect(first.error).toBeNull()
    const second = await supabase.auth.signInWithOtp({ phone: '+15005550040' })
    expect(second.error?.code).toBe('over_sms_send_rate_limit')
    expect(second.error?.status).toBe(429)
    expect(outbox).toHaveLength(1)
    // another number is not held up
    const other = await supabase.auth.signInWithOtp({ phone: '+15005550041' })
    expect(other.error).toBeNull()
  })
})

describe('test phone numbers ([auth.sms.test_otp])', () => {
  it('never texts a listed number, and its fixed code signs in', async () => {
    const { supabase, outbox } = await boot({ smsTestOtp: { '+1 (500) 555-0070': '424242' } })
    const r = await supabase.auth.signInWithOtp({ phone: '+15005550070' })
    expect(r.error).toBeNull()
    expect(r.data.messageId).toBeFalsy()
    expect(outbox).toHaveLength(0)
    const wrong = await supabase.auth.verifyOtp({ phone: '+15005550070', token: '000000', type: 'sms' })
    expect(wrong.error).not.toBeNull()
    const ok = await supabase.auth.verifyOtp({ phone: '+15005550070', token: '424242', type: 'sms' })
    expect(ok.error).toBeNull()
    expect(ok.data.user?.phone).toBe('15005550070')
    expect(ok.data.user?.phone_confirmed_at).toBeTruthy()
    // every request mints the same code again; other numbers still get a random one by text
    expect((await supabase.auth.signInWithOtp({ phone: '+15005550070' })).error).toBeNull()
    expect((await supabase.auth.verifyOtp({ phone: '+15005550070', token: '424242', type: 'sms' })).error).toBeNull()
    expect((await supabase.auth.signInWithOtp({ phone: '+15005550071' })).error).toBeNull()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].to).toBe('+15005550071')
    expect(outbox[0].body).not.toContain('424242')
  })

  it('covers phone signups and phone changes too', async () => {
    const { supabase, outbox } = await boot({ smsAutoconfirm: false, smsTestOtp: { '15005550072': '111111', '15005550073': '222222' } })
    const up = await supabase.auth.signUp({ phone: '+15005550072', password: 'password123' })
    expect(up.error).toBeNull()
    expect(up.data.session).toBeNull()
    const confirmed = await supabase.auth.verifyOtp({ phone: '+15005550072', token: '111111', type: 'sms' })
    expect(confirmed.error).toBeNull()
    expect(confirmed.data.session).not.toBeNull()
    // the client is signed in now; change to another listed number
    const upd = await supabase.auth.updateUser({ phone: '+15005550073' })
    expect(upd.error).toBeNull()
    expect(upd.data.user.new_phone).toBe('15005550073')
    const moved = await supabase.auth.verifyOtp({ phone: '+15005550073', token: '222222', type: 'phone_change' })
    expect(moved.error).toBeNull()
    expect(moved.data.user?.phone).toBe('15005550073')
    expect(outbox).toHaveLength(0)
    await supabase.auth.signOut()
  })

  it('still paces a listed number by max_frequency, as GoTrue does', async () => {
    const { supabase } = await boot({ maxSmsFrequencySeconds: 60, smsTestOtp: { '15005550074': '111111' } })
    expect((await supabase.auth.signInWithOtp({ phone: '+15005550074' })).error).toBeNull()
    const second = await supabase.auth.signInWithOtp({ phone: '+15005550074' })
    expect(second.error?.code).toBe('over_sms_send_rate_limit')
  })

  it('is a runtime setting: the admin API takes the map, echoes it, and refuses a bad entry', async () => {
    const { outbox } = await boot()
    const headers = { 'content-type': 'application/json', apikey: backend!.serviceRoleKey, authorization: `Bearer ${backend!.serviceRoleKey}` }
    const patch = (body: unknown) =>
      backend!.fetch(new Request('http://localhost:54321/admin/v1/auth-config', { method: 'PATCH', headers, body: JSON.stringify(body) }))
    const ok = await patch({ smsTestOtp: { '+91 98765 43210': '000000' } })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { settings: { smsTestOtp: Record<string, string> } }).settings.smsTestOtp).toEqual({ '919876543210': '000000' })
    // live at once: the listed number is not texted
    const supabase = createClient('http://localhost:54321', backend!.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
    })
    expect((await supabase.auth.signInWithOtp({ phone: '+919876543210' })).error).toBeNull()
    expect((await supabase.auth.verifyOtp({ phone: '+919876543210', token: '000000', type: 'sms' })).error).toBeNull()
    expect(outbox).toHaveLength(0)
    const badPhone = await patch({ smsTestOtp: { 'not-a-number': '123456' } })
    expect(badPhone.status).toBe(400)
    const badCode = await patch({ smsTestOtp: { '15005550075': 'abc' } })
    expect(badCode.status).toBe(400)
    const cleared = await patch({ smsTestOtp: {} })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as { settings: { smsTestOtp: Record<string, string> } }).settings.smsTestOtp).toEqual({})
  })
})

describe('without an SMS provider', () => {
  it('captures the text in the dev inbox, marked as SMS', async () => {
    const { supabase } = await boot({}, { sender: false })
    expect(backend!.inbox).not.toBeNull()
    const r = await supabase.auth.signInWithOtp({ phone: '+15005550050' })
    expect(r.error).toBeNull()
    const msgs = backend!.inbox!.list()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].channel).toBe('sms')
    expect(msgs[0].to).toBe('+15005550050')
    expect(msgs[0].code).toMatch(/^\d{6}$/)
    const verified = await supabase.auth.verifyOtp({ phone: '+15005550050', token: msgs[0].code!, type: 'sms' })
    expect(verified.error).toBeNull()
  })

  it('does not log the code', async () => {
    const { supabase } = await boot({}, { sender: false })
    await supabase.auth.signInWithOtp({ phone: '+15005550051' })
    const code = backend!.inbox!.list()[0].code!
    const smsLogs = backend!.logs.list(500).filter((l) => l.msg.startsWith('[sms]'))
    expect(smsLogs.length).toBeGreaterThanOrEqual(1)
    expect(smsLogs.map((l) => l.msg).join('\n')).not.toContain(code)
  })
})

describe('admin API', () => {
  it('creates a phone user, and the Twilio auth token is never echoed back', async () => {
    const { supabase } = await boot()
    const admin = createClient('http://localhost:54321', backend!.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
    })
    const created = await admin.auth.admin.createUser({ phone: '+15005550060', password: 'password123', phone_confirm: true })
    expect(created.error).toBeNull()
    expect(created.data.user?.phone).toBe('15005550060')
    const login = await supabase.auth.signInWithPassword({ phone: '+15005550060', password: 'password123' })
    expect(login.error).toBeNull()

    const headers = { 'content-type': 'application/json', apikey: backend!.serviceRoleKey, authorization: `Bearer ${backend!.serviceRoleKey}` }
    const patched = await backend!.fetch(
      new Request('http://localhost:54321/admin/v1/auth-config', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ smsTwilio: { accountSid: 'ACtest', authToken: 'secret-token' } }),
      })
    )
    expect(patched.status).toBe(200)
    const { settings } = (await patched.json()) as { settings: Record<string, any> }
    expect(settings.smsTwilio.accountSid).toBe('ACtest')
    expect(settings.smsTwilio.authToken).toBe('')
    expect(settings.smsTwilioAuthTokenSet).toBe(true)

    // a later edit naming only the service sid keeps the secret
    const again = await backend!.fetch(
      new Request('http://localhost:54321/admin/v1/auth-config', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ smsTwilio: { messageServiceSid: 'MGtest' } }),
      })
    )
    expect(again.status).toBe(200)
    const got = await (await backend!.fetch(new Request('http://localhost:54321/admin/v1/auth-config', { headers }))).json()
    expect(got.settings.smsTwilio).toEqual({ accountSid: 'ACtest', authToken: '', messageServiceSid: 'MGtest' })
    expect(got.settings.smsTwilioAuthTokenSet).toBe(true)
    expect(JSON.stringify(got)).not.toContain('secret-token')
  })

  it('does not freeze an env-supplied credential into the database', async () => {
    // The platform injects the key through the environment (here: the boot
    // defaults). A Studio edit of an unrelated setting must not copy it into
    // auth.config, or a rotated key would never take effect.
    backend = await createBackend({
      authSettings: { phoneEnabled: true, smsTwilio: { accountSid: 'ACenv', authToken: 'env-token', messageServiceSid: '' } },
    })
    const headers = { 'content-type': 'application/json', apikey: backend.serviceRoleKey, authorization: `Bearer ${backend.serviceRoleKey}` }
    await backend.fetch(
      new Request('http://localhost:54321/admin/v1/auth-config', { method: 'PATCH', headers, body: JSON.stringify({ smsAutoconfirm: false }) })
    )
    const row = await backend.db.query(`select value from auth.config where key = 'settings'`)
    const stored = (row.rows[0] as { value: Record<string, any> }).value
    expect(stored.smsTwilio).toEqual({ accountSid: '', authToken: '', messageServiceSid: '' })
    expect(stored.smsAutoconfirm).toBe(false)
  })
})

describe('on the pg-mem subset engine', () => {
  it('runs the phone OTP flow (the one_time_tokens upgrade is pg-mem-safe)', async () => {
    const { createPgmemEngine } = await import('../src/index.js')
    const outbox: SmsMessage[] = []
    backend = await createBackend({
      engine: await createPgmemEngine(),
      smsSender: { send: async (m) => void outbox.push(m) },
      authSettings: { phoneEnabled: true, maxSmsFrequencySeconds: 0 },
    })
    const supabase = createClient('http://localhost:54321', backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
    })
    const sent = await supabase.auth.signInWithOtp({ phone: '+15005550070' })
    expect(sent.error).toBeNull()
    const code = outbox[0].body.match(/\d{6}/)![0]
    const verified = await supabase.auth.verifyOtp({ phone: '+15005550070', token: code, type: 'sms' })
    expect(verified.error).toBeNull()
    expect(verified.data.user?.phone).toBe('15005550070')
    await supabase.auth.signOut()
    // and the email OTP, which writes the same send columns
    const mail = await supabase.auth.signInWithOtp({ email: 'pgmem-otp@example.com' })
    expect(mail.error).toBeNull()
  })
})
