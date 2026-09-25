/**
 * Read everything tinbase can honor from an existing Supabase project's
 * supabase/config.toml, so pointing tinbase at that project needs no new config.
 *
 * config.toml is one document, so this is one loader: parse once, then project
 * the tree into a nested `ProjectConfig` that mirrors the file's sections. The
 * CLI spreads those sections into createBackend. Sections for services tinbase
 * doesn't run (SMS, analytics, pooler, studio/edge-runtime ports, experimental)
 * are intentionally ignored.
 */
import type { AuthSettings } from '../auth/settings.js'
import type { OAuthProviderConfig } from '../auth/oauth.js'
import type { RateLimitRule } from '../auth/rate-limit.js'
import type { BucketSeed } from '../types.js'
import {
  loadConfigToml,
  tableAt,
  getBool,
  getInt,
  getString,
  getStringArray,
  getByteSize,
  getDurationSeconds,
  type ConfigTable,
} from './config-toml.js'

/** The project's config.toml, projected into the shapes tinbase consumes. */
export interface ProjectConfig {
  /** the [auth] slice: settings, redirects, sessions, rate limits, OAuth */
  auth: AuthConfig
  /** the [api] slice: exposed schemas and row cap */
  api: ApiConfig
  /** the [storage] slice: default size limit and buckets to seed */
  storage: StorageConfig
  /** the [db.seed] slice: whether/what to seed */
  seed: SeedConfig
  /** per-function options keyed by function name ([functions.<name>]) */
  functions: Record<string, FunctionOptions>
}

/** The `[auth]` slice of config.toml, projected into the shapes the backend consumes. */
export interface AuthConfig {
  /** whether to run the auth service ([auth].enabled) */
  enabled?: boolean
  /** runtime-toggleable settings, layered under the live auth.config table */
  settings: Partial<AuthSettings>
  /** [auth].site_url - where the app lives; the default redirect */
  siteUrl?: string
  /** [auth].api_external_url - where this server answers; emailed links are built on it */
  apiExternalUrl?: string
  /** [auth].jwt_expiry, seconds */
  jwtExpiry?: number
  /** [auth].additional_redirect_urls */
  uriAllowList?: string[]
  /** [auth.rate_limit].* mapped to the auth limiter's rules */
  rateLimits?: Record<string, RateLimitRule>
  /** [auth.sessions].timebox, seconds */
  sessionTimeboxSeconds?: number
  /** [auth.sessions].inactivity_timeout, seconds */
  sessionInactivitySeconds?: number
  /** OAuth providers from [auth.external.*] and env-var fallbacks */
  oauthProviders: Record<string, OAuthProviderConfig>
  /**
   * [auth.email.template.*]: per-type `subject` and `content_path`. The path is
   * recorded, not read - loading files is the CLI's job, since config parsing
   * is shared with the browser build.
   */
  emailTemplates?: Record<string, { subject?: string; contentPath?: string }>
  /**
   * `[auth.email.smtp]`: the project's own mail server. Present means the
   * project sends its own email rather than relying on whatever the deployment
   * configured. `pass` arrives already resolved through the parser's `env(VAR)`
   * substitution, so the secret never has to sit in the committed file.
   */
  smtp?: { enabled?: boolean; host?: string; port?: number; user?: string; pass?: string; adminEmail?: string; senderName?: string; secure?: boolean }
  /**
   * `[auth.hook.send_email]`: hand the email to an endpoint instead of sending
   * it. Outranks every transport, because it replaces the rendering too.
   */
  sendEmailHook?: { enabled?: boolean; uri?: string; secret?: string }
}

/** The `[api]` slice of config.toml. */
export interface ApiConfig {
  /** [api].schemas: schemas exposed through the Data API (db-schemas) */
  schemas?: string[]
  /** [api].max_rows: REST read row cap */
  maxRows?: number
}

/** The `[storage]` slice of config.toml. */
export interface StorageConfig {
  /** [storage].file_size_limit: default per-bucket byte limit */
  fileSizeLimit?: number
  /** [storage.buckets.*]: buckets to create at boot */
  buckets?: BucketSeed[]
}

/** The `[db.seed]` slice of config.toml. */
export interface SeedConfig {
  /** [db.seed].enabled */
  enabled?: boolean
  /** [db.seed].sql_paths (files or globs, relative to supabase/) */
  paths?: string[]
}

/** Per-function `[functions.<name>]` options. */
export interface FunctionOptions {
  /** [functions.<name>].enabled */
  enabled?: boolean
  /** [functions.<name>].verify_jwt */
  verifyJwt?: boolean
  /** [functions.<name>].entrypoint, relative to the project root */
  entrypoint?: string
}

