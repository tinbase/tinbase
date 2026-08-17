/**
 * tinbase - a pure-JS, Docker-free Supabase backend on PGlite that speaks
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
import { RateLimiter } from './auth/rate-limit.js'
import { InboxMailer } from './auth/inbox.js'
import { loadAuthSettings } from './auth/settings.js'
import { LogBuffer } from './log-buffer.js'
import { FunctionsHandler, type EdgeFunction } from './functions/handler.js'
import { installDenoShim } from './functions/deno-shim.js'
import { Database } from './db/database.js'
import { deriveApiKeys, verifyJwt } from './jwt.js'
import { RealtimeEngine } from './realtime/engine.js'
import { RestHandler } from './rest/handler.js'
import { MemoryStorageDriver } from './storage/driver.js'
import { StorageHandler } from './storage/handler.js'
import { WebhooksService, type WebhookDelivery } from './webhooks/service.js'
import { CronService } from './cron/service.js'
import { NetService, type NetDelivery } from './net/service.js'
import { RetentionService } from './retention/service.js'
import { DEFAULT_JWT_SECRET, type BackendConfig, type Mailer, type MigrationFile, type RequestContext } from './types.js'
import { assertSecretsSafe, isNetworkExposed } from './security.js'

export * from './types.js'
export { Database } from './db/database.js'
export { createPgmemEngine } from './db/pgmem-engine.js'
export { createPgliteEngine } from './db/pglite-engine.js'
export { MemoryStorageDriver } from './storage/driver.js'
export { InboxMailer, type InboxEntry } from './auth/inbox.js'
export { LogBuffer, type LogEntry, type LogLevel } from './log-buffer.js'
export { RealtimeEngine, type RealtimeSocketLike } from './realtime/engine.js'
export { signJwt, verifyJwt, decodeJwt, deriveApiKeys } from './jwt.js'
export { FunctionsHandler, type EdgeFunction, type FunctionContext } from './functions/handler.js'
export { generateTypes } from './gen-types.js'
export { installDenoShim } from './functions/deno-shim.js'
export { WebhooksService, type WebhookConfig, type WebhookDelivery } from './webhooks/service.js'
export { CronService, cronMatches } from './cron/service.js'
export { NetService, type NetDelivery } from './net/service.js'
export { RetentionService, type RetentionConfig } from './retention/service.js'
export { snapshotSchema, diffSchemas, type SchemaSnapshot } from './db/schema-diff.js'
export { inspectDb, type TableInfo } from './db/inspect.js'

/**
 * A running tinbase backend. The one field a consumer always needs is
 * {@link TinbaseBackend.fetch}; the rest expose the underlying services for
 * advanced/embedded use (in-process realtime, manual migrations, log access).
 * Returned by {@link createBackend}.
 */
export interface TinbaseBackend {
  /** The whole backend as a fetch handler. Pass to supabase-js as global.fetch for in-process use. */
  fetch: (req: Request) => Promise<Response>
  /** The database engine wrapper - run raw SQL, inspect schema, apply migrations. */
  db: Database
  /** Realtime (Postgres CDC → WebSocket) engine backing supabase.channel(). */
  realtime: RealtimeEngine
  /** Edge-function registry/dispatcher backing supabase.functions.invoke(). */
  functions: FunctionsHandler
  /** Database-webhook service (HTTP requests fired on row changes). */
  webhooks: WebhooksService
  /** pg_cron emulation scheduler. */
  cron: CronService
  /** pg_net emulation sender (net.http_* queue drain). */
  net: NetService
  /** Background sweeper that purges expired tokens and aged-out audit rows. */
  retention: RetentionService
  /** JWT for the anon role - use as supabase-js's supabaseKey. */
  anonKey: string
  /** JWT for the service_role - bypasses RLS. */
  serviceRoleKey: string
  /** Secret used to sign/verify every JWT (the resolved value, incl. the default). */
  jwtSecret: string
  /** Recent server logs (also surfaced in the Studio Logs pane). */
  logs: LogBuffer
  /** Captured dev email inbox (mounted at /inbox), or null if a custom mailer was provided. */
  inbox: InboxMailer | null
  /** Apply additional migrations at runtime. */
  migrate: (migrations: MigrationFile[], seedSql?: string) => Promise<string[]>
  /** Tear down every background service and close the database. Idempotent-safe to await once. */
  close: () => Promise<void>
}

