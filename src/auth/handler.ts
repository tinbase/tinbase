/**
 * GoTrue-compatible auth endpoints (/auth/v1/*) - the subset supabase-js
 * uses for email/password auth, sessions, and admin user management.
 */
import type { Database } from '../db/database.js'
import { randomToken, signJwt, verifyJwt, type JwtClaims } from '../jwt.js'
import { TINBASE_VERSION, type Mailer, type RequestContext } from '../types.js'
import { OAuthService, type OAuthProviderConfig } from './oauth.js'
import { hashPassword, verifyPassword } from './password.js'
import { qrSvgDataUri } from './qr.js'
import { DEFAULT_AUTH_SETTINGS, type AuthSettings } from './settings.js'
import { resolveRedirect } from './redirect.js'
import { htmlToText, renderTemplate, type EmailTemplateName, type EmailTemplates } from './templates.js'
import { callSendEmailHook, type EmailActionType, type SendEmailHookConfig } from './send-email-hook.js'
import { RateLimiter } from './rate-limit.js'
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js'

/** Construction-time config for {@link AuthHandler}. */
export interface AuthConfig {
  /** HS256 secret used to sign and verify access tokens */
  jwtSecret: string
  /**
   * Where the *application* lives. The default redirect when a link carries no
   * `redirect_to` or one the allowlist refuses, and what `{{ .SiteURL }}`
   * interpolates to in an email template.
   *
   * This is GoTrue's `SITE_URL`, and it is not where this server answers - see
   * {@link apiExternalUrl}.
   */
  siteUrl: string
  /**
   * Where *this server* answers, as a mail client can reach it. Emailed links
   * are built on it and it is the token issuer.
   *
   * Separate from {@link siteUrl} because the two are different machines: a
   * link has to come back here to be verified, while a user who finishes the
   * flow belongs on the app. Collapsing them forces a choice between links
   * that resolve and a redirect that lands somewhere useful - set to the API,
   * every fallback dumps the user on this server's root; set to the app, no
   * emailed link works at all.
   *
   * Defaults to {@link siteUrl}, which is the pre-0.17 behaviour.
   */
  apiExternalUrl?: string
  /** Access-token lifetime in seconds. */
  jwtExpiry: number
  /** Force sign-out after this many seconds (config.toml auth.sessions.timebox). Caps session lifetime. */
  sessionTimeboxSeconds?: number
  /** sends outgoing auth email (magic links, OTP codes, recovery) */
  mailer: Mailer
  /**
   * Per-type HTML overrides from `[auth.email.template.*]`. A project that
   * supplies one decides for itself what the mail offers - link, code, both, or
   * a link straight to its own page - by which variables it interpolates.
   * Types without an override keep the built-in default.
   */
  emailTemplates?: EmailTemplates
  /**
   * `[auth.hook.send_email]`. When set, the email is handed to this endpoint
   * instead of being rendered and sent here - the endpoint owns the wording,
   * the format and the provider.
   */
  sendEmailHook?: SendEmailHookConfig
  /** Injectable fetch for the hook (tests capture the request). */
  hookFetch?: typeof fetch
  /** OAuth providers to enable, keyed by provider name (google, github, …) */
  oauthProviders?: Record<string, OAuthProviderConfig>
  /** injectable fetch for the OAuth provider calls (tests use a mock provider) */
  oauthFetch?: typeof fetch
  /**
   * Additional redirect targets allowed beyond the site URL's own origin
   * (GoTrue's URI_ALLOW_LIST). Entries may use `*`/`**` globs. A `redirect_to`
   * that matches neither the site origin nor an entry falls back to the site URL.
   */
  uriAllowList?: string[]
  /**
   * Enforce the redirect allowlist strictly. Off for local dev (any well-formed
   * URL is honored, like `supabase start`); the backend turns it on when
   * network-exposed so redirects can't leave the allowed origins.
   */
  enforceRedirectAllowList?: boolean
  /**
   * Runtime-mutable toggles (signups, anonymous users, autoconfirm…). The
   * admin API mutates this same object in place, so changes apply instantly.
   */
  settings?: AuthSettings
  /**
   * Rate limiter for login/signup/OTP/recovery. Defaults to a fresh in-memory
   * limiter with GoTrue-shaped windows; pass `null` to disable (e.g. tests).
   */
  rateLimiter?: RateLimiter | null
}

interface UserRow {
  id: string
  aud: string | null
  role: string | null
  email: string | null
  encrypted_password: string | null
  email_confirmed_at: Date | string | null
  last_sign_in_at: Date | string | null
  raw_app_meta_data: Record<string, unknown> | null
  raw_user_meta_data: Record<string, unknown> | null
  created_at: Date | string | null
  updated_at: Date | string | null
  phone: string | null
  phone_confirmed_at: Date | string | null
  is_anonymous: boolean | null
}

function authError(status: number, errorCode: string, msg: string): Response {
  return json(status, { code: status, error_code: errorCode, msg })
}

/**
 * The per-request inputs supabase-js attaches to an email-sending call.
 *
 * `redirectTo` is the `?redirect_to=` query param set by `emailRedirectTo` /
 * `resetPasswordForEmail(email, { redirectTo })`. `codeChallenge` and
 * `codeChallengeMethod` are the body fields a `flowType: 'pkce'` client
 * sends; their presence is what selects the PKCE variant of the link.
 */
/**
 * The `auth.users` timestamp a flow measures `max_frequency` against, using
 * GoTrue's column for that flow. These are schema columns, never caller input.
 */
type SentAtColumn = 'confirmation_sent_at' | 'recovery_sent_at' | 'email_change_sent_at' | 'reauthentication_sent_at'

interface EmailFlowOptions {
  flavor?: 'login' | 'confirm'
  redirectTo?: string | null
  codeChallenge?: string | null
  codeChallengeMethod?: string | null
}

/** Escape a value for interpolation into HTML text or an attribute. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * The HTML body of an auth email: a real `<a href>` for the link, plus the code.
 *
 * A text-only mail leaves the client to find the URL by pattern-matching, and a
 * long auth link (query string, percent-encoded `redirect_to`) defeats that -
 * Gmail on Android linkified only `https://<host>` of a 210-character recovery
 * link and dropped `/auth/v1/verify?...`, so the tap landed on the API root.
 * With an anchor the target is declared, not inferred.
 *
 * Deliberately plain inline HTML: no images, no external CSS, no web fonts -
 * the things that get stripped, blocked, or land mail in spam.
 */
function authEmailHtml(o: { lead: string; action: string; link: string; code: string | null }): string {
  const href = escapeHtml(o.link)
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a">`,
    `<p style="margin:0 0 20px">${escapeHtml(o.lead)}</p>`,
    `<p style="margin:0 0 24px"><a href="${href}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px">${escapeHtml(o.action)}</a></p>`,
    ...(o.code
      ? [
          `<p style="margin:0 0 8px;color:#666;font-size:14px">Or use this code:</p>`,
          `<p style="margin:0 0 24px;font-size:24px;letter-spacing:3px;font-weight:600">${escapeHtml(o.code)}</p>`,
        ]
      : []),
    `<p style="margin:0;color:#888;font-size:13px">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(o.link)}</span></p>`,
    `</div>`,
  ].join('')
}

/** A cryptographically-random numeric OTP of `length` digits (6-10). */
/**
 * Whether knowing `token` proves nothing on its own.
 *
 * An OTP is six to ten digits - a few hundred thousand guesses, which is
 * nothing without the address it was sent to. The link token is 24 random
 * bytes in base64url, which is not guessable and is all an emailed link can
 * carry, so it stays redeemable unscoped.
 *
 * Decided from the token itself rather than from `token_type`, because both
 * rows a recovery mints share one type - the shape is the only honest
 * discriminator.
 */
function isGuessableToken(token: string): boolean {
  return token.length < 20 || /^\d+$/.test(token)
}

