/**
 * Native sign-in with a provider's ID token: GoTrue's `POST /token?grant_type=id_token`, which supabase-js
 * calls from `signInWithIdToken({ provider, token, nonce, access_token })`.
 *
 * Mirrors supabase/auth (internal/api/token_oidc.go, internal/api/provider/{apple,oidc}.go): the same checks
 * in the same order, the same error bodies, and the same identity data. Apple tokens come from either of
 * Apple's issuers and their email always counts as verified; the audience must be one of the configured
 * client ids; the nonce is compared by its SHA-256 (hex) unless `skip_nonce_check`; an `access_token` is
 * checked against the token's `at_hash` when both are present.
 *
 * WebCrypto only, so it runs in the browser build as well as Node.
 */
import type { OAuthProfile } from './oauth.js'

const APPLE_ISSUERS = ['https://appleid.apple.com', 'https://account.apple.com']
const GOOGLE_ISSUER = 'https://accounts.google.com'

/** What one provider's ID tokens look like. */
interface IdTokenPreset {
  /** the issuer the token is checked against; null for Apple, whose issuer is detected and checked separately */
  issuer: string | null
  /** the provider's JSON Web Key Set */
  jwksUrl: string
  /** claims → the profile; `identityData` is what GoTrue stores as identity_data and merges into user_metadata */
  profile: (claims: Record<string, unknown>) => OAuthProfile
}

const truthy = (v: unknown) => v === true || v === 'true'
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
/** structs.Map(Claims): omitempty fields only when set; email_verified and phone_verified always. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))
}

const PRESETS: Record<string, IdTokenPreset> = {
  apple: {
    issuer: null,
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    // parseAppleIDToken: the email is always verified; is_private_email / auth_time / transfer_sub go to custom_claims.
    // Apple sends the name only to the app (or, on the web, in the callback's `user` field), never in the token.
    profile: (c) => {
      const custom = compact({
        is_private_email: c.is_private_email === undefined ? undefined : truthy(c.is_private_email),
        auth_time: c.auth_time,
        transfer_sub: str(c.transfer_sub),
      })
      const identityData = {
        ...compact({ iss: str(c.iss), sub: String(c.sub), email: str(c.email), provider_id: String(c.sub) }),
        email_verified: true,
        phone_verified: false,
        ...(Object.keys(custom).length ? { custom_claims: custom } : {}),
      }
      return { id: String(c.sub), email: str(c.email), emailVerified: true, identityData }
    },
  },
  google: {
    issuer: GOOGLE_ISSUER,
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    profile: (c) => {
      const identityData = {
        ...compact({
          iss: str(c.iss),
          sub: String(c.sub),
          name: str(c.name),
          picture: str(c.picture),
          email: str(c.email),
          full_name: str(c.name),
          avatar_url: str(c.picture),
          provider_id: String(c.sub),
        }),
        email_verified: truthy(c.email_verified),
        phone_verified: false,
        // parseGoogleIDToken: a Workspace account's hosted domain
        ...(str(c.hd) ? { custom_claims: { hd: c.hd } } : {}),
      }
      return { id: String(c.sub), email: str(c.email), emailVerified: truthy(c.email_verified), name: str(c.name), identityData }
    },
  },
}

/** Providers whose ID tokens we can check. */
export const ID_TOKEN_PROVIDERS = Object.keys(PRESETS)

/** Whether `issuer` is one of Apple's (GoTrue IsAppleIssuer). */
export function isAppleIssuer(issuer: string | null | undefined): boolean {
  return !!issuer && APPLE_ISSUERS.includes(issuer)
}

/**
 * A rejected token. `oauth` errors are GoTrue's OAuthError: HTTP 400 `{ error, error_description }`. `http`
 * errors are its HTTPError: `{ code, error_code, msg }` with that status.
 */
export class IdTokenError extends Error {
  constructor(
    readonly body: { kind: 'oauth'; error: string; description: string } | { kind: 'http'; status: number; code: string },
    message: string
  ) {
    super(message)
  }
  static oauth(error: string, description: string): IdTokenError {
    return new IdTokenError({ kind: 'oauth', error, description }, description)
  }
  static http(status: number, code: string, msg: string): IdTokenError {
    return new IdTokenError({ kind: 'http', status, code }, msg)
  }
}
const badToken = () => IdTokenError.oauth('invalid request', 'Bad ID token')

interface Jwk {
  kid?: string
  kty: string
  alg?: string
  n?: string
  e?: string
}

const JWKS_TTL_MS = 60 * 60 * 1000
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>()

