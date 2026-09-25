/**
 * Public configuration and shared types for the tinbase package. {@link BackendConfig}
 * is the primary input to {@link import('./index.js').createBackend}; the rest are
 * the small structural types that config and handlers exchange.
 */
import type { JwtClaims } from './jwt.js'

/** A single SQL migration, in Supabase CLI form (one file under supabase/migrations). */
export interface MigrationFile {
  /** e.g. "20240101120000_create_posts" (no extension) */
  name: string
  /** Raw SQL applied in one statement batch. */
  sql: string
}

/**
 * Configuration for {@link import('./index.js').createBackend}. Every field is
 * optional; an empty config boots an in-memory PGlite backend on the Supabase
 * local-dev defaults. The CLI derives this object from supabase/config.toml plus
 * the project's migrations/functions/seed.
 */
export interface BackendConfig {
  /**
   * PGlite data directory. Node: a filesystem path. Browser: "idb://name" or
   * "opfs-ahp://name". Omit for in-memory. Ignored when `engine` is set.
   */
  dataDir?: string
  /**
   * Custom database engine (e.g. the native embedded Postgres engine from
   * "tinbase/node"). Default: PGlite on `dataDir`.
   */
  engine?: import('./db/engine.js').DbEngine
  /**
   * Connect to an external Postgres you already run, e.g.
   * "postgres://user:pass@host:5432/db", instead of the embedded engine. Node
   * only; ignored when `engine` is set. The target is treated as shared: the
   * bootstrap runs idempotently and never assumes exclusive ownership.
   */
  databaseUrl?: string
  /** Secret used to sign/verify every JWT. Defaults to the Supabase local-dev secret. */
  jwtSecret?: string
  /**
   * Schemas exposed through the Data API (/rest/v1) for anon/authenticated -
   * PostgREST's db-schemas. Requests profiling into any other schema get a 406
   * unless made with the service_role key. Default: ['public'].
   */
  dbSchemas?: string[]
  /**
   * Auth setting defaults (the committed baseline, e.g. read from
   * supabase/config.toml's [auth] section). Live studio edits, persisted in the
   * auth.config table, are layered on top. Any omitted key falls back to the
   * built-in default.
   */
  authSettings?: Partial<import('./auth/settings.js').AuthSettings>
  /**
   * Key used to encrypt Vault secrets at rest (pgcrypto). Held only in a session
   * GUC, never stored in the database. Defaults to a value derived from
   * jwtSecret. Required when binding to a network-exposed host (see `host`);
   * always set a dedicated key in production.
   */
  vaultKey?: string
  /** Where the application lives: the default redirect for emailed links. */
  siteUrl?: string
  /**
   * Where this backend answers - emailed links are built on it and it is the
   * JWT issuer. Defaults to `siteUrl`, which is what a deployment serving both
   * from one address is already using.
   */
  apiExternalUrl?: string
  /**
   * Host the server is bound to. Used only to decide whether the backend is
   * network-exposed: a non-loopback host turns the default JWT secret and the
   * derived vault key from warnings into hard startup errors. Default: treated
   * as loopback (local dev) when omitted.
   */
  host?: string
  /** Access token lifetime in seconds (default 3600). */
  jwtExpiry?: number
  /**
   * Redirect targets allowed beyond the site URL's own origin (GoTrue's
   * URI_ALLOW_LIST). Entries may use `*`/`**` globs. A `redirect_to` matching
   * neither the site origin nor an entry falls back to the site URL.
   */
  uriAllowList?: string[]
  /** Migrations to apply on boot (Supabase CLI convention: sorted by name). */
  migrations?: MigrationFile[]
  /** SQL from supabase/seed.sql, applied once after the first migration run. */
  seedSql?: string
  /** Where object storage bytes live. Default: in-memory. Node CLI passes a fs driver. */
  storageDriver?: StorageDriver
  /** Edge functions: name → fetch handler, served at /functions/v1/<name>. */
  functions?: Map<string, import('./functions/handler.js').EdgeFunction> | Record<string, import('./functions/handler.js').EdgeFunction>
  /** Extra env/secrets exposed to functions via Deno.env and ctx.env (e.g. from supabase/functions/.env). */
  functionEnv?: Record<string, string>
  /** Mail transport for OTP/magic-link/recovery emails. Default: console logger. */
  mailer?: Mailer
  /**
   * Per-type auth email bodies (config.toml `[auth.email.template.*]`), as
   * GoTrue templates. A project decides what its mail offers - link, code, or a
   * link straight to its own page - by which `{{ .Variable }}` it uses. Types
   * without an override keep the built-in default.
   */
  emailTemplates?: import('./auth/templates.js').EmailTemplates
  /**
   * `[auth.hook.send_email]`: an endpoint that receives the token data and
   * composes and sends the mail itself, replacing both rendering and transport.
   */
  sendEmailHook?: import('./auth/send-email-hook.js').SendEmailHookConfig
  /** Injectable fetch for the hook (tests capture the request). */
  hookFetch?: typeof fetch
  /** OAuth providers, e.g. { google: { clientId, clientSecret } }. Served at /auth/v1/authorize. */
  oauthProviders?: Record<string, import('./auth/oauth.js').OAuthProviderConfig>
  /** Injectable fetch for OAuth provider calls (tests point this at a mock provider). */
  oauthFetch?: typeof fetch
  /** Database webhooks: fire HTTP requests on table changes. */
  webhooks?: import('./webhooks/service.js').WebhookConfig[]
  /** Injectable fetch for webhook delivery (tests capture calls). */
  webhookFetch?: typeof fetch
  /** Injectable fetch for net.http_* (pg_net emulation) delivery (tests capture calls). */
  netFetch?: typeof fetch
  /** Print startup/debug logs. */
  log?: (msg: string) => void
  /**
   * Log the full body of auth emails (OTP codes, magic links) to the server log.
   * Off by default so secrets don't land in log files; the /inbox dev UI still
   * shows the full body regardless. Enable only for local debugging.
   */
  logMailBody?: boolean
  /** Data-retention windows for the background cleanup sweep. */
  retention?: import('./retention/service.js').RetentionConfig
  /** Max rows a single REST read returns (PostgREST db-max-rows; config.toml api.max_rows). Unlimited if unset. */
  maxRows?: number
  /** Default per-bucket file size limit in bytes (config.toml storage.file_size_limit). */
  storageFileSizeLimit?: number
  /** Buckets to create at boot if absent (config.toml storage.buckets.*). */
  buckets?: BucketSeed[]
  /** Force sign-out after this many seconds regardless of activity (config.toml auth.sessions.timebox). */
  sessionTimeboxSeconds?: number
  /** Sign out after this many seconds of inactivity (config.toml auth.sessions.inactivity_timeout). */
  sessionInactivitySeconds?: number
  /** Per-endpoint auth rate-limit rules (config.toml auth.rate_limit.*). Defaults applied when unset. */
  authRateLimits?: Record<string, import('./auth/rate-limit.js').RateLimitRule>
  /** Mount the auth service. Default true; config.toml auth.enabled = false turns /auth/v1 off. */
  authEnabled?: boolean
}

