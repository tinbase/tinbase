import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { clearIdTokenKeyCache } from '../src/auth/id-token.js'

/**
 * Apple sign-in, checked against what supabase/auth (GoTrue) does: internal/api/token_oidc.go,
 * internal/api/provider/{apple,oidc}.go, internal/api/external.go, internal/api/settings.go. Every expected
 * value here is GoTrue's.
 */
const BUNDLE_ID = 'com.acme.app'
const IOS_BUNDLE_ID = 'com.acme.extra'
const KID = 'parity-kid'
let keys: CryptoKeyPair
let publicJwk: JsonWebKey

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
async function sha256(s: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

let n = 0
async function appleToken(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  const h = enc({ alg: 'RS256', kid: KID })
  const p = enc({ iss: 'https://appleid.apple.com', aud: BUNDLE_ID, sub: `parity.${++n}`, email: `p${n}@privaterelay.appleid.com`, iat: now, exp: now + 600, ...claims })
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`
}

const appleFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url === 'https://appleid.apple.com/auth/keys') return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256' }] }))
  throw new Error(`unexpected fetch: ${url}`)
}

let backend: TinbaseBackend
let noNonce: TinbaseBackend
let closed: TinbaseBackend
let bare: TinbaseBackend
const BASE = 'http://127.0.0.1:54321'
const sb = (b: TinbaseBackend, accessToken?: string) =>
  createClient(BASE, b.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => b.fetch(new Request(i, init)), headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
  })
/** The raw response, to compare GoTrue's exact body. */
async function grant(b: TinbaseBackend, body: Record<string, unknown>, bearer?: string) {
  const res = await b.fetch(
    new Request(`${BASE}/auth/v1/token?grant_type=id_token`, {
      method: 'POST',
      headers: { apikey: b.anonKey, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    })
  )
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  backend = await createBackend({ siteUrl: BASE, idTokenClients: { apple: [BUNDLE_ID] }, iosBundleId: IOS_BUNDLE_ID, oauthFetch: appleFetch })
  noNonce = await createBackend({ siteUrl: BASE, idTokenClients: { apple: [BUNDLE_ID] }, skipNonceCheck: ['apple'], oauthFetch: appleFetch })
  closed = await createBackend({ siteUrl: BASE, idTokenClients: { apple: [BUNDLE_ID] }, oauthFetch: appleFetch, authSettings: { disableSignup: true } })
  bare = await createBackend({ siteUrl: BASE, oauthFetch: appleFetch })
})
afterAll(async () => {
  for (const b of [backend, noNonce, closed, bare]) await b.close()
})
beforeEach(() => clearIdTokenKeyCache())

describe('id_token grant: GoTrue parity (Apple)', () => {
  it("accepts Apple's second issuer, https://account.apple.com (IsAppleIssuer)", async () => {
    const { error } = await sb(backend).auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ iss: 'https://account.apple.com' }) })
    expect(error).toBeNull()
  })

  it('stores identity_data as parseAppleIDToken: email always verified, custom_claims, provider_id', async () => {
    const token = await appleToken({ sub: 'shape.sub', email: 'shape@privaterelay.appleid.com', email_verified: 'false', is_private_email: 'true', auth_time: 1795400000 })
    const { data } = await sb(backend).auth.signInWithIdToken({ provider: 'apple', token })
    const identity = data.user!.identities!.find((i) => i.provider === 'apple')!
    expect(identity.identity_data).toEqual({
      iss: 'https://appleid.apple.com',
      sub: 'shape.sub',
      email: 'shape@privaterelay.appleid.com',
      email_verified: true,
      phone_verified: false,
      provider_id: 'shape.sub',
      custom_claims: { is_private_email: true, auth_time: 1795400000 },
    })
    // UpdateUserMetaData(identityData): user_metadata carries the same claims
    expect(data.user!.user_metadata).toMatchObject({ sub: 'shape.sub', email_verified: true, provider_id: 'shape.sub' })
    expect(data.user!.email_confirmed_at).toBeTruthy()
  })

  it('UpdateAppMetaDataProviders: linking Apple to an email account lists both, oldest first', async () => {
    const s = sb(backend)
    const up = await s.auth.signUp({ email: 'both@example.com', password: 'password-123' })
    expect(up.error).toBeNull()
    const { data } = await sb(backend).auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ sub: 'both.sub', email: 'both@example.com' }) })
    expect(data.user!.id).toBe(up.data.user!.id)
    expect(data.user!.app_metadata).toMatchObject({ provider: 'email', providers: ['email', 'apple'] })
  })

  it('GOTRUE_EXTERNAL_IOS_BUNDLE_ID is also an accepted audience', async () => {
    const { error } = await sb(backend).auth.signInWithIdToken({ provider: 'apple', token: await appleToken({ aud: IOS_BUNDLE_ID }) })
    expect(error).toBeNull()
  })

  it('error bodies are GoTrue OAuthErrors (HTTP 400 { error, error_description })', async () => {
    expect(await grant(backend, { provider: 'apple' })).toEqual({ status: 400, body: { error: 'invalid request', error_description: 'id_token required' } })
    expect(await grant(backend, { id_token: 'x' })).toEqual({ status: 400, body: { error: 'invalid request', error_description: 'provider or client_id and issuer required' } })
    expect(await grant(backend, { provider: 'apple', id_token: await appleToken({ aud: 'com.other' }) })).toEqual({
      status: 400,
      body: { error: 'invalid request', error_description: 'Unacceptable audience in id_token: [com.other]' },
    })
    expect(await grant(backend, { provider: 'apple', id_token: await appleToken({ sub: '' }) })).toEqual({
      status: 400,
      body: { error: 'invalid request', error_description: 'Missing sub claim in id_token' },
    })
    const nonced = await appleToken({ nonce: hex(await sha256('raw')) })
    expect(await grant(backend, { provider: 'apple', id_token: nonced, nonce: 'other' })).toEqual({ status: 400, body: { error: 'invalid nonce', error_description: 'Nonces mismatch' } })
  })

  it('HTTP errors keep GoTrue codes and messages: issuer detection, disabled provider, unknown provider', async () => {
    expect(await grant(backend, { provider: 'apple', id_token: 'not-a-jwt' })).toEqual({
      status: 400,
      body: { code: 400, error_code: 'validation_failed', msg: 'Unable to detect issuer in ID token for Apple provider' },
    })
    expect(await grant(backend, { provider: 'apple', id_token: await appleToken(), issuer: 'https://account.apple.com' })).toEqual({
      status: 400,
      body: { code: 400, error_code: 'validation_failed', msg: 'Provided issuer does not match ID token issuer' },
    })
    expect(await grant(bare, { provider: 'apple', id_token: await appleToken() })).toEqual({
      status: 400,
      body: { code: 400, error_code: 'provider_disabled', msg: 'Provider (issuer "https://appleid.apple.com") is not enabled' },
    })
    expect(await grant(backend, { provider: 'myspace', id_token: await appleToken() })).toEqual({
      status: 400,
      body: { code: 400, error_code: 'validation_failed', msg: 'Custom OIDC provider "myspace" not allowed' },
    })
  })

  it('provider can be given as issuer + client_id instead (Apple issuer)', async () => {
    const r = await grant(backend, { issuer: 'https://appleid.apple.com', client_id: BUNDLE_ID, id_token: await appleToken() })
    expect(r.status).toBe(200)
  })

  it('skip_nonce_check: a token with a nonce signs in without one, and vice versa', async () => {
    const withNonce = await appleToken({ nonce: hex(await sha256('raw')) })
    expect((await sb(noNonce).auth.signInWithIdToken({ provider: 'apple', token: withNonce })).error).toBeNull()
    expect((await sb(noNonce).auth.signInWithIdToken({ provider: 'apple', token: await appleToken(), nonce: 'raw' })).error).toBeNull()
  })

  it('access_token is checked against at_hash when both are present', async () => {
    const access = 'apple-access-token'
    const h = await sha256(access)
    const token = await appleToken({ at_hash: b64url(h.slice(0, 16)) })
    expect((await sb(backend).auth.signInWithIdToken({ provider: 'apple', token, access_token: access })).error).toBeNull()
    const wrong = await grant(backend, { provider: 'apple', id_token: await appleToken({ at_hash: b64url(h.slice(0, 16)) }), access_token: 'other' })
    expect(wrong).toEqual({ status: 400, body: { error: 'invalid request', error_description: 'Bad ID token' } })
  })

  it('link_identity: links Apple to the signed-in user; linking it again is identity_already_exists', async () => {
    const up = await sb(backend).auth.signUp({ email: 'linker@example.com', password: 'password-123' })
    const at = up.data.session!.access_token
    const token = await appleToken({ sub: 'linked.sub', email: 'someone-else@privaterelay.appleid.com' })
    const linked = await grant(backend, { provider: 'apple', id_token: token, link_identity: true }, at)
    expect(linked.status).toBe(200)
    expect(linked.body.user.id).toBe(up.data.user!.id)
    expect(linked.body.user.app_metadata.providers).toEqual(['email', 'apple'])
    expect(await grant(backend, { provider: 'apple', id_token: token, link_identity: true }, at)).toEqual({
      status: 422,
      body: { code: 422, error_code: 'identity_already_exists', msg: 'Identity is already linked' },
    })
    expect(await grant(backend, { provider: 'apple', id_token: token, link_identity: true })).toEqual({
      status: 400,
      body: { error: 'invalid request', error_description: 'Linking requires a valid user access token in Authorization' },
    })
  })

  it('a banned user is refused (403 user_banned)', async () => {
    const token = await appleToken({ sub: 'banned.sub', email: 'banned@privaterelay.appleid.com' })
    const first = await sb(backend).auth.signInWithIdToken({ provider: 'apple', token })
    await backend.db.query(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [first.data.user!.id])
    expect(await grant(backend, { provider: 'apple', id_token: await appleToken({ sub: 'banned.sub', email: 'banned@privaterelay.appleid.com' }) })).toEqual({
      status: 403,
      body: { code: 403, error_code: 'user_banned', msg: 'User is banned' },
    })
  })

  it('signups disabled: a new Apple user is refused (422 signup_disabled)', async () => {
    expect(await grant(closed, { provider: 'apple', id_token: await appleToken() })).toEqual({
      status: 422,
      body: { code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' },
    })
  })
})

describe('/settings: GoTrue ProviderSettings', () => {
  it('lists every provider GoTrue knows, false unless enabled', async () => {
    const res = await backend.fetch(new Request(`${BASE}/auth/v1/settings`, { headers: { apikey: backend.anonKey } }))
    const external = ((await res.json()) as { external: Record<string, boolean> }).external
    expect(external.apple).toBe(true)
    for (const p of ['google', 'github', 'azure', 'facebook', 'twitter', 'zoom', 'slack_oidc', 'linkedin_oidc', 'workos']) expect(external[p]).toBe(false)
    expect(external.email).toBe(true)
  })
})