function randomOtp(length: number): string {
  const n = Math.max(6, Math.min(10, Math.floor(length)))
  const buf = new Uint32Array(n)
  crypto.getRandomValues(buf)
  let code = ''
  for (let i = 0; i < n; i++) code += String(buf[i] % 10)
  return code
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

/** Routes and services the GoTrue-compatible `/auth/v1/*` endpoints. */
export class AuthHandler {
  private oauth: OAuthService
  /** Shared, runtime-mutable settings - read on every request, never copied. */
  private settings: AuthSettings
  private rateLimiter: RateLimiter | null

  constructor(
    private db: Database,
    private config: AuthConfig
  ) {
    this.oauth = new OAuthService(
      db,
      config.siteUrl,
      config.apiExternalUrl || config.siteUrl,
      config.oauthProviders ?? {},
      config.oauthFetch ?? fetch,
      config.uriAllowList,
      config.enforceRedirectAllowList
    )
    this.settings = config.settings ?? { ...DEFAULT_AUTH_SETTINGS }
    this.rateLimiter = config.rateLimiter === undefined ? new RateLimiter() : config.rateLimiter
  }

  /**
   * Where this server answers: emailed links come back here, and tokens are
   * issued by it. Falls back to the site URL, which is what a deployment that
   * has not separated the two is already using for both.
   */
  private get apiUrl(): string {
    return this.config.apiExternalUrl || this.config.siteUrl
  }

  /**
   * Enforce the rate limit for `action`, keyed by client address. Returns a 429
   * (GoTrue's `over_request_rate_limit`) when exceeded, else null to proceed.
   */
  private limit(action: string, req: Request): Response | null {
    if (!this.rateLimiter) return null
    const client = req.headers.get('x-tinbase-remote-addr') ?? 'local'
    const retryAfter = this.rateLimiter.check(action, client)
    if (retryAfter === null) return null
    return new Response(
      JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
      { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfter) } }
    )
  }

  /** GoTrue's 429 for `max_frequency`, with the seconds the caller must wait. */
  private static tooSoon(retryAfter: number): Response {
    return new Response(
      JSON.stringify({
        code: 429,
        error_code: 'over_email_send_rate_limit',
        msg: `For security purposes, you can only request this after ${retryAfter} seconds.`,
      }),
      { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfter) } }
    )
  }

  /**
   * Enforce `max_frequency` the way GoTrue does: against the timestamp that
   * flow last wrote on the user row, not against one budget per address.
   *
   * Which column a flow measures itself by is GoTrue's mapping, quirks
   * included - a magic link is measured by `recovery_sent_at`, the same column
   * password recovery uses, because GoTrue mints both from the recovery token.
   * Sharing that budget is therefore correct rather than an oversight; a
   * confirmation, by contrast, has its own. An app that sets `max_frequency`
   * in config.toml gets the pacing Supabase's docs describe, which is the
   * point of spelling it the same way.
   *
   * An address with no account has no row to measure, so those fall back to an
   * in-memory window keyed the same way. GoTrue simply lets them through,
   * which makes a 429 proof that an account exists - `/recover` answers 200
   * for an address it has never seen precisely so the response cannot be used
   * to enumerate accounts, and a frequency check that only ever fires for real
   * users hands that back. The fallback keeps the two indistinguishable.
   */
  private async limitEmailFrequency(email: string, column: SentAtColumn): Promise<Response | null> {
    const seconds = this.settings.maxEmailFrequencySeconds
    if (!seconds || seconds <= 0) return null
    const normalized = email.toLowerCase().trim()

    // `column` is one of the four literals in SentAtColumn, never caller input.
    const res = await this.db.query(
      `select extract(epoch from (now() - ${column}))::int as elapsed
       from auth.users where email = $1`,
      [normalized]
    )
    const row = res.rows[0] as { elapsed: number | null } | undefined

    if (row) {
      // A row exists: the column is the authority, and it survives a restart,
      // which an in-memory counter does not.
      if (row.elapsed !== null && row.elapsed < seconds) {
        return AuthHandler.tooSoon(Math.max(1, seconds - row.elapsed))
      }
      return null
    }

    if (!this.rateLimiter) return null
    const retryAfter = this.rateLimiter.check(`email_frequency:${column}`, normalized, Date.now(), {
      limit: 1,
      windowMs: seconds * 1000,
    })
    return retryAfter === null ? null : AuthHandler.tooSoon(retryAfter)
  }

  /**
   * Record that this flow has just mailed the address, so the next request is
   * measured from now. Written only after the mail was accepted - a transport
   * that refused it has not spent the window.
   */
  private async markEmailSent(userId: string, column: SentAtColumn): Promise<void> {
    await this.db.query(`update auth.users set ${column} = now() where id = $1`, [userId])
  }

  /** Stop background timers (rate-limiter sweep). Called on backend close. */
  stop(): void {
    this.rateLimiter?.stop()
  }

  /** Dispatch one `/auth/v1/*` request. Any thrown error becomes a 500 `unexpected_failure`. */
  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/auth\/v1\/?/, '').replace(/\/+$/, '')
    const method = req.method.toUpperCase()

    try {
      if (path === 'health') return json(200, { name: 'tinbase-auth', version: TINBASE_VERSION, description: 'GoTrue-compatible auth' })
      if (path === 'settings') {
        const providers = Object.keys(this.config.oauthProviders ?? {})
        return json(200, {
          external: {
            email: true,
            phone: false,
            anonymous_users: this.settings.anonymousUsers,
            ...Object.fromEntries(providers.map((p) => [p, !this.settings.disabledProviders.includes(p)])),
          },
          disable_signup: this.settings.disableSignup,
          autoconfirm: this.settings.autoconfirm,
          mailer_autoconfirm: this.settings.autoconfirm,
          minimum_password_length: this.settings.minPasswordLength,
        })
      }
      if (path === 'signup' && method === 'POST') return this.limit('signup', req) ?? (await this.signup(req, url))
      if (path === 'token' && method === 'POST') return this.limit('token', req) ?? (await this.token(req, url))
      if (path === 'user' && method === 'GET') return await this.getUser(req)
      if (path === 'user' && method === 'PUT') return await this.updateUser(req)
      if (path === 'logout' && method === 'POST') return await this.logout(req)
      if (path === 'otp' && method === 'POST') return this.limit('otp', req) ?? (await this.sendOtp(req, url))
      if (path === 'recover' && method === 'POST') return this.limit('recover', req) ?? (await this.sendRecovery(req, url))
      if (['magiclink', 'resend'].includes(path) && method === 'POST')
        return this.limit('otp', req) ?? (await this.sendOtp(req, url))
      if (path === 'verify' && method === 'POST') return this.limit('verify', req) ?? (await this.verifyToken(req))
      // Deliberately unlimited, unlike the POST above: a link carries no email,
      // so after the scoping guard in redeem() this path can only redeem the
      // 24-byte link token. There is nothing here left to guess.
      if (path === 'verify' && method === 'GET') return await this.verifyLink(url)
      if (path === 'factors' && method === 'POST') return await this.enrollFactor(req)
      if (/^factors\/[^/]+\/challenge$/.test(path) && method === 'POST')
        return await this.challengeFactor(req, path.split('/')[1])
      if (/^factors\/[^/]+\/verify$/.test(path) && method === 'POST')
        return await this.verifyFactor(req, path.split('/')[1])
      if (/^factors\/[^/]+$/.test(path) && method === 'DELETE')
        return await this.unenrollFactor(req, path.split('/')[1])
      if (path === 'authorize' && method === 'GET') {
        const provider = url.searchParams.get('provider') ?? ''
        if (provider && this.settings.disabledProviders.includes(provider)) {
          return authError(422, 'provider_disabled', `Sign-ins with ${provider} are disabled`)
        }
        return await this.oauth.authorize(url)
      }
      if (path === 'callback' && (method === 'GET' || method === 'POST')) {
        return await this.oauth.callback(url, (userId) => this.sessionTokensFor(userId))
      }
      if (path.startsWith('admin/')) return await this.admin(req, ctx, path, method)
      return authError(404, 'not_found', `unknown auth endpoint: ${path}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return authError(500, 'unexpected_failure', msg)
    }
  }

  // ── flows ─────────────────────────────────────────────────────────────

  private async signup(req: Request, url: URL): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      password?: string
      data?: Record<string, unknown>
      code_challenge?: string
      code_challenge_method?: string
    }

    if (!body.email && !body.password) {
      // supabase.auth.signInAnonymously()
      if (!this.settings.anonymousUsers) {
        return authError(422, 'anonymous_provider_disabled', 'Anonymous sign-ins are disabled')
      }
      const res = await this.db.query(
        `insert into auth.users (aud, role, raw_app_meta_data, raw_user_meta_data, is_anonymous, last_sign_in_at)
         values ('authenticated', 'authenticated', '{}', $1, true, now())
         returning *`,
        [JSON.stringify(body.data ?? {})]
      )
      return json(200, await this.sessionFor(res.rows[0] as UserRow))
    }

    if (this.settings.disableSignup) {
      return authError(422, 'signup_disabled', 'Signups not allowed for this instance')
    }
    if (!body.email || !body.password) {
      return authError(400, 'validation_failed', 'Signup requires a valid email and password')
    }
    if (body.password.length < this.settings.minPasswordLength) {
      return authError(422, 'weak_password', `Password should be at least ${this.settings.minPasswordLength} characters.`)
    }
    const email = body.email.toLowerCase().trim()
    const existing = await this.db.query(`select id from auth.users where email = $1`, [email])
    if (existing.rows.length > 0) {
      return authError(422, 'user_already_exists', 'User already registered')
    }
    // A signup that has to be confirmed sends mail, so it belongs under the
    // same per-recipient budget as /otp and /recover. Repeating a signup was
    // never the way to abuse that - the second is refused as
    // `user_already_exists` before any mail is considered - but the
    // confirmation not counting meant the three flows that can mail an address
    // each spent the window separately, putting more into one inbox than
    // `max_frequency` allows.
    //
    // Checked before the row is written, so a refusal leaves no half-made
    // account behind, and only when confirmation is on: under autoconfirm
    // there is no email to pace, and spending the budget would block a flow
    // that would actually use it.
    const autoconfirm = this.settings.autoconfirm
    if (!autoconfirm) {
      const tooSoon = await this.limitEmailFrequency(email, 'confirmation_sent_at')
      if (tooSoon) return tooSoon
    }
    const hashed = await hashPassword(body.password)
    const res = await this.db.query(
      `insert into auth.users
         (aud, role, email, encrypted_password, email_confirmed_at, last_sign_in_at,
          raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', $1, $2, case when $4 then now() else null end, now(),
               '{"provider":"email","providers":["email"]}', $3)
       returning *`,
      [email, hashed, JSON.stringify(body.data ?? {}), autoconfirm]
    )
    const newUser = res.rows[0] as UserRow
    // GoTrue records an `email` identity at signup, so user.identities reflects
    // the email provider (getUser returned [] before this). Mirrors the shape
    // written on anonymous-to-email upgrade.
    await this.db.query(
      `insert into auth.identities (user_id, provider, provider_id, identity_data)
       values ($1, 'email', $2, $3)
       on conflict (provider, provider_id) do nothing`,
      [newUser.id, newUser.id, JSON.stringify({ sub: newUser.id, email: newUser.email })]
    )
    await this.audit('user_signedup', { actorId: newUser.id, actorEmail: email })
    if (!autoconfirm) {
      // confirmation required: email a verification link/code; no session yet
      await this.issueToken(email, 'otp', false, {
        flavor: 'confirm',
        redirectTo: url.searchParams.get('redirect_to'),
        ...AuthHandler.pkceFrom(body),
      })
      return json(200, this.userJson(newUser))
    }
    return json(200, await this.sessionFor(newUser))
  }

  private async token(req: Request, url: URL): Promise<Response> {
    const grantType = url.searchParams.get('grant_type')
    const body = (await req.json().catch(() => ({}))) as Record<string, string>

    if (grantType === 'password') {
      const email = (body.email ?? '').toLowerCase().trim()
      const res = await this.db.query(`select * from auth.users where email = $1`, [email])
      const user = res.rows[0] as UserRow | undefined
      if (!user || !user.encrypted_password || !(await verifyPassword(body.password ?? '', user.encrypted_password))) {
        await this.audit('login_failed', { actorEmail: email, traits: { grant_type: 'password' } })
        return authError(400, 'invalid_credentials', 'Invalid login credentials')
      }
      // when confirmation is required, unverified accounts cannot sign in yet
      if (!this.settings.autoconfirm && !user.email_confirmed_at) {
        return authError(400, 'email_not_confirmed', 'Email not confirmed')
      }
      await this.db.query(`update auth.users set last_sign_in_at = now() where id = $1`, [user.id])
      await this.audit('login', { actorId: user.id, actorEmail: user.email, traits: { grant_type: 'password' } })
      return json(200, await this.sessionFor(user))
    }

    if (grantType === 'refresh_token') {
      const token = body.refresh_token
      if (!token) return authError(400, 'validation_failed', 'refresh_token required')
      const res = await this.db.query(
        `select rt.*, u.id as uid from auth.refresh_tokens rt
         join auth.users u on u.id = rt.user_id
         where rt.token = $1`,
        [token]
      )
      const row = res.rows[0] as { revoked: boolean; user_id: string; session_id: string | null } | undefined
      if (!row || row.revoked) {
        return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
      }
      // A logout deletes the session but leaves its refresh tokens revoked; if
      // the session is gone, the refresh token must not resurrect it.
      if (row.session_id) {
        const live = await this.db.query(`select 1 from auth.sessions where id = $1`, [row.session_id])
        if (live.rows.length === 0) {
          return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
        }
      }
      await this.db.query(`update auth.refresh_tokens set revoked = true, updated_at = now() where token = $1`, [token])
      const ures = await this.db.query(`select * from auth.users where id = $1`, [row.user_id])
      return json(200, await this.sessionFor(ures.rows[0] as UserRow, token, { sessionId: row.session_id ?? undefined }))
    }

    if (grantType === 'pkce') {
      const authCode = body.auth_code
      const verifier = body.code_verifier
      if (!authCode || !verifier) return authError(400, 'validation_failed', 'auth_code and code_verifier required')
      const userId = await this.oauth.exchangePkce(authCode, verifier)
      if (!userId) return authError(403, 'flow_state_not_found', 'invalid or expired auth code')
      const ures = await this.db.query(`select * from auth.users where id = $1`, [userId])
      return json(200, await this.sessionFor(ures.rows[0] as UserRow))
    }

    return authError(400, 'invalid_grant', `unsupported grant_type: ${grantType}`)
  }

  private async getUser(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'Invalid or expired token')
    return json(200, this.userJson(user, await this.getUserFactors(user.id), await this.getUserIdentities(user.id)))
  }

  private async updateUser(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'Invalid or expired token')
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      password?: string
      data?: Record<string, unknown>
    }
    const sets: string[] = []
    const params: unknown[] = []
    // Upgrading an anonymous user to a permanent one: adding an email (and
    // usually a password) keeps the same id + data, flips is_anonymous off, and
    // records an email identity - matching supabase.auth.updateUser({ email }).
    const upgradingAnon = (user.is_anonymous ?? false) && !!body.email
    if (body.email) {
      const email = body.email.toLowerCase().trim()
      const clash = await this.db.query(`select id from auth.users where email = $1 and id <> $2`, [email, user.id])
      if (clash.rows.length > 0) {
        return authError(422, 'email_exists', 'A user with this email address has already been registered')
      }
      params.push(email)
      sets.push(`email = $${params.length}, email_confirmed_at = now()`)
    }
    if (body.password) {
      if (body.password.length < this.settings.minPasswordLength) {
        return authError(422, 'weak_password', `Password should be at least ${this.settings.minPasswordLength} characters.`)
      }
      params.push(await hashPassword(body.password))
      sets.push(`encrypted_password = $${params.length}`)
    }
    if (body.data) {
      params.push(JSON.stringify(body.data))
      sets.push(`raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $${params.length}::jsonb`)
    }
    if (upgradingAnon) {
      sets.push(`is_anonymous = false`)
      sets.push(`raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"provider":"email","providers":["email"]}'::jsonb`)
    }
    if (sets.length === 0) return json(200, this.userJson(user))
    params.push(user.id)
    const res = await this.db.query(
      `update auth.users set ${sets.join(', ')}, updated_at = now() where id = $${params.length} returning *`,
      params
    )
    const updated = res.rows[0] as UserRow
    if (upgradingAnon) {
      // record the email identity, unless one somehow already exists
      await this.db.query(
        `insert into auth.identities (user_id, provider, provider_id, identity_data)
         values ($1, 'email', $2, $3)
         on conflict (provider, provider_id) do nothing`,
        [updated.id, updated.id, JSON.stringify({ sub: updated.id, email: updated.email })]
      )
    }
    return json(200, this.userJson(updated))
  }

  /**
   * POST /auth/v1/logout[?scope=global|local|others]
   *
   * Deleting the session rows is what makes the logout observable: the access
   * token stays cryptographically valid, so `/user` has to be able to see that
   * its session is gone. Refresh tokens are revoked alongside, as before.
   */
  private async logout(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (user) {
      const scope = new URL(req.url).searchParams.get('scope') ?? 'global'
      const current = await this.sessionIdFromBearer(req)
      if (scope === 'local' && current) {
        await this.db.query(`delete from auth.sessions where id = $1`, [current])
        await this.db.query(`update auth.refresh_tokens set revoked = true, updated_at = now() where session_id = $1`, [
          current,
        ])
      } else if (scope === 'others' && current) {
        await this.db.query(`delete from auth.sessions where user_id = $1 and id <> $2`, [user.id, current])
        await this.db.query(
          `update auth.refresh_tokens set revoked = true, updated_at = now()
           where user_id = $1 and (session_id is null or session_id <> $2)`,
          [user.id, current]
        )
      } else {
        // global, and the fallback when a token carries no session to scope by
        await this.db.query(`delete from auth.sessions where user_id = $1`, [user.id])
        await this.db.query(`update auth.refresh_tokens set revoked = true, updated_at = now() where user_id = $1`, [
          user.id,
        ])
      }
      await this.audit('logout', { actorId: user.id, actorEmail: user.email, traits: { scope } })
    }
    return new Response(null, { status: 204 })
  }

  // ── OTP / magic links / recovery ──────────────────────────────────────

  /**
   * Create-or-find the user for `email` and mint its one-time code + link token
   * pair, replacing any live tokens of the same type.
   *
   * Shared by the email-sending flows ({@link issueToken}) and the admin
   * `generate_link` endpoint, which needs the very same tokens but hands them
   * back to the caller instead of mailing them. Keeping one implementation is
   * what stops the two from disagreeing about expiry, replacement, or which
   * `token_type` rows get written - a link that `verify` can't redeem is worse
   * than no link at all.
   */
  private async mintOneTimeToken(
    email: string,
    tokenType: 'otp' | 'recovery',
    createUser: boolean
  ): Promise<{ user: UserRow; code: string; linkToken: string } | { error: Response }> {
    const normalized = email.toLowerCase().trim()
    let res = await this.db.query(`select * from auth.users where email = $1`, [normalized])
    let user = res.rows[0] as UserRow | undefined
    if (!user) {
      if (!createUser) return { error: authError(422, 'otp_disabled', 'Signups not allowed for otp') }
      if (this.settings.disableSignup)
        return { error: authError(422, 'signup_disabled', 'Signups not allowed for this instance') }
      res = await this.db.query(
        `insert into auth.users (aud, role, email, raw_app_meta_data, raw_user_meta_data)
         values ('authenticated', 'authenticated', $1, '{"provider":"email","providers":["email"]}', '{}')
         returning *`,
        [normalized]
      )
      user = res.rows[0] as UserRow
    }
    const code = randomOtp(this.settings.otpLength)
    const linkToken = randomToken(24)
    const expiry = `${this.settings.otpExpirySeconds} seconds`
    await this.db.query(`delete from auth.one_time_tokens where email = $1 and token_type = $2`, [normalized, tokenType])
    await this.db.query(
      `insert into auth.one_time_tokens (user_id, email, token_type, token, expires_at)
       values ($1, $2, $3, $4, now() + $7::interval), ($1, $2, $5, $6, now() + $7::interval)`,
      [user.id, normalized, tokenType, code, tokenType === 'otp' ? 'magiclink' : tokenType, linkToken, expiry]
    )
    return { user, code, linkToken }
  }

  /** Pull the PKCE fields out of a request body, or nothing when the client is on the implicit flow. */
  private static pkceFrom(body: { code_challenge?: string; code_challenge_method?: string }): Pick<EmailFlowOptions, 'codeChallenge' | 'codeChallengeMethod'> {
    return { codeChallenge: body.code_challenge ?? null, codeChallengeMethod: body.code_challenge_method ?? null }
  }

  /**
   * Mint a one-time token for `email` and mail the link + code.
   *
   * GoTrue bakes `redirect_to` into the emailed link so that clicking it lands
   * the user on the app's own screen (e.g. `/reset-password`); omitting it
   * would send every link to the bare site URL instead. It goes through the
   * same allow-list as {@link verifyLink} so a request can't mint a link that
   * redirects to an origin the operator hasn't allowed.
   *
   * With a PKCE challenge, the challenge is parked in `auth.flow_state` under
   * the link token (GoTrue does the same, `provider = 'email'`). Clicking the
   * link then yields `?code=` for `exchangeCodeForSession` instead of putting
   * the session tokens in the URL fragment - see {@link verifyLink}. The
   * 6-digit code path (`verifyOtp`) is unaffected: it returns a session
   * directly in both flows, as in GoTrue.
   */
  private async issueToken(
    email: string,
    tokenType: 'otp' | 'recovery',
    createUser: boolean,
    opts: EmailFlowOptions = {}
  ): Promise<Response> {
    const flavor = opts.flavor ?? 'login'
    const minted = await this.mintOneTimeToken(email, tokenType, createUser)
    if ('error' in minted) return minted.error
    const { code, linkToken } = minted
    const normalized = email.toLowerCase().trim()
    const kind = tokenType === 'otp' ? 'magiclink' : tokenType
    // GoTrue's mapping: a confirmation has its own budget, while a magic link
    // and a recovery share `recovery_sent_at`.
    const sentAtColumn: SentAtColumn = flavor === 'confirm' ? 'confirmation_sent_at' : 'recovery_sent_at'
    let link = `${this.apiUrl}/auth/v1/verify?token=${linkToken}&type=${kind}`
    const redirectTo = resolveRedirect(
      opts.redirectTo,
      this.config.siteUrl,
      this.config.uriAllowList,
      this.config.enforceRedirectAllowList
    )
    if (opts.redirectTo) link += `&redirect_to=${encodeURIComponent(redirectTo)}`
    if (opts.codeChallenge) {
      await this.db.query(
        `insert into auth.flow_state (provider, provider_state, redirect_to, code_challenge, code_challenge_method, expires_at)
         values ('email', $1, $2, $3, $4, now() + $5::interval)`,
        [linkToken, redirectTo, opts.codeChallenge, opts.codeChallengeMethod, `${this.settings.otpExpirySeconds} seconds`]
      )
    }
    // Whether the 6-digit code is offered alongside the link.
    //
    // Not for recovery: GoTrue's default Reset Password template carries only
    // the link, and a 6-digit code is a far weaker credential for taking over
    // an account than a 32-character token - it survives being forwarded and
    // only has the attempt cap standing behind it. Offering it also strands
    // anyone who tries to use it, since an app that never built a code-entry
    // screen has nowhere to type it. The code row is still minted, so
    // `verifyOtp({ email, token, type: 'recovery' })` keeps working for an app
    // that does implement that screen.
    const copy =
      tokenType === 'recovery'
        ? { subject: 'Reset your password', action: 'Reset your password', lead: 'Reset your password with this link:', code: null }
        : flavor === 'confirm'
          ? { subject: 'Confirm your email', action: 'Confirm your email', lead: 'Confirm your email address with this link:', code }
          : { subject: 'Your login code', action: 'Sign in', lead: 'Sign in with this link:', code }
    // The hook replaces rendering, so it is consulted before any of it happens.
    if (this.config.sendEmailHook) {
      const actionType: EmailActionType =
        tokenType === 'recovery' ? 'recovery' : flavor === 'confirm' ? 'signup' : 'magiclink'
      await callSendEmailHook(
        this.config.sendEmailHook,
        {
          user: this.userJson(minted.user),
          email_data: {
            token: code,
            token_hash: linkToken,
            redirect_to: redirectTo,
            email_action_type: actionType,
            site_url: this.config.siteUrl,
            token_new: '',
            token_hash_new: '',
          },
        },
        this.config.hookFetch
      )
      await this.markEmailSent(minted.user.id, sentAtColumn)
      return json(200, {})
    }

    const templateName: EmailTemplateName =
      tokenType === 'recovery' ? 'recovery' : flavor === 'confirm' ? 'confirmation' : 'magic_link'
    const template = this.config.emailTemplates?.[templateName]
    const defaultText =
      tokenType === 'recovery'
        ? `Reset your password with this link: ${link}`
        : flavor === 'confirm'
          ? `Confirm your email address with this link: ${link}\n\nOr enter the code ${code}`
          : `Your one-time code is ${code}\n\nOr sign in with this link: ${link}`
    // A project's template replaces the body outright; its text companion is
    // derived from it so the message stays multipart. `code` is always exposed
    // here even though the default recovery mail omits it - a template that
    // interpolates {{ .Token }} is a project saying it has a code-entry screen.
    const html = template?.content
      ? renderTemplate(template.content, {
          ConfirmationURL: link,
          Token: code,
          TokenHash: linkToken,
          RedirectTo: redirectTo,
          SiteURL: this.config.siteUrl,
          Email: normalized,
        })
      : authEmailHtml({ lead: copy.lead, action: copy.action, link, code: copy.code })
    await this.config.mailer.send({
      to: normalized,
      subject: template?.subject ?? copy.subject,
      text: template?.content ? htmlToText(html) : defaultText,
      html,
    })
    await this.markEmailSent(minted.user.id, sentAtColumn)
    return json(200, {})
  }

  private async sendOtp(req: Request, url: URL): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      create_user?: boolean
      code_challenge?: string
      code_challenge_method?: string
    }
    if (!body.email) return authError(400, 'validation_failed', 'email is required')
    const tooSoon = await this.limitEmailFrequency(body.email, 'recovery_sent_at')
    if (tooSoon) return tooSoon
    return this.issueToken(body.email, 'otp', body.create_user !== false, {
      redirectTo: url.searchParams.get('redirect_to'),
      ...AuthHandler.pkceFrom(body),
    })
  }

  private async sendRecovery(req: Request, url: URL): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      code_challenge?: string
      code_challenge_method?: string
    }
    if (!body.email) return authError(400, 'validation_failed', 'email is required')
    const tooSoon = await this.limitEmailFrequency(body.email, 'recovery_sent_at')
    if (tooSoon) return tooSoon
    // GoTrue answers 200 for an address it has never seen, so the response
    // can't be used to enumerate which emails have accounts. supabase-js apps
    // rely on this to show "check your inbox" unconditionally.
    const normalized = body.email.toLowerCase().trim()
    const existing = await this.db.query(`select 1 from auth.users where email = $1`, [normalized])
    if (existing.rows.length === 0) return json(200, {})
    return this.issueToken(body.email, 'recovery', false, {
      redirectTo: url.searchParams.get('redirect_to'),
      ...AuthHandler.pkceFrom(body),
    })
  }

  /** Max wrong guesses for a one-time code before its tokens are invalidated. */
  private static readonly MAX_OTP_ATTEMPTS = 5

  private async redeem(token: string, types: string[], email?: string): Promise<UserRow | null> {
    // `|| null`, not `??`: an empty string is an absent address, not one to
    // match on. Left as '' it reaches the query as `email = ''`, which matches
    // nothing, and a client that sends `email: ''` beside a link token has a
    // good token refused.
    const normalizedEmail = email?.toLowerCase().trim() || null
    // SECURITY: a guessable code is only a credential together with the address
    // it was sent to. Unscoped, `token = $1` matches whoever happens to hold a
    // live code - so one guess is tried against every account at once - and the
    // attempt counter below needs the email to know what to count, so the
    // lockout never fires either. Refuse rather than widen the match.
    if (!normalizedEmail && isGuessableToken(token)) return null
    const res = await this.db.query(
      `delete from auth.one_time_tokens
       where token = $1 and token_type = any($2::text[])
         and ($3::text is null or email = $3) and expires_at > now()
         and attempts < $4
       returning user_id, email`,
      [token, `{${types.join(',')}}`, normalizedEmail, AuthHandler.MAX_OTP_ATTEMPTS]
    )
    const row = res.rows[0] as { user_id: string; email: string } | undefined
    if (!row) {
      // Wrong/expired code: count the failed guess against the live tokens for
      // this email, and burn them once the attempt cap is hit (brute-force
      // lockout for the 6-digit OTP). Requires the email to scope the counter.
      if (normalizedEmail) {
        await this.db.query(
          `update auth.one_time_tokens set attempts = attempts + 1
           where email = $1 and token_type = any($2::text[]) and expires_at > now()`,
          [normalizedEmail, `{${types.join(',')}}`]
        )
        await this.db.query(
          `delete from auth.one_time_tokens where email = $1 and attempts >= $2`,
          [normalizedEmail, AuthHandler.MAX_OTP_ATTEMPTS]
        )
      }
      return null
    }
    await this.db.query(`delete from auth.one_time_tokens where email = $1`, [row.email])
    const ures = await this.db.query(
      `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()), last_sign_in_at = now()
       where id = $1 returning *`,
      [row.user_id]
    )
    return (ures.rows[0] as UserRow) ?? null
  }

  /**
   * The `one_time_tokens.token_type` rows a given verification type may redeem.
   *
   * A recovery (password-reset) token must be redeemed with type=recovery
   * explicitly - never fold it into the default set, or a guessed login OTP
   * could mint a recovery session. Everything else (`otp`, `signup`, `invite`,
   * `email`, or absent) redeems the login pair, since those all mint the same
   * otp+magiclink rows.
   */
  private static redeemTypes(type?: string): string[] {
    if (type === 'recovery') return ['recovery']
    if (type === 'magiclink') return ['magiclink']
    return ['otp', 'magiclink']
  }

  private async verifyToken(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      type?: string
      email?: string
      token?: string
      token_hash?: string
    }
    // supabase-js sends `token_hash` for verifyOtp({ token_hash }) - the shape
    // `admin.generateLink` feeds - and `token` for verifyOtp({ email, token }).
    // Accept either; ours are opaque one-time tokens, so the two are the same
    // string here.
    const token = body.token ?? body.token_hash
    if (!token) return authError(400, 'validation_failed', 'token is required')
    const user = await this.redeem(token, AuthHandler.redeemTypes(body.type), body.email)
    if (!user) return authError(403, 'otp_expired', 'Token has expired or is invalid')
    // A PKCE challenge parked for the link is moot once the code was typed in
    // instead; drop it so nothing is left to redeem.
    await this.db.query(`delete from auth.flow_state where provider = 'email' and provider_state = $1`, [token])
    return json(200, await this.sessionFor(user))
  }

  private async verifyLink(url: URL): Promise<Response> {
    const token = url.searchParams.get('token') ?? ''
    const type = url.searchParams.get('type') ?? 'magiclink'
    // Never redirect (with the freshly minted session tokens) to an origin the
    // operator hasn't allowed - a crafted magic-link would otherwise exfiltrate
    // the session. Unknown targets fall back to the site URL.
    const redirectTo = resolveRedirect(
      url.searchParams.get('redirect_to'),
      this.config.siteUrl,
      this.config.uriAllowList,
      this.config.enforceRedirectAllowList
    )
    const user = await this.redeem(token, AuthHandler.redeemTypes(type))
    if (!user) {
      return new Response(null, { status: 303, headers: { location: `${redirectTo}#error=access_denied&error_code=otp_expired` } })
    }

    // PKCE: the request that sent this email parked a code_challenge under the
    // link token. Hand back a one-shot auth code (redirect_to?code=...) for
    // POST /token?grant_type=pkce - the same exchange OAuth uses - instead of
    // exposing the session tokens in the URL. supabase-js remembers which flow
    // (recovery vs. magic link) it started, so no `type` is needed here.
    const flow = await this.db.query(
      `delete from auth.flow_state where provider = 'email' and provider_state = $1 returning code_challenge, code_challenge_method`,
      [token]
    )
    const pkce = flow.rows[0] as { code_challenge: string | null; code_challenge_method: string | null } | undefined
    if (pkce?.code_challenge) {
      const authCode = randomToken(24)
      await this.db.query(
        `insert into auth.flow_state (provider, provider_state, redirect_to, code_challenge, code_challenge_method, auth_code, user_id, expires_at)
         values ('email', $1, $2, $3, $4, $5, $6, now() + interval '5 minutes')`,
        [randomToken(16), redirectTo, pkce.code_challenge, pkce.code_challenge_method, authCode, user.id]
      )
      return new Response(null, { status: 303, headers: { location: `${redirectTo}?code=${authCode}` } })
    }

    const session = (await this.sessionFor(user)) as { access_token: string; refresh_token: string; expires_in: number }
    const hash = `#access_token=${session.access_token}&refresh_token=${session.refresh_token}&expires_in=${session.expires_in}&token_type=bearer&type=${type}`
    return new Response(null, { status: 303, headers: { location: `${redirectTo}${hash}` } })
  }

  // ── admin ─────────────────────────────────────────────────────────────

  private async admin(req: Request, ctx: RequestContext, path: string, method: string): Promise<Response> {
    if (ctx.role !== 'service_role') {
      return authError(403, 'insufficient_permissions', 'Admin endpoints require the service_role key')
    }
    const idMatch = path.match(/^admin\/users\/([0-9a-f-]{36})$/)
    const exportMatch = path.match(/^admin\/users\/([0-9a-f-]{36})\/export$/)

    if (path === 'admin/audit' && method === 'GET') {
      const res = await this.db.query(
        `select id, payload, created_at, ip_address from auth.audit_log_entries
         order by created_at desc limit 200`
      )
      return json(200, { entries: res.rows })
    }

    if (exportMatch && method === 'GET') {
      return await this.exportUser(exportMatch[1])
    }

    if (path === 'admin/users' && method === 'GET') {
      const res = await this.db.query(`select * from auth.users order by created_at desc limit 1000`)
      return json(200, { users: (res.rows as UserRow[]).map((u) => this.userJson(u)), aud: 'authenticated' })
    }
    if (path === 'admin/users' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        email?: string
        password?: string
        email_confirm?: boolean
        user_metadata?: Record<string, unknown>
        app_metadata?: Record<string, unknown>
      }
      if (!body.email) return authError(400, 'validation_failed', 'email is required')
      const hashed = body.password ? await hashPassword(body.password) : null
      const res = await this.db.query(
        `insert into auth.users
           (aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
         values ('authenticated', 'authenticated', $1, $2, case when $3 then now() else null end, $4, $5)
         returning *`,
        [
          body.email.toLowerCase().trim(),
          hashed,
          body.email_confirm ?? true,
          JSON.stringify({ provider: 'email', providers: ['email'], ...(body.app_metadata ?? {}) }),
          JSON.stringify(body.user_metadata ?? {}),
        ]
      )
      return json(200, this.userJson(res.rows[0] as UserRow))
    }
    if (idMatch && method === 'GET') {
      const res = await this.db.query(`select * from auth.users where id = $1`, [idMatch[1]])
      if (res.rows.length === 0) return authError(404, 'user_not_found', 'User not found')
      return json(200, this.userJson(res.rows[0] as UserRow))
    }
    if (idMatch && method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      const sets: string[] = []
      const params: unknown[] = []
      if (typeof body.email === 'string') {
        params.push(body.email.toLowerCase().trim())
        sets.push(`email = $${params.length}`)
      }
      if (typeof body.password === 'string') {
        params.push(await hashPassword(body.password))
        sets.push(`encrypted_password = $${params.length}`)
      }
      if (body.user_metadata) {
        params.push(JSON.stringify(body.user_metadata))
        sets.push(`raw_user_meta_data = $${params.length}::jsonb`)
      }
      if (body.app_metadata) {
        params.push(JSON.stringify(body.app_metadata))
        sets.push(`raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || $${params.length}::jsonb`)
      }
      if (body.email_confirm === true) sets.push(`email_confirmed_at = now()`)
      if (sets.length === 0) return authError(400, 'validation_failed', 'nothing to update')
      params.push(idMatch[1])
      const res = await this.db.query(
        `update auth.users set ${sets.join(', ')}, updated_at = now() where id = $${params.length} returning *`,
        params
      )
      if (res.rows.length === 0) return authError(404, 'user_not_found', 'User not found')
      return json(200, this.userJson(res.rows[0] as UserRow))
    }
    if (idMatch && method === 'DELETE') {
      return await this.eraseUser(idMatch[1])
    }
    if (path === 'admin/generate_link' && method === 'POST') {
      return await this.generateLink(req)
    }
    return authError(404, 'not_found', `unknown admin endpoint`)
  }

  /**
   * POST /auth/v1/admin/generate_link - mint a link/OTP and return it instead of
   * emailing it, so a caller (typically an e2e test harness) can deliver or
   * redeem it itself. No mail is sent, matching GoTrue.
   *
   * The response is deliberately flat - user fields alongside `action_link`,
   * `email_otp`, `hashed_token`, `redirect_to` and `verification_type` - because
   * supabase-js splits that shape into `{ user, properties }` client-side. A
   * nested response would leave `data.properties` undefined.
   *
   * `hashed_token` is the same opaque one-time token the emailed link carries;
   * tinbase stores one-time tokens verbatim rather than hashing them, so there
   * is nothing to un-hash and `verifyOtp({ token_hash })` redeems it directly.
   */
  private async generateLink(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      type?: string
      email?: string
      password?: string
      data?: Record<string, unknown>
      redirect_to?: string
    }
    if (!body.email) return authError(400, 'validation_failed', 'email is required')
    const type = body.type ?? 'magiclink'

    // email_change_* would have to mint a token against a pending new address,
    // which needs the email-change plumbing this handler doesn't have yet. Say
    // so rather than returning a link that verifies as a plain login.
    if (type === 'email_change_current' || type === 'email_change_new') {
      return authError(400, 'validation_failed', `generate_link type "${type}" is not supported yet`)
    }
    if (!['signup', 'invite', 'magiclink', 'recovery'].includes(type)) {
      return authError(400, 'validation_failed', `unsupported generate_link type: ${type}`)
    }

    // recovery is a reset for an existing account; the other three are the
    // account-creating flows, mirroring how signup/otp already behave.
    const tokenType = type === 'recovery' ? 'recovery' : 'otp'
    const minted = await this.mintOneTimeToken(body.email, tokenType, type !== 'recovery')
    if ('error' in minted) return minted.error
    let { user } = minted
    const { code, linkToken } = minted

    // Optional extras GoTrue accepts on the signup/invite flows.
    if (body.password || body.data) {
      const sets: string[] = []
      const params: unknown[] = []
      if (body.password) {
        params.push(await hashPassword(body.password))
        sets.push(`encrypted_password = $${params.length}`)
      }
      if (body.data) {
        params.push(JSON.stringify(body.data))
        sets.push(`raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $${params.length}::jsonb`)
      }
      params.push(user.id)
      const res = await this.db.query(
        `update auth.users set ${sets.join(', ')}, updated_at = now() where id = $${params.length} returning *`,
        params
      )
      user = (res.rows[0] as UserRow) ?? user
    }

    const redirectTo = resolveRedirect(
      body.redirect_to,
      this.config.siteUrl,
      this.config.uriAllowList,
      this.config.enforceRedirectAllowList
    )
    const actionLink =
      `${this.apiUrl}/auth/v1/verify?token=${linkToken}&type=${type}` +
      `&redirect_to=${encodeURIComponent(redirectTo)}`

    await this.audit('generate_link', { actorId: user.id, actorEmail: user.email, traits: { type } })

    return json(200, {
      ...this.userJson(user),
      action_link: actionLink,
      email_otp: code,
      hashed_token: linkToken,
      redirect_to: redirectTo,
      verification_type: type,
    })
  }

  // ── audit trail ───────────────────────────────────────────────────────

  /**
   * Append a security event to auth.audit_log_entries (GoTrue-compatible
   * payload). Best-effort: a logging failure never breaks the request.
   */
  private async audit(
    action: string,
    opts: { actorId?: string | null; actorEmail?: string | null; type?: string; traits?: Record<string, unknown> } = {}
  ): Promise<void> {
    try {
      const payload = {
        action,
        actor_id: opts.actorId ?? null,
        actor_username: opts.actorEmail ?? null,
        log_type: opts.type ?? 'account',
        traits: opts.traits ?? {},
        timestamp: new Date().toISOString(),
      }
      await this.db.query(`insert into auth.audit_log_entries (payload) values ($1::jsonb)`, [JSON.stringify(payload)])
    } catch {
      // audit logging is best-effort
    }
  }

  // ── GDPR: data-subject access (export) ────────────────────────────────

  /**
   * Export everything held about one user across the auth schema, for a GDPR
   * right-of-access / portability request. Credentials (password hash, MFA
   * secrets, raw token values) are deliberately omitted - they are not personal
   * data to hand back and exporting them would leak secrets.
   */
  private async exportUser(userId: string): Promise<Response> {
    const ures = await this.db.query(`select * from auth.users where id = $1`, [userId])
    if (ures.rows.length === 0) return authError(404, 'user_not_found', 'User not found')
    const user = ures.rows[0] as UserRow & Record<string, unknown>

    const identities = await this.db.query(
      `select id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at
       from auth.identities where user_id = $1`,
      [userId]
    )
    const sessions = await this.db.query(
      `select id, parent, session_id, revoked, created_at, updated_at
       from auth.refresh_tokens where user_id = $1`,
      [userId]
    )
    const factors = await this.db.query(
      `select id, friendly_name, factor_type, status, created_at, updated_at
       from auth.mfa_factors where user_id = $1`,
      [userId]
    )

    // strip credential/token columns from the raw record before returning it
    const SENSITIVE = [
      'encrypted_password',
      'confirmation_token',
      'recovery_token',
      'email_change_token_new',
      'email_change_token_current',
      'phone_change_token',
      'reauthentication_token',
    ]
    const userSafe = Object.fromEntries(Object.entries(user).filter(([k]) => !SENSITIVE.includes(k)))
    await this.audit('user_data_exported', { actorId: userId, type: 'admin' })
    return json(200, {
      exported_at: new Date().toISOString(),
      user: this.userJson(user),
      user_record: userSafe,
      identities: identities.rows,
      sessions: sessions.rows,
      mfa_factors: factors.rows,
    })
  }

  /**
   * Erase a user (GDPR right to erasure). Deletes the user row; auth.identities,
   * refresh_tokens, one_time_tokens, flow_state, and mfa_factors/challenges are
   * removed by their ON DELETE CASCADE foreign keys. Returns a 404 if the user
   * doesn't exist and a summary of what was erased.
   *
   * Note: storage.objects.owner has no FK to auth.users, so object rows/bytes
   * owned by the user are not removed here - see COMPLIANCE.md for the
   * storage-erasure step the operator must run.
   */
  private async eraseUser(userId: string): Promise<Response> {
    const before = await this.db.query<{ identities: number; sessions: number; factors: number }>(
      `select
         (select count(*) from auth.identities where user_id = $1)::int as identities,
         (select count(*) from auth.refresh_tokens where user_id = $1)::int as sessions,
         (select count(*) from auth.mfa_factors where user_id = $1)::int as factors`,
      [userId]
    )
    const del = await this.db.query(`delete from auth.users where id = $1 returning id`, [userId])
    if (del.rows.length === 0) return authError(404, 'user_not_found', 'User not found')
    const c = before.rows[0]
    await this.audit('user_deleted', { actorId: userId, type: 'admin', traits: { erased: true } })
    return json(200, {
      erased: true,
      user_id: userId,
      cascaded: { identities: c.identities, sessions: c.sessions, mfa_factors: c.factors },
    })
  }

  // ── MFA (TOTP) ────────────────────────────────────────────────────────

  private async enrollFactor(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
    const body = (await req.json().catch(() => ({}))) as {
      factor_type?: string
      friendly_name?: string
      issuer?: string
    }
    const factorType = body.factor_type ?? 'totp'
    if (factorType !== 'totp') {
      return authError(422, 'validation_failed', 'Only the totp factor type is supported')
    }
    if (!this.settings.totpEnrollEnabled) {
      return authError(422, 'mfa_totp_enroll_disabled', 'TOTP enrollment is disabled')
    }
    const enrolled = await this.db.query(
      `select count(*)::int as n from auth.mfa_factors where user_id = $1`,
      [user.id]
    )
    if ((enrolled.rows[0] as { n: number }).n >= this.settings.maxEnrolledFactors) {
      return authError(422, 'too_many_enrolled_mfa_factors', 'Maximum number of enrolled MFA factors reached')
    }
    const friendlyName = body.friendly_name ?? null
    if (friendlyName) {
      const dup = await this.db.query(
        `select 1 from auth.mfa_factors where user_id = $1 and friendly_name = $2`,
        [user.id, friendlyName]
      )
      if (dup.rows.length > 0) {
        return authError(422, 'mfa_factor_name_conflict', 'A factor with this friendly name already exists')
      }
    }
    const secret = generateTotpSecret()
    let issuer = body.issuer
    if (!issuer) {
      try {
        issuer = new URL(this.config.siteUrl).host || 'tinbase'
      } catch {
        issuer = 'tinbase'
      }
    }
    const uri = otpauthUri({ secret, account: user.email || user.id, issuer })
    const ins = await this.db.query(
      `insert into auth.mfa_factors (user_id, friendly_name, factor_type, status, secret)
       values ($1, $2, 'totp', 'unverified', $3) returning id`,
      [user.id, friendlyName, secret]
    )
    const id = (ins.rows[0] as { id: string }).id
    return json(200, {
      id,
      type: 'totp',
      friendly_name: friendlyName,
      status: 'unverified',
      totp: { qr_code: qrSvgDataUri(uri), secret, uri },
    })
  }

  private async challengeFactor(req: Request, factorId: string): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
    if (!this.settings.totpVerifyEnabled) {
      return authError(422, 'mfa_totp_verify_disabled', 'TOTP verification is disabled')
    }
    const fr = await this.db.query(`select id from auth.mfa_factors where id = $1 and user_id = $2`, [factorId, user.id])
    if (fr.rows.length === 0) return authError(404, 'mfa_factor_not_found', 'MFA factor not found')
    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    const ins = await this.db.query(
      `insert into auth.mfa_challenges (factor_id, expires_at) values ($1, $2) returning id, expires_at`,
      [factorId, expiresAt]
    )
    const c = ins.rows[0] as { id: string; expires_at: string | Date }
    return json(200, {
      id: c.id,
      type: 'totp',
      expires_at: Math.floor(new Date(c.expires_at).getTime() / 1000),
    })
  }

  private async verifyFactor(req: Request, factorId: string): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
    const body = (await req.json().catch(() => ({}))) as { challenge_id?: string; code?: string }
    const fr = await this.db.query(
      `select id, secret, status from auth.mfa_factors where id = $1 and user_id = $2`,
      [factorId, user.id]
    )
    const factor = fr.rows[0] as { id: string; secret: string; status: string } | undefined
    if (!factor) return authError(404, 'mfa_factor_not_found', 'MFA factor not found')
    const cr = await this.db.query(
      `select id, expires_at, verified_at from auth.mfa_challenges where id = $1 and factor_id = $2`,
      [body.challenge_id ?? '', factorId]
    )
    const challenge = cr.rows[0] as { id: string; expires_at: string | Date; verified_at: string | Date | null } | undefined
    if (!challenge) return authError(404, 'mfa_challenge_not_found', 'MFA challenge not found')
    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      return authError(422, 'mfa_challenge_expired', 'MFA challenge has expired, verify against another one')
    }
    // a challenge is single-use: once verified it cannot be replayed
    if (challenge.verified_at) {
      return authError(422, 'mfa_verification_failed', 'This challenge has already been verified')
    }
    if (!(await verifyTotp(factor.secret, body.code ?? ''))) {
      return authError(422, 'mfa_verification_failed', 'Invalid TOTP code entered')
    }
    await this.db.query(`update auth.mfa_challenges set verified_at = now() where id = $1`, [challenge.id])
    if (factor.status !== 'verified') {
      await this.db.query(`update auth.mfa_factors set status = 'verified', updated_at = now() where id = $1`, [factorId])
    }
    // elevate the session to aal2 for the same user
    const session = await this.sessionFor(user, undefined, {
      aal: 'aal2',
      amr: [
        { method: 'password', timestamp: Math.floor(Date.now() / 1000) },
        { method: 'totp', timestamp: Math.floor(Date.now() / 1000) },
      ],
    })
    return json(200, session)
  }

  private async unenrollFactor(req: Request, factorId: string): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
    const del = await this.db.query(
      `delete from auth.mfa_factors where id = $1 and user_id = $2 returning id`,
      [factorId, user.id]
    )
    if (del.rows.length === 0) return authError(404, 'mfa_factor_not_found', 'MFA factor not found')
    return json(200, { id: factorId })
  }

  private async getUserFactors(userId: string): Promise<Record<string, unknown>[]> {
    const res = await this.db.query(
      `select id, friendly_name, factor_type, status, created_at, updated_at
       from auth.mfa_factors where user_id = $1 order by created_at`,
      [userId]
    )
    return (res.rows as Record<string, unknown>[]).map((f) => ({
      id: f.id,
      friendly_name: f.friendly_name ?? null,
      factor_type: f.factor_type,
      status: f.status,
      created_at: iso(f.created_at as Date | string | null),
      updated_at: iso(f.updated_at as Date | string | null),
    }))
  }

  /** GoTrue-shaped identities for a user (linked providers), from auth.identities. */
  private async getUserIdentities(userId: string): Promise<Record<string, unknown>[]> {
    const res = await this.db.query(
      `select id, provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at
       from auth.identities where user_id = $1 order by created_at`,
      [userId]
    )
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      identity_id: r.id,
      id: r.provider_id,
      user_id: r.user_id,
      identity_data: r.identity_data ?? {},
      provider: r.provider,
      last_sign_in_at: iso(r.last_sign_in_at as Date | string | null),
      created_at: iso(r.created_at as Date | string | null),
      updated_at: iso(r.updated_at as Date | string | null),
    }))
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /**
   * Resolve the bearer token to a user, rejecting tokens whose session has been
   * logged out.
   *
   * A valid signature is not enough here: GoTrue's `/user` consults session
   * state, which is the whole reason server-side code validates with
   * `getUser(jwt)` instead of verifying the JWT locally - so that a logout takes
   * effect immediately rather than at expiry.
   *
   * Only tokens that carry a `session_id` are subject to the check. Ones that
   * don't (the studio's impersonation token, for instance) have no session to
   * revoke and behave as before.
   *
   * Note this deliberately does not extend to REST: PostgREST validates the JWT
   * signature and nothing else, so a logged-out token keeps working there until
   * it expires, in real Supabase as much as here.
   */
  private async userFromBearer(req: Request): Promise<UserRow | null> {
    const authz = req.headers.get('authorization') ?? ''
    if (!authz.toLowerCase().startsWith('bearer ')) return null
    const claims = await verifyJwt(authz.slice(7), this.config.jwtSecret)
    if (!claims?.sub) return null
    const sessionId = (claims as { session_id?: unknown }).session_id
    if (typeof sessionId === 'string' && sessionId) {
      const live = await this.db.query(
        `select 1 from auth.sessions where id = $1 and (not_after is null or not_after > now())`,
        [sessionId]
      )
      if (live.rows.length === 0) return null
    }
    const res = await this.db.query(`select * from auth.users where id = $1`, [claims.sub])
    return (res.rows[0] as UserRow) ?? null
  }

  /** The session_id claim on a request's bearer token, if it carries one. */
  private async sessionIdFromBearer(req: Request): Promise<string | null> {
    const authz = req.headers.get('authorization') ?? ''
    if (!authz.toLowerCase().startsWith('bearer ')) return null
    const claims = await verifyJwt(authz.slice(7), this.config.jwtSecret)
    const sessionId = (claims as { session_id?: unknown } | null)?.session_id
    return typeof sessionId === 'string' && sessionId ? sessionId : null
  }

  /** Shape a user row into the GoTrue user object supabase-js expects. */
  userJson(
    u: UserRow,
    factors: Record<string, unknown>[] = [],
    identities: Record<string, unknown>[] = []
  ): Record<string, unknown> {
    return {
      id: u.id,
      aud: u.aud ?? 'authenticated',
      role: u.role ?? 'authenticated',
      email: u.email ?? '',
      email_confirmed_at: iso(u.email_confirmed_at),
      phone: u.phone ?? '',
      confirmed_at: iso(u.email_confirmed_at),
      last_sign_in_at: iso(u.last_sign_in_at),
      app_metadata: u.raw_app_meta_data ?? {},
      user_metadata: u.raw_user_meta_data ?? {},
      identities,
      factors,
      created_at: iso(u.created_at),
      updated_at: iso(u.updated_at),
      is_anonymous: u.is_anonymous ?? false,
    }
  }

  /** Session tokens for a bare user id (used by the OAuth implicit callback). */
  private async sessionTokensFor(userId: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const res = await this.db.query(`select * from auth.users where id = $1`, [userId])
    const session = (await this.sessionFor(res.rows[0] as UserRow)) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }
    return { access_token: session.access_token, refresh_token: session.refresh_token, expires_in: session.expires_in }
  }

  private async sessionFor(
    user: UserRow,
    parentToken?: string,
    opts?: { aal?: string; amr?: { method: string; timestamp: number }[]; sessionId?: string }
  ): Promise<Record<string, unknown>> {
    const now = Math.floor(Date.now() / 1000)
    // Cap the access-token lifetime at the session timebox so a timeboxed
    // session can't outlive its absolute deadline (config.toml auth.sessions.timebox).
    const lifetime = this.config.sessionTimeboxSeconds
      ? Math.min(this.config.jwtExpiry, this.config.sessionTimeboxSeconds)
      : this.config.jwtExpiry
    const expiresAt = now + lifetime
    // Refreshing keeps the same session: a refresh is not a new login, and
    // minting a fresh id would strand the previous access token's session_id on
    // a row nothing points at, so the outgoing token would be rejected the
    // moment the client refreshed.
    const sessionId = opts?.sessionId ?? crypto.randomUUID()
    const claims: JwtClaims = {
      iss: `${this.apiUrl}/auth/v1`,
      sub: user.id,
      aud: user.aud ?? 'authenticated',
      exp: expiresAt,
      iat: now,
      email: user.email ?? '',
      phone: user.phone ?? '',
      app_metadata: user.raw_app_meta_data ?? {},
      user_metadata: user.raw_user_meta_data ?? {},
      role: user.role ?? 'authenticated',
      is_anonymous: user.is_anonymous ?? false,
      session_id: sessionId,
      aal: opts?.aal ?? 'aal1',
      amr: opts?.amr ?? [{ method: 'password', timestamp: now }],
    }
    const accessToken = await signJwt(claims, this.config.jwtSecret)
    const refreshToken = randomToken(24)
    // Record the session before handing out a token that references it, so
    // /auth/v1/user can never see a valid-looking token with no session row.
    await this.db.query(
      `insert into auth.sessions (id, user_id, not_after) values ($1, $2, $3)
       on conflict (id) do update set updated_at = now()`,
      [
        sessionId,
        user.id,
        this.config.sessionTimeboxSeconds ? new Date((now + this.config.sessionTimeboxSeconds) * 1000).toISOString() : null,
      ]
    )
    await this.db.query(
      `insert into auth.refresh_tokens (token, user_id, parent, session_id) values ($1, $2, $3, $4)`,
      [refreshToken, user.id, parentToken ?? null, sessionId]
    )
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: lifetime,
      expires_at: expiresAt,
      refresh_token: refreshToken,
      user: this.userJson(user, await this.getUserFactors(user.id), await this.getUserIdentities(user.id)),
    }
  }
}
