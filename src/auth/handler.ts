/**
 * GoTrue-compatible auth endpoints (/auth/v1/*) — the subset supabase-js
 * uses for email/password auth, sessions, and admin user management.
 */
import type { Database } from '../db/database.js'
import { randomToken, signJwt, verifyJwt, type JwtClaims } from '../jwt.js'
import type { Mailer, RequestContext } from '../types.js'
import { OAuthService, type OAuthProviderConfig } from './oauth.js'
import { hashPassword, verifyPassword } from './password.js'
import { qrSvgDataUri } from './qr.js'
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js'

export interface AuthConfig {
  jwtSecret: string
  siteUrl: string
  jwtExpiry: number
  mailer: Mailer
  oauthProviders?: Record<string, OAuthProviderConfig>
  /** injectable fetch for the OAuth provider calls (tests use a mock provider) */
  oauthFetch?: typeof fetch
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

export class AuthHandler {
  private oauth: OAuthService

  constructor(
    private db: Database,
    private config: AuthConfig
  ) {
    this.oauth = new OAuthService(db, config.siteUrl, config.oauthProviders ?? {}, config.oauthFetch ?? fetch)
  }

  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/auth\/v1\/?/, '').replace(/\/+$/, '')
    const method = req.method.toUpperCase()

    try {
      if (path === 'health') return json(200, { name: 'tinbase-auth', version: '0.1.0', description: 'GoTrue-compatible auth' })
      if (path === 'settings') {
        return json(200, {
          external: { email: true, phone: false, anonymous_users: true },
          disable_signup: false,
          autoconfirm: true,
          mailer_autoconfirm: true,
        })
      }
      if (path === 'signup' && method === 'POST') return await this.signup(req)
      if (path === 'token' && method === 'POST') return await this.token(req, url)
      if (path === 'user' && method === 'GET') return await this.getUser(req)
      if (path === 'user' && method === 'PUT') return await this.updateUser(req)
      if (path === 'logout' && method === 'POST') return await this.logout(req)
      if (path === 'otp' && method === 'POST') return await this.sendOtp(req)
      if (path === 'recover' && method === 'POST') return await this.sendRecovery(req)
      if (['magiclink', 'resend'].includes(path) && method === 'POST') return await this.sendOtp(req)
      if (path === 'verify' && method === 'POST') return await this.verifyToken(req)
      if (path === 'verify' && method === 'GET') return await this.verifyLink(url)
      if (path === 'factors' && method === 'POST') return await this.enrollFactor(req)
      if (/^factors\/[^/]+\/challenge$/.test(path) && method === 'POST')
        return await this.challengeFactor(req, path.split('/')[1])
      if (/^factors\/[^/]+\/verify$/.test(path) && method === 'POST')
        return await this.verifyFactor(req, path.split('/')[1])
      if (/^factors\/[^/]+$/.test(path) && method === 'DELETE')
        return await this.unenrollFactor(req, path.split('/')[1])
      if (path === 'authorize' && method === 'GET') return await this.oauth.authorize(url)
      if (path === 'callback' && (method === 'GET' || method === 'POST')) {
        return await this.oauth.callback(url, (userId) => this.sessionTokensFor(userId))
      }
      if (path.startsWith('admin/users')) return await this.admin(req, ctx, path, method)
      return authError(404, 'not_found', `unknown auth endpoint: ${path}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return authError(500, 'unexpected_failure', msg)
    }
  }

  // ── flows ─────────────────────────────────────────────────────────────

  private async signup(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      password?: string
      data?: Record<string, unknown>
    }

    if (!body.email && !body.password) {
      // supabase.auth.signInAnonymously()
      const res = await this.db.query(
        `insert into auth.users (aud, role, raw_app_meta_data, raw_user_meta_data, is_anonymous, last_sign_in_at)
         values ('authenticated', 'authenticated', '{}', $1, true, now())
         returning *`,
        [JSON.stringify(body.data ?? {})]
      )
      return json(200, await this.sessionFor(res.rows[0] as UserRow))
    }

    if (!body.email || !body.password) {
      return authError(400, 'validation_failed', 'Signup requires a valid email and password')
    }
    if (body.password.length < 6) {
      return authError(422, 'weak_password', 'Password should be at least 6 characters.')
    }
    const email = body.email.toLowerCase().trim()
    const existing = await this.db.query(`select id from auth.users where email = $1`, [email])
    if (existing.rows.length > 0) {
      return authError(422, 'user_already_exists', 'User already registered')
    }
    const hashed = await hashPassword(body.password)
    const res = await this.db.query(
      `insert into auth.users
         (aud, role, email, encrypted_password, email_confirmed_at, last_sign_in_at,
          raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', $1, $2, now(), now(),
               '{"provider":"email","providers":["email"]}', $3)
       returning *`,
      [email, hashed, JSON.stringify(body.data ?? {})]
    )
    return json(200, await this.sessionFor(res.rows[0] as UserRow))
  }

  private async token(req: Request, url: URL): Promise<Response> {
    const grantType = url.searchParams.get('grant_type')
    const body = (await req.json().catch(() => ({}))) as Record<string, string>

    if (grantType === 'password') {
      const email = (body.email ?? '').toLowerCase().trim()
      const res = await this.db.query(`select * from auth.users where email = $1`, [email])
      const user = res.rows[0] as UserRow | undefined
      if (!user || !user.encrypted_password || !(await verifyPassword(body.password ?? '', user.encrypted_password))) {
        return authError(400, 'invalid_credentials', 'Invalid login credentials')
      }
      await this.db.query(`update auth.users set last_sign_in_at = now() where id = $1`, [user.id])
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
      const row = res.rows[0] as { revoked: boolean; user_id: string } | undefined
      if (!row || row.revoked) {
        return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
      }
      await this.db.query(`update auth.refresh_tokens set revoked = true, updated_at = now() where token = $1`, [token])
      const ures = await this.db.query(`select * from auth.users where id = $1`, [row.user_id])
      return json(200, await this.sessionFor(ures.rows[0] as UserRow, token))
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
    return json(200, this.userJson(user, await this.getUserFactors(user.id)))
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
    // records an email identity — matching supabase.auth.updateUser({ email }).
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
      if (body.password.length < 6) {
        return authError(422, 'weak_password', 'Password should be at least 6 characters.')
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

  private async logout(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (user) {
      await this.db.query(`update auth.refresh_tokens set revoked = true where user_id = $1`, [user.id])
    }
    return new Response(null, { status: 204 })
  }

  // ── OTP / magic links / recovery ──────────────────────────────────────

  private async issueToken(email: string, tokenType: 'otp' | 'recovery', createUser: boolean): Promise<Response> {
    const normalized = email.toLowerCase().trim()
    let res = await this.db.query(`select * from auth.users where email = $1`, [normalized])
    let user = res.rows[0] as UserRow | undefined
    if (!user) {
      if (!createUser) return authError(422, 'otp_disabled', 'Signups not allowed for otp')
      res = await this.db.query(
        `insert into auth.users (aud, role, email, raw_app_meta_data, raw_user_meta_data)
         values ('authenticated', 'authenticated', $1, '{"provider":"email","providers":["email"]}', '{}')
         returning *`,
        [normalized]
      )
      user = res.rows[0] as UserRow
    }
    const code = String(Math.floor(100000 + Math.random() * 900000))
    const linkToken = randomToken(24)
    await this.db.query(`delete from auth.one_time_tokens where email = $1 and token_type = $2`, [normalized, tokenType])
    await this.db.query(
      `insert into auth.one_time_tokens (user_id, email, token_type, token, expires_at)
       values ($1, $2, $3, $4, now() + interval '15 minutes'), ($1, $2, $5, $6, now() + interval '15 minutes')`,
      [user.id, normalized, tokenType, code, tokenType === 'otp' ? 'magiclink' : tokenType, linkToken]
    )
    const kind = tokenType === 'otp' ? 'magiclink' : tokenType
    const link = `${this.config.siteUrl}/auth/v1/verify?token=${linkToken}&type=${kind}`
    await this.config.mailer.send({
      to: normalized,
      subject: tokenType === 'otp' ? 'Your login code' : 'Reset your password',
      text:
        tokenType === 'otp'
          ? `Your one-time code is ${code}\n\nOr sign in with this link: ${link}`
          : `Reset your password with this link: ${link}\n\nOr use code ${code}`,
    })
    return json(200, {})
  }

  private async sendOtp(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { email?: string; create_user?: boolean }
    if (!body.email) return authError(400, 'validation_failed', 'email is required')
    return this.issueToken(body.email, 'otp', body.create_user !== false)
  }

  private async sendRecovery(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { email?: string }
    if (!body.email) return authError(400, 'validation_failed', 'email is required')
    return this.issueToken(body.email, 'recovery', false)
  }

  /** Max wrong guesses for a one-time code before its tokens are invalidated. */
  private static readonly MAX_OTP_ATTEMPTS = 5

  private async redeem(token: string, types: string[], email?: string): Promise<UserRow | null> {
    const normalizedEmail = email?.toLowerCase().trim() ?? null
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

  private async verifyToken(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { type?: string; email?: string; token?: string }
    if (!body.token) return authError(400, 'validation_failed', 'token is required')
    // A recovery (password-reset) token must be redeemed with type=recovery
    // explicitly — never fold it into the default set, or a guessed login OTP
    // could mint a recovery session.
    const types =
      body.type === 'recovery' ? ['recovery'] : body.type === 'magiclink' ? ['magiclink'] : ['otp', 'magiclink']
    const user = await this.redeem(body.token, types, body.email)
    if (!user) return authError(403, 'otp_expired', 'Token has expired or is invalid')
    return json(200, await this.sessionFor(user))
  }

  private async verifyLink(url: URL): Promise<Response> {
    const token = url.searchParams.get('token') ?? ''
    const type = url.searchParams.get('type') ?? 'magiclink'
    const redirectTo = url.searchParams.get('redirect_to') ?? this.config.siteUrl
    const user = await this.redeem(token, [type])
    if (!user) {
      return new Response(null, { status: 303, headers: { location: `${redirectTo}#error=access_denied&error_code=otp_expired` } })
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
      await this.db.query(`delete from auth.users where id = $1`, [idMatch[1]])
      return json(200, {})
    }
    return authError(404, 'not_found', `unknown admin endpoint`)
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

  // ── helpers ───────────────────────────────────────────────────────────

  private async userFromBearer(req: Request): Promise<UserRow | null> {
    const authz = req.headers.get('authorization') ?? ''
    if (!authz.toLowerCase().startsWith('bearer ')) return null
    const claims = await verifyJwt(authz.slice(7), this.config.jwtSecret)
    if (!claims?.sub) return null
    const res = await this.db.query(`select * from auth.users where id = $1`, [claims.sub])
    return (res.rows[0] as UserRow) ?? null
  }

  userJson(u: UserRow, factors: Record<string, unknown>[] = []): Record<string, unknown> {
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
      identities: [],
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
    opts?: { aal?: string; amr?: { method: string; timestamp: number }[] }
  ): Promise<Record<string, unknown>> {
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + this.config.jwtExpiry
    const sessionId = crypto.randomUUID()
    const claims: JwtClaims = {
      iss: `${this.config.siteUrl}/auth/v1`,
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
    await this.db.query(
      `insert into auth.refresh_tokens (token, user_id, parent, session_id) values ($1, $2, $3, $4)`,
      [refreshToken, user.id, parentToken ?? null, sessionId]
    )
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.config.jwtExpiry,
      expires_at: expiresAt,
      refresh_token: refreshToken,
      user: this.userJson(user, await this.getUserFactors(user.id)),
    }
  }
}
