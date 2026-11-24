/**
 * OAuth 2.0 / OIDC provider support for GoTrue-compatible sign-in.
 *
 * Flow (matches hosted Supabase):
 *   GET /authorize?provider=…  → 302 to the provider, state persisted
 *   provider → GET /callback?code=…&state=…
 *     → exchange code for a provider token, fetch the profile, upsert the
 *       user + identity, then:
 *         - PKCE: redirect to redirect_to?code=<auth_code>  (client calls
 *           exchangeCodeForSession → POST /token?grant_type=pkce)
 *         - implicit: redirect to redirect_to#access_token=…&refresh_token=…
 */
import type { Database } from '../db/database.js'
import { randomToken } from '../jwt.js'
import { verifyIdToken } from './id-token.js'
import { resolveRedirect } from './redirect.js'

/** Operator-supplied config for one OAuth provider. Endpoint URLs are optional for presets (google, github). */
export interface OAuthProviderConfig {
  /** OAuth client id issued by the provider */
  clientId: string
  /** OAuth client secret issued by the provider */
  clientSecret: string
  /** Overrides; filled from a preset for known providers (google, github). */
  authorizeUrl?: string
  /** token endpoint; filled from a preset when omitted */
  tokenUrl?: string
  /** userinfo endpoint; filled from a preset when omitted */
  userInfoUrl?: string
  /** space-separated scopes to request; falls back to the preset's */
  scopes?: string
  /** Map the provider's raw userinfo JSON to a normalized profile. */
  profileMap?: (raw: any) => OAuthProfile
  /**
   * The profile comes from the `id_token` in the token response (verified against the provider's keys),
   * not from a userinfo endpoint: Apple has none. Set by the apple preset.
   */
  idTokenProfile?: string
  /** Extra query parameters on the authorize URL (Apple: response_mode=form_post). Set by presets. */
  authorizeParams?: Record<string, string>
}

/** What the provider's token endpoint returned: handed back to the app as provider_token / provider_refresh_token. */
export interface ProviderTokens {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
}

/** Normalized profile extracted from a provider's userinfo response. */
export interface OAuthProfile {
  /** Provider-local user id (becomes auth.identities.provider_id). */
  id: string
  /** email address the provider returned, if any */
  email?: string
  /** Whether the provider asserts the email is verified; gated for account linking. */
  emailVerified?: boolean
  /** display name the provider returned, if any */
  name?: string
  /** extra provider fields (avatar, username, …) merged into identity_data */
  metadata?: Record<string, unknown>
  /**
   * GoTrue's identity data (structs.Map of the provider's claims): stored as identity_data and merged into
   * user_metadata as is. Set by ID-token profiles (Apple, Google); others build it from id/email/metadata.
   */
  identityData?: Record<string, unknown>
}

/** A GoTrue HTTPError raised while signing in: `{ code, error_code, msg }` with this status, or a redirect with it. */
export class AuthHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** GoTrue's oauthErrorMap and the codes it reports as access_denied, for error redirects. */
function oauthErrorFor(e: AuthHttpError): string {
  if (e.code === 'signup_disabled' || e.code === 'user_banned' || e.code === 'provider_email_needs_verification') return 'access_denied'
  return ({ 400: 'invalid_request', 401: 'unauthorized_client', 403: 'access_denied', 500: 'server_error', 503: 'temporarily_unavailable' } as Record<number, string>)[e.status] ?? 'server_error'
}

interface ResolvedProvider extends Required<Omit<OAuthProviderConfig, 'profileMap' | 'idTokenProfile' | 'authorizeParams' | 'userInfoUrl'>> {
  name: string
  userInfoUrl: string | null
  profileMap: (raw: any) => OAuthProfile
  idTokenProfile: string | null
  authorizeParams: Record<string, string>
}

