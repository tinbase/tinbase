/** Client for the tinbase backend, authenticated with the service_role key. */

let KEY = localStorage.getItem('tinbase_service_key') || ''
export const getKey = () => KEY
export const setKey = (k: string) => {
  KEY = k
  localStorage.setItem('tinbase_service_key', k)
}
export const clearKey = () => {
  KEY = ''
  localStorage.removeItem('tinbase_service_key')
}

// In dev the studio runs on the Vite port; point it at the tinbase server.
// In production it is served from the tinbase server itself (same origin).
export const BASE = import.meta.env.DEV ? 'http://127.0.0.1:54321' : ''

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...extra }
}

async function req(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers as object) } })
}

async function jsonOrThrow(res: Response): Promise<any> {
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) {
    throw new Error(body?.error || body?.message || body?.msg || `HTTP ${res.status}`)
  }
  return body
}

// ── types ──
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
  version: string
}

// ── admin ──
export const api = {
  ping: () => req('/admin/v1/stats').then(jsonOrThrow) as Promise<Stats>,
  stats: () => req('/admin/v1/stats').then(jsonOrThrow) as Promise<Stats>,
  schemas: () => req('/admin/v1/schemas').then(jsonOrThrow).then((r) => r.schemas as string[]),
  tables: (schema = 'public') =>
    req(`/admin/v1/tables?schema=${encodeURIComponent(schema)}`)
      .then(jsonOrThrow)
      .then((r) => r.tables as TableInfo[]),
  migrations: () =>
    req('/admin/v1/migrations')
      .then(jsonOrThrow)
      .then((r) => r.migrations as { version: string; name: string | null; applied_at: string }[]),
  policies: () => req('/admin/v1/policies').then(jsonOrThrow).then((r) => r.policies as any[]),
  createPolicy: (body: Record<string, unknown>) =>
    req('/admin/v1/policies', { method: 'POST', body: JSON.stringify(body) }).then(jsonOrThrow),
  dropPolicy: (table: string, name: string) => {
    const p = new URLSearchParams({ table, name })
    return req(`/admin/v1/policies?${p}`, { method: 'DELETE' }).then(jsonOrThrow)
  },
  functions: () => req('/admin/v1/functions').then(jsonOrThrow).then((r) => r.functions as any[]),
  triggers: () => req('/admin/v1/triggers').then(jsonOrThrow).then((r) => r.triggers as any[]),
  sql: (query: string) =>
    req('/admin/v1/sql', { method: 'POST', body: JSON.stringify({ query }) }).then(async (res) => {
      const body = await res.json()
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
    }),

  // ── rows via PostgREST (service_role bypasses RLS) ──
  rows: (table: string, opts: { limit: number; offset: number; order?: string }) => {
    const p = new URLSearchParams({ select: '*', limit: String(opts.limit), offset: String(opts.offset) })
    if (opts.order) p.set('order', opts.order)
    return req(`/rest/v1/${encodeURIComponent(table)}?${p}`, {
      headers: { prefer: 'count=exact' },
    }).then(async (res) => {
      const rows = await jsonOrThrow(res)
      const range = res.headers.get('content-range') || ''
      const total = parseInt(range.split('/')[1] || '0', 10)
      return { rows: rows as any[], total }
    })
  },
  insertRow: (table: string, row: Record<string, unknown>) =>
    req(`/rest/v1/${encodeURIComponent(table)}`, {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(row),
    }).then(jsonOrThrow),
  updateRow: (table: string, pk: Record<string, unknown>, patch: Record<string, unknown>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(pk)) p.set(k, `eq.${v}`)
    return req(`/rest/v1/${encodeURIComponent(table)}?${p}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }).then(jsonOrThrow)
  },
  deleteRow: (table: string, pk: Record<string, unknown>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(pk)) p.set(k, `eq.${v}`)
    return req(`/rest/v1/${encodeURIComponent(table)}?${p}`, { method: 'DELETE' }).then(jsonOrThrow)
  },

  // ── auth users ──
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

  // ── storage ──
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
}
