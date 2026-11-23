/**
 * Native sign-in with a provider's ID token: GoTrue's
 * `POST /token?grant_type=id_token`, which supabase-js calls from
 * `signInWithIdToken({ provider, token, nonce })`.
 *
 * The app gets the token from the platform itself (expo-apple-authentication's
 * `identityToken`, Google Sign-In's `idToken`) and hands it to us. We check it
 * the way GoTrue does: the signature against the provider's published keys,
 * the issuer, the expiry, the audience (the app's own client ids, so a token an
 * attacker obtained for another app can't sign in here) and the nonce, then the
 * caller signs the user in from the claims.
 *
 * WebCrypto only, so it runs in the browser build as well as Node.
 */
import type { OAuthProfile } from './oauth.js'

/** What one provider's ID tokens look like. */
interface IdTokenPreset {
  /** accepted `iss` values */
  issuers: string[]
  /** the provider's JSON Web Key Set */
  jwksUrl: string
  /** claims → the profile the user is created or found from */
  profile: (claims: Record<string, unknown>) => OAuthProfile
}

const truthy = (v: unknown) => v === true || v === 'true'

const PRESETS: Record<string, IdTokenPreset> = {
  apple: {
    issuers: ['https://appleid.apple.com'],
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    // Apple sends the name only to the app, on the first sign-in, never in the
    // token: the app sets it with updateUser({ data: { full_name } }).
    profile: (c) => ({
      id: String(c.sub),
      email: typeof c.email === 'string' ? c.email : undefined,
      emailVerified: truthy(c.email_verified),
      metadata: { is_private_email: truthy(c.is_private_email), provider_id: String(c.sub) },
    }),
  },
  google: {
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    profile: (c) => ({
      id: String(c.sub),
      email: typeof c.email === 'string' ? c.email : undefined,
      emailVerified: truthy(c.email_verified),
      name: typeof c.name === 'string' ? c.name : undefined,
      metadata: { avatar_url: c.picture, full_name: c.name, provider_id: String(c.sub) },
    }),
  },
}

/** Providers whose ID tokens we can check. */
export const ID_TOKEN_PROVIDERS = Object.keys(PRESETS)

/** A rejected token: the message is safe to show the client. */
export class IdTokenError extends Error {}

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
  if (!res.ok) throw new IdTokenError(`could not fetch the provider's signing keys (${res.status})`)
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

function b64urlJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlBytes(s)))
  } catch {
    throw new IdTokenError('malformed id_token')
  }
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface VerifyIdTokenOptions {
  /** The app's client ids for this provider (its bundle id, service id…): `aud` must be one of them. */
  audiences: string[]
  /** The raw nonce the app generated, when it passed its hash to the provider. */
  nonce?: string
  fetchImpl?: typeof fetch
  /** seconds, for tests */
  now?: number
}

/**
 * Check `token` as an ID token from `provider` and return the profile to sign
 * in with.
 *
 * @throws IdTokenError when the provider is unknown or the token doesn't verify.
 */
export async function verifyIdToken(provider: string, token: string, opts: VerifyIdTokenOptions): Promise<OAuthProfile> {
  const preset = PRESETS[provider]
  if (!preset) throw new IdTokenError(`id_token sign-in is not supported for provider ${provider}`)
  if (!opts.audiences.length) throw new IdTokenError(`provider ${provider} has no client ids configured for id_token sign-in`)

  const parts = token.split('.')
  if (parts.length !== 3) throw new IdTokenError('malformed id_token')
  const header = b64urlJson(parts[0]) as { alg?: string; kid?: string }
  const claims = b64urlJson(parts[1])
  if (header.alg !== 'RS256') throw new IdTokenError(`unsupported id_token algorithm ${header.alg}`)

  const fetchImpl = opts.fetchImpl ?? fetch
  let jwk = (await loadKeys(preset.jwksUrl, fetchImpl, false)).find((k) => k.kid === header.kid)
  // the provider rotated its keys since we cached them
  if (!jwk) jwk = (await loadKeys(preset.jwksUrl, fetchImpl, true)).find((k) => k.kid === header.kid)
  if (!jwk || jwk.kty !== 'RSA') throw new IdTokenError('id_token signed with an unknown key')

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  )
  if (!ok) throw new IdTokenError('id_token signature is invalid')

  if (!preset.issuers.includes(String(claims.iss))) throw new IdTokenError('id_token issuer is not the provider')
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)]
  if (!aud.some((a) => opts.audiences.includes(a))) {
    throw new IdTokenError(`id_token audience ${aud.join(',')} is not one of this project's ${provider} client ids`)
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const skew = 60
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new IdTokenError('id_token has expired')
  if (typeof claims.iat === 'number' && claims.iat - skew > now) throw new IdTokenError('id_token is not valid yet')
  if (!claims.sub) throw new IdTokenError('id_token has no subject')

  // GoTrue: a token minted with a nonce needs the raw nonce back, and the
  // provider stores its SHA-256 (hex), as Apple's and Google's SDKs send it.
  const tokenNonce = typeof claims.nonce === 'string' ? claims.nonce : undefined
  if (tokenNonce || opts.nonce) {
    if (!tokenNonce || !opts.nonce) throw new IdTokenError('id_token nonce does not match')
    // only the hash: the token carries its nonce in the clear, so accepting it
    // as given would let anyone holding the token replay it
    if (tokenNonce !== (await sha256Hex(opts.nonce))) throw new IdTokenError('id_token nonce does not match')
  }

  return preset.profile(claims)
}

/** Forget cached signing keys (tests). */
export function clearIdTokenKeyCache(): void {
  jwksCache.clear()
}
