/**
 * Resolve OAuth providers the way an existing Supabase project already declares
 * them, so no new config is needed:
 *
 *   1. supabase/config.toml  [auth.external.<provider>]  (enabled/client_id/secret/url/redirect_uri),
 *      resolving `env(VAR)` references — this is a real Supabase project's source of truth.
 *   2. GOTRUE_EXTERNAL_<PROVIDER>_CLIENT_ID / _SECRET / _ENABLED  (what GoTrue runs on).
 *   3. TINBASE_OAUTH_<PROVIDER>_CLIENT_ID / _SECRET  (alias, lowest precedence).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OAuthProviderConfig } from '../auth/oauth.js'

type Providers = Record<string, OAuthProviderConfig>

export function loadOAuthProviders(projectDir: string, env = process.env): Providers {
  const providers: Providers = {}
  fromConfigToml(projectDir, env, providers)
  fromGotrueEnv(env, providers)
  fromTinbaseEnv(env, providers)
  return providers
}

/** Resolve a config.toml value: strip quotes, expand `env(VAR)`. */
function resolveValue(raw: string, env: NodeJS.ProcessEnv): string | undefined {
  let v = raw.trim().replace(/^["']|["']$/g, '')
  const m = v.match(/^env\(\s*"?([A-Za-z0-9_]+)"?\s*\)$/)
  if (m) return env[m[1]]
  return v
}

function fromConfigToml(projectDir: string, env: NodeJS.ProcessEnv, out: Providers): void {
  let text: string
  try {
    text = readFileSync(join(projectDir, 'supabase', 'config.toml'), 'utf8')
  } catch {
    return
  }
  // minimal TOML section scan: [auth.external.<provider>] key = value
  const lines = text.split('\n')
  let provider: string | null = null
  let acc: Record<string, string> = {}
  const flush = () => {
    if (!provider) return
    const enabled = acc.enabled === undefined ? true : acc.enabled === 'true'
    const clientId = acc.client_id
    const secret = acc.secret
    if (enabled && clientId && secret) {
      // google/github get endpoints from presets; `url` (custom OIDC) or explicit
      // *_url keys override. Only pass overrides we actually have.
      out[provider] = {
        clientId,
        clientSecret: secret,
        authorizeUrl: acc.authorize_url ?? (acc.url ? `${acc.url}/authorize` : undefined),
        tokenUrl: acc.token_url ?? (acc.url ? `${acc.url}/token` : undefined),
        userInfoUrl: acc.userinfo_url ?? (acc.url ? `${acc.url}/userinfo` : undefined),
        scopes: acc.scopes,
      }
    }
    provider = null
    acc = {}
  }
  for (const line of lines) {
    const trimmed = line.trim()
    const section = trimmed.match(/^\[auth\.external\.([a-z0-9_]+)\]$/i)
    if (section) {
      flush()
      provider = section[1].toLowerCase()
      continue
    }
    if (trimmed.startsWith('[')) {
      flush()
      continue
    }
    if (!provider) continue
    const kv = trimmed.match(/^([a-z_]+)\s*=\s*(.+)$/i)
    if (kv) {
      const val = resolveValue(kv[2], env)
      if (val !== undefined) acc[kv[1]] = val
    }
  }
  flush()
}

function fromGotrueEnv(env: NodeJS.ProcessEnv, out: Providers): void {
  collectEnv(env, out, 'GOTRUE_EXTERNAL_', {
    id: 'CLIENT_ID',
    secret: 'SECRET',
    enabled: 'ENABLED',
  })
}

function fromTinbaseEnv(env: NodeJS.ProcessEnv, out: Providers): void {
  collectEnv(env, out, 'TINBASE_OAUTH_', {
    id: 'CLIENT_ID',
    secret: 'CLIENT_SECRET',
    enabled: 'ENABLED',
  })
}

function collectEnv(
  env: NodeJS.ProcessEnv,
  out: Providers,
  prefix: string,
  keys: { id: string; secret: string; enabled: string }
): void {
  const names = new Set<string>()
  for (const key of Object.keys(env)) {
    if (key.startsWith(prefix) && key.endsWith(`_${keys.id}`)) {
      names.add(key.slice(prefix.length, -`_${keys.id}`.length))
    }
  }
  for (const upper of names) {
    const name = upper.toLowerCase()
    if (out[name]) continue // higher-precedence source already set it
    const g = (s: string) => env[`${prefix}${upper}_${s}`]
    const clientId = g(keys.id)
    const clientSecret = g(keys.secret)
    const enabled = g(keys.enabled)
    if (!clientId || !clientSecret) continue
    if (enabled !== undefined && enabled !== 'true') continue
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