/** Parse supabase/config.toml once and project it into a {@link ProjectConfig}. */
export function loadProjectConfig(projectDir: string, env: NodeJS.ProcessEnv = process.env): ProjectConfig {
  const root = loadConfigToml(projectDir, env)
  return {
    auth: readAuth(root, env),
    api: readApi(root),
    storage: readStorage(root),
    seed: readSeed(root),
    functions: readFunctions(root),
  }
}

// ── [auth] ─────────────────────────────────────────────────────────────────

function readAuth(root: ConfigTable, env: NodeJS.ProcessEnv): AuthConfig {
  const auth = tableAt(root, 'auth')
  const out: AuthConfig = { settings: readAuthSettings(root), oauthProviders: readOAuthProviders(root, env) }

  const enabled = getBool(auth, 'enabled')
  if (enabled !== undefined) out.enabled = enabled
  const siteUrl = getString(auth, 'site_url')
  if (siteUrl !== undefined) out.siteUrl = siteUrl
  const apiExternalUrl = getString(auth, 'api_external_url')
  if (apiExternalUrl !== undefined) out.apiExternalUrl = apiExternalUrl
  const jwtExpiry = getInt(auth, 'jwt_expiry')
  if (jwtExpiry !== undefined && jwtExpiry > 0) out.jwtExpiry = jwtExpiry
  const redirects = getStringArray(auth, 'additional_redirect_urls')
  if (redirects !== undefined) out.uriAllowList = redirects

  const rateLimits = readRateLimits(root)
  if (rateLimits) out.rateLimits = rateLimits

  const templates = readEmailTemplates(root)
  if (templates) out.emailTemplates = templates

  const smtp = readSmtp(root)
  if (smtp) out.smtp = smtp
  const hook = tableAt(root, 'auth.hook.send_email')
  if (hook) {
    const enabled = getBool(hook, 'enabled')
    const uri = getString(hook, 'uri')
    const secret = getString(hook, 'secret')
    if (enabled !== undefined || uri !== undefined || secret !== undefined) {
      out.sendEmailHook = {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(uri !== undefined ? { uri } : {}),
        ...(secret !== undefined ? { secret } : {}),
      }
    }
  }

  const sessions = tableAt(root, 'auth.sessions')
  const timebox = getDurationSeconds(sessions, 'timebox')
  if (timebox !== undefined) out.sessionTimeboxSeconds = timebox
  const inactivity = getDurationSeconds(sessions, 'inactivity_timeout')
  if (inactivity !== undefined) out.sessionInactivitySeconds = inactivity

  return out
}

/**
 * `[auth.email.smtp]`, spelled as Supabase spells it so a project's block works
 * on either. Returned as-is; the CLI decides whether to build a transport from
 * it, since this module also runs where there is no network stack.
 */
function readSmtp(root: ConfigTable): AuthConfig['smtp'] | undefined {
  const t = tableAt(root, 'auth.email.smtp')
  if (!t) return undefined
  const out: NonNullable<AuthConfig['smtp']> = {}
  const enabled = getBool(t, 'enabled')
  if (enabled !== undefined) out.enabled = enabled
  const host = getString(t, 'host')
  if (host !== undefined) out.host = host
  const port = getInt(t, 'port')
  if (port !== undefined) out.port = port
  const user = getString(t, 'user')
  if (user !== undefined) out.user = user
  const pass = getString(t, 'pass')
  if (pass !== undefined) out.pass = pass
  const adminEmail = getString(t, 'admin_email')
  if (adminEmail !== undefined) out.adminEmail = adminEmail
  const senderName = getString(t, 'sender_name')
  if (senderName !== undefined) out.senderName = senderName
  const secure = getBool(t, 'secure')
  if (secure !== undefined) out.secure = secure
  return Object.keys(out).length ? out : undefined
}

/**
 * `[auth.email.template.<name>]` blocks: `subject` and `content_path`, exactly
 * as Supabase's config.toml spells them. The body itself is left on disk for
 * the CLI to read - this module also runs where there is no filesystem.
 */
function readEmailTemplates(root: ConfigTable): Record<string, { subject?: string; contentPath?: string }> | undefined {
  const templates = tableAt(root, 'auth.email.template')
  if (!templates) return undefined
  const out: Record<string, { subject?: string; contentPath?: string }> = {}
  for (const name of templates.children.keys()) {
    const t = templates.children.get(name)
    const subject = getString(t, 'subject')
    const contentPath = getString(t, 'content_path')
    if (subject === undefined && contentPath === undefined) continue
    out[name] = { ...(subject !== undefined ? { subject } : {}), ...(contentPath !== undefined ? { contentPath } : {}) }
  }
  return Object.keys(out).length ? out : undefined
}

