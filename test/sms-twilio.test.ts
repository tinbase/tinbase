import { createClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, TwilioSmsSender, normalizePhone, parseTestOtpEnv, type TinbaseBackend } from '../src/index.js'
import { Database } from '../src/db/database.js'
import { BOOTSTRAP_SQL } from '../src/db/bootstrap.js'

/**
 * The built-in Twilio provider: Supabase's `[auth.sms.twilio]` on the wire -
 * one form-encoded POST to the Messages API with Basic auth - and `api_url`,
 * which points that same request at a Twilio-compatible gateway.
 */
let backend: TinbaseBackend | undefined
afterEach(async () => {
  await backend?.close()
  backend = undefined
})

interface Captured {
  url: string
  headers: Record<string, string>
  body: string
}

function fakeTwilio(captured: Captured[], reply: { status: number; body: unknown } = { status: 201, body: { sid: 'SMfake', status: 'queued' } }) {
  const fetchImpl: typeof fetch = async (input, init) => {
    captured.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body ?? ''),
    })
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }
  return fetchImpl
}

describe('TwilioSmsSender', () => {
  it('posts To/MessagingServiceSid/Body form-encoded with Basic auth, and returns the sid', async () => {
    const captured: Captured[] = []
    const sender = new TwilioSmsSender({
      accountSid: 'ACabc',
      authToken: 'tok',
      messageServiceSid: 'MGxyz',
      fetch: fakeTwilio(captured),
    })
    const sid = await sender.send({ to: '+15005550006', body: 'Your code is 123456' })
    expect(sid).toBe('SMfake')
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACabc/Messages.json')
    expect(captured[0].headers.authorization).toBe(`Basic ${btoa('ACabc:tok')}`)
    expect(captured[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(captured[0].body)
    expect(form.get('To')).toBe('+15005550006')
    expect(form.get('MessagingServiceSid')).toBe('MGxyz')
    expect(form.get('Body')).toBe('Your code is 123456')
  })

  it('api_url sends the same request to a gateway instead', async () => {
    const captured: Captured[] = []
    const sender = new TwilioSmsSender({ accountSid: 'proj_1', authToken: 'rn_svc_key', apiUrl: 'https://services.example.com/sms/', fetch: fakeTwilio(captured) })
    await sender.send({ to: '+15005550006', body: 'hi' })
    expect(captured[0].url).toBe('https://services.example.com/sms/2010-04-01/Accounts/proj_1/Messages.json')
    expect(captured[0].headers.authorization).toBe(`Basic ${btoa('proj_1:rn_svc_key')}`)
  })

  it('surfaces a refusal with Twilio\'s code and message, without the body', async () => {
    const captured: Captured[] = []
    const sender = new TwilioSmsSender({
      accountSid: 'ACabc',
      authToken: 'tok',
      fetch: fakeTwilio(captured, { status: 400, body: { code: 21211, message: "The 'To' number is not a valid phone number." } }),
    })
    await expect(sender.send({ to: '+15005550001', body: 'Your code is 999999' })).rejects.toThrow(/HTTP 400 \(21211\) The 'To' number/)
    await expect(sender.send({ to: '+15005550001', body: 'Your code is 999999' })).rejects.not.toThrow(/999999/)
  })

  it('needs both credentials', () => {
    expect(() => new TwilioSmsSender({ accountSid: '', authToken: 'x' })).toThrow(/account_sid/)
    expect(() => new TwilioSmsSender({ accountSid: 'AC', authToken: '' })).toThrow(/auth_token/)
  })
})

describe('the backend sends through Twilio from the runtime settings', () => {
  it('uses [auth.sms.twilio] credentials and api_url, and the log says so without the code', async () => {
    const captured: Captured[] = []
    backend = await createBackend({
      smsFetch: fakeTwilio(captured),
      smsApiUrl: 'https://gateway.example.com',
      authSettings: {
        phoneEnabled: true,
        maxSmsFrequencySeconds: 0,
        smsTwilio: { accountSid: 'proj_42', authToken: 'rn_svc_abc', messageServiceSid: '' },
      },
    })
    const supabase = createClient('http://localhost:54321', backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
    })
    const r = await supabase.auth.signInWithOtp({ phone: '+15005550006' })
    expect(r.error).toBeNull()
    expect(r.data.messageId).toBe('SMfake')
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://gateway.example.com/2010-04-01/Accounts/proj_42/Messages.json')
    const form = new URLSearchParams(captured[0].body)
    expect(form.has('MessagingServiceSid')).toBe(false)
    const code = form.get('Body')!.match(/\d{6}/)![0]
    const logs = backend.logs.list(500).map((l) => l.msg).join('\n')
    expect(logs).toContain('[sms] to=+15005550006')
    expect(logs).not.toContain(code)
    // the code the gateway received is the one that verifies
    const verified = await supabase.auth.verifyOtp({ phone: '+15005550006', token: code, type: 'sms' })
    expect(verified.error).toBeNull()
    // /settings names the provider
    const settings = await (await backend.fetch(new Request('http://localhost:54321/auth/v1/settings', { headers: { apikey: backend.anonKey } }))).json()
    expect(settings.sms_provider).toBe('twilio')
  })

  it('a provider refusal fails the request and is logged, and no send window is spent', async () => {
    const captured: Captured[] = []
    backend = await createBackend({
      smsFetch: fakeTwilio(captured, { status: 429, body: { code: 20429, message: 'Too Many Requests' } }),
      authSettings: {
        phoneEnabled: true,
        maxSmsFrequencySeconds: 60,
        smsTwilio: { accountSid: 'AC', authToken: 'tok', messageServiceSid: 'MG' },
      },
    })
    const supabase = createClient('http://localhost:54321', backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
    })
    const r = await supabase.auth.signInWithOtp({ phone: '+15005550006' })
    expect(r.error).not.toBeNull()
    expect(r.error?.status).toBe(500)
    // GoTrue's code and wording for a provider refusal, with the provider's reason. Read off the
    // wire: supabase-js folds any 5xx into a retryable fetch error and drops the code, as it does
    // against GoTrue itself.
    const raw = await backend.fetch(
      new Request('http://localhost:54321/auth/v1/otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: backend.anonKey },
        body: JSON.stringify({ phone: '+15005550007' }),
      })
    )
    expect(raw.status).toBe(500)
    const body = (await raw.json()) as { error_code: string; msg: string }
    expect(body.error_code).toBe('sms_send_failed')
    expect(body.msg).toMatch(/^Error sending sms OTP: .*Too Many Requests/)
    // and the code minted for the failed send is gone: nothing a guess could redeem
    const left = await backend.db.query(`select count(*)::int as n from auth.one_time_tokens where token_type = 'sms'`)
    expect((left.rows[0] as { n: number }).n).toBe(0)
    expect(backend.logs.list(500).some((l) => l.msg.startsWith('[sms] FAILED to=+15005550006'))).toBe(true)
    // the text never went out, so max_frequency has nothing to measure from
    const again = await supabase.auth.signInWithOtp({ phone: '+15005550006' })
    expect(again.error?.code).not.toBe('over_sms_send_rate_limit')
    expect(captured).toHaveLength(3)
  })
})

