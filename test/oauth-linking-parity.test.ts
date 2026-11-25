import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import type { MailMessage } from '../src/types.js'

/**
 * Account linking, unverified provider emails, linkIdentity / unlinkIdentity and the GitHub / Google profiles,
 * checked against supabase/auth (GoTrue): internal/models/linking.go (DetermineAccountLinking),
 * internal/api/external.go (createAccountFromExternalIdentity, GetExternalProviderRedirectURL),
 * internal/api/identity.go (linkIdentityToUser, DeleteIdentity), internal/models/user.go
 * (UpdateUserEmailFromIdentities, RemoveUnconfirmedIdentities, Confirm) and internal/api/provider/{github,
 * google,oidc}.go. Every expected value is GoTrue's.
 */
const BASE = 'http://127.0.0.1:54321'
const APP = 'http://app.local/done'

// ── a GitHub that answers like api.github.com ─────────────────────────────
let ghUser: Record<string, unknown> = {}
let ghEmails: Array<{ email: string; verified: boolean; primary: boolean }> = []
let googleIdToken: string | null = null
let googleUserinfo: Record<string, unknown> = {}
let lastProviderAuthorize: URL | null = null

const KID = 'g-kid'
let keys: CryptoKeyPair
let publicJwk: JsonWebKey
function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
async function signJwt(claims: Record<string, unknown>) {
  const h = enc({ alg: 'RS256', kid: KID })
  const p = enc(claims)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`
}
const now = () => Math.floor(Date.now() / 1000)

const providerFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString()
  const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
  if (url === 'https://github.com/login/oauth/access_token') return ok({ access_token: 'gh-token', token_type: 'bearer' })
  if (url === 'https://api.github.com/user') return ok(ghUser)
  if (url === 'https://api.github.com/user/emails') return ok(ghEmails)
  if (url === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'g-token', ...(googleIdToken ? { id_token: googleIdToken } : {}) })
  if (url === 'https://www.googleapis.com/userinfo/v2/me') return ok(googleUserinfo)
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return ok({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256' }] })
  if (url === 'https://appleid.apple.com/auth/keys') return ok({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256' }] })
  throw new Error(`unexpected fetch: ${url}`)
}

const PROVIDERS = {
  github: { clientId: 'gh-client', clientSecret: 'gh-secret' },
  google: { clientId: 'g-client', clientSecret: 'g-secret' },
}

const outbox: MailMessage[] = []
let open: TinbaseBackend // autoconfirm on: the default (and `supabase start`'s)
let confirming: TinbaseBackend // [auth.email] enable_confirmations = true
let lenient: TinbaseBackend // confirmations on, GOTRUE_MAILER_ALLOW_UNVERIFIED_EMAIL_SIGN_INS
let optional: TinbaseBackend // [auth.external.github] email_optional = true
let linking: TinbaseBackend // [auth] enable_manual_linking = true

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const common = { siteUrl: BASE, uriAllowList: ['http://app.local/**'], oauthProviders: PROVIDERS, oauthFetch: providerFetch }
  open = await createBackend({ ...common, idTokenClients: { apple: ['com.acme.app'] } })
  confirming = await createBackend({ ...common, authSettings: { autoconfirm: false }, mailer: { send: async (m) => void outbox.push(m) } })
  lenient = await createBackend({ ...common, authSettings: { autoconfirm: false }, allowUnverifiedEmailSignIns: true, mailer: { send: async (m) => void outbox.push(m) } })
  optional = await createBackend({ ...common, emailOptional: ['github'] })
  linking = await createBackend({ ...common, idTokenClients: { apple: ['com.acme.app'] }, authSettings: { manualLinking: true } })
})
afterAll(async () => {
  for (const b of [open, confirming, lenient, optional, linking]) await b.close()
})

const sb = (b: TinbaseBackend) =>
  createClient(BASE, b.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => b.fetch(new Request(i, init)) },
  })

/** The whole browser round trip: /authorize → the provider → /callback. Returns the final redirect. */
async function oauthRoundTrip(b: TinbaseBackend, provider: string, extra = '', authorizeUrl?: string): Promise<URL> {
  let location = authorizeUrl
  if (!location) {
    const res = await b.fetch(new Request(`${BASE}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(APP)}${extra}`, { redirect: 'manual' }))
    expect(res.status).toBe(302)
    location = res.headers.get('location')!
  }
  lastProviderAuthorize = new URL(location)
  const state = lastProviderAuthorize.searchParams.get('state')!
  const cb = await b.fetch(new Request(`${BASE}/auth/v1/callback?code=abcd1234&state=${state}`, { redirect: 'manual' }))
  expect(cb.status).toBe(302)
  return new URL(cb.headers.get('location')!)
}
const fragment = (u: URL) => new URLSearchParams(u.hash.slice(1))

async function userBy(b: TinbaseBackend, where: string, args: unknown[]) {
  const r = await b.db.query<any>(`select * from auth.users where ${where}`, args)
  return r.rows[0]
}
async function identitiesOf(b: TinbaseBackend, userId: string) {
  const r = await b.db.query<any>(`select * from auth.identities where user_id = $1 order by created_at`, [userId])
  return r.rows
}
const meta = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, any>

let seq = 0
function github(emails: typeof ghEmails, user: Record<string, unknown> = {}) {
  const id = 9000 + ++seq
  ghUser = { id, login: `octo${id}`, name: `Octo ${id}`, avatar_url: `https://avatars/${id}`, ...user }
  ghEmails = emails
  return String(id)
}

