/**
 * Client for the tinbase backend, authenticated with the service_role key.
 *
 * @module
 */

// The service_role key bypasses RLS and unlocks arbitrary SQL, so it lives in
// sessionStorage (scoped to the tab, cleared when it closes) rather than
// localStorage — it never persists to disk across browser sessions.
const KEY_STORAGE = 'tinbase_service_key'
let KEY = sessionStorage.getItem(KEY_STORAGE) || ''

/** Returns the stored service_role key. */
export const getKey = () => KEY

/** Stores the service_role key in memory and sessionStorage (tab-scoped). */
export const setKey = (k: string) => {
  KEY = k
  sessionStorage.setItem(KEY_STORAGE, k)
}

/** Clears the stored service_role key from memory and sessionStorage. */
export const clearKey = () => {
  KEY = ''
  sessionStorage.removeItem(KEY_STORAGE)
}

/**
 * Base URL of the tinbase server. In dev the studio runs on the Vite port and
 * targets the tinbase server directly; in production it is served from the
 * tinbase server itself (same origin).
 */
export const BASE = import.meta.env.DEV ? 'http://127.0.0.1:54321' : ''

let ROLE_TOKEN: string | null = null

/**
 * Sets the role-preview token. When set, `/rest/v1` calls authenticate with
 * this token instead of the service_role key, so the grid shows exactly what
 * that role sees (RLS applied). Admin endpoints always use the service_role
 * key.
 *
 * @param t - The role token, or `null` to clear it.
 */
export const setRoleToken = (t: string | null) => {
  ROLE_TOKEN = t
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...extra }
}

function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const k = ROLE_TOKEN ?? KEY
  return { apikey: k, authorization: `Bearer ${k}`, 'content-type': 'application/json', ...extra }
}

async function req(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers as object) } })
}

/**
 * REST request with optional schema targeting: PostgREST reads the schema from
 * `Accept-Profile` (reads) / `Content-Profile` (writes); omitted for public.
 */
async function reqRest(path: string, opts: RequestInit = {}, schema?: string): Promise<Response> {
  const method = (opts.method ?? 'GET').toUpperCase()
  const profile =
    schema && schema !== 'public' ? { [method === 'GET' || method === 'HEAD' ? 'accept-profile' : 'content-profile']: schema } : {}
  return fetch(`${BASE}${path}`, { ...opts, headers: { ...restHeaders(), ...profile, ...(opts.headers as object) } })
}

/** Error carrying the HTTP status, so callers can distinguish auth vs transient failures. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Parse `text` as JSON, tolerating an empty or non-JSON body. */
function parseJson(text: string): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function jsonOrThrow(res: Response): Promise<any> {
  const body = parseJson(await res.text())
  if (!res.ok) {
    throw new ApiError(body?.error || body?.message || body?.msg || `HTTP ${res.status}`, res.status)
  }
  return body
}

/* ── types ── */

export interface Column {
  name: string
  type: string
  nullable: boolean
  hasDefault: boolean
  isPrimaryKey: boolean
}
export interface TableInfo {
  name: string
  primaryKey: string[]
  rowCount: number
  /** true for views — read-only, rendered with an eye icon instead of PK warnings */
  isView?: boolean
  columns: Column[]
  foreignKeys: { columns: string[]; target: string; targetColumns: string[] }[]
}
export interface Stats {
  users: number
  buckets: number
  objects: number
  migrations: number
  tables: number
  dbSize: string
  /** database size in bytes (null when the engine cannot report it) */
  dbSizeBytes: number | null
  version: string
}

/* ── admin ── */

export interface LogEntry {
  ts: string
  level: 'info' | 'warn' | 'error'
  msg: string
}

/** Runtime-mutable auth toggles (mirrors src/auth/settings.ts on the server). */
export interface AuthSettings {
  disableSignup: boolean
  anonymousUsers: boolean
  autoconfirm: boolean
  minPasswordLength: number
  disabledProviders: string[]
  /** phone sign-ins ([auth.sms] enable_signup) */
  phoneEnabled: boolean
  /** confirm phone numbers automatically on signup (inverse of [auth.sms] enable_confirmations) */
  smsAutoconfirm: boolean
  smsOtpLength: number
  smsOtpExpirySeconds: number
  maxSmsFrequencySeconds: number
  /** [auth.sms.twilio]; authToken is never echoed back (always '' on read; see smsTwilioAuthTokenSet) */
  smsTwilio: { accountSid: string; authToken: string; messageServiceSid: string }
  smsTwilioAuthTokenSet?: boolean
}