/** A rendered outbound email (OTP code, magic link, recovery, etc.). */
export interface MailMessage {
  to: string
  subject: string
  /** Plain-text body. Carries OTP codes / magic links, so it is not logged by default. */
  text: string
  /**
   * HTML body, sent alongside `text` as a multipart alternative.
   *
   * Not decoration: a bare URL in a text-only mail is linkified by the client's
   * own guesswork, and a long auth link (query string, percent-encoded
   * `redirect_to`) gets truncated by that guesswork - Gmail on Android opened
   * only the scheme and host of a 210-character recovery link, landing the user
   * on the API root instead of the reset page. An `<a href>` states the target
   * exactly, so there is nothing to guess.
   */
  html?: string
}

/** Pluggable mail transport. Default implementation logs to the console. */
export interface Mailer {
  send(msg: MailMessage): Promise<void>
}

/**
 * The public Supabase local-dev JWT secret. Used when no `jwtSecret` is set so
 * default keys match a stock `supabase start`.
 *
 * SECURITY: forgeable by anyone (it is public). Startup refuses to bind to a
 * network-exposed host while still using it - see {@link import('./security.js').assertSecretsSafe}.
 */
export const DEFAULT_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'

/**
 * tinbase package version, surfaced in `/rest/v1/` and `/auth/v1/health`, and used
 * for the update check on start.
 *
 * Hardcoded rather than read from package.json at runtime, because the
 * single-binary build has no package.json to read and would report a fallback.
 * It is therefore duplicated, and it drifted: it sat at 0.9.0 for three releases
 * while both endpoints reported that to callers. `version stays in sync with
 * package.json` in test/version.test.ts now fails the moment the two diverge, so
 * a release cannot quietly ship the wrong number again.
 */
export const TINBASE_VERSION = '0.16.2'

/** Per-request execution context derived from apikey/Authorization headers. */
export interface RequestContext {
  /** Postgres role to SET LOCAL: anon | authenticated | service_role */
  role: string
  /** Verified JWT claims (published to request.jwt.claims for RLS). */
  claims: JwtClaims | null
}

/** A bucket to create at boot (from config.toml [storage.buckets.<id>]). */
export interface BucketSeed {
  id: string
  public: boolean
  /** Per-bucket byte limit, or null for none. */
  fileSizeLimit: number | null
  /** Allowed MIME types, or null for any. */
  allowedMimeTypes: string[] | null
}

/** Pluggable object-storage backend for bucket bytes (in-memory, fs, etc.). */
export interface StorageDriver {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  deleteMany(keys: string[]): Promise<void>
}

/** Error carrying an HTTP status + JSON body, thrown by handlers and rendered as-is to the client. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>
  ) {
    super(typeof body.message === 'string' ? body.message : JSON.stringify(body))
  }
}