describe('GitHub profile (provider/github.go)', () => {
  it('identity_data is GoTrue\'s claims map; the email is the primary of /user/emails', async () => {
    const id = github([
      { email: 'Other@Example.com', verified: true, primary: false },
      { email: 'Octo.Primary@Example.com', verified: true, primary: true },
    ])
    const done = await oauthRoundTrip(open, 'github')
    expect(fragment(done).get('access_token')).toBeTruthy()
    const ident = (await open.db.query<any>(`select * from auth.identities where provider = 'github' and provider_id = $1`, [id])).rows[0]
    expect(meta(ident.identity_data)).toEqual({
      iss: 'https://api.github.com',
      sub: id,
      name: `Octo ${id}`,
      preferred_username: `octo${id}`,
      avatar_url: `https://avatars/${id}`,
      full_name: `Octo ${id}`,
      provider_id: id,
      user_name: `octo${id}`,
      email: 'Octo.Primary@Example.com',
      email_verified: true,
      phone_verified: false,
    })
    const user = await userBy(open, 'id = $1', [ident.user_id])
    expect(user.email).toBe('octo.primary@example.com')
    expect(user.email_confirmed_at).not.toBeNull()
  })

  it('asks GitHub for user:email only, and passes other query params on to the provider', async () => {
    github([{ email: `fwd${seq}@example.com`, verified: true, primary: true }])
    await oauthRoundTrip(open, 'github', '&login=octo&client_id=evil&redirect_uri=https://evil&nonce=n1')
    const p = lastProviderAuthorize!.searchParams
    expect(p.get('scope')).toBe('user:email')
    expect(p.get('login')).toBe('octo') // passed through
    expect(p.get('nonce')).toBe('n1') // nonce is the one reserved name a request may pass
    expect(p.get('client_id')).toBe('gh-client') // never the request's
    expect(p.get('redirect_uri')).toBe(`${BASE}/auth/v1/callback`)
    expect(p.get('redirect_to')).toBe(APP) // GoTrue forwards it too
  })

  it('no email at all: 500 "Error getting user email from external provider", unless email_optional', async () => {
    const id = github([])
    const done = await oauthRoundTrip(open, 'github')
    expect(Object.fromEntries(done.searchParams)).toEqual({
      error: 'server_error',
      error_code: 'unexpected_failure',
      error_description: 'Error getting user email from external provider',
    })
    expect((await open.db.query(`select 1 from auth.identities where provider_id = $1`, [id])).rows.length).toBe(0)

    const id2 = github([])
    const ok = await oauthRoundTrip(optional, 'github')
    expect(fragment(ok).get('access_token')).toBeTruthy()
    const ident = (await optional.db.query<any>(`select * from auth.identities where provider_id = $1`, [id2])).rows[0]
    const user = await userBy(optional, 'id = $1', [ident.user_id])
    expect(user.email).toBeNull()
    expect(meta(ident.identity_data).email_verified).toBe(false)
  })
})