export const api = {
  ping: () => req('/admin/v1/stats').then(jsonOrThrow) as Promise<Stats>,
  stats: () => req('/admin/v1/stats').then(jsonOrThrow) as Promise<Stats>,
  keys: () => req('/admin/v1/keys').then(jsonOrThrow) as Promise<{ anonKey: string | null }>,
  impersonate: (role: 'anon' | 'authenticated', user?: { sub: string; email?: string }) => {
    const p = new URLSearchParams({ role })
    if (user) {
      p.set('sub', user.sub)
      if (user.email) p.set('email', user.email)
    }
    return req(`/admin/v1/impersonate?${p}`).then(jsonOrThrow) as Promise<{ token: string; expiresIn: number }>
  },
  schemas: () => req('/admin/v1/schemas').then(jsonOrThrow).then((r) => r.schemas as string[]),
  tables: (schema = 'public') =>
    req(`/admin/v1/tables?schema=${encodeURIComponent(schema)}`)
      .then(jsonOrThrow)
      .then((r) => r.tables as TableInfo[]),
  migrations: () =>
    req('/admin/v1/migrations')
      .then(jsonOrThrow)
      .then((r) => r.migrations as { version: string; name: string | null; applied_at: string }[]),
  policies: (schema = 'public') =>
    req(`/admin/v1/policies?schema=${encodeURIComponent(schema)}`).then(jsonOrThrow).then((r) => r.policies as any[]),
  createPolicy: (body: Record<string, unknown>) =>
    req('/admin/v1/policies', { method: 'POST', body: JSON.stringify(body) }).then(jsonOrThrow),
  dropPolicy: (table: string, name: string, schema = 'public') => {
    const p = new URLSearchParams({ table, name, schema })
    return req(`/admin/v1/policies?${p}`, { method: 'DELETE' }).then(jsonOrThrow)
  },
  functions: (schema = 'public') =>
    req(`/admin/v1/functions?schema=${encodeURIComponent(schema)}`).then(jsonOrThrow).then((r) => r.functions as any[]),
  triggers: (schema = 'public') =>
    req(`/admin/v1/triggers?schema=${encodeURIComponent(schema)}`).then(jsonOrThrow).then((r) => r.triggers as any[]),
  logs: () => req('/admin/v1/logs').then(jsonOrThrow).then((r) => r.logs as LogEntry[]),
  clearLogs: () => req('/admin/v1/logs', { method: 'DELETE' }).then(jsonOrThrow),
  sql: (query: string, opts?: { role?: string; claims?: Record<string, unknown> }) =>
    req('/admin/v1/sql', { method: 'POST', body: JSON.stringify({ query, role: opts?.role, claims: opts?.claims }) }).then(
      async (res) => {
        const body = parseJson(await res.text()) ?? { error: `HTTP ${res.status}` }
        return { ok: res.ok, ...body } as {
          ok: boolean
          rows?: any[]
          rowCount?: number
          affectedRows?: number | null
          ms?: number
          error?: string
          code?: string
          detail?: string
          hint?: string
        }
      }
    ),
  edgeFunctions: () =>
    req('/admin/v1/edge-functions').then(jsonOrThrow) as Promise<{
      functions: string[]
      env: Record<string, string>
      builtins: string[]
      digests: Record<string, string>
    }>,
  putSecrets: (secrets: Record<string, string>) =>
    req('/admin/v1/edge-functions/secrets', { method: 'PUT', body: JSON.stringify({ secrets }) }).then(jsonOrThrow) as Promise<{
      ok: true
      secrets: Record<string, string>
    }>,
  deleteSecret: (name: string) =>
    req(`/admin/v1/edge-functions/secrets?name=${encodeURIComponent(name)}`, { method: 'DELETE' }).then(jsonOrThrow),
  authConfig: () =>
    req('/admin/v1/auth-config').then(jsonOrThrow) as Promise<{
      providers: string[]
      inbox: boolean
      /** SMS delivery: a custom sender from createBackend, and the Twilio-compatible API the built-in provider posts to */
      sms?: { custom: boolean; apiUrl: string }
      settings: AuthSettings | null
    }>,
  updateAuthSettings: (patch: Partial<AuthSettings>) =>
    req('/admin/v1/auth-config', { method: 'PATCH', body: JSON.stringify(patch) })
      .then(jsonOrThrow)
      .then((r) => r.settings as AuthSettings),
  webhooksConfig: () =>
    req('/admin/v1/webhooks')
      .then(jsonOrThrow)
      .then((r) => r.webhooks as { table: string; events?: string[]; url: string }[]),

  /* ── rows via PostgREST (service_role bypasses RLS) ── */

  /**
   * Fetches a page of rows from a table. `filters` are raw PostgREST query
   * pairs (e.g. `['category', 'eq.student']` or
   * `['or', '(name.ilike.*ada*,email.ilike.*ada*)']`) built by the caller.
   */
  rows: (
    table: string,
    opts: { limit: number; offset: number; order?: string; filters?: [string, string][]; schema?: string }
  ) => {
    const p = new URLSearchParams({ select: '*', limit: String(opts.limit), offset: String(opts.offset) })
    if (opts.order) p.set('order', opts.order)
    for (const [k, v] of opts.filters ?? []) p.append(k, v)
    return reqRest(`/rest/v1/${encodeURIComponent(table)}?${p}`, { headers: { prefer: 'count=exact' } }, opts.schema).then(
      async (res) => {
        const rows = await jsonOrThrow(res)
        const range = res.headers.get('content-range') || ''
        const total = parseInt(range.split('/')[1] || '0', 10)
        return { rows: rows as any[], total }
      }
    )
  },
  insertRow: (table: string, row: Record<string, unknown>, schema?: string) =>
    reqRest(
      `/rest/v1/${encodeURIComponent(table)}`,
      { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row) },
      schema
    ).then(jsonOrThrow),
  updateRow: (table: string, pk: Record<string, unknown>, patch: Record<string, unknown>, schema?: string) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(pk)) p.set(k, `eq.${v}`)
    return reqRest(
      `/rest/v1/${encodeURIComponent(table)}?${p}`,
      { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(patch) },
      schema
    ).then(jsonOrThrow)
  },
  deleteRow: (table: string, pk: Record<string, unknown>, schema?: string) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(pk)) p.set(k, `eq.${v}`)
    return reqRest(`/rest/v1/${encodeURIComponent(table)}?${p}`, { method: 'DELETE' }, schema).then(jsonOrThrow)
  },
  /** Bulk delete by single-column primary key using `in.(...)`. */
  deleteRows: (table: string, pkCol: string, values: unknown[], schema?: string) => {
    const lit = values.map((v) => {
      const s = String(v)
      return /^-?\d+(\.\d+)?$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`
    })
    const p = new URLSearchParams()
    p.set(pkCol, `in.(${lit.join(',')})`)
    return reqRest(`/rest/v1/${encodeURIComponent(table)}?${p}`, { method: 'DELETE' }, schema).then(jsonOrThrow)
  },

  /* ── auth users ── */

  users: () =>
    req('/auth/v1/admin/users')
      .then(jsonOrThrow)
      .then((r) => r.users as any[]),
  createUser: (body: { email: string; password?: string; email_confirm?: boolean }) =>
    req('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email_confirm: true, ...body }) }).then(
      jsonOrThrow
    ),
  updateUser: (id: string, body: Record<string, unknown>) =>
    req(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }).then(jsonOrThrow),
  deleteUser: (id: string) => req(`/auth/v1/admin/users/${id}`, { method: 'DELETE' }).then(jsonOrThrow),
  /** Send a magic-link / OTP email (creates the user when missing). */
  sendMagicLink: (email: string) =>
    req('/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email, create_user: true }) }).then(jsonOrThrow),

  /* ── storage ── */

  buckets: () => req('/storage/v1/bucket').then(jsonOrThrow) as Promise<any[]>,
  createBucket: (body: { id: string; name: string; public: boolean }) =>
    req('/storage/v1/bucket', { method: 'POST', body: JSON.stringify(body) }).then(jsonOrThrow),
  deleteBucket: (id: string) => req(`/storage/v1/bucket/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(jsonOrThrow),
  listObjects: (bucket: string, prefix = '') =>
    req(`/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST',
      body: JSON.stringify({ prefix, limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
    }).then(jsonOrThrow) as Promise<any[]>,
  uploadObject: (bucket: string, path: string, file: File) => {
    const form = new FormData()
    form.append('', file)
    return fetch(`${BASE}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`, {
      method: 'POST',
      headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'x-upsert': 'true' },
      body: form,
    }).then(jsonOrThrow)
  },
  removeObject: (bucket: string, path: string) =>
    req(`/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: [path] }),
    }).then(jsonOrThrow),
  removeObjects: (bucket: string, paths: string[]) =>
    req(`/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: paths }),
    }).then(jsonOrThrow),
  /** Create a time-limited signed URL for an object (path relative to bucket). */
  signUrl: (bucket: string, path: string, expiresIn = 3600) =>
    req(`/storage/v1/object/sign/${encodeURIComponent(bucket)}/${path}`, {
      method: 'POST',
      body: JSON.stringify({ expiresIn }),
    })
      .then(jsonOrThrow)
      .then((r) => `${BASE}/storage/v1${(r.signedURL ?? r.signedUrl ?? '') as string}`),
  /** Authenticated object download (for inline previews). */
  downloadObject: (bucket: string, path: string) =>
    req(`/storage/v1/object/${encodeURIComponent(bucket)}/${path}`).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.blob()
    }),
}
