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
    private enforceRedirectAllowList = false
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
   * GET or POST /callback - exchange code, upsert user+identity, redirect back. `params` is the query string,
   * or the form body when the provider POSTs (Apple's form_post).
   */
  async callback(params: URLSearchParams, createSession: (userId: string) => Promise<OAuthSession>): Promise<Response> {
    const code = params.get('code')
    const state = params.get('state')
    const providerError = params.get('error')
    if (providerError && state) {
      // the user cancelled at the provider (Apple: user_cancelled_authorize): back to the app with the error
      const res = await this.db.query<FlowRow>(`delete from auth.flow_state where provider_state = $1 returning *`, [state])
      const target = res.rows[0]?.redirect_to ?? this.siteUrl
      return redirect(`${target}#error=${encodeURIComponent(providerError)}&error_description=${encodeURIComponent(params.get('error_description') ?? providerError)}`)
    }
    if (!code || !state) return redirect(`${this.siteUrl}#error=invalid_request`)

    const res = await this.db.query<FlowRow>(
      `delete from auth.flow_state where provider_state = $1 and expires_at > now() returning *`,
      [state]
    )
    const flow = res.rows[0]
    if (!flow) return redirect(`${this.siteUrl}#error=invalid_state`)
    const provider = this.providers.get(flow.provider)
    if (!provider) return redirect(`${flow.redirect_to}#error=provider_not_enabled`)

    let profile: OAuthProfile
    let tokens: ProviderTokens
    try {
      tokens = await this.exchangeCode(provider, code)
      profile = await this.fetchProfile(provider, tokens)
      // Apple sends the name once, on the first consent, as a `user` JSON field beside the code
      const name = appleUserName(params.get('user'))
      if (name && !profile.name) profile = { ...profile, name, metadata: { ...profile.metadata, full_name: name, name } }
    } catch (e) {
      const msg = encodeURIComponent(e instanceof Error ? e.message : 'oauth_error')
      return redirect(`${flow.redirect_to}#error=server_error&error_description=${msg}`)
    }

    const userId = await this.upsertUser(provider.name, profile)

    // PKCE: hand back an auth code the client exchanges for a session.
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

    // implicit: tokens in the URL fragment
    const session = await createSession(userId)
    const hash =
      `#access_token=${session.access_token}&refresh_token=${session.refresh_token}&expires_in=${session.expires_in}&token_type=bearer` +
      `&provider_token=${encodeURIComponent(tokens.accessToken)}&provider_refresh_token=${encodeURIComponent(tokens.refreshToken ?? '')}`
    return redirect(`${flow.redirect_to}${hash}`)
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
   * Sign in from a profile someone else already verified (a native ID token):
   * the same find-or-create and email-linking rules as the OAuth callback.
   */
  signInWithProfile(provider: string, profile: OAuthProfile): Promise<string> {
    return this.upsertUser(provider, profile)
  }

  private async upsertUser(provider: string, profile: OAuthProfile): Promise<string> {
    // existing identity?
    const existing = await this.db.query<{ user_id: string }>(
      `select user_id from auth.identities where provider = $1 and provider_id = $2`,
      [provider, profile.id]
    )
    if (existing.rows[0]) {
      await this.db.query(`update auth.identities set last_sign_in_at = now(), identity_data = $3 where provider = $1 and provider_id = $2`, [
        provider,
        profile.id,
        JSON.stringify({ sub: profile.id, email: profile.email, ...profile.metadata }),
      ])
      await this.db.query(`update auth.users set last_sign_in_at = now() where id = $1`, [existing.rows[0].user_id])
      return existing.rows[0].user_id
    }

    // Link to an existing user with the same email ONLY when the provider
    // asserts the email is verified - otherwise an attacker could register a
    // provider account with a victim's unverified email and take over their
    // account. Unverified → fall through and create a separate user.
    let userId: string | undefined
    const email = profile.email?.toLowerCase() ?? null
    const verified = !!profile.email && profile.emailVerified === true
    if (email && verified) {
      const byEmail = await this.db.query<{ id: string }>(`select id from auth.users where email = $1`, [email])
      userId = byEmail.rows[0]?.id
    }
    if (!userId) {
      // Only claim the email on the new user when the provider verified it AND
      // it isn't already owned by another account. An unverified or taken email
      // is left null so it can't collide with (or hijack) an existing user.
      let userEmail: string | null = verified ? email : null
      if (userEmail) {
        const taken = await this.db.query(`select 1 from auth.users where email = $1`, [userEmail])
        if (taken.rows.length > 0) userEmail = null
      }
      const created = await this.db.query<{ id: string }>(
        `insert into auth.users (aud, role, email, email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data)
         values ('authenticated','authenticated',$1, $2, now(),
                 $3::jsonb, $4::jsonb) returning id`,
        [
          userEmail,
          userEmail ? new Date().toISOString() : null,
          JSON.stringify({ provider, providers: [provider] }),
          JSON.stringify({ sub: profile.id, email: profile.email, full_name: profile.name, ...profile.metadata }),
        ]
      )
      userId = created.rows[0].id
    }
    await this.db.query(
      `insert into auth.identities (user_id, provider, provider_id, identity_data)
       values ($1, $2, $3, $4::jsonb)`,
      [userId, provider, profile.id, JSON.stringify({ sub: profile.id, email: profile.email, ...profile.metadata })]
    )
    return userId!
  }
}

/** The minimal session the callback puts in the redirect fragment for the implicit flow. */
export interface OAuthSession {
  /** signed access token (JWT) */
  access_token: string
  /** opaque refresh token */
  refresh_token: string
  /** access-token lifetime in seconds */
  expires_in: number
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
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } })
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