describe('Google profile (provider/google.go, oidc.go)', () => {
  it('from the id_token in the token response, with the hosted domain in custom_claims', async () => {
    const sub = `g-${++seq}`
    googleIdToken = await signJwt({ iss: 'https://accounts.google.com', aud: 'g-client', sub, email: `${sub}@acme.com`, email_verified: true, name: 'Gee Oogle', picture: 'https://pic', hd: 'acme.com', iat: now(), exp: now() + 600 })
    await oauthRoundTrip(open, 'google')
    expect(lastProviderAuthorize!.searchParams.get('scope')).toBe('email profile')
    const ident = (await open.db.query<any>(`select * from auth.identities where provider = 'google' and provider_id = $1`, [sub])).rows[0]
    expect(meta(ident.identity_data)).toEqual({
      iss: 'https://accounts.google.com',
      sub,
      name: 'Gee Oogle',
      picture: 'https://pic',
      avatar_url: 'https://pic',
      full_name: 'Gee Oogle',
      provider_id: sub,
      email: `${sub}@acme.com`,
      email_verified: true,
      phone_verified: false,
      custom_claims: { hd: 'acme.com' },
    })
  })

  it('without an id_token: the legacy userinfo/v2 endpoint, issuer = that URL', async () => {
    googleIdToken = null
    const id = `1${++seq}`
    googleUserinfo = { id, email: `u${id}@gmail.com`, verified_email: true, name: 'User Info', picture: 'https://p2' }
    await oauthRoundTrip(open, 'google')
    const ident = (await open.db.query<any>(`select * from auth.identities where provider = 'google' and provider_id = $1`, [id])).rows[0]
    expect(meta(ident.identity_data)).toEqual({
      iss: 'https://www.googleapis.com/userinfo/v2/me',
      sub: id,
      name: 'User Info',
      picture: 'https://p2',
      avatar_url: 'https://p2',
      full_name: 'User Info',
      provider_id: id,
      email: `u${id}@gmail.com`,
      email_verified: true,
      phone_verified: false,
    })
  })
})

describe('unverified provider emails (DetermineAccountLinking + createAccountFromExternalIdentity)', () => {
  it('autoconfirm on: an unverified address counts as verified and links to the account that has it', async () => {
    const email = `owner${++seq}@example.com`
    await sb(open).auth.signUp({ email, password: 'password123' })
    const owner = await userBy(open, 'email = $1', [email])
    const id = github([{ email, verified: false, primary: true }])
    const done = await oauthRoundTrip(open, 'github')
    expect(fragment(done).get('access_token')).toBeTruthy()
    const ident = (await open.db.query<any>(`select user_id from auth.identities where provider_id = $1`, [id])).rows[0]
    expect(ident.user_id).toBe(owner.id)
    expect(meta((await userBy(open, 'id = $1', [owner.id])).raw_app_meta_data).providers).toEqual(['email', 'github'])
  })

  it('confirmations on: a new user keeps the address unconfirmed, is mailed, and is refused with 422 provider_email_needs_verification', async () => {
    const email = `new${++seq}@example.com`
    const id = github([{ email, verified: false, primary: true }])
    const before = outbox.length
    const done = await oauthRoundTrip(confirming, 'github')
    const expected = {
      error: 'access_denied',
      error_code: 'provider_email_needs_verification',
      error_description: 'Unverified email with github. A confirmation email has been sent to your github email',
    }
    expect(Object.fromEntries(done.searchParams)).toEqual(expected)
    expect(Object.fromEntries(fragment(done))).toEqual({ ...expected, sb: '' })
    // committed, as GoTrue's CommitWithError: the user and identity stay, unconfirmed, and the mail went out
    const user = await userBy(confirming, 'email = $1', [email])
    expect(user.email_confirmed_at).toBeNull()
    expect((await identitiesOf(confirming, user.id)).map((i: any) => i.provider_id)).toEqual([id])
    expect(outbox.length).toBe(before + 1)
    expect(outbox.at(-1)!.to).toBe(email)
    expect(outbox.at(-1)!.subject).toBe('Confirm your email')
  })

  it('confirmations on: an unverified address another user owns is not taken; nothing to mail, "Verify the email with github"', async () => {
    const email = `taken${++seq}@example.com`
    await sb(confirming).auth.signUp({ email, password: 'password123' })
    const owner = await userBy(confirming, 'email = $1', [email])
    const id = github([{ email, verified: false, primary: true }])
    const before = outbox.length
    const done = await oauthRoundTrip(confirming, 'github')
    expect(done.searchParams.get('error_description')).toBe('Unverified email with github. Verify the email with github in order to sign in')
    expect(done.searchParams.get('error_code')).toBe('provider_email_needs_verification')
    const ident = (await confirming.db.query<any>(`select user_id from auth.identities where provider_id = $1`, [id])).rows[0]
    expect(ident.user_id).not.toBe(owner.id)
    expect((await userBy(confirming, 'id = $1', [ident.user_id])).email).toBeNull()
    expect(outbox.length).toBe(before)
  })

  it('confirmations on: a verified address still links and confirms', async () => {
    const email = `verified${++seq}@example.com`
    const id = github([{ email, verified: true, primary: true }])
    const done = await oauthRoundTrip(confirming, 'github')
    expect(fragment(done).get('access_token')).toBeTruthy()
    const ident = (await confirming.db.query<any>(`select user_id from auth.identities where provider_id = $1`, [id])).rows[0]
    const user = await userBy(confirming, 'id = $1', [ident.user_id])
    expect(user.email_confirmed_at).not.toBeNull()
    expect(meta(user.raw_user_meta_data).email_verified).toBe(true)
  })

  it('an unconfirmed password account taken over by a verified provider sign-in loses its password and other identities (RemoveUnconfirmedIdentities)', async () => {
    const email = `squat${++seq}@example.com`
    await sb(confirming).auth.signUp({ email, password: 'password123' }) // never confirmed
    const squatter = await userBy(confirming, 'email = $1', [email])
    expect(squatter.encrypted_password).toBeTruthy()
    const id = github([{ email, verified: true, primary: true }])
    const done = await oauthRoundTrip(confirming, 'github')
    expect(fragment(done).get('access_token')).toBeTruthy()
    const user = await userBy(confirming, 'id = $1', [squatter.id])
    expect(user.encrypted_password).toBeNull()
    expect(user.email_confirmed_at).not.toBeNull()
    expect((await identitiesOf(confirming, user.id)).map((i: any) => i.provider)).toEqual(['github'])
    expect(meta(user.raw_app_meta_data).providers).toEqual(['github'])
    const m = meta(user.raw_user_meta_data)
    expect(m.sub).toBe(id)
    expect(m.email_verified).toBe(true)
  })

  it('GOTRUE_MAILER_ALLOW_UNVERIFIED_EMAIL_SIGN_INS: mailed, but signed in while unconfirmed', async () => {
    const email = `lenient${++seq}@example.com`
    github([{ email, verified: false, primary: true }])
    const before = outbox.length
    const done = await oauthRoundTrip(lenient, 'github')
    expect(fragment(done).get('access_token')).toBeTruthy()
    expect((await userBy(lenient, 'email = $1', [email])).email_confirmed_at).toBeNull()
    expect(outbox.length).toBe(before + 1)
  })
})