const PRESETS: Record<string, Partial<OAuthProviderConfig>> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: 'openid email profile',
    profileMap: (r) => ({
      id: r.sub,
      email: r.email,
      emailVerified: r.email_verified === true,
      name: r.name,
      metadata: { avatar_url: r.picture, full_name: r.name },
    }),
  },
  // Sign in with Apple on the web, as GoTrue's apple provider: Apple POSTs the result back to the callback
  // (form_post, required once name or email is asked for), and has no userinfo endpoint, so the profile is
  // the id_token from the token response. `secret` is the client-secret JWT signed with the Sign in with
  // Apple key, exactly as Supabase's [auth.external.apple] secret.
  apple: {
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    scopes: 'email name',
    idTokenProfile: 'apple',
    authorizeParams: { response_mode: 'form_post' },
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scopes: 'read:user user:email',
    profileMap: (r) => ({ id: String(r.id), email: r.email, name: r.name ?? r.login, metadata: { avatar_url: r.avatar_url, user_name: r.login } }),
  },
}

/**
 * Merge operator config with the built-in preset for `name` into a fully
 * resolved provider.
 *
 * @throws if no endpoint URLs are supplied and no preset exists for `name`.
 */
export function resolveProvider(name: string, cfg: OAuthProviderConfig): ResolvedProvider {
  const preset = PRESETS[name] ?? {}
  const authorizeUrl = cfg.authorizeUrl ?? preset.authorizeUrl
  const tokenUrl = cfg.tokenUrl ?? preset.tokenUrl
  const userInfoUrl = cfg.userInfoUrl ?? preset.userInfoUrl ?? null
  const idTokenProfile = cfg.idTokenProfile ?? preset.idTokenProfile ?? null
  if (!authorizeUrl || !tokenUrl || (!userInfoUrl && !idTokenProfile)) {
    throw new Error(`OAuth provider "${name}" needs authorizeUrl/tokenUrl/userInfoUrl (no preset available)`)
  }
  return {
    name,
    // GoTrue takes a comma-separated list (bundle ids for native sign-in, the Services ID for the web);
    // the web flow uses the first.
    clientId: cfg.clientId.split(',')[0].trim(),
    clientSecret: cfg.clientSecret,
    authorizeUrl,
    tokenUrl,
    userInfoUrl,
    scopes: cfg.scopes ?? preset.scopes ?? '',
    profileMap: cfg.profileMap ?? preset.profileMap ?? ((r) => ({ id: String(r.id ?? r.sub), email: r.email, name: r.name })),
    idTokenProfile,
    authorizeParams: { ...preset.authorizeParams, ...cfg.authorizeParams },
  }
}

/** Drives the OAuth authorize/callback/PKCE flows against the configured providers. */
export class OAuthService {
  private providers = new Map<string, ResolvedProvider>()

  constructor(
    private db: Database,
    private siteUrl: string,
    /** Where this server answers; the provider redirects back here, not to the app. */
    private apiExternalUrl: string,
    configs: Record<string, OAuthProviderConfig>,
    private fetchImpl: typeof fetch = fetch,
    private uriAllowList: string[] = [],
    private enforceRedirectAllowList = false,
    /** Read on every sign-in: [auth] enable_signup can change at runtime. */
    private getSettings: () => { disableSignup: boolean } = () => ({ disableSignup: false })
  ) {
    for (const [name, cfg] of Object.entries(configs)) {
      this.providers.set(name, resolveProvider(name, cfg))
    }
  }

  /** Whether a provider by this name is configured. */
  has(name: string): boolean {
    return this.providers.has(name)
  }

  private callbackUrl(): string {
    // The provider sends the user back to this server to exchange the code -
    // the app has no endpoint for it. Error and success redirects below still
    // go to siteUrl, which is where the user belongs once the flow is over.
    return `${this.apiExternalUrl}/auth/v1/callback`
  }