/**
 * Content-Security-Policy for the studio shell. The build inlines all JS/CSS
 * into one document, so `'unsafe-inline'` is unavoidable for scripts/styles;
 * everything else is locked to same-origin, `frame-ancestors 'none'` blocks
 * clickjacking, and `object-src 'none'` blocks plugin content.
 */
const ADMIN_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
  "base-uri 'self'; frame-ancestors 'none'"

/** Stable weak ETag for the (constant) studio HTML, so reloads revalidate to 304. */
const ADMIN_ETAG = `W/"${fnv1a(ADMIN_HTML)}"`

/** FNV-1a 32-bit hash as an 8-char hex string. Non-cryptographic, ETag-only. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  'access-control-allow-headers':
    'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, x-upsert, x-client-info, x-supabase-api-version, cache-control',
  'access-control-expose-headers': 'content-range, range-unit, content-profile',
  'access-control-max-age': '86400',
}

/**
 * Build a running tinbase backend from {@link BackendConfig}. Wires the
 * database, auth, storage, realtime, edge functions, and the background
 * services (webhooks/cron/net/retention), mints the anon/service_role keys, and
 * returns a {@link TinbaseBackend} whose `fetch` handles every Supabase wire
 * route.
 *
 * All config is optional: with an empty config it boots an in-memory PGlite
 * backend on the Supabase local-dev defaults. If any startup step throws (e.g. a
 * failing migration), every handle opened so far is torn down before the error
 * propagates, so a failed construction never leaks the engine or a timer.
 *
 * @throws Error from {@link assertSecretsSafe} when bound to a network-exposed
 *   host with a weak/default JWT secret or a derived vault key.
 */
