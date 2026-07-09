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

import type { Database } from "../db/database.js";
import { randomToken } from "../jwt.js";

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  /** Overrides; filled from a preset for known providers (google, github). */
  authorizeUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes?: string;
  /** Map the provider's raw userinfo JSON to a normalized profile. */
  profileMap?: (raw: any) => OAuthProfile;
}

export interface OAuthProfile {
  id: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  metadata?: Record<string, unknown>;
}

interface ResolvedProvider extends Required<
  Omit<OAuthProviderConfig, "profileMap">
> {
  name: string;
  profileMap: (raw: any) => OAuthProfile;
}

const PRESETS: Record<string, Partial<OAuthProviderConfig>> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: "openid email profile",
    profileMap: (r) => ({
      id: r.sub,
      email: r.email,
      emailVerified: r.email_verified === true,
      name: r.name,
      metadata: { avatar_url: r.picture, full_name: r.name },
    }),
  },
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: "read:user user:email",
    profileMap: (r) => ({
      id: String(r.id),
      email: r.email,
      name: r.name ?? r.login,
      metadata: { avatar_url: r.avatar_url, user_name: r.login },
    }),
  },
};

export function resolveProvider(
  name: string,
  cfg: OAuthProviderConfig,
): ResolvedProvider {
  const preset = PRESETS[name] ?? {};
  const authorizeUrl = cfg.authorizeUrl ?? preset.authorizeUrl;
  const tokenUrl = cfg.tokenUrl ?? preset.tokenUrl;
  const userInfoUrl = cfg.userInfoUrl ?? preset.userInfoUrl;
  if (!authorizeUrl || !tokenUrl || !userInfoUrl) {
    throw new Error(
      `OAuth provider "${name}" needs authorizeUrl/tokenUrl/userInfoUrl (no preset available)`,
    );
  }
  return {
    name,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authorizeUrl,
    tokenUrl,
    userInfoUrl,
    scopes: cfg.scopes ?? preset.scopes ?? "",
    profileMap:
      cfg.profileMap ??
      preset.profileMap ??
      ((r) => ({ id: String(r.id ?? r.sub), email: r.email, name: r.name })),
  };
}

export class OAuthService {
  private providers = new Map<string, ResolvedProvider>();

  constructor(
    private db: Database,
    private siteUrl: string,
    configs: Record<string, OAuthProviderConfig>,
    private fetchImpl: typeof fetch = fetch,
  ) {
    for (const [name, cfg] of Object.entries(configs)) {
      this.providers.set(name, resolveProvider(name, cfg));
    }
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  private callbackUrl(): string {
    return `${this.siteUrl}/auth/v1/callback`;
  }

  /** GET /authorize — persist state, redirect to the provider. */
  async authorize(url: URL): Promise<Response> {
    const providerName = url.searchParams.get("provider") ?? "";
    const provider = this.providers.get(providerName);
    if (!provider) {
      return redirect(
        `${this.siteUrl}#error=provider_not_enabled&error_description=${encodeURIComponent(`provider ${providerName} is not configured`)}`,
      );
    }
    const providerState = randomToken(16);
    const scopes = url.searchParams.get("scopes") || provider.scopes;
    await this.db.query(
      `insert into auth.flow_state (provider, provider_state, redirect_to, code_challenge, code_challenge_method, expires_at)
       values ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [
        providerName,
        providerState,
        url.searchParams.get("redirect_to") ?? this.siteUrl,
        url.searchParams.get("code_challenge"),
        url.searchParams.get("code_challenge_method"),
      ],
    );
    const p = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: this.callbackUrl(),
      response_type: "code",
      scope: scopes,
      state: providerState,
    });
    return redirect(`${provider.authorizeUrl}?${p}`);
  }

  /** GET /callback — exchange code, upsert user+identity, redirect back. */
  async callback(
    url: URL,
    createSession: (userId: string) => Promise<OAuthSession>,
  ): Promise<Response> {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state)
      return redirect(`${this.siteUrl}#error=invalid_request`);

    const res = await this.db.query<FlowRow>(
      `delete from auth.flow_state where provider_state = $1 and expires_at > now() returning *`,
      [state],
    );
    const flow = res.rows[0];
    if (!flow) return redirect(`${this.siteUrl}#error=invalid_state`);
    const provider = this.providers.get(flow.provider);
    if (!provider)
      return redirect(`${flow.redirect_to}#error=provider_not_enabled`);

    let profile: OAuthProfile;
    try {
      const token = await this.exchangeCode(provider, code);
      profile = await this.fetchProfile(provider, token);
    } catch (e) {
      const msg = encodeURIComponent(
        e instanceof Error ? e.message : "oauth_error",
      );
      return redirect(
        `${flow.redirect_to}#error=server_error&error_description=${msg}`,
      );
    }

    const userId = await this.upsertUser(provider.name, profile);

    // PKCE: hand back an auth code the client exchanges for a session.
    if (flow.code_challenge) {
      const authCode = randomToken(24);
      await this.db.query(
        `insert into auth.flow_state (provider, provider_state, redirect_to, code_challenge, code_challenge_method, auth_code, user_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')`,
        [
          flow.provider,
          randomToken(16),
          flow.redirect_to,
          flow.code_challenge,
          flow.code_challenge_method,
          authCode,
          userId,
        ],
      );
      return redirect(`${flow.redirect_to}?code=${authCode}`);
    }

    // implicit: tokens in the URL fragment
    const session = await createSession(userId);
    const hash = `#access_token=${session.access_token}&refresh_token=${session.refresh_token}&expires_in=${session.expires_in}&token_type=bearer&provider_token=`;
    return redirect(`${flow.redirect_to}${hash}`);
  }

  /** POST /token?grant_type=pkce — exchange an auth code + verifier for a session. */
  async exchangePkce(
    authCode: string,
    verifier: string,
  ): Promise<string | null> {
    const res = await this.db.query<FlowRow>(
      `delete from auth.flow_state where auth_code = $1 and expires_at > now() returning *`,
      [authCode],
    );
    const flow = res.rows[0];
    if (!flow || !flow.user_id) return null;
    if (
      flow.code_challenge_method === "s256" ||
      flow.code_challenge_method === "S256"
    ) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
      );
      const challenge = base64url(new Uint8Array(digest));
      if (challenge !== flow.code_challenge) return null;
    } else if (flow.code_challenge && flow.code_challenge !== verifier) {
      return null; // plain method
    }
    return flow.user_id;
  }