  /** GET /authorize - persist state, redirect to the provider. */
  async authorize(url: URL): Promise<Response> {
    const providerName = url.searchParams.get('provider') ?? ''
    const provider = this.providers.get(providerName)
    if (!provider) {
      return redirect(`${this.siteUrl}#error=provider_not_enabled&error_description=${encodeURIComponent(`provider ${providerName} is not configured`)}`)
    }
    const providerState = randomToken(16)
    const scopes = url.searchParams.get('scopes') || provider.scopes
    // Validate the redirect target up front so the callback can trust the stored
    // value - an unallowed target falls back to the site URL.
    const redirectTo = resolveRedirect(url.searchParams.get('redirect_to'), this.siteUrl, this.uriAllowList, this.enforceRedirectAllowList)
    await this.db.query(
      `insert into auth.flow_state (provider, provider_state, redirect_to, code_challenge, code_challenge_method, expires_at)
       values ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [
        providerName,
        providerState,
        redirectTo,
        url.searchParams.get('code_challenge'),
        url.searchParams.get('code_challenge_method'),
      ]
    )
    const p = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: this.callbackUrl(),
      response_type: 'code',
      scope: scopes,
      state: providerState,
      ...provider.authorizeParams,
    })
    return redirect(`${provider.authorizeUrl}?${p}`)
  }

  /**
   * GET or POST /callback - exchange code, upsert user+identity, redirect back. `params` is the query string
   * merged with the form body when the provider POSTs (Apple's form_post), as GoTrue's r.Form.
   *
   * As GoTrue: the state is checked first, then the provider's own error (a cancel), then the code; any
   * failure redirects to the app with error / error_description / error_code in the query AND the fragment.
   */
  async callback(params: URLSearchParams, createSession: (userId: string) => Promise<OAuthSession>): Promise<Response> {
    const state = params.get('state')
    if (!state) return this.errorRedirect(this.siteUrl, new AuthHttpError(400, 'bad_oauth_callback', 'OAuth state parameter missing'))
    const res = await this.db.query<FlowRow>(`delete from auth.flow_state where provider_state = $1 returning *`, [state])
    const flow = res.rows[0]
    if (!flow) return this.errorRedirect(this.siteUrl, new AuthHttpError(400, 'bad_oauth_state', 'OAuth state not found or expired'))
    const target = flow.redirect_to || this.siteUrl
    if (new Date(flow.expires_at).getTime() < Date.now()) return this.errorRedirect(target, new AuthHttpError(400, 'bad_oauth_state', 'OAuth state has expired'))

    const providerError = params.get('error')
    if (providerError) return this.errorRedirect(target, { error: providerError, description: params.get('error_description') ?? '' })
    const code = params.get('code')
    if (!code) return this.errorRedirect(target, new AuthHttpError(400, 'bad_oauth_callback', 'OAuth callback with missing authorization code missing'))
    const provider = this.providers.get(flow.provider)
    if (!provider) return this.errorRedirect(target, new AuthHttpError(400, 'oauth_provider_not_supported', `Unsupported provider: ${flow.provider}`))

    let tokens: ProviderTokens
    try {
      tokens = await this.exchangeCode(provider, code)
    } catch {
      return this.errorRedirect(target, new AuthHttpError(500, 'unexpected_failure', `Unable to exchange external code: ${code.slice(0, 4)}`))
    }
    let profile: OAuthProfile
    try {
      profile = await this.fetchProfile(provider, tokens)
    } catch {
      return this.errorRedirect(target, new AuthHttpError(500, 'unexpected_failure', 'Error getting user profile from external provider'))
    }
    // Apple's ParseUser: the name, sent once (first consent) as a `user` JSON field beside the code
    const name = provider.name === 'apple' ? appleUserName(params.get('user')) : null
    if (name) {
      profile = { ...profile, name, metadata: { ...profile.metadata, name, full_name: name } }
      if (profile.identityData) profile.identityData = { ...profile.identityData, name, full_name: name }
    }

    let userId: string
    try {
      userId = await this.upsertUser(provider.name, profile)
    } catch (e) {
      if (e instanceof AuthHttpError) return this.errorRedirect(target, e)
      throw e
    }

    // PKCE: hand back an auth code the client exchanges for a session (and the provider's tokens).
    if (flow.code_challenge) {
      const authCode = randomToken(24)
      await this.db.query(
        `insert into auth.flow_state (provider, provider_state, redirect_to, code_challenge, code_challenge_method, auth_code, user_id,
                                      provider_access_token, provider_refresh_token, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '5 minutes')`,
        [flow.provider, randomToken(16), flow.redirect_to, flow.code_challenge, flow.code_challenge_method, authCode, userId,
         tokens.accessToken, tokens.refreshToken]
      )
      return redirect(`${flow.redirect_to}?code=${authCode}`)
    }

    // implicit: GoTrue's AccessTokenResponse.AsRedirectURL - the session and the provider's tokens in the
    // fragment, url.Values-encoded (keys sorted), with the `sb` marker
    const session = await createSession(userId)
    const values: Record<string, string> = {
      access_token: session.access_token,
      expires_at: String(session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in),
      expires_in: String(session.expires_in),
      provider_token: tokens.accessToken,
      refresh_token: session.refresh_token,
      sb: '',
      token_type: 'bearer',
    }
    if (tokens.refreshToken) values.provider_refresh_token = tokens.refreshToken
    return redirect(`${flow.redirect_to}#${sortedQuery(values)}`)
  }

  /** GoTrue's redirectErrors: the error in the target's query and in its fragment (with `sb`). */
  private errorRedirect(base: string, err: AuthHttpError | { error: string; description: string }): Response {
    const values: Record<string, string> =
      err instanceof AuthHttpError
        ? { error: oauthErrorFor(err), error_description: err.message, error_code: err.code }
        : { error: err.error, ...(err.description ? { error_description: err.description } : {}) }
    let u: URL
    try {
      u = new URL(base)
    } catch {
      u = new URL(this.siteUrl)
    }
    for (const k of Object.keys(values).sort()) u.searchParams.set(k, values[k])
    u.hash = sortedQuery({ ...values, sb: '' })
    return redirect(u.toString())
  }

  /**
   * POST /token?grant_type=pkce - exchange an auth code + verifier for a session. Returns the user and, after
   * an OAuth sign-in, the provider's tokens (GoTrue's provider_token / provider_refresh_token).
   */
  async exchangePkce(
    authCode: string,
    verifier: string
  ): Promise<{ userId: string; providerToken: string | null; providerRefreshToken: string | null } | null> {
    const res = await this.db.query<FlowRow>(
      `delete from auth.flow_state where auth_code = $1 and expires_at > now() returning *`,
      [authCode]
    )
    const flow = res.rows[0]
    if (!flow || !flow.user_id) return null
    if (flow.code_challenge_method === 's256' || flow.code_challenge_method === 'S256') {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
      const challenge = base64url(new Uint8Array(digest))
      if (challenge !== flow.code_challenge) return null
    } else if (flow.code_challenge && flow.code_challenge !== verifier) {
      return null // plain method
    }
    return { userId: flow.user_id, providerToken: flow.provider_access_token ?? null, providerRefreshToken: flow.provider_refresh_token ?? null }
  }

  private async exchangeCode(provider: ResolvedProvider, code: string): Promise<ProviderTokens> {
    const body = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: this.callbackUrl(),
      grant_type: 'authorization_code',
    })
    const res = await this.fetchImpl(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    })
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string }
    if (!json.access_token) throw new Error('no access_token from provider')
    return { accessToken: json.access_token, refreshToken: json.refresh_token ?? null, idToken: json.id_token ?? null }
  }

  private async fetchProfile(provider: ResolvedProvider, tokens: ProviderTokens): Promise<OAuthProfile> {
    if (provider.idTokenProfile) {
      if (!tokens.idToken) throw new Error('no id_token from provider')
      return verifyIdToken(provider.idTokenProfile, tokens.idToken, { audiences: [provider.clientId], fetchImpl: this.fetchImpl })
    }
    const res = await this.fetchImpl(provider.userInfoUrl!, {
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json', 'user-agent': 'tinbase' },
    })
    if (!res.ok) throw new Error(`userinfo failed: HTTP ${res.status}`)
    const profile = provider.profileMap(await res.json())
    if (!profile.id) throw new Error('provider profile missing id')
    return profile
  }

  /**
   * Sign in from a profile someone else already verified (a native ID token): the same find-or-create and
   * email-linking rules as the OAuth callback (GoTrue createAccountFromExternalIdentity).
   */
  signInWithProfile(provider: string, profile: OAuthProfile): Promise<string> {
    return this.upsertUser(provider, profile)
  }

  /**
   * Link a verified identity to a signed-in user (signInWithIdToken / linkIdentity with link_identity),
   * as GoTrue's linkIdentityToUser.
   *
   * @throws AuthHttpError identity_already_exists when the identity belongs to this or another user.
   */
  async linkIdentity(userId: string, provider: string, profile: OAuthProfile): Promise<string> {
    const existing = await this.db.query<{ user_id: string }>(`select user_id from auth.identities where provider = $1 and provider_id = $2`, [provider, profile.id])
    if (existing.rows[0]) {
      throw new AuthHttpError(422, 'identity_already_exists', existing.rows[0].user_id === userId ? 'Identity is already linked' : 'Identity is already linked to another user')
    }
    await this.db.query(`insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, $2, $3, $4::jsonb)`, [
      userId,
      provider,
      profile.id,
      JSON.stringify(identityDataOf(profile)),
    ])
    await this.updateProviders(userId)
    return userId
  }

  private async upsertUser(provider: string, profile: OAuthProfile): Promise<string> {
    const identityData = identityDataOf(profile)
    // AccountExists: this provider identity has signed in before
    const existing = await this.db.query<{ user_id: string }>(`select user_id from auth.identities where provider = $1 and provider_id = $2`, [provider, profile.id])
    if (existing.rows[0]) {
      const userId = existing.rows[0].user_id
      await this.refuseBanned(userId)
      await this.db.query(`update auth.identities set last_sign_in_at = now(), updated_at = now(), identity_data = $3::jsonb where provider = $1 and provider_id = $2`, [
        provider,
        profile.id,
        JSON.stringify(identityData),
      ])
      await this.afterSignIn(userId, identityData)
      return userId
    }

    // LinkAccount: an existing user with the same email, ONLY when the provider asserts the email is verified -
    // otherwise an attacker could register a provider account with a victim's unverified email and take over
    // their account. Unverified → fall through and create a separate user.
    let userId: string | undefined
    const email = profile.email?.toLowerCase() ?? null
    const verified = !!profile.email && profile.emailVerified === true
    if (email && verified) {
      const byEmail = await this.db.query<{ id: string }>(`select id from auth.users where email = $1`, [email])
      userId = byEmail.rows[0]?.id
      if (userId) await this.refuseBanned(userId)
    }
    if (!userId) {
      // CreateAccount
      if (this.getSettings().disableSignup) throw new AuthHttpError(422, 'signup_disabled', 'Signups not allowed for this instance')
      // Only claim the email on the new user when the provider verified it AND it isn't already owned by
      // another account. An unverified or taken email is left null so it can't collide with (or hijack) an
      // existing user.
      let userEmail: string | null = verified ? email : null
      if (userEmail) {
        const taken = await this.db.query(`select 1 from auth.users where email = $1`, [userEmail])
        if (taken.rows.length > 0) userEmail = null
      }
      const created = await this.db.query<{ id: string }>(
        `insert into auth.users (aud, role, email, email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data)
         values ('authenticated','authenticated',$1, $2, now(),
                 $3::jsonb, $4::jsonb) returning id`,
        [userEmail, userEmail ? new Date().toISOString() : null, JSON.stringify({ provider, providers: [provider] }), JSON.stringify(identityData)]
      )
      userId = created.rows[0].id
    }
    await this.db.query(`insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, $2, $3, $4::jsonb)`, [
      userId,
      provider,
      profile.id,
      JSON.stringify(identityData),
    ])
    await this.afterSignIn(userId, identityData)
    return userId
  }

  /** GoTrue: user.IsBanned() → 403 user_banned. */
  private async refuseBanned(userId: string): Promise<void> {
    const r = await this.db.query<{ banned_until: string | Date | null }>(`select banned_until from auth.users where id = $1`, [userId])
    const until = r.rows[0]?.banned_until
    if (until && new Date(until).getTime() > Date.now()) throw new AuthHttpError(403, 'user_banned', 'User is banned')
  }

  /** GoTrue: UpdateUserMetaData(identityData) + UpdateAppMetaDataProviders, and last_sign_in_at. */
  private async afterSignIn(userId: string, identityData: Record<string, unknown>): Promise<void> {
    const r = await this.db.query<{ raw_user_meta_data: unknown }>(`select raw_user_meta_data from auth.users where id = $1`, [userId])
    const meta = { ...asObject(r.rows[0]?.raw_user_meta_data) }
    for (const [k, v] of Object.entries(identityData)) {
      if (v === null || v === undefined) delete meta[k]
      else meta[k] = v
    }
    await this.db.query(`update auth.users set raw_user_meta_data = $2::jsonb, last_sign_in_at = now(), updated_at = now() where id = $1`, [userId, JSON.stringify(meta)])
    await this.updateProviders(userId)
  }

  /** GoTrue UpdateAppMetaDataProviders: providers = distinct identity providers, oldest first; provider = the first. */
  private async updateProviders(userId: string): Promise<void> {
    const ids = await this.db.query<{ provider: string }>(`select provider from auth.identities where user_id = $1 order by created_at asc`, [userId])
    const providers = [...new Set(ids.rows.map((i) => i.provider))]
    const r = await this.db.query<{ raw_app_meta_data: unknown }>(`select raw_app_meta_data from auth.users where id = $1`, [userId])
    const app = { ...asObject(r.rows[0]?.raw_app_meta_data), providers, ...(providers.length ? { provider: providers[0] } : {}) }
    await this.db.query(`update auth.users set raw_app_meta_data = $2::jsonb where id = $1`, [userId, JSON.stringify(app)])
  }
}