describe('link_identity with an ID token (identity.go linkIdentityToUser)', () => {
  async function appleToken(sub: string, email?: string) {
    return signJwt({ iss: 'https://appleid.apple.com', aud: 'com.acme.app', sub, ...(email ? { email } : {}), iat: now(), exp: now() + 600 })
  }
  async function linkGrant(b: TinbaseBackend, bearer: string, token: string) {
    const res = await b.fetch(
      new Request(`${BASE}/auth/v1/token?grant_type=id_token`, {
        method: 'POST',
        headers: { apikey: b.anonKey, 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ provider: 'apple', id_token: token, link_identity: true }),
      })
    )
    return { status: res.status, body: (await res.json()) as any }
  }

  it('an anonymous user takes the Apple email, is confirmed and stops being anonymous', async () => {
    const { data } = await sb(open).auth.signInAnonymously()
    const email = `anon${++seq}@privaterelay.appleid.com`
    const r = await linkGrant(open, data.session!.access_token, await appleToken(`anon.${seq}`, email))
    expect(r.status).toBe(200)
    const user = await userBy(open, 'id = $1', [data.user!.id])
    expect(user.email).toBe(email)
    expect(user.email_confirmed_at).not.toBeNull()
    expect(user.is_anonymous).toBe(false)
    expect(meta(user.raw_app_meta_data).providers).toEqual(['apple'])
    expect(meta(user.raw_user_meta_data).email_verified).toBe(true)
  })

  it('an address another user has: 400 email_exists, nothing linked', async () => {
    const email = `dup${++seq}@example.com`
    await sb(open).auth.signUp({ email, password: 'password123' })
    const { data } = await sb(open).auth.signInAnonymously()
    const r = await linkGrant(open, data.session!.access_token, await appleToken(`dup.${seq}`, email))
    expect(r).toEqual({ status: 400, body: { code: 400, error_code: 'email_exists', msg: 'A user with this email address has already been registered' } })
    expect(await identitiesOf(open, data.user!.id)).toEqual([])
  })

  it('a user who has an email keeps it', async () => {
    const email = `keeps${++seq}@example.com`
    const { data } = await sb(open).auth.signUp({ email, password: 'password123' })
    const r = await linkGrant(open, data.session!.access_token, await appleToken(`keeps.${seq}`, `other${seq}@privaterelay.appleid.com`))
    expect(r.status).toBe(200)
    expect((await userBy(open, 'id = $1', [data.user!.id])).email).toBe(email)
    expect(meta((await userBy(open, 'id = $1', [data.user!.id])).raw_app_meta_data).providers).toEqual(['email', 'apple'])
  })
})