/** The [auth]/[auth.email]/[auth.mfa] keys that become AuthSettings defaults. */
function readAuthSettings(root: ConfigTable): Partial<AuthSettings> {
  const auth = tableAt(root, 'auth')
  const email = tableAt(root, 'auth.email')
  const mfa = tableAt(root, 'auth.mfa')
  const mfaTotp = tableAt(root, 'auth.mfa.totp')
  const out: Partial<AuthSettings> = {}

  // Signups: [auth].disable_signup (legacy) or enable_signup at [auth]/[auth.email].
  const disableSignup = getBool(auth, 'disable_signup')
  if (disableSignup !== undefined) out.disableSignup = disableSignup
  const enableSignup = getBool(auth, 'enable_signup') ?? getBool(email, 'enable_signup')
  if (enableSignup !== undefined) out.disableSignup = !enableSignup

  const anon = getBool(auth, 'enable_anonymous_sign_ins')
  if (anon !== undefined) out.anonymousUsers = anon

  // enable_confirmations (require email confirmation) is the inverse of autoconfirm;
  // [auth.email] is canonical, top-level [auth] is the legacy alias.
  const confirmations = getBool(email, 'enable_confirmations') ?? getBool(auth, 'enable_confirmations')
  if (confirmations !== undefined) out.autoconfirm = !confirmations

  const minLen = getInt(auth, 'minimum_password_length')
  if (minLen !== undefined) out.minPasswordLength = minLen

  const otpLength = getInt(email, 'otp_length')
  if (otpLength !== undefined) out.otpLength = otpLength
  const otpExpiry = getInt(email, 'otp_expiry')
  if (otpExpiry !== undefined) out.otpExpirySeconds = otpExpiry
  // Supabase writes this as a duration ("60s", "1m0s"); accept a bare number too.
  const secureEmailChange = getBool(email, 'secure_email_change_enabled')
  if (secureEmailChange !== undefined) out.secureEmailChange = secureEmailChange
  const maxFrequency = getDurationSeconds(email, 'max_frequency') ?? getInt(email, 'max_frequency')
  if (maxFrequency !== undefined) out.maxEmailFrequencySeconds = maxFrequency

  const maxFactors = getInt(mfa, 'max_enrolled_factors')
  if (maxFactors !== undefined) out.maxEnrolledFactors = maxFactors
  const totpEnroll = getBool(mfaTotp, 'enroll_enabled')
  if (totpEnroll !== undefined) out.totpEnrollEnabled = totpEnroll
  const totpVerify = getBool(mfaTotp, 'verify_enabled')
  if (totpVerify !== undefined) out.totpVerifyEnabled = totpVerify

  return out
}

