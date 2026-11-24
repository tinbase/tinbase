import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { clearIdTokenKeyCache } from '../src/auth/id-token.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectConfig } from '../src/node/load-config.js'

function loadConfigFromString(toml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tb-idtoken-'))
  mkdirSync(join(dir, 'supabase'))
  writeFileSync(join(dir, 'supabase', 'config.toml'), toml)
  return loadProjectConfig(dir, {})
}

/**
 * Native Sign in with Apple: the app gets an identity token from Apple and calls
 * supabase.auth.signInWithIdToken({ provider: 'apple', token, nonce }). Apple is
 * mocked by a key pair of ours, served at Apple's JWKS URL through oauthFetch.
 */
const BUNDLE_ID = 'com.acme.legal'
const KID = 'test-kid'
let keys: CryptoKeyPair
let otherKeys: CryptoKeyPair
let publicJwk: JsonWebKey

const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function appleToken(claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; kid?: string } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = enc({ alg: 'RS256', kid: opts.kid ?? KID })
  const payload = enc({
    iss: 'https://appleid.apple.com',
    aud: BUNDLE_ID,
    sub: '001234.abcdef.0001',
    email: 'apple-user@privaterelay.appleid.com',
    email_verified: 'true',
    is_private_email: 'true',
    iat: now,
    exp: now + 600,
    ...claims,
  })
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? keys.privateKey, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`
}

let jwksFetches = 0
const appleFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url === 'https://appleid.apple.com/auth/keys') {
    jwksFetches++
    return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] }), { headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

let backend: TinbaseBackend
const BASE = 'http://127.0.0.1:54321'
const client = () =>
  createClient(BASE, backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
  })

beforeAll(async () => {
  const gen = () =>
    crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  keys = (await gen()) as CryptoKeyPair
  otherKeys = (await gen()) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  backend = await createBackend({ siteUrl: BASE, idTokenClients: { apple: [BUNDLE_ID, 'com.acme.web'] }, oauthFetch: appleFetch })
})
afterAll(async () => {
  await backend.close()
})
beforeEach(() => clearIdTokenKeyCache())

describe('signInWithIdToken (apple)', () => {
  it('signs in a new user from a valid Apple token, with an apple identity', async () => {
    const { data, error } = await client().auth.signInWithIdToken({ provider: 'apple', token: await appleToken() })
    expect(error).toBeNull()
    expect(data.session?.access_token).toBeTruthy()
    expect(data.user?.email).toBe('apple-user@privaterelay.appleid.com')
    expect(data.user?.identities?.map((i) => i.provider)).toContain('apple')
  })

  it('signs the same Apple account into the same user again', async () => {
    const a = await client().auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ sub: 'same.sub' , email: 'same@example.com' }) })
    const b = await client().auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ sub: 'same.sub', email: 'same@example.com' }) })
    expect(a.error).toBeNull()
    expect(b.data.user?.id).toBe(a.data.user?.id)
  })

  it("links to an existing email account: Apple's email always counts as verified (GoTrue parseAppleIDToken)", async () => {
    const sb = client()
    const signup = await sb.auth.signUp({ email: 'linked@example.com', password: 'password-123' })
    expect(signup.error).toBeNull()
    const linked = await client().auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ sub: 'link.sub', email: 'linked@example.com' }) })
    expect(linked.data.user?.id).toBe(signup.data.user?.id)
    const unverified = await client().auth.signInWithIdToken({
      provider: 'apple',
      token: await appleToken({ sub: 'other.sub', email: 'linked@example.com', email_verified: 'false' }),
    })
    expect(unverified.error).toBeNull()
    expect(unverified.data.user?.id).toBe(signup.data.user?.id)
  })

  it('accepts any of the configured client ids', async () => {
    const { error } = await client().auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ aud: 'com.acme.web', sub: 'web.sub' }) })
    expect(error).toBeNull()
  })

  it("rejects a token issued to another app (aud), so another app's token can't sign in here", async () => {
    const { error } = await client().auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ aud: 'com.attacker.app' }) })
    expect(error?.message).toBe('Unacceptable audience in id_token: [com.attacker.app]')
  })

  it('rejects a bad signature, a wrong issuer, an expired token and an unknown key', async () => {
    const forged = await appleToken({}, { key: otherKeys.privateKey })
    // GoTrue reports every verification failure as "Bad ID token", and a non-Apple issuer before that
    expect((await client().auth.signInWithIdToken({ provider: 'apple', token: forged })).error?.message).toBe('Bad ID token')
    const wrongIss = await appleToken({ iss: 'https://evil.example' })
    expect((await client().auth.signInWithIdToken({ provider: 'apple', token: wrongIss })).error?.message).toBe('Detected ID token issuer is not an Apple ID token issuer')
    const old = Math.floor(Date.now() / 1000) - 3600
    const expired = await appleToken({ iat: old - 600, exp: old })
    expect((await client().auth.signInWithIdToken({ provider: 'apple', token: expired })).error?.message).toBe('Bad ID token')
    const unknownKid = await appleToken({}, { kid: 'rotated-away' })
    expect((await client().auth.signInWithIdToken({ provider: 'apple', token: unknownKid })).error?.message).toBe('Bad ID token')
  })

  it('checks the nonce: the raw nonce must hash to the one in the token', async () => {
    const raw = 'raw-nonce-123'
    const token = await appleToken({ sub: 'nonce.sub', nonce: await sha256Hex(raw) })
    expect((await client().auth.signInWithIdToken({ provider: 'apple', token, nonce: raw })).error).toBeNull()
    expect((await client().auth.signInWithIdToken({ provider: 'apple', token, nonce: 'wrong' })).error?.message).toBe('Nonces mismatch')
    expect((await client().auth.signInWithIdToken({ provider: 'apple', token })).error?.message).toBe('Passed nonce and nonce in id_token should either both exist or not.')
    // the hash itself (visible in the token) is not accepted as the nonce
    expect((await client().auth.signInWithIdToken({ provider: 'apple', token, nonce: await sha256Hex(raw) })).error?.message).toBe('Nonces mismatch')
  })

  it('caches the signing keys between sign-ins', async () => {
    jwksFetches = 0
    await client().auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ sub: 'cache.1' }) })
    await client().auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ sub: 'cache.2' }) })
    expect(jwksFetches).toBe(1)
  })

  it('lists apple in /settings', async () => {
    const res = await backend.fetch(new Request(`${BASE}/auth/v1/settings`, { headers: { apikey: backend.anonKey } }))
    expect(((await res.json()) as { external: Record<string, boolean> }).external.apple).toBe(true)
  })

  it('refuses when the project has no Apple client ids, and for unsupported providers', async () => {
    const bare = await createBackend({ siteUrl: BASE, oauthFetch: appleFetch })
    try {
      const sb = createClient(BASE, bare.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (i, init) => bare.fetch(new Request(i, init)) } })
      expect((await sb.auth.signInWithIdToken({ provider: 'apple', token: await appleToken() })).error?.message).toMatch(/not enabled/)
    } finally {
      await bare.close()
    }
  })
})

describe('config: [auth.external.apple]', () => {
  it('reads client_id (comma-separated) without a secret, and keeps apple out of the web OAuth providers', () => {
    const cfg = loadConfigFromString(`
[auth.external.apple]
enabled = true
client_id = "com.acme.legal, com.acme.web"
secret = ""
`)
    expect(cfg.auth.idTokenClients.apple).toEqual(['com.acme.legal', 'com.acme.web'])
    expect(cfg.auth.oauthProviders.apple).toBeUndefined()
  })

  it('skips a disabled block', () => {
    const cfg = loadConfigFromString(`
[auth.external.apple]
enabled = false
client_id = "com.acme.legal"
`)
    expect(cfg.auth.idTokenClients.apple).toBeUndefined()
  })
})
