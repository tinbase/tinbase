/**
 * Phone OTP delivery: Twilio's Messages API, which is what Supabase's
 * `[auth.sms.twilio]` provider speaks, so a project's block works unchanged
 * on either.
 *
 * Deliberately a plain REST call rather than the `twilio` package: the API is
 * one form-encoded POST with Basic auth, and a dependency that pulls in half of
 * npm for it would be the heavier choice in a package meant to stay small.
 *
 * `apiUrl` exists for the same reason `TINBASE_RESEND_ENDPOINT` does. A
 * platform hosting many tenants points it at its own Twilio-shaped gateway:
 * the gateway holds the real credential, so no tenant container does, and it
 * can attribute and cap each tenant's sending. The payload is the same either
 * way, which is what makes the provider portable - a self-hoster leaves it at
 * Twilio and uses their own account.
 */
import type { SmsMessage, SmsSender } from '../types.js'

/** `[auth.sms.twilio]`, using Supabase's key names. */
export interface TwilioConfig {
  accountSid: string
  authToken: string
  /** Twilio Messaging Service (MG…) the message is sent through. */
  messageServiceSid?: string
  /** Base URL of the API; default https://api.twilio.com. */
  apiUrl?: string
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch
}

export const DEFAULT_TWILIO_API_URL = 'https://api.twilio.com'

/** The default `[auth.sms] template`: GoTrue's, with `{{ .Code }}` as the OTP. */
export const DEFAULT_SMS_TEMPLATE = 'Your code is {{ .Code }}'

/** Substitute `{{ .Code }}` (any inner spacing, as Go's template syntax allows) into the SMS template. */
export function renderSmsTemplate(template: string, code: string): string {
  return template.replace(/\{\{\s*\.Code\s*\}\}/g, code)
}

/**
 * Normalize a phone number the way GoTrue does: strip formatting, drop the
 * leading `+`, and require E.164's shape (1-15 digits, no leading zero).
 * Returns the bare digits, which is how `auth.users.phone` is stored and what
 * supabase-js hands back in `user.phone`, or null when it is not a phone number.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.trim().replace(/^\+/, '').replace(/[\s().-]/g, '')
  return /^[1-9]\d{1,14}$/.test(digits) ? digits : null
}

/** The E.164 form a provider wants on the wire: the stored digits with `+` in front. */
export function e164(stored: string): string {
  return stored.startsWith('+') ? stored : `+${stored}`
}

export class TwilioSmsSender implements SmsSender {
  private readonly fetch: typeof fetch
  private readonly apiUrl: string

  constructor(private readonly cfg: TwilioConfig) {
    if (!cfg.accountSid) throw new Error('Twilio: account_sid is required')
    if (!cfg.authToken) throw new Error('Twilio: auth_token is required')
    this.fetch = cfg.fetch ?? globalThis.fetch
    this.apiUrl = (cfg.apiUrl || DEFAULT_TWILIO_API_URL).replace(/\/+$/, '')
  }

  async send(msg: SmsMessage): Promise<string | void> {
    const form = new URLSearchParams({ To: e164(msg.to), Body: msg.body })
    if (this.cfg.messageServiceSid) form.set('MessagingServiceSid', this.cfg.messageServiceSid)
    const res = await this.fetch(`${this.apiUrl}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${this.cfg.accountSid}:${this.cfg.authToken}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    // Twilio answers 201 for an accepted message; the body carries the sid and
    // status, or `code` + `message` for a refusal.
    let body: { sid?: string; code?: number; message?: string } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      // The reason without the message body, which carries the OTP.
      const detail = body.message ? ` ${body.message}` : ''
      const code = body.code ? ` (${body.code})` : ''
      throw new Error(`Twilio rejected SMS to ${e164(msg.to)}: HTTP ${res.status}${code}${detail}`)
    }
    return body.sid
  }
}

/** The code a test phone number accepts: digits only, 4 to 10 of them. */
export const TEST_OTP_CODE = /^\d{4,10}$/

/**
 * Supabase's test phone numbers, `[auth.sms.test_otp]`: `<number> = "<code>"`.
 * A listed number is never texted and always accepts its fixed code - for
 * store reviewers' demo accounts and QA against the live app. Keys are kept as
 * bare digits like `auth.users.phone`; an entry that is not a phone number or
 * not a digit code is dropped rather than failing the whole map.
 */
export function normalizeTestOtp(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    const phone = normalizePhone(k)
    if (!phone || typeof v !== 'string') continue
    const code = v.trim()
    if (TEST_OTP_CODE.test(code)) out[phone] = code
  }
  return out
}

/** `TINBASE_SMS_TEST_OTP="4152127777:123456,+15005550006:0000"` - GoTrue's `GOTRUE_SMS_TEST_OTP` shape. */
export function parseTestOtpEnv(value: string): Record<string, string> {
  const raw: Record<string, unknown> = {}
  for (const entry of value.split(',')) {
    const i = entry.lastIndexOf(':')
    if (i < 0) continue
    raw[entry.slice(0, i).trim()] = entry.slice(i + 1).trim()
  }
  return normalizeTestOtp(raw)
}
