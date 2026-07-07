/**
 * tinbase — a pure-JS, Docker-free Supabase backend on PGlite that speaks
 * the same wire protocols as hosted Supabase, so the official supabase-js
 * SDK works unchanged.
 *
 * The core is a fetch handler (Request → Response): serve it over HTTP in
 * Node, or call it in-process in the browser by passing it as supabase-js's
 * `global.fetch`.
 */
import { AdminApi } from './admin/api.js'
import { ADMIN_HTML } from './admin/ui.js'
import { AuthHandler } from './auth/handler.js'
import { FunctionsHandler, type EdgeFunction } from './functions/handler.js'
import { Database } from './db/database.js'
import { signJwt, verifyJwt } from './jwt.js'
import { RealtimeEngine } from './realtime/engine.js'
import { RestHandler } from './rest/handler.js'
import { MemoryStorageDriver } from './storage/driver.js'
import { StorageHandler } from './storage/handler.js'
import { DEFAULT_JWT_SECRET, type BackendConfig, type MigrationFile, type RequestContext } from './types.js'

export * from './types.js'
export { Database } from './db/database.js'
export { MemoryStorageDriver } from './storage/driver.js'
export { RealtimeEngine, type RealtimeSocketLike } from './realtime/engine.js'
export { signJwt, verifyJwt, decodeJwt } from './jwt.js'
export { FunctionsHandler, type EdgeFunction, type FunctionContext } from './functions/handler.js'
export { generateTypes } from './gen-types.js'
export { snapshotSchema, diffSchemas, type SchemaSnapshot } from './db/schema-diff.js'

export interface TinbaseBackend {
  /** The whole backend as a fetch handler. Pass to supabase-js as global.fetch for in-process use. */
  fetch: (req: Request) => Promise<Response>
  db: Database
  realtime: RealtimeEngine
  functions: FunctionsHandler
  /** JWT for the anon role — use as supabase-js's supabaseKey. */
  anonKey: string
  /** JWT for the service_role — bypasses RLS. */
  serviceRoleKey: string
  jwtSecret: string
  /** Apply additional migrations at runtime. */
  migrate: (migrations: MigrationFile[], seedSql?: string) => Promise<string[]>
  close: () => Promise<void>
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  'access-control-allow-headers':
    'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, x-upsert, x-client-info, x-supabase-api-version, cache-control',
  'access-control-expose-headers': 'content-range, range-unit, content-profile',
  'access-control-max-age': '86400',
}

