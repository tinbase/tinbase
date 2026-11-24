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
  /** Map the provider's raw userinfo JSON (and, with `emailsUrl`, its email list) to a normalized profile. */
  profileMap?: (raw: any, emails?: any) => OAuthProfile
  /** A second endpoint listing the user's addresses (GitHub's /user/emails). Set by presets. */
  emailsUrl?: string
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

/** One address a provider reported, as GoTrue's provider.Email. */
export interface ProviderEmail {
  email: string
  verified: boolean
  primary: boolean
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
   * Every address the provider reported (GoTrue's UserProvidedData.Emails). Defaults to `email` as the one
   * primary address. Linking and confirmation follow these, not `email`.
   */
  emails?: ProviderEmail[]
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

interface ResolvedProvider extends Required<Omit<OAuthProviderConfig, 'profileMap' | 'idTokenProfile' | 'authorizeParams' | 'userInfoUrl' | 'emailsUrl'>> {
  name: string
  userInfoUrl: string | null
  emailsUrl: string | null
  profileMap: (raw: any, emails?: any) => OAuthProfile
  idTokenProfile: string | null
  authorizeParams: Record<string, string>
}

const PRESETS: Record<string, Partial<OAuthProviderConfig>> = {
  // GoTrue's google provider: the profile is the id_token from the token response (checked against Google's
  // keys and this client id); only when Google sends none, the legacy userinfo/v2 endpoint.
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/userinfo/v2/me',
    scopes: 'email profile',
    idTokenProfile: 'google',
    profileMap: (r) => {
      const verified = r.verified_email === true || r.email_verified === true || r.email_verified === 'true'
      const identityData = {
        ...compact({
          iss: 'https://www.googleapis.com/userinfo/v2/me',
          sub: str(r.id),
          name: str(r.name),
          picture: str(r.picture),
          email: str(r.email),
          avatar_url: str(r.picture),
          full_name: str(r.name),
          provider_id: str(r.id),
        }),
        email_verified: verified,
        phone_verified: false,
      }
      return {
        id: String(r.id ?? ''),
        email: str(r.email),
        emailVerified: verified,
        name: str(r.name),
        emails: r.email ? [{ email: r.email, verified, primary: true }] : [],
        identityData,
      }
    },
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
  // GoTrue's github provider: /user for the profile, /user/emails for the addresses (each with verified and
  // primary), issuer = the API host.
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    emailsUrl: 'https://api.github.com/user/emails',
    scopes: 'user:email',
    profileMap: (r, emails) => {
      const id = r.id === undefined || r.id === null ? '' : String(r.id)
      const list: ProviderEmail[] = (Array.isArray(emails) ? emails : [])
        .filter((e: any) => e && typeof e.email === 'string' && e.email)
        .map((e: any) => ({ email: e.email, verified: e.verified === true, primary: e.primary === true }))
      const identityData = compact({
        iss: 'https://api.github.com',
        sub: id,
        name: str(r.name),
        preferred_username: str(r.login),
        avatar_url: str(r.avatar_url),
        full_name: str(r.name),
        provider_id: id,
        user_name: str(r.login),
      })
      return { id, email: list.find((e) => e.primary)?.email, name: str(r.name) ?? str(r.login), emails: list, identityData }
    },
  },
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
/** structs.Map with omitempty: unset fields are left out */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))
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
    emailsUrl: cfg.emailsUrl ?? (cfg.userInfoUrl ? null : (preset.emailsUrl ?? null)),
    scopes: cfg.scopes ?? preset.scopes ?? '',
    profileMap: cfg.profileMap ?? preset.profileMap ?? ((r) => ({ id: String(r.id ?? r.sub), email: r.email, name: r.name })),
    idTokenProfile,
    authorizeParams: { ...preset.authorizeParams, ...cfg.authorizeParams },
  }
}

/**
 * What the sign-in logic needs from the auth server around it: its live settings, its mailer and its audit
 * trail. Defaults keep the service usable on its own (tests): signups on, autoconfirm on, nothing mailed.
 */
