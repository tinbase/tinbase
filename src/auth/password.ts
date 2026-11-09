/** PBKDF2-SHA256 password hashing on WebCrypto (portable, no native deps). */

const ITERATIONS = 100_000

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256
  )
  return new Uint8Array(bits)
}

/** Hash a password into the self-describing `pbkdf2$iterations$salt$hash` string stored in encrypted_password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`
}

/**
 * Verify a password against a stored `pbkdf2$…` hash, re-deriving with the
 * salt/iterations embedded in it. Returns false for any malformed hash.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = parseInt(parts[1], 10)
  const salt = fromHex(parts[2])
  const expected = parts[3]
  const hash = await derive(password, salt, iterations)
  const actual = toHex(hash)
  if (actual.length !== expected.length) return false
  // SECURITY: constant-time compare over the full hash to avoid leaking a
  // match prefix via timing.
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

/**
 * A bcrypt hash (`$2a$`/`$2b$`/`$2y$`, cost, 53 chars of salt + hash), which is
 * what hosted Supabase (GoTrue) stores in `auth.users.encrypted_password`. Users
 * restored from a Supabase dump arrive with these.
 */
export function isBcryptHash(stored: string): boolean {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(stored)
}

/**
 * The same hash spelled with the `$2a$` prefix. `$2a$`, `$2b$` and `$2y$` hash
 * identically for any real password (they differ only in how very long
 * passwords and an old PHP bug are handled), and `$2a$` is the spelling
 * pgcrypto's `crypt()` accepts everywhere.
 */
export function asBcrypt2a(stored: string): string {
  return '$2a$' + stored.slice(4)
}