describe('linkIdentity / unlinkIdentity (GET /user/identities/authorize, DELETE /user/identities/{id})', () => {
  it('404 manual_linking_disabled unless [auth] enable_manual_linking', async () => {
    const { data } = await sb(open).auth.signUp({ email: `ml${++seq}@example.com`, password: 'password123' })
    const res = await open.fetch(
      new Request(`${BASE}/auth/v1/user/identities/authorize?provider=github&skip_http_redirect=true`, {
        headers: { apikey: open.anonKey, authorization: `Bearer ${data.session!.access_token}` },
      })
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: 404, error_code: 'manual_linking_disabled', msg: 'Manual linking is disabled' })
  })

  it('supabase-js linkIdentity: the OAuth round trip adds the identity to the signed-in user', async () => {
    const email = `link${++seq}@example.com`
    const client = sb(linking)
    const { data } = await client.auth.signUp({ email, password: 'password123' })
    expect(data.session).toBeTruthy()
    const { data: linked, error } = await client.auth.linkIdentity({ provider: 'github', options: { redirectTo: APP, skipBrowserRedirect: true } })
    expect(error).toBeNull()
    expect(linked.url).toContain('https://github.com/login/oauth/authorize')
    const id = github([{ email: `gh${seq}@example.com`, verified: true, primary: true }])
    const done = await oauthRoundTrip(linking, 'github', '', linked.url!)
    expect(fragment(done).get('access_token')).toBeTruthy()
    const ids = await identitiesOf(linking, data.user!.id)
    expect(ids.map((i: any) => [i.provider, i.provider_id])).toEqual([
      ['email', data.user!.id],
      ['github', id],
    ])
    expect((await userBy(linking, 'id = $1', [data.user!.id])).email).toBe(email)

    // the same GitHub account again: identity_already_exists
    const again = await client.auth.linkIdentity({ provider: 'github', options: { redirectTo: APP, skipBrowserRedirect: true } })
    const refused = await oauthRoundTrip(linking, 'github', '', again.data.url!)
    expect(refused.searchParams.get('error_code')).toBe('identity_already_exists')
    expect(refused.searchParams.get('error_description')).toBe('Identity is already linked')

    // unlink it: providers follow, the email stays (the email identity still has it)
    const github_ = ids.find((i: any) => i.provider === 'github')
    const res = await linking.fetch(
      new Request(`${BASE}/auth/v1/user/identities/${github_.id}`, {
        method: 'DELETE',
        headers: { apikey: linking.anonKey, authorization: `Bearer ${data.session!.access_token}` },
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    const user = await userBy(linking, 'id = $1', [data.user!.id])
    expect(meta(user.raw_app_meta_data).providers).toEqual(['email'])
    expect(user.email).toBe(email)
  })

  it('unlink: never the last identity, a missing one, or a malformed id', async () => {
    const { data } = await sb(linking).auth.signUp({ email: `last${++seq}@example.com`, password: 'password123' })
    const del = async (id: string) => {
      const res = await linking.fetch(
        new Request(`${BASE}/auth/v1/user/identities/${id}`, { method: 'DELETE', headers: { apikey: linking.anonKey, authorization: `Bearer ${data.session!.access_token}` } })
      )
      return { status: res.status, body: await res.json() }
    }
    const [only] = await identitiesOf(linking, data.user!.id)
    expect(await del(only.id)).toEqual({ status: 422, body: { code: 422, error_code: 'single_identity_not_deletable', msg: 'User must have at least 1 identity after unlinking' } })
    expect(await del('not-a-uuid')).toEqual({ status: 404, body: { code: 404, error_code: 'validation_failed', msg: 'identity_id must be an UUID' } })
    // a second identity, then ask for one that isn't this user's
    github([{ email: `l2${seq}@example.com`, verified: true, primary: true }])
    const client = createClient(BASE, linking.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => linking.fetch(new Request(i, init)), headers: { Authorization: `Bearer ${data.session!.access_token}` } },
    })
    await client.auth.setSession({ access_token: data.session!.access_token, refresh_token: data.session!.refresh_token })
    const { data: l } = await client.auth.linkIdentity({ provider: 'github', options: { redirectTo: APP, skipBrowserRedirect: true } })
    await oauthRoundTrip(linking, 'github', '', l.url!)
    expect(await del('00000000-0000-4000-8000-000000000000')).toEqual({ status: 422, body: { code: 422, error_code: 'identity_not_found', msg: "Identity doesn't exist" } })
  })
})