export interface OAuthHooks {
  /** Read on every sign-in: these can change at runtime. */
  settings: () => { disableSignup: boolean; autoconfirm: boolean }
  /** GOTRUE_MAILER_ALLOW_UNVERIFIED_EMAIL_SIGN_INS */
  allowUnverifiedEmailSignIns: boolean
  /** Providers with [auth.external.<p>] email_optional = true */
  emailOptional: string[]
  /** GoTrue's max_frequency check for a confirmation mail to `email`: the 429 to refuse with, or null. */
  confirmationTooSoon: (email: string) => Promise<AuthHttpError | null>
  /** GoTrue's sendConfirmation (implicit flow): mail `email` its confirmation link. */
  sendConfirmation: (email: string, redirectTo: string | null) => Promise<void>
  /** GoTrue's NewAuditLogEntry. */
  audit: (action: string, actor: { id: string; email: string | null }, traits: Record<string, unknown>, logType: string) => Promise<void>
}

const DEFAULT_HOOKS: OAuthHooks = {
  settings: () => ({ disableSignup: false, autoconfirm: true }),
  allowUnverifiedEmailSignIns: false,
  emailOptional: [],
  confirmationTooSoon: async () => null,
  sendConfirmation: async () => {},
  audit: async () => {},
}

/** The columns of auth.users the linking rules read. */
interface LinkUser {
  id: string
  email: string | null
  email_confirmed_at: string | Date | null
  banned_until: string | Date | null
  is_anonymous: boolean | null
}

type LinkingDecision =
  | { kind: 'exists'; user: LinkUser; identityId: string }
  | { kind: 'link'; user: LinkUser }
  | { kind: 'create' }
  | { kind: 'multiple' }

/** Drives the OAuth authorize/callback/PKCE flows against the configured providers. */
export class OAuthService {
  private providers = new Map<string, ResolvedProvider>()
  private hooks: OAuthHooks

  constructor(
    private db: Database,
    private siteUrl: string,
    /** Where this server answers; the provider redirects back here, not to the app. */
    private apiExternalUrl: string,
    configs: Record<string, OAuthProviderConfig>,
    private fetchImpl: typeof fetch = fetch,
    private uriAllowList: string[] = [],
    private enforceRedirectAllowList = false,
    hooks: Partial<OAuthHooks> = {}
  ) {
    this.hooks = { ...DEFAULT_HOOKS, ...hooks }
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
    return redirect(await this.authorizeUrl(url, null))
  }