export async function createBackend(config: BackendConfig = {}): Promise<TinbaseBackend> {
  const jwtSecret = config.jwtSecret ?? DEFAULT_JWT_SECRET
  const siteUrl = config.siteUrl ?? 'http://localhost:54321'
  const jwtExpiry = config.jwtExpiry ?? 3600

  const db = await Database.create(config.engine ?? config.dataDir)
  if (config.migrations?.length || config.seedSql) {
    const applied = await db.runMigrations(config.migrations ?? [], config.seedSql)
    if (applied.length > 0) config.log?.(`applied migrations: ${applied.join(', ')}`)
  }

  const now = Math.floor(Date.now() / 1000)
  const tenYears = 10 * 365 * 24 * 3600
  const anonKey = await signJwt({ iss: 'supabase', ref: 'tinbase', role: 'anon', iat: now, exp: now + tenYears }, jwtSecret)
  const serviceRoleKey = await signJwt(
    { iss: 'supabase', ref: 'tinbase', role: 'service_role', iat: now, exp: now + tenYears },
    jwtSecret
  )

  const rest = new RestHandler(db)
  const mailer = config.mailer ?? {
    async send(msg: { to: string; subject: string; text: string }) {
      const log = config.log ?? console.log
      log(`[mail] to=${msg.to} subject="${msg.subject}"\n${msg.text}`)
    },
  }
  const auth = new AuthHandler(db, {
    jwtSecret,
    siteUrl,
    jwtExpiry,
    mailer,
    oauthProviders: config.oauthProviders,
    oauthFetch: config.oauthFetch,
  })
  const storage = new StorageHandler(db, config.storageDriver ?? new MemoryStorageDriver(), { jwtSecret })
  const realtime = new RealtimeEngine(db, jwtSecret)
  await realtime.start()
  const admin = new AdminApi(db)

  const fnMap =
    config.functions instanceof Map
      ? config.functions
      : new Map(Object.entries(config.functions ?? {}))
  const functions = new FunctionsHandler(fnMap as Map<string, EdgeFunction>, {
    SUPABASE_URL: siteUrl,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  })

  async function resolveContext(req: Request, url: URL): Promise<RequestContext | Response> {
    const authz = req.headers.get('authorization')
    const bearer = authz?.toLowerCase().startsWith('bearer ') ? authz.slice(7) : null
    const token = bearer ?? req.headers.get('apikey') ?? url.searchParams.get('apikey')
    if (!token) {
      return withCors(
        new Response(JSON.stringify({ message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    const claims = await verifyJwt(token, jwtSecret)
    if (!claims) {
      return withCors(
        new Response(JSON.stringify({ message: 'Invalid API key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    const role = typeof claims.role === 'string' ? claims.role : 'anon'
    if (!['anon', 'authenticated', 'service_role'].includes(role)) {
      return withCors(
        new Response(JSON.stringify({ message: `Invalid role: ${role}` }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    return { role, claims }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }
    if (path === '/' || path === '/health') {
      return withCors(
        new Response(JSON.stringify({ name: 'tinbase', status: 'healthy' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    }

    if (path === '/_' || path === '/_/') {
      return new Response(ADMIN_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    // public endpoints that skip apikey checks
    if (path.startsWith('/storage/v1/object/public/') || path.startsWith('/storage/v1/object/sign/')) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        return withCors(await storage.handle(req, { role: 'anon', claims: null }, url))
      }
    }
    if (
      (path === '/auth/v1/verify' || path === '/auth/v1/authorize' || path === '/auth/v1/callback') &&
      (req.method === 'GET' || req.method === 'POST')
    ) {
      // email-link clicks and OAuth provider redirects arrive without an apikey
      return withCors(await auth.handle(req, { role: 'anon', claims: null }, url))
    }
    if (path.startsWith('/auth/v1/')) {
      // GoTrue validates the apikey header, but user JWTs ride Authorization
      const apikey = req.headers.get('apikey') ?? url.searchParams.get('apikey')
      if (!apikey || !(await verifyJwt(apikey, jwtSecret))) {
        return withCors(
          new Response(JSON.stringify({ message: 'No API key found in request' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        )
      }
      const keyClaims = await verifyJwt(apikey, jwtSecret)
      const ctx: RequestContext = { role: String(keyClaims?.role ?? 'anon'), claims: keyClaims }
      return withCors(await auth.handle(req, ctx, url))
    }

    const ctx = await resolveContext(req, url)
    if (ctx instanceof Response) return ctx

    if (path.startsWith('/rest/v1')) return withCors(await rest.handle(req, ctx, url))
    if (path.startsWith('/admin/v1')) return withCors(await admin.handle(req, ctx, url))
    if (path.startsWith('/functions/v1')) return withCors(await functions.handle(req, ctx, url))
    if (path.startsWith('/storage/v1')) return withCors(await storage.handle(req, ctx, url))
    if (path.startsWith('/realtime/v1')) {
      return withCors(
        new Response(JSON.stringify({ message: 'Realtime requires a WebSocket connection' }), {
          status: 426,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    return withCors(
      new Response(JSON.stringify({ message: `Unknown endpoint: ${path}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    )
  }

  return {
    fetch: handle,
    db,
    realtime,
    functions,
    anonKey,
    serviceRoleKey,
    jwtSecret,
    migrate: (migrations, seedSql) => db.runMigrations(migrations, seedSql),
    close: async () => {
      realtime.stop()
      await db.close()
    },
  }
}

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v)
  }
  return res
}
