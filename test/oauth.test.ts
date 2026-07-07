import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'

/**
 * A mock OAuth provider implemented as a fetch handler. tinbase's OAuthService
 * calls token + userinfo through the injected `oauthFetch`; the authorize step
 * is driven by the test simulating the browser landing on the provider and
 * being redirected back to /callback.
 */
const PROFILE = { id: 'gh_123', login: 'octocat', name: 'The Octocat', email: 'octo@example.com', avatar_url: 'x' }
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
  profileMap: (r: any) => ({ id: String(r.id), email: r.email, name: r.name, metadata: { user_name: r.login } }),
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
    expect(authRes.status).toBe(303)
    const providerUrl = authRes.headers.get('location')!
    expect(providerUrl).toContain('https://mock/authorize')
    expect(providerUrl).toContain('client_id=client-id')

    // 2. provider redirects back to /callback; tinbase issues a session
    const cbRes = await driveProvider(providerUrl)
    expect(cbRes.status).toBe(303)
    const back = cbRes.headers.get('location')!
    expect(back).toContain('http://app.local/welcome#access_token=')
    expect(back).toContain('refresh_token=')

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

  it('unknown provider redirects with an error', async () => {
    const res = await backend.fetch(new Request(`${BASE}/auth/v1/authorize?provider=nope`, { redirect: 'manual' }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=provider_not_enabled')
  })
})