  /**
   * GoTrue's GetExternalProviderRedirectURL: store the flow (with the user being linked, for
   * GET /user/identities/authorize) and build the provider's authorize URL. Every query parameter but
   * provider, scopes and the ones this server controls is passed on to the provider, as GoTrue does.
   */
  async authorizeUrl(url: URL, linkingTargetId: string | null): Promise<string> {
    const providerName = url.searchParams.get('provider') ?? ''
    const provider = this.providers.get(providerName)
    if (!provider) throw new AuthHttpError(400, 'validation_failed', `Unsupported provider: Provider ${providerName} could not be found`)
    const providerState = randomToken(16)
    const scopes = url.searchParams.get('scopes') || provider.scopes
    // Validate the redirect target up front so the callback can trust the stored
    // value - an unallowed target falls back to the site URL.
    const redirectTo = resolveRedirect(url.searchParams.get('redirect_to'), this.siteUrl, this.uriAllowList, this.enforceRedirectAllowList)
    await this.db.query(
      `insert into auth.flow_state (provider, provider_state, redirect_to, code_challenge, code_challenge_method, linking_target_id, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
      [
        providerName,
        providerState,
        redirectTo,
        url.searchParams.get('code_challenge'),
        url.searchParams.get('code_challenge_method'),
        linkingTargetId,
      ]
    )
    const p = new URLSearchParams()
    for (const [k, v] of url.searchParams) {
      const lower = k.toLowerCase()
      if (k === 'provider' || k === 'scopes' || (lower !== 'nonce' && RESERVED_OAUTH_PARAMS.includes(lower))) continue
      p.set(k, v)
    }
    for (const [k, v] of Object.entries({
      client_id: provider.clientId,
      redirect_uri: this.callbackUrl(),
      response_type: 'code',
      scope: scopes,
      state: providerState,
      ...provider.authorizeParams,
    })) p.set(k, v)
    return `${provider.authorizeUrl}?${p}`
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
    if (flow.linking_target_id) {
      const t = await this.db.query(`select id from auth.users where id = $1`, [flow.linking_target_id])
      if (!t.rows[0]) return this.errorRedirect(target, new AuthHttpError(422, 'user_not_found', 'Linking target user not found'))
    }

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
    if (emailsOf(profile).length === 0 && !this.hooks.emailOptional.includes(provider.name)) {
      return this.errorRedirect(target, new AuthHttpError(500, 'unexpected_failure', 'Error getting user email from external provider'))
    }

    let userId: string
    try {
      userId = flow.linking_target_id
        ? await this.linkIdentity(flow.linking_target_id, provider.name, profile, flow.redirect_to)
        : await this.signIn(provider.name, profile, flow.redirect_to)
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
    // GoTrue's ParseIDToken on the web: signature, issuer, expiry, this client id and at_hash; no nonce
    if (provider.idTokenProfile && (tokens.idToken || !provider.userInfoUrl)) {
      if (!tokens.idToken) throw new Error('no id_token from provider')
      return verifyIdToken(provider.idTokenProfile, tokens.idToken, {
        audiences: [provider.clientId],
        accessToken: tokens.accessToken,
        skipNonceCheck: true,
        fetchImpl: this.fetchImpl,
      })
    }
    const get = async (u: string) => {
      const res = await this.fetchImpl(u, {
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json', 'user-agent': 'tinbase' },
      })
      if (!res.ok) throw new Error(`userinfo failed: HTTP ${res.status}`)
      return res.json()
    }
    const raw = await get(provider.userInfoUrl!)
    const emails = provider.emailsUrl ? await get(provider.emailsUrl) : undefined
    const profile = provider.profileMap(raw, emails)
    if (!profile.id) throw new Error('provider profile missing id')
    return profile
  }

  /**
   * Sign in from a profile someone else already verified (a native ID token): the same find-or-create and
   * email-linking rules as the OAuth callback (GoTrue createAccountFromExternalIdentity).
   */
  signInWithProfile(provider: string, profile: OAuthProfile): Promise<string> {
    return this.signIn(provider, profile, null)
  }

  /**
   * GoTrue's DetermineAccountLinking, in the default linking domain (tinbase has no SSO or custom domains):
   * - the identity has signed in before → exists;
   * - none of the provider's addresses is verified (and autoconfirm is off) → create a new user, without the
   *   address when another user already has it;
   * - otherwise the one user who has a verified address (as an identity's or as the user's email) → link;
   *   nobody → create; more than one → multiple.
   */
  private async determineAccountLinking(provider: string, sub: string, emails: ProviderEmail[]): Promise<{ decision: LinkingDecision; candidate: ProviderEmail }> {
    const autoconfirm = this.hooks.settings().autoconfirm
    const verifiedEmails: string[] = []
    let candidate: ProviderEmail = { email: '', verified: false, primary: false }
    for (const e of emails) {
      if (e.verified || autoconfirm) verifiedEmails.push(e.email.toLowerCase())
      if (e.primary) candidate = { ...e, email: e.email.toLowerCase() }
    }

    const ident = await this.db.query<{ id: string; user_id: string }>(`select id, user_id from auth.identities where provider = $1 and provider_id = $2`, [provider, sub])
    if (ident.rows[0]) {
      const user = await this.findUser(ident.rows[0].user_id)
      if (!user) throw new AuthHttpError(500, 'unexpected_failure', 'Database error finding user')
      // the existing user's email stands in for the provider's: the user could have none
      return { decision: { kind: 'exists', user, identityId: ident.rows[0].id }, candidate: { ...candidate, email: user.email ?? '' } }
    }

    if (verifiedEmails.length === 0) {
      if (candidate.email && (await this.isDuplicatedEmail(candidate.email))) candidate = { ...candidate, email: '' }
      return { decision: { kind: 'create' }, candidate }
    }

    const list = verifiedEmails.map((_, i) => `$${i + 1}`).join(', ')
    const similarIdentities = await this.db.query<{ user_id: string }>(`select user_id from auth.identities where lower(identity_data->>'email') in (${list})`, verifiedEmails)
    const similarUsers = await this.db.query<{ id: string }>(`select id from auth.users where email in (${list})`, verifiedEmails)
    if (similarIdentities.rows.length === 0) {
      if (similarUsers.rows.length === 1) {
        const user = await this.findUser(similarUsers.rows[0].id)
        if (user) return { decision: { kind: 'link', user }, candidate }
      }
      if (similarUsers.rows.length > 1) return { decision: { kind: 'multiple' }, candidate }
      return { decision: { kind: 'create' }, candidate }
    }
    const userIds = new Set(similarIdentities.rows.map((r) => r.user_id))
    if (userIds.size > 1) return { decision: { kind: 'multiple' }, candidate }
    const user = await this.findUser([...userIds][0])
    if (!user) throw new AuthHttpError(500, 'unexpected_failure', 'Database error finding user')
    return { decision: { kind: 'link', user }, candidate }
  }

  /** GoTrue IsDuplicatedEmail: another user already has this address, on an identity or as its email. */
  private async isDuplicatedEmail(email: string): Promise<boolean> {
    const byIdentity = await this.db.query(`select 1 from auth.identities where lower(identity_data->>'email') = $1`, [email])
    if (byIdentity.rows.length > 0) return true
    const byUser = await this.db.query(`select 1 from auth.users where email = $1`, [email])
    return byUser.rows.length > 0
  }

  private async findUser(id: string): Promise<LinkUser | null> {
    const r = await this.db.query<LinkUser>(`select id, email, email_confirmed_at, banned_until, is_anonymous from auth.users where id = $1`, [id])
    return r.rows[0] ?? null
  }

  /**
   * GoTrue's createAccountFromExternalIdentity. tinbase has no transaction around it, so every refusal GoTrue
   * would roll back (multiple accounts, signups off, a ban, the mail budget) is decided before the first
   * write; the one GoTrue commits (an unverified address: the user and the confirmation mail stay) after.
   */
  private async signIn(provider: string, rawProfile: OAuthProfile, redirectTo: string | null): Promise<string> {
    const { profile, emails } = withPrimaryEmail(rawProfile)
    const identityData = identityDataOf(profile)
    const settings = this.hooks.settings()
    const { decision, candidate } = await this.determineAccountLinking(provider, profile.id, emails)

    if (decision.kind === 'multiple') {
      throw new AuthHttpError(500, 'unexpected_failure', 'Multiple accounts with the same email address in the same linking domain detected: default')
    }
    if (decision.kind === 'create' && settings.disableSignup) throw new AuthHttpError(422, 'signup_disabled', 'Signups not allowed for this instance')
    const existing = decision.kind === 'create' ? null : decision.user
    if (existing && isBanned(existing)) throw new AuthHttpError(403, 'user_banned', 'User is banned')

    const hasEmails = !this.hooks.emailOptional.includes(provider) || candidate.email !== ''
    const unconfirmed = hasEmails && !existing?.email_confirmed_at
    const confirmNow = unconfirmed && (candidate.verified || settings.autoconfirm)
    const mail = unconfirmed && !confirmNow && candidate.email !== ''
    if (mail) {
      const tooSoon = await this.hooks.confirmationTooSoon(candidate.email)
      if (tooSoon) throw tooSoon
    }

    let userId: string
    let identityId: string
    if (decision.kind === 'link') {
      userId = decision.user.id
      identityId = await this.insertIdentity(userId, provider, profile.id, identityData)
      await this.mergeUserMetaData(userId, identityData)
      await this.updateProviders(userId)
      await this.hooks.audit('identity_linked', { id: userId, email: decision.user.email }, { identity_id: identityId, provider, provider_id: profile.id }, 'user')
    } else if (decision.kind === 'create') {
      let created
      try {
        created = await this.db.query<{ id: string }>(
          `insert into auth.users (aud, role, email, raw_app_meta_data, raw_user_meta_data)
           values ('authenticated', 'authenticated', $1, $2::jsonb, $3::jsonb) returning id`,
          [candidate.email || null, JSON.stringify({ provider, providers: [provider] }), JSON.stringify(identityData)]
        )
      } catch {
        throw new AuthHttpError(500, 'unexpected_failure', 'Database error saving new user')
      }
      userId = created.rows[0].id
      identityId = await this.insertIdentity(userId, provider, profile.id, identityData)
    } else {
      userId = decision.user.id
      identityId = decision.identityId
      await this.db.query(`update auth.identities set identity_data = $2::jsonb, last_sign_in_at = now(), updated_at = now() where id = $1`, [
        identityId,
        JSON.stringify(identityData),
      ])
      await this.mergeUserMetaData(userId, identityData)
      await this.updateProviders(userId)
    }
    const actor = { id: userId, email: candidate.email || existing?.email || null }

    if (unconfirmed) {
      await this.removeUnconfirmedIdentities(userId, provider, identityId, identityData)
      if (confirmNow) {
        await this.hooks.audit('user_signedup', actor, { provider }, 'team')
        await this.confirm(userId)
      } else {
        if (mail) await this.hooks.sendConfirmation(candidate.email, redirectTo)
        if (!this.hooks.allowUnverifiedEmailSignIns) {
          throw new AuthHttpError(
            422,
            'provider_email_needs_verification',
            mail
              ? `Unverified email with ${provider}. A confirmation email has been sent to your ${provider} email`
              : `Unverified email with ${provider}. Verify the email with ${provider} in order to sign in`
          )
        }
      }
    } else {
      await this.hooks.audit('login', actor, { provider }, 'account')
    }
    await this.db.query(`update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1`, [userId])
    return userId
  }

  /**
   * Link a verified identity to a signed-in user (signInWithIdToken with link_identity, or linkIdentity's
   * OAuth round trip), as GoTrue's linkIdentityToUser: a user without an email takes one from its
   * identities, and must confirm it when the provider didn't verify it.
   *
   * @throws AuthHttpError identity_already_exists when the identity belongs to this or another user.
   */
  async linkIdentity(userId: string, provider: string, rawProfile: OAuthProfile, redirectTo: string | null = null): Promise<string> {
    const { profile } = withPrimaryEmail(rawProfile)
    const identityData = identityDataOf(profile)
    const existing = await this.db.query<{ user_id: string }>(`select user_id from auth.identities where provider = $1 and provider_id = $2`, [provider, profile.id])
    if (existing.rows[0]) {
      throw new AuthHttpError(422, 'identity_already_exists', existing.rows[0].user_id === userId ? 'Identity is already linked' : 'Identity is already linked to another user')
    }
    const user = await this.findUser(userId)
    if (!user) throw new AuthHttpError(422, 'user_not_found', 'User not found')
    const metadataVerified = identityData.email_verified === true

    // Decide the email a user without one takes, and whether it needs mailing, before writing anything
    let promote: { email: string; verified: boolean } | null = null
    if (!user.email) {
      const pick = await this.pickEmailFromIdentities(user, { email: str(identityData.email)?.toLowerCase() ?? '', verified: metadataVerified })
      if (pick === 'conflict') throw new AuthHttpError(400, 'email_exists', 'A user with this email address has already been registered')
      promote = pick
      if (!metadataVerified) {
        const to = pick?.email ?? ''
        if (!to) throw new AuthHttpError(500, 'unexpected_failure', 'Error sending confirmation email')
        const tooSoon = await this.hooks.confirmationTooSoon(to)
        if (tooSoon) throw tooSoon
      }
    }

    const identityId = await this.insertIdentity(userId, provider, profile.id, identityData)
    await this.hooks.audit('identity_linked', { id: userId, email: user.email }, { identity_id: identityId, provider, provider_id: profile.id }, 'user')

    if (!user.email) {
      if (promote) {
        try {
          await this.setEmailFromIdentity(userId, promote)
        } catch {
          throw new AuthHttpError(400, 'email_exists', 'A user with this email address has already been registered')
        }
      }
      if (!metadataVerified) {
        await this.hooks.sendConfirmation(promote!.email, redirectTo)
        throw new AuthHttpError(422, 'email_not_confirmed', `Unverified email with ${provider}. A confirmation email has been sent to your ${provider} email`)
      }
      await this.confirm(userId)
      if (user.is_anonymous) await this.db.query(`update auth.users set is_anonymous = false where id = $1`, [userId])
    }
    await this.updateProviders(userId)
    await this.db.query(`update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1`, [userId])
    return userId
  }

  /**
   * DELETE /user/identities/{id} (unlinkIdentity), as GoTrue's DeleteIdentity: never the last identity; a
   * phone identity takes the phone with it, any other may move the user's email to another identity's.
   */
  async unlinkIdentity(userId: string, identityId: string): Promise<void> {
    const ids = await this.db.query<{ id: string; provider: string; provider_id: string }>(`select id, provider, provider_id from auth.identities where user_id = $1`, [userId])
    if (ids.rows.length <= 1) throw new AuthHttpError(422, 'single_identity_not_deletable', 'User must have at least 1 identity after unlinking')
    const doomed = ids.rows.find((i) => i.id === identityId)
    if (!doomed) throw new AuthHttpError(422, 'identity_not_found', "Identity doesn't exist")
    const user = await this.findUser(userId)
    if (!user) throw new AuthHttpError(422, 'user_not_found', 'User not found')

    let promote: { email: string; verified: boolean } | null = null
    if (doomed.provider !== 'phone') {
      const pick = await this.pickEmailFromIdentities(user, null, identityId)
      if (pick === 'conflict') throw new AuthHttpError(422, 'email_conflict_identity_not_deletable', 'Unable to unlink identity due to email conflict')
      promote = pick
    }
    await this.hooks.audit('identity_unlinked', { id: userId, email: user.email }, { identity_id: doomed.id, provider: doomed.provider, provider_id: doomed.provider_id }, 'user')
    await this.db.query(`delete from auth.identities where id = $1`, [identityId])
    if (doomed.provider === 'phone') {
      await this.db.query(`update auth.users set phone = null, phone_confirmed_at = null where id = $1`, [userId])
    } else if (promote) {
      try {
        await this.setEmailFromIdentity(userId, promote)
      } catch {
        throw new AuthHttpError(422, 'email_conflict_identity_not_deletable', 'Unable to unlink identity due to email conflict')
      }
    }
    await this.updateProviders(userId)
  }

  /**
   * The choice in GoTrue's UpdateUserEmailFromIdentities: null when an identity already uses the user's
   * email (keep it); otherwise the best identity's address no other user has (verified first, then
   * unverified, then none; oldest first); 'conflict' when every address is taken. `extra` is an identity
   * about to be added, `without` one about to be removed.
   */
  private async pickEmailFromIdentities(
    user: LinkUser,
    extra: { email: string; verified: boolean } | null,
    without?: string
  ): Promise<{ email: string; verified: boolean } | null | 'conflict'> {
    const r = await this.db.query<{ id: string; identity_data: unknown; created_at: string | Date }>(
      `select id, identity_data, created_at from auth.identities where user_id = $1`,
      [user.id]
    )
    const ids = r.rows
      .filter((i) => i.id !== without)
      .map((i) => {
        const d = asObject(i.identity_data)
        return { id: i.id, email: (str(d.email) ?? '').toLowerCase(), verified: d.email_verified === true, at: new Date(i.created_at).getTime() }
      })
    if (extra) ids.push({ id: '~', email: extra.email, verified: extra.verified, at: Date.now() })
    const current = (user.email ?? '').toLowerCase()
    if (ids.some((i) => i.email === current)) return null
    const rank = (i: { email: string; verified: boolean }) => (i.email === '' ? 2 : i.verified ? 0 : 1)
    ids.sort((a, b) => rank(a) - rank(b) || a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const i of ids) {
      if (!i.email) return { email: '', verified: false }
      const taken = await this.db.query(`select 1 from auth.users where email = $1 and id <> $2`, [i.email, user.id])
      if (taken.rows.length === 0) return { email: i.email, verified: i.verified }
    }
    return 'conflict'
  }

  /** The rest of UpdateUserEmailFromIdentities: set it, drop pending tokens, unconfirm what isn't verified. */
  private async setEmailFromIdentity(userId: string, pick: { email: string; verified: boolean }): Promise<void> {
    await this.db.query(
      `update auth.users set email = $2, confirmation_sent_at = null, recovery_sent_at = null, email_change = '',
         email_change_token_new = '', email_change_token_current = '', email_change_sent_at = null, email_change_confirm_status = 0,
         phone_change = '', phone_change_token = '', phone_change_sent_at = null, reauthentication_sent_at = null
       where id = $1`,
      [userId, pick.email || null]
    )
    await this.db.query(`delete from auth.one_time_tokens where user_id = $1`, [userId])
    if (!pick.email || (!pick.verified && !this.hooks.settings().autoconfirm)) {
      await this.db.query(`update auth.users set email_confirmed_at = null where id = $1`, [userId])
      await this.mergeUserMetaData(userId, { email_verified: false })
    }
  }

  private async insertIdentity(userId: string, provider: string, providerId: string, identityData: Record<string, unknown>): Promise<string> {
    const r = await this.db.query<{ id: string }>(
      `insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, $2, $3, $4::jsonb) returning id`,
      [userId, provider, providerId, JSON.stringify(identityData)]
    )
    return r.rows[0].id
  }

  /**
   * GoTrue RemoveUnconfirmedIdentities: an unconfirmed user signing in with a provider keeps only that
   * identity (and its metadata, and no password unless it is the email/phone identity), so whoever
   * registered the address first can't keep a way in.
   */
  private async removeUnconfirmedIdentities(userId: string, provider: string, identityId: string, identityData: Record<string, unknown>): Promise<void> {
    if (provider !== 'email' && provider !== 'phone') await this.db.query(`update auth.users set encrypted_password = null where id = $1`, [userId])
    const meta = Object.fromEntries(Object.entries(identityData).filter(([, v]) => v !== null && v !== undefined))
    await this.db.query(`update auth.users set raw_user_meta_data = $2::jsonb where id = $1`, [userId, JSON.stringify(meta)])
    await this.db.query(`delete from auth.identities where user_id = $1 and id <> $2`, [userId, identityId])
    await this.updateProviders(userId)
  }

  /** GoTrue user.Confirm: confirmed now, email_verified in the metadata, outstanding one-time tokens gone. */
  private async confirm(userId: string): Promise<void> {
    await this.db.query(`update auth.users set email_confirmed_at = now() where id = $1`, [userId])
    await this.mergeUserMetaData(userId, { email_verified: true })
    await this.db.query(`delete from auth.one_time_tokens where user_id = $1`, [userId])
  }

  /** GoTrue UpdateUserMetaData: each key set, a null deletes it. */
  private async mergeUserMetaData(userId: string, data: Record<string, unknown>): Promise<void> {
    const r = await this.db.query<{ raw_user_meta_data: unknown }>(`select raw_user_meta_data from auth.users where id = $1`, [userId])
    const meta = { ...asObject(r.rows[0]?.raw_user_meta_data) }
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) delete meta[k]
      else meta[k] = v
    }
    await this.db.query(`update auth.users set raw_user_meta_data = $2::jsonb, updated_at = now() where id = $1`, [userId, JSON.stringify(meta)])
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

/** OAuth/OIDC parameters this server sets on the provider's authorize URL; a client can't pass its own. */
const RESERVED_OAUTH_PARAMS = ['client_id', 'client_secret', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method', 'code_verifier', 'nonce']

function isBanned(u: LinkUser): boolean {
  return !!u.banned_until && new Date(u.banned_until).getTime() > Date.now()
}

/** The provider's addresses: `emails`, or `email` as the one primary address. */
function emailsOf(profile: OAuthProfile): ProviderEmail[] {
  if (profile.emails) return profile.emails
  return profile.email ? [{ email: profile.email, verified: profile.emailVerified === true, primary: true }] : []
}

/**
 * GoTrue's loop before signing in: the identity's email and email_verified come from the primary address
 * (or the last one when none is primary), and email_verified is false when there is none.
 */
function withPrimaryEmail(profile: OAuthProfile): { profile: OAuthProfile; emails: ProviderEmail[] } {
  const emails = emailsOf(profile)
  let email = ''
  let verified = false
  for (const e of emails) {
    email = e.email
    verified = e.verified
    if (e.primary) break
  }
  const data = { ...identityDataOf(profile) }
  if (email) data.email = email
  else delete data.email
  data.email_verified = verified
  // structs.Map: email_verified and phone_verified carry no omitempty, so every identity has both
  if (data.phone_verified === undefined) data.phone_verified = false
  return { profile: { ...profile, identityData: data }, emails }
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
  linking_target_id?: string | null
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
