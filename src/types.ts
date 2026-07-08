import type { JwtClaims } from './jwt.js'

export interface MigrationFile {
  /** e.g. "20240101120000_create_posts" (no extension) */
  name: string
  sql: string
}

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
  /** Secret used to sign/verify every JWT. Defaults to the Supabase local-dev secret. */
  jwtSecret?: string
  /** External URL of this backend, used as JWT issuer. */
  siteUrl?: string
  /** Access token lifetime in seconds (default 3600). */
  jwtExpiry?: number
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
}

export interface MailMessage {
  to: string
  subject: string
  text: string
}

/** Pluggable mail transport. Default implementation logs to the console. */
export interface Mailer {
  send(msg: MailMessage): Promise<void>
}

export const DEFAULT_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'

/** Per-request execution context derived from apikey/Authorization headers. */
export interface RequestContext {
  /** Postgres role to SET LOCAL: anon | authenticated | service_role */
  role: string
  /** Verified JWT claims (published to request.jwt.claims for RLS). */
  claims: JwtClaims | null
}

export interface StorageDriver {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  deleteMany(keys: string[]): Promise<void>
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>
  ) {
    super(typeof body.message === 'string' ? body.message : JSON.stringify(body))
  }
}
