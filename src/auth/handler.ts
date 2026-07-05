/**
 * GoTrue-compatible auth endpoints (/auth/v1/*) — the subset supabase-js
 * uses for email/password auth, sessions, and admin user management.
 */
import type { Database } from '../db/database.js'
import { randomToken, signJwt, verifyJwt, type JwtClaims } from '../jwt.js'
import type { RequestContext } from '../types.js'
import { hashPassword, verifyPassword } from './password.js'

export interface AuthConfig {
  jwtSecret: string
  siteUrl: string
  jwtExpiry: number
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
  constructor(
    private db: Database,
    private config: AuthConfig
  ) {}

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
      if (['recover', 'otp', 'magiclink', 'resend'].includes(path) && method === 'POST') {
        // no mail transport in tinbase — accept and no-op so flows don't crash
        return json(200, {})
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

    return authError(400, 'invalid_grant', `unsupported grant_type: ${grantType}`)
  }

  private async getUser(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'Invalid or expired token')
    return json(200, this.userJson(user))
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
    if (body.email) {
      params.push(body.email.toLowerCase().trim())
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
    if (sets.length === 0) return json(200, this.userJson(user))
    params.push(user.id)
    const res = await this.db.query(
      `update auth.users set ${sets.join(', ')}, updated_at = now() where id = $${params.length} returning *`,
      params
    )
    return json(200, this.userJson(res.rows[0] as UserRow))
  }

  private async logout(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (user) {
      await this.db.query(`update auth.refresh_tokens set revoked = true where user_id = $1`, [user.id])
    }
    return new Response(null, { status: 204 })
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

  // ── helpers ───────────────────────────────────────────────────────────

  private async userFromBearer(req: Request): Promise<UserRow | null> {
    const authz = req.headers.get('authorization') ?? ''
    if (!authz.toLowerCase().startsWith('bearer ')) return null
    const claims = await verifyJwt(authz.slice(7), this.config.jwtSecret)
    if (!claims?.sub) return null
    const res = await this.db.query(`select * from auth.users where id = $1`, [claims.sub])
    return (res.rows[0] as UserRow) ?? null
  }

  userJson(u: UserRow): Record<string, unknown> {
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
      created_at: iso(u.created_at),
      updated_at: iso(u.updated_at),
      is_anonymous: u.is_anonymous ?? false,
    }
  }

  private async sessionFor(user: UserRow, parentToken?: string): Promise<Record<string, unknown>> {
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
      user: this.userJson(user),
    }
  }
}
