/**
 * Minimal HS256 JWT implementation on WebCrypto.
 * Works in Node (>=18) and browsers — no dependencies.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  )
}

export interface JwtClaims {
  [key: string]: unknown
  sub?: string
  role?: string
  exp?: number
  iat?: number
  iss?: string
  aud?: string
  email?: string
}

export async function signJwt(claims: JwtClaims, secret: string): Promise<string> {
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)))
  const data = `${header}.${payload}`
  const key = await hmacKey(secret, 'sign')
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return `${data}.${bytesToBase64Url(new Uint8Array(sig))}`
}

/** Verifies signature and expiry. Returns claims, or null when invalid. */
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts
  try {
    const key = await hmacKey(secret, 'verify')
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signature) as BufferSource,
      encoder.encode(`${header}.${payload}`)
    )
    if (!valid) return null
    const claims = JSON.parse(decoder.decode(base64UrlToBytes(payload))) as JwtClaims
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}

/** Decode without verification (for introspection/debugging only). */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(decoder.decode(base64UrlToBytes(parts[1])))
  } catch {
    return null
  }
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return bytesToBase64Url(buf)
}