export async function createBackend(config: BackendConfig = {}): Promise<TinbaseBackend> {
  const jwtSecret = config.jwtSecret ?? DEFAULT_JWT_SECRET
  const siteUrl = config.siteUrl ?? 'http://localhost:54321'
  const jwtExpiry = config.jwtExpiry ?? 3600

  // capture server logs for the Studio "Logs" pane, still forwarding to the
  // configured logger (or console)
  const logs = new LogBuffer()
  const baseLog = config.log ?? ((m: string) => console.log(m))
  const log = (m: string) => {
    logs.push(m)
    baseLog(m)
  }

  // Vault encryption key: use the configured value, else derive one from the
  // JWT secret so vault secrets are encrypted at rest out of the box (better
  // than the old plaintext store). Set a dedicated vaultKey in production.
  const vaultKeyDerived = config.vaultKey === undefined
  const vaultKey = config.vaultKey ?? `tinbase-vault:${jwtSecret}`

  // Weak/default secrets are fine on loopback; refuse to start with them when
  // the server is bound to a network-exposed host.
  assertSecretsSafe({ host: config.host, jwtSecret, vaultKeyDerived, warn: log })

  // Resolve an external-Postgres engine on demand (Node only) so the browser
  // core never imports the wire client.
  let engine = config.engine
  if (!engine && config.databaseUrl) {
    const { createDatabaseUrlEngine } = await import('./node/native/database-url.js')
    engine = await createDatabaseUrlEngine({ databaseUrl: config.databaseUrl, log })
  }

  const db = await Database.create(engine ?? config.dataDir, { vaultKey })

  // Anything created after the engine (a running native Postgres child, the
  // realtime LISTEN, background timers) must be torn down if a later step throws
  // - e.g. a failing migration - so a construction error never leaks a handle.
  const cleanup: Array<() => void | Promise<void>> = []
  const failStartup = async (e: unknown): Promise<never> => {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {})
    await db.close().catch(() => {})
    throw e
  }

  try {
    if (config.migrations?.length || config.seedSql) {
      const applied = await db.runMigrations(config.migrations ?? [], config.seedSql)
      if (applied.length > 0) log(`applied migrations: ${applied.join(', ')}`)
    }
  } catch (e) {
    await failStartup(e)
  }

  // Dev keys are deterministic (Supabase-demo claims, fixed expiry): the same
  // secret always yields the same keys, so with the default secret they are
  // byte-identical to Supabase's well-known local demo keys and a .env.local
  // can be committed and shared. Under NODE_ENV=production every start signs
  // fresh, unique keys instead.
  const isProduction =
    typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
  const { anonKey, serviceRoleKey } = await deriveApiKeys(jwtSecret, isProduction ? 'unique' : 'deterministic')

  const rest = new RestHandler(db, { exposedSchemas: config.dbSchemas, maxRows: config.maxRows })
  // With no custom mailer, capture auth emails in an in-memory inbox (viewable
  // at /inbox) and log a metadata-only line. A provided mailer takes over and no
  // inbox is mounted.
  //
  // The server log records only the recipient and subject - never the body,
  // which carries OTP codes and magic links. Set logMailBody: true to also log
  // the full body for local debugging (the /inbox UI always shows it in full).
  const inbox = config.mailer
    ? null
    : new InboxMailer((msg) =>
        log(
          config.logMailBody
            ? `[mail] to=${msg.to} subject="${msg.subject}"\n${msg.text}`
            : `[mail] to=${msg.to} subject="${msg.subject}"`
        )
      )
  const mailer: Mailer = config.mailer ?? inbox!
  // one shared runtime-settings object: config.toml [auth] provides the
  // committed defaults, the persisted auth.config row layers live studio edits
  // on top, and the auth handler reads the merged object per request
  const authSettings = await loadAuthSettings(db, config.authSettings)
  const storage = new StorageHandler(db, config.storageDriver ?? new MemoryStorageDriver(), {
    jwtSecret,
    defaultFileSizeLimit: config.storageFileSizeLimit,
    log,
  })
  if (config.buckets?.length) await storage.ensureBuckets(config.buckets)
  const auth = new AuthHandler(db, {
    jwtSecret,
    siteUrl,
    jwtExpiry,
    sessionTimeboxSeconds: config.sessionTimeboxSeconds,
    mailer,
    oauthProviders: config.oauthProviders,
    oauthFetch: config.oauthFetch,
    uriAllowList: config.uriAllowList,
    enforceRedirectAllowList: isNetworkExposed(config.host),
    settings: authSettings,
    rateLimiter: new RateLimiter(config.authRateLimits),
  })
  cleanup.push(() => auth.stop())

  const realtime = new RealtimeEngine(db, jwtSecret)
  const webhooks = new WebhooksService(
    db,
    config.webhookFetch,
    (d: WebhookDelivery) =>
      log(`[webhook] ${d.event.type} ${d.event.schema}.${d.event.table} -> ${d.webhook.url} ${d.ok ? d.status : 'FAILED ' + (d.error ?? '')}`),
    isNetworkExposed(config.host)
  )
  const cron = new CronService(db)
  const retention = new RetentionService(db, config.retention)
  const net = new NetService(db, config.netFetch, undefined, (d: NetDelivery) =>
    log(`[net] ${d.method} ${d.url} -> ${d.timedOut ? 'TIMEOUT' : d.error ? 'FAILED ' + d.error : d.status}`)
  )

  try {
    await realtime.start()
    cleanup.push(() => realtime.stop())
    if (config.webhooks?.length) await webhooks.start(config.webhooks)
    cleanup.push(() => webhooks.stopService())
    cron.start()
    cleanup.push(() => cron.stop())
    retention.start()
    cleanup.push(() => retention.stop())
    net.start()
    cleanup.push(() => net.stop())
  } catch (e) {
    await failStartup(e)
  }

  const fnMap =
    config.functions instanceof Map
      ? config.functions
      : new Map(Object.entries(config.functions ?? {}))
  const fnEnv = {
    SUPABASE_URL: siteUrl,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    ...(config.functionEnv ?? {}),
  }

  const admin = new AdminApi(
    db,
    logs,
    { anonKey, jwtSecret },
    {
      edgeFunctions: [...fnMap.keys()],
      oauthProviders: Object.keys(config.oauthProviders ?? {}),
      inbox: inbox !== null,
      webhooks: config.webhooks ?? [],
      authSettings,
      functionEnv: fnEnv,
    }
  )

  // install the Deno global once per process; the shim's Deno.env is bound to
  // this backend's fnEnv per-invocation by FunctionsHandler (so backends don't
  // share env through the global).
  installDenoShim()
  const functions = new FunctionsHandler(fnMap as Map<string, EdgeFunction>, fnEnv)

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
      try {
        await db.query('select 1')
        return withCors(
          new Response(JSON.stringify({ name: 'tinbase', status: 'healthy' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      } catch (err: any) {
        log(`health check database query failed: ${err?.message ?? String(err)}`)
        return withCors(
          new Response(JSON.stringify({ name: 'tinbase', status: 'unhealthy' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        )
      }
    }

    // studio SPA - serve the shell for every /_/* route so deep links work.
    // no-cache forces revalidation (the whole app is inlined in this one
    // document); the ETag then lets an unchanged studio return 304 instead of
    // re-sending the full ~0.6 MB body. A strict CSP hardens the shell.
    if (path === '/_' || path.startsWith('/_/')) {
      // Auto-login: if `?_key=<service_role>` is in the URL, inject
      // the key into sessionStorage so the Studio shell authenticates
      // without a manual login step.
      const autoKey = url.searchParams.get('_key')
      const headers: Record<string, string> = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'content-security-policy': ADMIN_CSP,
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      }
      if (autoKey) {
        const loginScript = `<script>sessionStorage.setItem("tinbase_service_key",${JSON.stringify(autoKey)});` +
          // strip _key from the URL so it isn't visible / bookmarkable
          `history.replaceState(null,"",location.pathname)</script>`
        const html = ADMIN_HTML.includes('</head>')
          ? ADMIN_HTML.replace('</head>', loginScript + '</head>')
          : loginScript + ADMIN_HTML
        return new Response(html, { status: 200, headers })
      }
      headers['etag'] = ADMIN_ETAG
      if (req.headers.get('if-none-match') === ADMIN_ETAG) {
        return new Response(null, { status: 304, headers })
      }
      return new Response(ADMIN_HTML, { status: 200, headers })
    }

    // local email inbox (dev-only; mounted only when using the default mailer)
    if (inbox && (path === '/inbox' || path.startsWith('/inbox/'))) {
      return withCors(inbox.serve(req, url))
    }

    // public endpoints that skip apikey checks
    if (
      path.startsWith('/storage/v1/object/public/') ||
      path.startsWith('/storage/v1/object/sign/') ||
      path.startsWith('/storage/v1/render/image/public/') ||
      path.startsWith('/storage/v1/render/image/sign/')
    ) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        return withCors(await storage.handle(req, { role: 'anon', claims: null }, url))
      }
    }
    if (config.authEnabled === false && path.startsWith('/auth/v1')) {
      return withCors(
        new Response(JSON.stringify({ message: 'Auth service is disabled' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      )
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
      const keyClaims = apikey ? await verifyJwt(apikey, jwtSecret) : null
      if (!keyClaims) {
        return withCors(
          new Response(JSON.stringify({ message: 'No API key found in request' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        )
      }
      const ctx: RequestContext = { role: String(keyClaims.role ?? 'anon'), claims: keyClaims }
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

  // Last-resort guard: the fetch contract is Request → Response, so an
  // unexpected throw from any handler must become a 500, never a rejected fetch
  // (in-process/browser callers have no HTTP layer to convert a rejection).
  const safeHandle = async (req: Request): Promise<Response> => {
    try {
      return await handle(req)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(`[error] unhandled: ${msg}`)
      return withCors(
        new Response(JSON.stringify({ message: 'Internal Server Error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
  }

  // request logging for the Logs pane (skip health checks and the log-polling
  // endpoint itself to avoid noise / self-reference)
  const loggedFetch = async (req: Request): Promise<Response> => {
    const res = await safeHandle(req)
    try {
      const p = new URL(req.url).pathname
      if (p !== '/health' && p !== '/' && p !== '/admin/v1/logs') {
        const level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info'
        logs.push(`${req.method} ${p} → ${res.status}`, level)
      }
    } catch {
      // never let logging break a response
    }
    return res
  }

  return {
    fetch: loggedFetch,
    db,
    realtime,
    functions,
    webhooks,
    cron,
    net,
    retention,
    anonKey,
    serviceRoleKey,
    jwtSecret,
    logs,
    inbox,
    migrate: (migrations, seedSql) => db.runMigrations(migrations, seedSql),
    close: async () => {
      auth.stop()
      await cron.stop()
      await net.stop()
      await retention.stop()
      webhooks.stopService()
      realtime.stop()
      await db.close()
    },
  }
}

/** Add the permissive CORS headers to a response, leaving any already-set header untouched. */
function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v)
  }
  return res
}
