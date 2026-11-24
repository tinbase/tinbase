import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { clearIdTokenKeyCache } from '../src/auth/id-token.js'
import { loadProjectConfig } from '../src/node/load-config.js'

/**
 * Sign in with Apple on the web, as GoTrue's apple provider does it: signInWithOAuth({ provider: 'apple' })
 * → Apple's authorize page (response_mode=form_post) → Apple POSTs code + state (+ `user` on the first
 * consent) to /auth/v1/callback → the token endpoint returns an id_token (the profile) and the provider's
 * own tokens, which reach the app as provider_token / provider_refresh_token.
 */
const SERVICES_ID = 'com.acme.web'
const BUNDLE_ID = 'com.acme.app'
const KID = 'apple-kid'
let keys: CryptoKeyPair
let publicJwk: JsonWebKey
let lastTokenRequest: URLSearchParams | null = null
let idTokenClaims: Record<string, unknown> = {}

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))

async function idToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000)
  const h = enc({ alg: 'RS256', kid: KID })
  const p = enc({ iss: 'https://appleid.apple.com', aud: SERVICES_ID, sub: 'apple.web.001', email: 'web@privaterelay.appleid.com', email_verified: 'true', iat: now, exp: now + 600, ...claims })
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`
}

const appleFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url === 'https://appleid.apple.com/auth/keys') {
    return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256' }] }), { headers: { 'content-type': 'application/json' } })
  }
  if (url === 'https://appleid.apple.com/auth/token') {
    lastTokenRequest = new URLSearchParams(String(init?.body))
    return new Response(
      JSON.stringify({ access_token: 'apple-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'apple-refresh', id_token: await idToken(idTokenClaims) }),
      { headers: { 'content-type': 'application/json' } }
    )
  }
  throw new Error(`unexpected fetch: ${url}`)
}

let backend: TinbaseBackend
const BASE = 'http://127.0.0.1:54321'
const client = (flowType: 'implicit' | 'pkce', storage?: Map<string, string>) =>
  createClient(BASE, backend.anonKey, {
    auth: {
      persistSession: !!storage,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType,
      storage: storage && {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => void storage.set(k, v),
        removeItem: (k) => void storage.delete(k),
      },
    },
    global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
  })

/** Apple's side: read the authorize URL tinbase sent the browser to, then POST the form back to the callback. */
async function applePostsBack(authorizeUrl: string, extra: Record<string, string> = {}): Promise<Response> {
  const u = new URL(authorizeUrl)
  const form = new URLSearchParams({ code: 'apple-code', state: u.searchParams.get('state')!, ...extra })
  return backend.fetch(
    new Request(u.searchParams.get('redirect_uri')!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    })
  )
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  backend = await createBackend({
    siteUrl: BASE,
    // as config.toml: client_id = "com.acme.web,com.acme.app" (web Services ID first), secret = the client-secret JWT
    oauthProviders: { apple: { clientId: `${SERVICES_ID},${BUNDLE_ID}`, clientSecret: 'client-secret-jwt' } },
    idTokenClients: { apple: [SERVICES_ID, BUNDLE_ID] },
    oauthFetch: appleFetch,
    uriAllowList: ['http://app.local/**'],
  })
})
afterAll(async () => {
  await backend.close()
})
beforeEach(() => {
  clearIdTokenKeyCache()
  idTokenClaims = {}
})

describe('Sign in with Apple on the web (signInWithOAuth)', () => {
  it("sends the browser to Apple's authorize page with form_post, the Services ID and Apple's default scopes", async () => {
    const { data, error } = await client('implicit').auth.signInWithOAuth({ provider: 'apple', options: { redirectTo: 'http://app.local/', skipBrowserRedirect: true } })
    expect(error).toBeNull()
    const res = await backend.fetch(new Request(data.url!, { redirect: 'manual' }))
    const loc = new URL(res.headers.get('location')!)
    expect(loc.origin + loc.pathname).toBe('https://appleid.apple.com/auth/authorize')
    expect(loc.searchParams.get('client_id')).toBe(SERVICES_ID)
    expect(loc.searchParams.get('response_mode')).toBe('form_post')
    expect(loc.searchParams.get('response_type')).toBe('code')
    expect(loc.searchParams.get('scope')).toBe('email name')
    expect(loc.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/v1/callback`)
  })

  it('implicit: the POSTed callback signs the user in and returns provider_token / provider_refresh_token', async () => {
    const { data } = await client('implicit').auth.signInWithOAuth({ provider: 'apple', options: { redirectTo: 'http://app.local/', skipBrowserRedirect: true } })
    const authorize = (await backend.fetch(new Request(data.url!, { redirect: 'manual' }))).headers.get('location')!
    const back = await applePostsBack(authorize, { user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: 'web@privaterelay.appleid.com' }) })
    const loc = back.headers.get('location')!
    expect(loc.startsWith('http://app.local/#')).toBe(true)
    const frag = new URLSearchParams(loc.split('#')[1])
    // GoTrue AsRedirectURL: url.Values.Encode() (keys sorted), expires_at and the `sb` marker
    expect([...frag.keys()]).toEqual(['access_token', 'expires_at', 'expires_in', 'provider_refresh_token', 'provider_token', 'refresh_token', 'sb', 'token_type'])
    expect(back.status).toBe(302)
    expect(frag.get('access_token')).toBeTruthy()
    expect(frag.get('provider_token')).toBe('apple-access')
    expect(frag.get('provider_refresh_token')).toBe('apple-refresh')
    // the code exchange used the configured secret and the Services ID
    expect(lastTokenRequest?.get('client_secret')).toBe('client-secret-jwt')
    expect(lastTokenRequest?.get('client_id')).toBe(SERVICES_ID)
    expect(lastTokenRequest?.get('code')).toBe('apple-code')

    const sb = client('implicit')
    const { data: u } = await sb.auth.getUser(frag.get('access_token')!)
    expect(u.user?.email).toBe('web@privaterelay.appleid.com')
    expect(u.user?.identities?.map((i) => i.provider)).toContain('apple')
    expect(u.user?.user_metadata.full_name).toBe('Ada Lovelace')
  })

  it('pkce: exchangeCodeForSession returns the session with provider_token / provider_refresh_token', async () => {
    idTokenClaims = { sub: 'apple.web.pkce', email: 'pkce@example.com' }
    const storage = new Map<string, string>()
    const sb = client('pkce', storage)
    const { data } = await sb.auth.signInWithOAuth({ provider: 'apple', options: { redirectTo: 'http://app.local/', skipBrowserRedirect: true } })
    const authorize = (await backend.fetch(new Request(data.url!, { redirect: 'manual' }))).headers.get('location')!
    const back = await applePostsBack(authorize)
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!
    const { data: s, error } = await sb.auth.exchangeCodeForSession(code)
    expect(error).toBeNull()
    expect(s.session?.provider_token).toBe('apple-access')
    expect(s.session?.provider_refresh_token).toBe('apple-refresh')
    expect(s.user?.email).toBe('pkce@example.com')
  })

  it('a cancel at Apple comes back to the app as an error, not a crash', async () => {
    const { data } = await client('implicit').auth.signInWithOAuth({ provider: 'apple', options: { redirectTo: 'http://app.local/', skipBrowserRedirect: true } })
    const authorize = new URL((await backend.fetch(new Request(data.url!, { redirect: 'manual' }))).headers.get('location')!)
    const res = await backend.fetch(
      new Request(authorize.searchParams.get('redirect_uri')!, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ error: 'user_cancelled_authorize', state: authorize.searchParams.get('state')! }).toString(),
        redirect: 'manual',
      })
    )
    // GoTrue redirectErrors: the provider's error in the query and in the fragment (with sb)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://app.local/?error=user_cancelled_authorize#error=user_cancelled_authorize&sb=')
  })

  it("refuses an id_token issued to another client (the profile is Apple's verified token)", async () => {
    idTokenClaims = { aud: 'com.attacker.web' }
    const { data } = await client('implicit').auth.signInWithOAuth({ provider: 'apple', options: { redirectTo: 'http://app.local/', skipBrowserRedirect: true } })
    const authorize = (await backend.fetch(new Request(data.url!, { redirect: 'manual' }))).headers.get('location')!
    const back = await applePostsBack(authorize)
    // GoTrue: a token Apple's verifier rejects fails GetUserData → 500 unexpected_failure
    expect(back.headers.get('location')).toBe(
      'http://app.local/?error=server_error&error_code=unexpected_failure&error_description=Error+getting+user+profile+from+external+provider' +
        '#error=server_error&error_code=unexpected_failure&error_description=Error+getting+user+profile+from+external+provider&sb='
    )
  })

  it('native sign-in keeps working beside the web flow (same [auth.external.apple] block)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const h = enc({ alg: 'RS256', kid: KID })
    const p = enc({ iss: 'https://appleid.apple.com', aud: BUNDLE_ID, sub: 'apple.native.001', iat: now, exp: now + 600 })
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${h}.${p}`))
    const { error } = await client('implicit').auth.signInWithIdToken({ provider: 'apple', token: `${h}.${p}.${b64url(new Uint8Array(sig))}` })
    expect(error).toBeNull()
  })
})

describe('config: [auth.external.apple] with a secret is also a web OAuth provider', () => {
  it('client_id list → the web flow uses the first, native accepts all; the secret is the client-secret JWT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-apple-oauth-'))
    mkdirSync(join(dir, 'supabase'))
    writeFileSync(join(dir, 'supabase', 'config.toml'), `[auth.external.apple]\nenabled = true\nclient_id = "com.acme.web,com.acme.app"\nsecret = "eyJ.client.secret"\n`)
    const cfg = loadProjectConfig(dir, {})
    expect(cfg.auth.oauthProviders.apple?.clientSecret).toBe('eyJ.client.secret')
    expect(cfg.auth.idTokenClients.apple).toEqual(['com.acme.web', 'com.acme.app'])
  })
})
