import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'

/**
 * A mock OAuth provider implemented as a fetch handler. tinbase's OAuthService
 * calls token + userinfo through the injected `oauthFetch`; the authorize step
 * is driven by the test simulating the browser landing on the provider and
 * being redirected back to /callback.
 */
const PROFILE = { id: 'gh_123', login: 'octocat', name: 'The Octocat', email: 'octo@example.com', avatar_url: 'x', verified: true }
let lastAuthorize: URL | null = null

const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.toString())
  if (url.href.startsWith('https://mock/token')) {
    return new Response(JSON.stringify({ access_token: 'provider-tok', token_type: 'bearer' }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url.href.startsWith('https://mock/userinfo')) {
    return new Response(JSON.stringify(PROFILE), { headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected fetch in mock: ${url.href}`)
}

const provider = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  authorizeUrl: 'https://mock/authorize',
  tokenUrl: 'https://mock/token',
  userInfoUrl: 'https://mock/userinfo',
  scopes: 'read:user',
  profileMap: (r: any) => ({ id: String(r.id), email: r.email, emailVerified: r.verified === true, name: r.name, metadata: { user_name: r.login } }),
}

let backend: TinbaseBackend
const BASE = 'http://127.0.0.1:54321'

beforeAll(async () => {
  backend = await createBackend({
    siteUrl: BASE,
    oauthProviders: { github: provider },
    oauthFetch: mockFetch,
  })
})
afterAll(async () => {
  await backend.close()
})

/** Drive the provider side: read tinbase's redirect to the provider, then hit /callback with a code. */
async function driveProvider(authorizeLocation: string): Promise<Response> {
  lastAuthorize = new URL(authorizeLocation)
  const state = lastAuthorize.searchParams.get('state')!
  const redirectUri = lastAuthorize.searchParams.get('redirect_uri')!
  // provider would prompt the user, then redirect back with an auth code
  return backend.fetch(new Request(`${redirectUri}?code=provider-code&state=${state}`, { redirect: 'manual' }))
}

describe('oauth', () => {
  it('signInWithOAuth returns a provider authorize URL', async () => {
    const supabase = createClient(BASE, backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, flowType: 'implicit' },
      global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
    })
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: 'http://app.local/welcome', skipBrowserRedirect: true },
    })
    expect(error).toBeNull()
    expect(data.url).toContain('/auth/v1/authorize?provider=github')
  })

  it('implicit flow: authorize → provider → callback → session in the hash', async () => {
    // 1. hit /authorize (tinbase redirects to the provider)
    const authRes = await backend.fetch(
      new Request(`${BASE}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent('http://app.local/welcome')}`, {
        redirect: 'manual',
      })
    )
    expect(authRes.status).toBe(302) // GoTrue: 302 Found
    const providerUrl = authRes.headers.get('location')!
    expect(providerUrl).toContain('https://mock/authorize')
    expect(providerUrl).toContain('client_id=client-id')

    // 2. provider redirects back to /callback; tinbase issues a session
    const cbRes = await driveProvider(providerUrl)
    expect(cbRes.status).toBe(302)
    const back = cbRes.headers.get('location')!
    expect(back).toContain('http://app.local/welcome#access_token=')
    expect(back).toContain('refresh_token=')
    // GitHub returns no refresh token: GoTrue leaves provider_refresh_token out, provider_token is GitHub's
    const frag = new URLSearchParams(back.split('#')[1])
    expect([...frag.keys()]).toEqual(['access_token', 'expires_at', 'expires_in', 'provider_token', 'refresh_token', 'sb', 'token_type'])
    expect(frag.get('provider_token')).toBe('provider-tok')

    // 3. the created user + identity exist
    const users = await backend.db.query(`select email from auth.users where email = 'octo@example.com'`)
    expect(users.rows.length).toBe(1)
    const ident = await backend.db.query(`select * from auth.identities where provider = 'github' and provider_id = 'gh_123'`)
    expect(ident.rows.length).toBe(1)
  })

  it('pkce flow: callback returns ?code, exchangeCodeForSession yields a session', async () => {
    const supabase = createClient(BASE, backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, flowType: 'pkce' },
      global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
    })
    // supabase-js stores the code_verifier and builds the authorize URL with a challenge
    const { data } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: 'http://app.local/cb', skipBrowserRedirect: true },
    })
    const authUrl = new URL(data.url!)
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy()

    // follow authorize → provider → callback
    const authRes = await backend.fetch(new Request(data.url!, { redirect: 'manual' }))
    const cbRes = await driveProvider(authRes.headers.get('location')!)
    const back = new URL(cbRes.headers.get('location')!)
    const code = back.searchParams.get('code')
    expect(code).toBeTruthy()

    // exchange the auth code (+ stored verifier) for a session
    const { data: sess, error } = await supabase.auth.exchangeCodeForSession(code!)
    expect(error).toBeNull()
    expect(sess.session?.access_token).toBeTruthy()
    expect(sess.user?.email).toBe('octo@example.com')
  })

  it('unknown provider is a 400 validation_failed, as GoTrue', async () => {
    const res = await backend.fetch(new Request(`${BASE}/auth/v1/authorize?provider=nope`, { redirect: 'manual' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 400, error_code: 'validation_failed', msg: 'Unsupported provider: Provider nope could not be found' })
    const off = await backend.fetch(new Request(`${BASE}/auth/v1/authorize?provider=google`, { redirect: 'manual' }))
    expect(await off.json()).toEqual({ code: 400, error_code: 'validation_failed', msg: 'Unsupported provider: provider is not enabled' })
  })

  it('links an unverified provider email under autoconfirm, as Supabase does (DetermineAccountLinking)', async () => {
    // pre-existing password account owns victim@example.com
    const victim = createClient(BASE, backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
    })
    await victim.auth.signUp({ email: 'victim@example.com', password: 'password123' })
    const before = await backend.db.query<{ id: string }>(
      `select id from auth.users where email = 'victim@example.com'`
    )
    const victimId = before.rows[0].id

    // a NEW provider identity presents the same email, unverified. GoTrue counts every address as verified
    // when the mailer autoconfirms (tinbase's default, and `supabase start`'s): it links. With
    // enable_confirmations on it doesn't - see oauth-linking-parity.test.ts.
    PROFILE.id = 'gh_attacker'
    PROFILE.email = 'victim@example.com'
    PROFILE.verified = false
    const authRes = await backend.fetch(
      new Request(`${BASE}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent('http://app.local/x')}`, {
        redirect: 'manual',
      })
    )
    await driveProvider(authRes.headers.get('location')!)

    const ident = await backend.db.query<{ user_id: string }>(
      `select user_id from auth.identities where provider = 'github' and provider_id = 'gh_attacker'`
    )
    expect(ident.rows.length).toBe(1)
    expect(ident.rows[0].user_id).toBe(victimId)
  })
})
