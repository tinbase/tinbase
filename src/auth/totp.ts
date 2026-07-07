/**
 * TOTP (RFC 6238) for MFA — pure WebCrypto, no dependencies. GoTrue uses
 * SHA-1, 6 digits, a 30-second period; we mirror that so any standard
 * authenticator app (Google Authenticator, 1Password, …) works against the
 * secret we hand out at enroll time.
 */
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Encode bytes as unpadded RFC 4648 base32 (the format authenticator apps expect). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** Decode an unpadded/padded base32 string to bytes (case-insensitive). */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** A fresh 20-byte (160-bit) base32 secret, the GoTrue/authenticator default. */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return base32Encode(bytes)
}

/** Build the otpauth:// URI an authenticator app scans. */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${opts.issuer}:${opts.account}`
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}

/** Compute the 6-digit TOTP for a given counter (RFC 6238 dynamic truncation). */
async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const msg = new Uint8Array(8)
  // 64-bit big-endian counter (safe integer range covers TOTP for millennia)
  let c = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff
    c = Math.floor(c / 256)
  }
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg as BufferSource))
  const offset = hmac[hmac.length - 1] & 0x0f
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return (bin % 1_000_000).toString().padStart(6, '0')
}

/** Current 6-digit code for a base32 secret (used in tests and self-checks). */
export async function totpNow(secretBase32: string, atMs = Date.now()): Promise<string> {
  const counter = Math.floor(atMs / 1000 / 30)
  return hotp(base32Decode(secretBase32), counter)
}

/**
 * Verify a submitted code against the secret, allowing ±`window` steps of
 * clock skew (default ±1 = a 90-second acceptance window, like GoTrue).
 */
export async function verifyTotp(secretBase32: string, code: string, window = 1, atMs = Date.now()): Promise<boolean> {
  const trimmed = (code ?? '').trim()
  if (!/^\d{6}$/.test(trimmed)) return false
  const secret = base32Decode(secretBase32)
  const base = Math.floor(atMs / 1000 / 30)
  for (let i = -window; i <= window; i++) {
    if ((await hotp(secret, base + i)) === trimmed) return true
  }
  return false
}