/** identity_data for a profile: GoTrue's claims map when the profile has one, else the legacy shape. */
function identityDataOf(profile: OAuthProfile): Record<string, unknown> {
  return profile.identityData ?? { sub: profile.id, email: profile.email, ...profile.metadata }
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v)
      return o && typeof o === 'object' ? o : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** url.Values.Encode(): keys sorted, form-encoded. */
function sortedQuery(values: Record<string, string>): string {
  const q = new URLSearchParams()
  for (const k of Object.keys(values).sort()) q.set(k, values[k])
  return q.toString()
}

/** The minimal session the callback puts in the redirect fragment for the implicit flow. */
export interface OAuthSession {
  /** signed access token (JWT) */
  access_token: string
  /** opaque refresh token */
  refresh_token: string
  /** access-token lifetime in seconds */
  expires_in: number
  /** when the access token expires, unix seconds */
  expires_at?: number
}

interface FlowRow {
  provider: string
  provider_access_token?: string | null
  provider_refresh_token?: string | null
  redirect_to: string
  code_challenge: string | null
  code_challenge_method: string | null
  auth_code: string | null
  user_id: string | null
  expires_at: string | Date
}

function redirect(location: string): Response {
  // GoTrue redirects with 302 Found (authorize and callback alike)
  return new Response(null, { status: 302, headers: { location } })
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The name in Apple's `user` form field ({"name":{"firstName","lastName"},"email"}), sent on the first consent only. */
function appleUserName(raw: string | null): string | null {
  if (!raw) return null
  try {
    const n = (JSON.parse(raw) as { name?: { firstName?: string; lastName?: string } }).name
    const full = [n?.firstName, n?.lastName].filter(Boolean).join(' ').trim()
    return full || null
  } catch {
    return null
  }
}