  private async exchangeCode(
    provider: ResolvedProvider,
    code: string,
  ): Promise<string> {
    const body = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: this.callbackUrl(),
      grant_type: "authorization_code",
    });
    const res = await this.fetchImpl(provider.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error("no access_token from provider");
    return json.access_token;
  }

  private async fetchProfile(
    provider: ResolvedProvider,
    token: string,
  ): Promise<OAuthProfile> {
    const res = await this.fetchImpl(provider.userInfoUrl, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": "tinbase",
      },
    });
    if (!res.ok) throw new Error(`userinfo failed: HTTP ${res.status}`);
    const profile = provider.profileMap(await res.json());
    if (!profile.id) throw new Error("provider profile missing id");
    return profile;
  }

  private async upsertUser(
    provider: string,
    profile: OAuthProfile,
  ): Promise<string> {
    // existing identity?
    const existing = await this.db.query<{ user_id: string }>(
      `select user_id from auth.identities where provider = $1 and provider_id = $2`,
      [provider, profile.id],
    );
    if (existing.rows[0]) {
      await this.db.query(
        `update auth.identities set last_sign_in_at = now(), identity_data = $3 where provider = $1 and provider_id = $2`,
        [
          provider,
          profile.id,
          JSON.stringify({
            sub: profile.id,
            email: profile.email,
            ...profile.metadata,
          }),
        ],
      );
      await this.db.query(
        `update auth.users set last_sign_in_at = now() where id = $1`,
        [existing.rows[0].user_id],
      );
      return existing.rows[0].user_id;
    }

    // Link to an existing user with the same email ONLY when the provider
    // asserts the email is verified — otherwise an attacker could register a
    // provider account with a victim's unverified email and take over their
    // account. Unverified → fall through and create a separate user.
    let userId: string | undefined;
    const email = profile.email?.toLowerCase() ?? null;
    const verified = !!profile.email && profile.emailVerified === true;
    if (email && verified) {
      const byEmail = await this.db.query<{ id: string }>(
        `select id from auth.users where email = $1`,
        [email],
      );
      userId = byEmail.rows[0]?.id;
    }
    if (!userId) {
      // Only claim the email on the new user when the provider verified it AND
      // it isn't already owned by another account. An unverified or taken email
      // is left null so it can't collide with (or hijack) an existing user.
      let userEmail: string | null = verified ? email : null;
      if (userEmail) {
        const taken = await this.db.query(
          `select 1 from auth.users where email = $1`,
          [userEmail],
        );
        if (taken.rows.length > 0) userEmail = null;
      }
      const created = await this.db.query<{ id: string }>(
        `insert into auth.users (aud, role, email, email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data)
         values ('authenticated','authenticated',$1, $2, now(),
                 $3::jsonb, $4::jsonb) returning id`,
        [
          userEmail,
          userEmail ? new Date().toISOString() : null,
          JSON.stringify({ provider, providers: [provider] }),
          JSON.stringify({
            sub: profile.id,
            email: profile.email,
            full_name: profile.name,
            ...profile.metadata,
          }),
        ],
      );
      userId = created.rows[0].id;
    }
    await this.db.query(
      `insert into auth.identities (user_id, provider, provider_id, identity_data)
       values ($1, $2, $3, $4::jsonb)`,
      [
        userId,
        provider,
        profile.id,
        JSON.stringify({
          sub: profile.id,
          email: profile.email,
          ...profile.metadata,
        }),
      ],
    );
    return userId!;
  }
}

export interface OAuthSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface FlowRow {
  provider: string;
  redirect_to: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  auth_code: string | null;
  user_id: string | null;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