async function loadKeys(url: string, fetchImpl: typeof fetch, refresh: boolean): Promise<Jwk[]> {
  const hit = jwksCache.get(url)
  if (hit && !refresh && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys
  const res = await fetchImpl(url)
  if (!res.ok) throw badToken()
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = Array.isArray(body.keys) ? body.keys : []
  jwksCache.set(url, { at: Date.now(), keys })
  return keys
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlBytes(s)))
  } catch {
    return null
  }
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

export interface VerifyIdTokenOptions {
  /** The client ids an `aud` may name (the app's bundle id, Services ID, Android/web client ids…). */
  audiences: string[]
  /** The raw nonce the app generated, when it passed its hash to the provider. */
  nonce?: string
  /** [auth.external.<provider>] skip_nonce_check */
  skipNonceCheck?: boolean
  /** signInWithIdToken's access_token: checked against the token's at_hash when both are present. */
  accessToken?: string
  /** the request's `issuer`, when given: Apple's must match the token's */
  issuer?: string
  fetchImpl?: typeof fetch
  /** seconds, for tests */
  now?: number
}

/**
 * Check `token` as an ID token from `provider` and return the profile to sign in with.
 *
 * @throws IdTokenError with GoTrue's error for that failure.
 */
export async function verifyIdToken(provider: string, token: string, opts: VerifyIdTokenOptions): Promise<OAuthProfile> {
  const preset = PRESETS[provider]
  if (!preset) throw IdTokenError.http(400, 'validation_failed', `Custom OIDC provider "${provider}" not allowed`)

  const parts = token.split('.')
  const header = parts.length === 3 ? (b64urlJson(parts[0]) as { alg?: string; kid?: string } | null) : null
  const claims = parts.length === 3 ? b64urlJson(parts[1]) : null

  if (provider === 'apple') checkAppleIssuer(token, opts.issuer)
  if (!header || !claims || header.alg !== 'RS256') throw badToken()

  // ParseIDToken: signature against the provider's keys, issuer (not Apple's: already checked), expiry, at_hash
  const fetchImpl = opts.fetchImpl ?? fetch
  let jwk = (await loadKeys(preset.jwksUrl, fetchImpl, false)).find((k) => k.kid === header.kid)
  // the provider rotated its keys since we cached them
  if (!jwk) jwk = (await loadKeys(preset.jwksUrl, fetchImpl, true)).find((k) => k.kid === header.kid)
  if (!jwk || jwk.kty !== 'RSA') throw badToken()
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  if (!ok) throw badToken()
  if (preset.issuer && claims.iss !== preset.issuer) throw badToken()
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < now) throw badToken()
  if (opts.accessToken && typeof claims.at_hash === 'string') {
    // OIDC at_hash for RS256: the left half of SHA-256(access_token), base64url
    const h = await sha256(opts.accessToken)
    if (b64url(h.slice(0, h.length / 2)) !== claims.at_hash) throw badToken()
  }

  if (!claims.sub) throw IdTokenError.oauth('invalid request', 'Missing sub claim in id_token')

  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)]
  if (!opts.audiences.some((id) => id && aud.includes(id))) {
    throw IdTokenError.oauth('invalid request', `Unacceptable audience in id_token: [${aud.join(' ')}]`)
  }

  if (!opts.skipNonceCheck) {
    const tokenNonce = typeof claims.nonce === 'string' ? claims.nonce : ''
    const paramNonce = opts.nonce ?? ''
    if (!!tokenNonce !== !!paramNonce) throw IdTokenError.oauth('invalid request', 'Passed nonce and nonce in id_token should either both exist or not.')
    // the token carries the hash; the raw nonce must hash to it (the hash itself is never accepted)
    if (tokenNonce && hex(await sha256(paramNonce)) !== tokenNonce) throw IdTokenError.oauth('invalid nonce', 'Nonces mismatch')
  }

  return preset.profile(claims)
}

/**
 * GoTrue's getProvider for Apple: the issuer is detected from the token before anything else (even before the
 * provider's enabled check), and must be one of Apple's, and match a given `issuer`.
 *
 * @throws IdTokenError validation_failed
 */
export function checkAppleIssuer(token: string, issuer?: string): void {
  const parts = token.split('.')
  const claims = parts.length === 3 ? b64urlJson(parts[1]) : null
  if (!claims) throw IdTokenError.http(400, 'validation_failed', 'Unable to detect issuer in ID token for Apple provider')
  if (!isAppleIssuer(String(claims.iss))) throw IdTokenError.http(400, 'validation_failed', 'Detected ID token issuer is not an Apple ID token issuer')
  if (issuer && issuer !== claims.iss) throw IdTokenError.http(400, 'validation_failed', 'Provided issuer does not match ID token issuer')
}

/** Forget cached signing keys (tests). */
export function clearIdTokenKeyCache(): void {
  jwksCache.clear()
}