/** Map [auth.rate_limit].* to the auth limiter's rules (GoTrue's windows). */
function readRateLimits(root: ConfigTable): Record<string, RateLimitRule> | undefined {
  const rl = tableAt(root, 'auth.rate_limit')
  if (!rl) return undefined
  const out: Record<string, RateLimitRule> = {}
  const FIVE_MIN = 5 * 60 * 1000
  const ONE_HOUR = 60 * 60 * 1000

  const signIn = getInt(rl, 'sign_in_sign_ups')
  if (signIn !== undefined) {
    out.token = { limit: signIn, windowMs: FIVE_MIN }
    out.signup = { limit: signIn, windowMs: FIVE_MIN }
  }
  const verify = getInt(rl, 'token_verifications')
  if (verify !== undefined) out.verify = { limit: verify, windowMs: FIVE_MIN }
  const email = getInt(rl, 'email_sent')
  if (email !== undefined) {
    out.otp = { limit: email, windowMs: ONE_HOUR }
    out.recover = { limit: email, windowMs: ONE_HOUR }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * OAuth providers, highest precedence first:
 *   1. config.toml [auth.external.<provider>]
 *   2. GOTRUE_EXTERNAL_<PROVIDER>_CLIENT_ID / _SECRET / _ENABLED
 *   3. TINBASE_OAUTH_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET / _ENABLED
 * Endpoints come from presets in oauth.ts; only real overrides are passed.
 */
function readOAuthProviders(root: ConfigTable, env: NodeJS.ProcessEnv): Record<string, OAuthProviderConfig> {
  const out: Record<string, OAuthProviderConfig> = {}

  const external = tableAt(root, 'auth.external')
  if (external) {
    for (const [name, t] of external.children) {
      const enabled = getBool(t, 'enabled') ?? true
      const clientId = getString(t, 'client_id')
      const secret = getString(t, 'secret')
      if (!enabled || !clientId || !secret) continue
      const url = getString(t, 'url')
      out[name.toLowerCase()] = {
        clientId,
        clientSecret: secret,
        authorizeUrl: getString(t, 'authorize_url') ?? (url ? `${url}/authorize` : undefined),
        tokenUrl: getString(t, 'token_url') ?? (url ? `${url}/token` : undefined),
        userInfoUrl: getString(t, 'userinfo_url') ?? (url ? `${url}/userinfo` : undefined),
        scopes: getString(t, 'scopes'),
      }
    }
  }

  collectEnvProviders(env, out, 'GOTRUE_EXTERNAL_', 'SECRET')
  collectEnvProviders(env, out, 'TINBASE_OAUTH_', 'CLIENT_SECRET')
  return out
}

/** Collect providers declared via `<prefix><NAME>_CLIENT_ID/_<secretKey>/_ENABLED` env vars. */
function collectEnvProviders(
  env: NodeJS.ProcessEnv,
  out: Record<string, OAuthProviderConfig>,
  prefix: string,
  secretKey: string
): void {
  const names = new Set<string>()
  for (const key of Object.keys(env)) {
    if (key.startsWith(prefix) && key.endsWith('_CLIENT_ID')) {
      names.add(key.slice(prefix.length, -'_CLIENT_ID'.length))
    }
  }
  for (const upper of names) {
    const name = upper.toLowerCase()
    if (out[name]) continue // higher-precedence source already set it
    const g = (s: string) => env[`${prefix}${upper}_${s}`]
    const clientId = g('CLIENT_ID')
    const clientSecret = g(secretKey)
    if (!clientId || !clientSecret) continue
    if (g('ENABLED') !== undefined && g('ENABLED') !== 'true') continue
    out[name] = {
      clientId,
      clientSecret,
      authorizeUrl: g('AUTHORIZE_URL'),
      tokenUrl: g('TOKEN_URL'),
      userInfoUrl: g('USERINFO_URL'),
      scopes: g('SCOPES'),
    }
  }
}

// ── [api] ────────────────────────────────────────────────────────────────

function readApi(root: ConfigTable): ApiConfig {
  const api = tableAt(root, 'api')
  const out: ApiConfig = {}
  const schemas = getStringArray(api, 'schemas')
  if (schemas !== undefined) out.schemas = schemas
  const maxRows = getInt(api, 'max_rows')
  if (maxRows !== undefined && maxRows > 0) out.maxRows = maxRows
  return out
}

// ── [storage] ──────────────────────────────────────────────────────────────

function readStorage(root: ConfigTable): StorageConfig {
  const storage = tableAt(root, 'storage')
  const out: StorageConfig = {}
  const limit = getByteSize(storage, 'file_size_limit')
  if (limit !== undefined) out.fileSizeLimit = limit

  const buckets = tableAt(root, 'storage.buckets')
  if (buckets && buckets.children.size > 0) {
    out.buckets = [...buckets.children].map(([id, t]) => ({
      id,
      public: getBool(t, 'public') ?? false,
      fileSizeLimit: getByteSize(t, 'file_size_limit') ?? null,
      allowedMimeTypes: getStringArray(t, 'allowed_mime_types') ?? null,
    }))
  }
  return out
}

// ── [db.seed] ──────────────────────────────────────────────────────────────

function readSeed(root: ConfigTable): SeedConfig {
  const seed = tableAt(root, 'db.seed')
  const out: SeedConfig = {}
  const enabled = getBool(seed, 'enabled')
  if (enabled !== undefined) out.enabled = enabled
  const paths = getStringArray(seed, 'sql_paths')
  if (paths !== undefined) out.paths = paths
  return out
}

// ── [functions.<name>] ───────────────────────────────────────────────────

function readFunctions(root: ConfigTable): Record<string, FunctionOptions> {
  const fns = tableAt(root, 'functions')
  const out: Record<string, FunctionOptions> = {}
  if (!fns) return out
  for (const [name, t] of fns.children) {
    const opts: FunctionOptions = {}
    const enabled = getBool(t, 'enabled')
    if (enabled !== undefined) opts.enabled = enabled
    const verifyJwt = getBool(t, 'verify_jwt')
    if (verifyJwt !== undefined) opts.verifyJwt = verifyJwt
    const entrypoint = getString(t, 'entrypoint')
    if (entrypoint !== undefined) opts.entrypoint = entrypoint
    out[name] = opts
  }
  return out
}