describe('normalizePhone', () => {
  it('accepts E.164 with or without formatting and returns bare digits', () => {
    expect(normalizePhone('+15005550006')).toBe('15005550006')
    expect(normalizePhone(' +1 (500) 555-0006 ')).toBe('15005550006')
    expect(normalizePhone('15005550006')).toBe('15005550006')
    expect(normalizePhone('+919876543210')).toBe('919876543210')
  })
  it('refuses what is not a phone number', () => {
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone('+0123')).toBeNull()
    expect(normalizePhone('555-CALL-NOW')).toBeNull()
    expect(normalizePhone('+1234567890123456')).toBeNull()
  })
})

describe('parseTestOtpEnv', () => {
  it("reads GoTrue's \"<number>:<code>,…\" form and drops what is not a number or a digit code", () => {
    expect(parseTestOtpEnv('4152127777:123456, +1 (500) 555-0006:0000, junk, 123:abc, :1234')).toEqual({
      '4152127777': '123456',
      '15005550006': '0000',
    })
    expect(parseTestOtpEnv('')).toEqual({})
  })
})

describe('schema upgrade', () => {
  it('adds the phone column and relaxes email on a database made before 0.21.0', async () => {
    backend = await createBackend()
    // Put the table back the way < 0.21.0 created it.
    await backend.db.query(`delete from auth.one_time_tokens`)
    await backend.db.query(`alter table auth.one_time_tokens drop column phone`)
    await backend.db.query(`alter table auth.one_time_tokens alter column email set not null`)
    // The bootstrap runs on every start; re-running it is what a restart does.
    await backend.db.engine.exec(BOOTSTRAP_SQL)
    const cols = await backend.db.query(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'auth' and table_name = 'one_time_tokens' and column_name in ('email', 'phone')
       order by column_name`
    )
    expect(cols.rows).toEqual([
      { column_name: 'email', is_nullable: 'YES' },
      { column_name: 'phone', is_nullable: 'YES' },
    ])
    expect(Database).toBeDefined()
  })
})
