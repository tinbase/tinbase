# Changelog

All notable changes to tinbase are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow semver
(pre-1.0, minor bumps may include breaking changes).

## [Unreleased]

### Changed

- The parity harness covers email. `parity/scenarios.ts` had no email scenarios at all, so the
  part of the surface most recently changed was also the part not being measured against a real
  Supabase. Six added, comparing what the API says rather than what arrives in an inbox - the
  mail itself is not comparable, since tinbase captures it and `supabase start` puts it in
  Inbucket. Auth goes from 3 scenarios to 9.

### Security

- Changing the address on an account now has to be confirmed. `updateUser({ email })` wrote
  straight to `auth.users.email` and stamped it confirmed on the spot, so a live session was the
  only thing needed to move an account to an address of the holder's choosing - nothing was sent
  to either address, and the one losing the account never heard about it. The new address is now
  parked in `email_change` until confirmed, and with `secure_email_change_enabled` (on by
  default, as in Supabase) both ends have to click: the new address proves it is reachable, and
  the current one gets a say in losing the account. A stolen session is no longer sufficient on
  its own.

### Added

- `[auth.email] secure_email_change_enabled`, GoTrue's `MAILER_SECURE_EMAIL_CHANGE_ENABLED`.
  With it off, only the new address is asked and one click completes the change.
- `admin.generateLink({ type: 'email_change_current' | 'email_change_new', email, new_email })`
  mints an email-change link instead of refusing as unsupported. Both sides are minted whichever
  is asked for, since they are one change and minting half of a secure change would leave one
  that can never complete.
- `verifyOtp({ type: 'email_change' })` and `GET /auth/v1/verify?type=email_change` redeem
  either side. While one side is outstanding the caller is told so and gets no session; the
  address moves, and a session is issued, only once none is left.
- The `email_change` template, which existed as a name with no flow behind it, is now the
  template those messages use. The send-email hook's `token_hash_new` carries the new address's
  token, having been an empty string since the hook was added for want of this flow.
- `new_email` on the user object, reporting a change asked for but not yet confirmed.

### Fixed

- An email change is paced by `email_change_sent_at`, the column GoTrue measures it by, which
  like the others was never written.

## [0.17.0]

### Security

- The local email inbox is no longer served on a network-exposed bind. `/inbox` is
  unauthenticated and shows every captured message in full, so on a host reachable beyond
  loopback it handed anyone who asked the magic link, confirmation link and OTP for any address
  they cared to name. It was mounted whenever no mailer was configured, with nothing else
  gating it - so an instance that lost its mail settings started serving them. It now draws the
  same line `enforceRedirectAllowList` draws. Capture is unchanged, so `backend.inbox` still
  works in tests, and the startup banner says plainly when auth email is unconfigured on an
  exposed host.

### Changed

- SMTP settings that fail to load no longer take the database down with them, when they came
  from the environment. A project's own `[auth.email.smtp]` still exits at startup - its author
  is reading that output, and a typo should stop them there. Platform-injected `TINBASE_SMTP_*`
  now logs, disables auth email, and leaves everything else running: one platform pushes the
  same values to every tenant it hosts, so a single bad address used to stop every app rather
  than just their email. A misconfiguration that breaks email should break email.

### Fixed

- `POST /auth/v1/resend` sends the confirmation for the `type` it was given, instead of aliasing
  `/magiclink`. The alias sent a different email: a login link measured by `recovery_sent_at`,
  and - because the magic-link flow creates an account for an address it has never seen - a
  resend for a stranger's address signed them up and mailed them a way in. It now takes GoTrue's
  `type`, answers 200 with an empty body both for an unknown address and for one already
  confirmed (identical from outside, so the response cannot report who has an account), creates
  nothing, and is paced by `confirmation_sent_at`. `sms` and `phone_change` are refused as phone
  auth is unsupported, and `email_change` until that flow exists.

- `max_frequency` is now measured the way GoTrue measures it: against the timestamp the flow
  last wrote on the user row, rather than one window shared by every flow that can mail an
  address. The mapping is GoTrue's, quirks included - a signup confirmation is measured by
  `confirmation_sent_at`, while a magic link and a password recovery share `recovery_sent_at`,
  because GoTrue mints both from the recovery token. Previously a single window covered all of
  them, so a magic link could block the password reset the same person asked for a moment
  later, and a signup confirmation drew on nothing at all.
- `confirmation_sent_at` and `recovery_sent_at` are written when that mail goes out. Both
  columns are in the mirrored GoTrue schema and were never set, so they read NULL however much
  mail an account had been sent - visible to anything reading the user row, Studio included.
  Written only once the transport accepted the message: a provider that refused it has not
  spent the window.
- Where GoTrue differs deliberately: an address with no account has no row to measure, and
  GoTrue lets those through. That makes a 429 proof the account exists, handing back the
  enumeration that answering 200 from `/recover` for an unknown address exists to prevent.
  Those fall back to an in-memory window keyed the same way, so the two are indistinguishable.

## [0.16.2]

### Added

- `API_EXTERNAL_URL` separates where this server answers from where the application lives,
  accepted as `TINBASE_API_EXTERNAL_URL`, `GOTRUE_API_EXTERNAL_URL`, `API_EXTERNAL_URL` or
  `api_external_url` in config.toml. Emailed links are built on it and tokens are issued by it,
  while `site_url` stays the app a finished flow returns to. Collapsing the two forces a choice
  between links that resolve and a redirect that lands somewhere useful. Defaults to `site_url`,
  so a deployment that has not separated them is unaffected. (Shipped in 0.16.2; recorded here
  after the fact, having been missed at release.)

### Security

- `POST /auth/v1/verify` no longer redeems a guessable code without the address it was sent
  to. The match was scoped by email only when one was supplied, so a bare six-digit code was
  tried against every account at once; the per-address attempt cap also needed that email to
  count against, so the five-try lockout never fired on that path. A short or all-numeric
  token now requires its email. The long link token, which is all an emailed link can carry,
  is unaffected — as is `GET /auth/v1/verify`, which after this can only redeem that token.

### Fixed

- `POST /auth/v1/verify` is rate limited (30 per 5 minutes by default). This also makes
  `[auth.rate_limit] token_verifications` take effect — it mapped to a limit nothing read.

## [0.16.1]

### Fixed

- `supabase/config.toml`: an array spread over several lines is now read. Previously only a
  single-line array parsed; written the way Supabase itself writes a long one, the value read
  back as the string `"["` and the setting was silently empty. For `additional_redirect_urls`
  that left a project with no redirect allowlist, so every emailed link fell back to the site
  URL with nothing reporting why.

## [0.16.0]

### Added
- **`[auth.email.smtp]` — a project sends its own email.** Until now the only way to send real
  mail was the Resend transport, which made our choice of provider everyone else's problem: to
  send at all you had to open an account with the one vendor we happened to implement. SMTP is a
  protocol rather than a vendor, so one implementation covers SES, Postmark, Mailgun, Resend or a
  mail server you run yourself — and the block uses GoTrue's key names (`host`, `port`, `user`,
  `pass`, `admin_email`, `sender_name`), so a project's configuration is portable between tinbase
  and Supabase. `pass` goes through the parser's existing `env(VAR)` substitution, so the secret
  never sits in the committed file. `nodemailer` is an optional dependency, imported lazily: the
  browser build must not pull `node:net`/`node:tls`.

  The same settings are also read from the environment as `TINBASE_SMTP_HOST` / `_PORT` /
  `_USER` / `_PASS` / `_ADMIN_EMAIL` / `_SENDER_NAME`, mirroring GoTrue's `GOTRUE_SMTP_*` so an
  operator moving between the two configures the same things by the same names. A deployment
  configures containers through the environment, not by writing into each project's committed
  files — and a platform that edited a tenant's `config.toml` would be editing something the
  tenant owns.

  Precedence is the project's own block, then the environment, then the dev
  inbox. A project's block wins because it is the more specific statement of intent — and because
  sending as the project's own address is only legitimate when the project's own credentials
  carry it.

- **`TINBASE_RESEND_ENDPOINT`** points the Resend transport at a Resend-compatible API other than
  Resend itself. A platform running many tenants can then send through its own gateway: the
  gateway holds the real provider credential, so no tenant's container does, and it can attribute
  and cap each tenant's sending — which one shared credential going straight to the provider
  cannot. The payload is unchanged, and an invalid URL fails at startup rather than looking like
  mail that never arrives.
- **`[auth.hook.send_email]` — hand the email to an endpoint instead of sending it.** The
  endpoint receives the token, its hash, the redirect target and which action it is, then
  composes and sends the mail itself, so it owns the wording, the format and the provider. This
  intercepts earlier than a transport: a transport receives a message we have already written,
  the hook receives the material. Payload and signing are GoTrue's — Standard Webhooks headers
  (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256 over `id.timestamp.body`)
  and the `v1,whsec_…` secret format — so an endpoint written against Supabase works here
  unchanged. An endpoint that refuses the request fails the caller's request rather than
  reporting a success for mail that was never sent.

## [0.15.4]

### Added
- **Auth email templates**, in GoTrue's shape. `[auth.email.template.<type>]` in `config.toml`
  takes a `subject` and a `content_path`, and the HTML may interpolate
  `{{ .ConfirmationURL }}`, `{{ .Token }}`, `{{ .TokenHash }}`, `{{ .RedirectTo }}`,
  `{{ .SiteURL }}` and `{{ .Email }}` — the same names Supabase's dashboard templates use, so
  a project can move between the two without rewriting its mail. What a message offers is
  therefore the project's decision rather than ours: a link, a 6-digit code for an app with a
  code-entry screen, or a `{{ .RedirectTo }}?token_hash={{ .TokenHash }}` link straight to its
  own page, which is the shape that survives being opened on a different device. A plain-text
  part is derived from the HTML so the message stays multipart. Types without a template keep
  the built-in default, and an unreadable `content_path` is a startup error rather than a
  silent fallback to mail the project believes it replaced.

### Changed
- **The recovery email offers the link only — no 6-digit code.** GoTrue's default Reset Password
  template carries just the link, and sending a code alongside it was worse than redundant: a
  6-digit code is a far weaker credential for taking over an account than the 32-character link
  token, it survives being forwarded, and an app that never built a code-entry screen strands
  whoever tries to use it. The code is still minted, so `verifyOtp({ email, token, type:
  'recovery' })` keeps working for an app that does have that screen. Login-OTP and
  confirmation emails still show the code, where it is the point.

## [0.15.3]

### Fixed
- **Auth emails are sent as HTML as well as text.** A text-only mail leaves the client to find
  the URL by pattern-matching, and an auth link defeats that: Gmail on Android linkified only
  the scheme and host of a 210-character recovery link and dropped `/auth/v1/verify?...`, so
  tapping it landed on the API root — `{"name":"tinbase","status":"healthy"}` — instead of the
  reset page. The HTML part states the target in an `<a href>`, with the full address repeated
  as copyable text and the code shown for clients that strip anchors. Plain inline styling
  only: no images, no external CSS, nothing that gets blocked or scores as spam. `MailMessage`
  gains an optional `html`, which the Resend transport sends alongside `text`.

## [0.15.2]

### Fixed
- **Auth mail is logged whatever the transport.** Only the dev inbox logged a line, so on a
  real deployment — the one case where `/inbox` is not even mounted — nothing recorded that a
  password-reset mail had been sent, and a transport that rejected it (an unverified sender
  domain, say) reported that only in the HTTP response to the end user. Every send now logs
  `[mail] to=… subject="…"`, and a failure logs `[mail] FAILED …` with the reason before the
  error propagates. The body, which carries the link and the OTP, is still never logged.

## [0.15.1]

### Added
- **`TINBASE_URI_ALLOW_LIST`.** Comma-separated redirect targets, merged with `config.toml`
  `auth.additional_redirect_urls`. The allowlist is enforced once tinbase binds a
  network-exposed host, so a project deployed behind a platform could not have its emailed
  links reach its own app: the platform mints the hostnames, and nothing in the project's
  committed config knows them. The startup banner now also prints the resolved list, since
  "the link went to the wrong page" is otherwise invisible.

## [0.15.0]

### Added
- **Resend delivery for auth emails.** Set `TINBASE_RESEND_API_KEY` and `TINBASE_MAIL_FROM`
  (`"My App <noreply@example.com>"`) and magic links, OTP codes and password-recovery mails go
  out through Resend; the unauthenticated dev `/inbox` is then not mounted. Without the key the
  inbox stays, as before — but the startup banner now says so ("not delivered"), because a
  network-exposed server on the inbox silently drops every reset email. A key without a valid
  sender is a startup error. `TINBASE_SITE_URL` sets the public URL emailed links are built on,
  ahead of `config.toml` `auth.site_url` and the bound address — inside a container the latter
  is meaningless to a user's mail client.
- **PKCE for email links.** A `flowType: 'pkce'` client (the default in Supabase's SSR /
  Next.js helpers) sends `code_challenge` with `/recover`, `/otp`, `/magiclink`, `/resend`
  and `/signup`. The challenge is parked in `auth.flow_state` (`provider = 'email'`, as
  GoTrue does) and `GET /verify` then redirects to `redirect_to?code=…` for
  `exchangeCodeForSession` — the existing `POST /token?grant_type=pkce` exchange OAuth
  already uses — instead of putting the session tokens in the URL fragment. Previously the
  challenge was ignored, the client received a hash it wasn't expecting, and password
  recovery / magic links silently failed on PKCE clients. `verifyOtp` with the typed code
  is unchanged and returns a session directly in both flows.

### Fixed
- **Auth emails now honour `redirectTo`.** `resetPasswordForEmail(email, { redirectTo })`,
  `signInWithOtp({ options: { emailRedirectTo } })` and `signUp({ options: { emailRedirectTo } })`
  send the target as `?redirect_to=` on `/recover`, `/otp`, `/magiclink`, `/resend` and
  `/signup`. It was silently ignored, so every emailed link redirected to the bare site URL
  and a "forgot password" screen at `/reset-password` was never reached. The link now carries
  `redirect_to` (checked against the same allow-list `GET /verify` enforces), matching GoTrue.
- **`POST /recover` for an unknown email returns `200 {}`** instead of `422 otp_disabled`,
  as GoTrue does, so the response cannot be used to enumerate which addresses have accounts
  and apps can show "check your inbox" unconditionally.

## [0.14.0]

### Added
- **Studio auto-login via URL.** Visiting `/_/?_key=<service_role_key>` now
  injects the key into sessionStorage and authenticates the Studio shell
  automatically, removing the need for manual login. The key is stripped from the
  visible URL via `history.replaceState` so it cannot be bookmarked or leaked in
  the address bar.

## [0.13.2]

### Fixed
- **A recycled PID no longer looks like a running postmaster.** `postmaster.pid` was
  treated as live whenever *some* process held the PID it names, which is a different
  question from whether a postmaster is running — and in a container the difference is
  decisive. Every start numbers processes from 1, so a pid file left behind by a killed
  container names a PID the new container has almost certainly reissued, frequently to
  node itself. Postgres then refused to start with `lock file "postmaster.pid" already
  exists`, and because the collision recurs on every boot, the database never opened
  again. The PID is now confirmed to belong to a postgres process for this data directory
  (`/proc/<pid>/cmdline`, the only route available in the slim images tinbase ships in,
  falling back to `ps` elsewhere), and the data directory recorded in the file is checked
  too, so a file left by a different cluster is stale regardless of what holds its PID.

  Unknowable cases stay conservative: alive but unidentifiable leaves the file alone and
  lets postgres report the conflict, because deleting the lock of a postmaster that *is*
  running would let a second one initialise over a live database.

## [0.13.1]

### Fixed
- **A failing seed no longer takes the server down.** Seeding re-runs whenever
  `supabase/seed.sql`'s hash changes, which meant an edited seed met a database that
  already held the old rows and died on a duplicate key (`23505`); and when a migration
  failed, the seed went on to reference tables that were never created (`42P01`). Neither
  says anything about whether the database can serve — the schema was applied and the data
  was intact — but startup aborted, so the project became permanently unreachable over
  sample data. A seed error is now logged and skipped. The transaction has already rolled
  back, and the hash is deliberately **not** recorded, so correcting `seed.sql` makes the
  next start apply it. Migration failures still abort: schema is load-bearing in a way
  that sample data is not.
- **Crash recovery is waited out instead of being called a startup failure.** `connect()`
  retried under a single 20-second deadline, but its two failure modes are not alike: a
  refused connection means the postmaster has not opened the socket yet, while a `57P03`
  reply means postgres is *alive* and running crash recovery, which on a loaded host with
  a busy database takes minutes. Recovery that would have finished at 25 seconds surfaced
  as a fatal error — and because the next boot restarts recovery from scratch, the
  database never opened again. `57P03` now has its own budget (5 minutes, announced so it
  is not a silent hang), and both are overridable with `TINBASE_PG_STARTUP_TIMEOUT_MS` and
  `TINBASE_PG_RECOVERY_TIMEOUT_MS`.

  Found together on a production fleet where 41 project databases sat in a permanent crash
  loop, every one of them healthy underneath.

## [0.13.0]

### Added
- **CLI commands work while `tinbase start` is running.** Applying a migration used
  to mean stopping your dev server first, which `supabase migration up` has never
  required. `migrate`, `status` and `inspect` now reuse the running server on all
  three engines, by two different routes because the engines differ in kind:
  - **native**: attaches directly to the running postmaster over the socket it
    already advertises in `postmaster.pid`, so no key is involved and it works with
    any JWT secret and under `NODE_ENV=production`. `db diff` and `db pull` work
    this way too.
  - **wasm (PGlite) / pgmem**: PGlite runs in-process and pgmem holds the database
    in memory, so the serving process is the only route in. These go through a new
    `POST /admin/v1/migrate`, which delegates to the same `runMigrations` the server
    calls on boot — so ordering, per-migration transactions, ledger bookkeeping,
    seed hashing and pgmem's skip-and-warn behaviour are one implementation, not a
    reimplementation behind an endpoint. `status` and `inspect` reuse the existing
    `migrations` and `tables` endpoints.

  On pgmem this is a new capability rather than a repair: with the database purely
  in memory there was previously no way at all to migrate a running instance.
- **`start` mentions a newer published version**, once, with the upgrade command.
  Deliberately a notice and not a self-updater: swapping a running binary needs
  atomicity, signature verification and an answer for an install that cannot repair
  itself. It never affects the command it rides on — not awaited, 1.5s timeout,
  every failure silent — and is skipped under `CI` and `NODE_ENV=production`, or
  with `TINBASE_NO_UPDATE_CHECK=1`.

### Fixed
- **`db reset` no longer destroys a running server's database and calls it a
  success.** The wipe removed `postmaster.pid` along with everything else — the very
  lock that should have prevented it — so a second postmaster then initialised a
  fresh cluster on the same path. The running server was left answering
  `connection closed` on every request with its database deleted underneath, while
  reset printed `reset complete`. It now refuses before deleting anything, on every
  engine, naming the process that holds the directory.
- **Migrating on the wasm engine while a server ran left the project unrepairable.**
  Two PGlite instances wrote one directory, and the result was a migration ledger
  claiming a migration whose table did not exist. Because the ledger said applied,
  re-running `migrate` could never fix it; only `db reset` recovered, discarding the
  data. On pgmem the same command was a no-op that reported success. Both now go
  through the running server instead.
- **`/rest/v1/` and `/auth/v1/health` report the running version.** Both served
  `0.9.0` for three releases, because the constant behind them was maintained by
  hand and nothing noticed when it drifted. A test now fails the moment it diverges
  from `package.json`.

### Changed
- `db diff` and `db pull` refuse while a server is running on the wasm or pgmem
  engines. Both need a shadow database to diff against, which a direct connection
  can provide and an admin endpoint cannot; on the native engine they work.
- `start` writes `.tinbase/server.json` (pid, engine, host, port) and removes it on
  shutdown, so other commands can tell a server is up on engines that advertise
  nothing themselves. A file left by a crashed run is detected by checking the pid,
  so it cannot lock a project out of its own CLI.

## [0.12.2]

### Fixed
- **Embeds resolve by foreign-key column or constraint name, not only by table
  name.** PostgREST lets you name the relationship in an embed by the fk column on
  the base table (`select=*,asset:asset_id(*)`) or by the fk constraint itself,
  instead of by the target table. Relationship resolution only ever matched table
  names, so those perfectly valid supabase-js queries came back as `PGRST200`
  "Could not find a relationship … in the schema cache" — which reads as a schema
  problem rather than an unsupported spelling, so the natural next step was to go
  looking for a missing foreign key that was there all along.

  Table-name matching is tried first and is unchanged; the fk-column and
  constraint-name passes only run when it finds nothing, so no existing query
  changes meaning or becomes newly ambiguous. Both directions are covered: a
  constraint name resolves a reverse (to-many) embed too, and stays a single
  object when the fk is a unique key, as one-to-one embeds already did.

## [0.12.1]

### Changed
- **Requires `@tinbase/pg-mem` 3.4.0 or newer**, up from 3.3.0, and the floor is a
  hard one rather than a preference: two things tinbase used to correct on its own
  are now fixed inside the engine, so 3.3.x would reintroduce both. Only the
  optional pgmem engine is affected; nothing changes for the native or PGlite
  engines. A fresh install picks this up on its own.

### Fixed
- **Logging out actually ends the session.** `POST /auth/v1/logout` revoked refresh
  tokens but recorded nothing an *access* token could be checked against, and
  `/auth/v1/user` only verified the JWT signature. So a logged-out token kept
  returning 200 with the full user object until it expired, which defeats the
  reason server-side code validates with `getUser(jwt)` instead of verifying the
  JWT locally: so that a logout takes effect immediately. Sessions are now
  persisted in `auth.sessions`, keyed by the `session_id` claim the access token
  already carried but nothing consulted, and logout deletes them. A refresh token
  can no longer resurrect a deleted session. Thanks to @itsacoyote for the report
  (#78).

  `?scope=` is honoured: `global` (the default) ends every session for the user,
  `local` ends only the calling one, `others` ends the rest. A refresh reuses its
  existing `session_id`, so refreshing is not a silent logout of the token the
  client still holds. Tokens carrying no `session_id` — the studio's impersonation
  token, for instance — have no session to revoke and are unaffected.

  This deliberately stops at the auth endpoints. PostgREST validates the JWT
  signature and nothing else, so a logged-out token keeps working against
  `/rest/v1` until it expires, in real Supabase exactly as here; making REST
  consult session state would diverge from Supabase rather than match it.
- **`order=relation(column)` orders by an embedded column** instead of failing.
  PostgREST supports ordering top-level rows by a to-one embedded column, and
  supabase-js exposes it as `.order('relation(column)')`, but the term was parsed
  as a column named literally `"relation(column)"` and passed to Postgres, which
  answered `42703 column t0.relation(column) does not exist`. It now resolves the
  embed and emits a correlated scalar subquery, which is how embeds are already
  rendered here. Thanks to @itsacoyote for the report (#79).

  Ordering by a to-many relationship is rejected with a message naming it, since
  it has no single value per base row — PostgREST rejects it too — and an unknown
  relation reports `PGRST200` rather than leaking a Postgres error. `signup` and
  `invite` verification links are also redeemable now, as a side effect of both
  verify paths resolving verification types through one shared helper; they
  previously matched no stored token row and always failed.
- **The studio's table browser no longer lists tinbase's internals on the pgmem
  engine.** pg-mem reported `auth.*`, `storage.*` and `supabase_migrations.*` as
  living in `public`, so the studio showed 13 internal tables beside the project's
  own — none of which could be opened, which is what their unknown row counts
  meant. Fixed in the engine rather than filtered out here, so `public` now holds
  only the project's tables and the internals are browsable under their own
  schemas, as they always were on the real engines.

### Internal
- The numeric/int8 JSON coercion added in 0.11.2 is gone from the REST layer,
  because pg-mem's json builders now emit JSON numbers themselves. 0.11.2
  attributed the strings to pg-mem's pg adapter; they in fact came from
  `to_json`/`row_to_json`/`json_agg` emitting the engine's internal string
  representation, which is where it is now fixed. Responses are unchanged — the
  parity tests covering them are untouched and still pass — but the correction
  now also applies to embedded relations and to anything else reading those
  functions, rather than only to requests passing through this REST handler.
- CI builds before running tests. The CLI tests spawn `dist/cli.js` and returned
  early when it was absent, which counted as passing, so they never ran in CI and
  it reported green regardless. They now report as skipped when the build is
  missing, and CI emits rather than only type-checking, so they actually run.

## [0.12.0]

### Added
- **`POST /auth/v1/admin/generate_link`** (`supabase.auth.admin.generateLink()`),
  which previously answered 404. It mints a link and OTP and returns them
  instead of emailing them, so a caller can deliver or redeem them itself. That
  is what makes programmatic session minting work: `generateLink()` then
  `verifyOtp()` yields a session with no password and no email round trip, which
  is the usual shape for an e2e test harness. No mail is sent, matching GoTrue.

  Supported types: `signup`, `invite`, `magiclink`, `recovery`. The response is
  flat (user fields alongside `action_link`, `email_otp`, `hashed_token`,
  `redirect_to`, `verification_type`), which is what supabase-js expects before
  it splits the body into `{ user, properties }`. Thanks to @itsacoyote for the
  report (#77).

### Fixed
- **`/auth/v1/verify` accepts `token_hash`, not just `token`.** supabase-js sends
  `token_hash` for `verifyOtp({ token_hash })`, which is the shape
  `generateLink` feeds it, so that call previously failed validation with
  "token is required". tinbase stores one-time tokens verbatim rather than
  hashing them, so the two keys name the same opaque string.
- **`signup` and `invite` verification links are redeemable.** Both `verify`
  paths now resolve a verification type to the stored `token_type` rows through
  one shared helper; `signup` and `invite` previously matched no row and always
  failed. `recovery` stays scoped to recovery tokens, so a login token still
  cannot mint a password-reset session.

### Internal
- CI builds before running tests. The CLI tests spawn `dist/cli.js` and returned
  early when it was absent, which counted as passing, so those cases never ran
  in CI and reported green regardless. They now report as skipped if the build
  is missing, and CI emits rather than type-checking only, so they actually run.

## [0.11.3]

### Fixed
- **`db reset` wipes the database the other commands actually use.** Argument
  parsing defaulted the data directory to `.tinbase/db` unconditionally, which
  made the engine-aware fallback inside `db reset` dead code. On the native
  engine reset therefore wiped `.tinbase/db` — a directory native never uses —
  initialized a *second* Postgres cluster there, applied migrations to it and
  reported `reset complete`, while `start`, `migrate`, `status` and `inspect`
  went on serving the untouched `.tinbase/pgdata`. A reset appeared to succeed
  and changed nothing. Data-directory resolution now lives in one engine-aware
  helper that every command shares, so they cannot drift apart again. Thanks to
  @SpaleRuby for the report (#76).

### Changed
- **`--data-dir` is honored by the native engine.** It was silently ignored
  there — `start` hardcoded `.tinbase/pgdata` — while `db reset` did respect it,
  the same disagreement in the opposite direction. Passing `--data-dir` now
  places the native cluster where you asked for every command. If you were
  passing it to a native project and relying on it being ignored, the data
  directory moves; the default (`.tinbase/pgdata` for native, `.tinbase/db` for
  wasm) is unchanged.
- A native or pgmem project no longer creates an unused, empty `.tinbase/db`
  alongside its real data directory on every command.

## [0.11.2]

### Fixed
- **`numeric` and `int8` serialize as JSON numbers on the pg-mem engine, matching
  PostgREST.** pg-mem's pg adapter follows the node-postgres convention and hands
  both types back as strings to preserve precision, and its identity
  `row_to_json` kept them strings inside the aggregated body — so an app doing
  `athlete.score.toFixed(1)` crashed against an in-page preview while the same
  code worked against real Supabase, which sends `score: 98.4`. Rows are now
  coerced at the REST layer on the subset engine only, driven by
  `information_schema` column types, and applied to reads, mutation echoes, and
  CDC payloads alike — so realtime carries numbers too. Numeric-looking `text`
  stays text. The full engines are untouched: their `json_agg` runs in real
  Postgres, which already emits JSON numbers. `int8` past 2^53 loses precision
  here exactly as it does through PostgREST's own serialization.

  Two known limits, both scoped to the subset engine: values reached through a
  column alias or an alias-renamed embed keep whatever the engine produced,
  because an alias can't be mapped back to its column without re-parsing the
  select tree.
- **Foreign-key introspection no longer depends on `constraint_column_usage`,**
  which pg-mem ships empty. It now joins `referential_constraints` against
  `key_column_usage`, pairing composite FK columns by ordinal instead of relying
  on dedup order. On pg-mem this replaces bogus `PGRST200` "relationship not
  found" errors with a genuine SQL execution failure on the correlated lateral
  subquery — embeds still aren't supported there, but the error now reflects the
  real cause instead of misreporting the schema.

### Changed
- The optional `pg-mem` dependency moves to `@tinbase/pg-mem@^3.3.0`, which is
  where `information_schema.referential_constraints` arrived. Installs that pin
  the older 3.2.x will not have it.

## [0.11.1]

### Fixed
- **The package bundles for the browser again.** 0.11.0 added a static
  `import { AsyncLocalStorage } from 'node:async_hooks'` to `deno-shim.ts`, which
  is reachable from the package root — so every app that bundles tinbase for the
  browser (in-page pg-mem previews) failed to build, with client bundlers
  (Turbopack, Metro) refusing to resolve a Node-only builtin: "the chunking
  context does not support external modules". `async_hooks` is now loaded at
  runtime through `process.getBuiltinModule`, which is synchronous and ESM-safe
  and leaves no import statement for a bundler to see. `Deno.cwd()` is guarded
  the same way, so it no longer throws `ReferenceError` where there is no
  `process`.

  On Node this is unchanged: `AsyncLocalStorage` still scopes each invocation's
  function env, so interleaved invocations stay isolated. Where
  `getBuiltinModule` is unavailable the shim falls back to a promise-scoped
  store — the env stays bound across awaits for a whole invocation, but
  concurrent invocations are not isolated from one another. That is the right
  trade for browser previews, which invoke one function at a time.

## [0.11.0]

### Added
- **Local dev API keys are deterministic, so a `.env.local` can be committed.**
  The anon and `service_role` keys were signed with `iat` = now, so every start
  on every machine produced different keys — nothing that reads them could be
  checked in, and each teammate had to copy their own pair out of the start
  banner. Dev keys are now signed with fixed claims (`iss: "supabase-demo"`,
  `exp: 1983812996`), which makes them stable across restarts and machines and,
  with the default secret, byte-identical to Supabase's well-known local demo
  keys — the same property `supabase start` has. The start banner prints a
  ready-to-copy `.env.local` block.
- `deriveApiKeys(jwtSecret, mode)` is exported from the package root, alongside
  the `DEMO_KEY_EXP` expiry claim. Both `createBackend` and `tinbase keys` go
  through it, so the CLI and the server can no longer disagree about what a
  given secret's keys are.

### Changed
- **Dev key values changed, and the claims they carry changed with them.** A
  custom `--jwt-secret` still yields deterministic keys (stable per secret), but
  in deterministic mode the claims are `iss: "supabase-demo"` with no `ref` and
  no `iat`, where they were previously `iss: "supabase"`, `ref: "tinbase"`, plus
  `iat`/`exp` ten years out. Anything that pinned a literal key string or
  asserted on those claims needs its expected value refreshed. Under
  `NODE_ENV=production` nothing changes: every start signs fresh, unique keys
  with the old claim shape.

## [0.10.2]

### Fixed
- **Studio's table browser worked on the pgmem engine again.** `listTables` asks
  `information_schema.views` which tables are views, so it can render those
  read-only. pg-mem has no `information_schema.views`, so that query threw and
  failed the whole request — the studio reported "No tables yet" for a database
  full of tables, while the dashboard card next to it correctly counted 14. The
  query is now guarded the same way the per-table `count(*)` already was (that
  guard's comment even names the pgmem engine); an engine without views yields an
  empty set, which is the right answer there rather than a degraded one.

## [0.10.1]

### Fixed
- **Studio deep links serve the app shell again.** `src` has routed every `/_/*`
  path to the shell for a while, but the shipped `dist` predated that change, so
  `/_/table` and `/_/database/functions` fell through to the REST handler and
  answered `401 {"message":"No API key found in request"}` — on refresh, on a
  deep link, and on back/forward. This release simply rebuilds, which is also why
  it is worth publishing on its own.
- **Studio works when embedded in a document whose location it doesn't control.**
  The router read `window.location.pathname`, which is `[Unforgeable]` — an
  embedder cannot virtualize it. It now reads `new URL(document.URL).pathname`,
  identical under normal hosting and virtualizable when embedded. This is what
  lets Lifo render the Studio from an in-VM tinbase inside a `blob:` iframe with
  no service worker; without it every nav click stayed on the home tab.

### Released here too — the Studio rebuild

Everything below shipped in this release rather than in 0.10.0. `src/admin/ui.ts`
has carried the rebuilt Studio since 2026-07-11, but 0.10.0's published `dist/`
predated it and served the old ~296 kB Studio; 0.10.1 is the first release built
from current sources, so the embedded Studio goes ~296 kB → ~1.32 MB (the table
editor, database panes and an inlined `ace` SQL editor, all in one self-contained
document because of `vite-plugin-singlefile`).

Rebuilds the Studio, adds the backend surface it needs, and adds the guardrails
and fixes needed to expose tinbase beyond localhost.

### Added
- Rebuilt Studio (`/_/`) to Supabase-Studio parity: table editor (filters, sort,
  inline edit, FK nav, RLS/role preview), database (schema visualizer, functions,
  triggers, enums, indexes, policies, roles, migrations), auth, storage, edge
  functions, realtime, automations, logs, SQL editor, settings, and a live advisor.
- Reads a real project's `supabase/config.toml` so pointing tinbase at it needs
  no new config. One loader honors every setting that maps to a tinbase feature:
  - `[auth]` / `[auth.email]` / `[auth.mfa]`: signup, confirmations, password
    length, OTP length + expiry, MFA factor cap, TOTP enroll/verify toggles.
  - `[auth]`: `site_url`, `jwt_expiry`, `additional_redirect_urls`, `enabled`.
  - `[auth.rate_limit]`: feeds the auth rate limiter's windows.
  - `[auth.sessions]`: `timebox` caps session lifetime.
  - `[auth.external.*]`: OAuth providers (with `env()` resolution).
  - `[api]`: `schemas` (exposed schemas) and `max_rows` (REST row cap).
  - `[storage]`: `file_size_limit` and declarative `[storage.buckets.*]`.
  - `[db.seed]`: `enabled` and `sql_paths`.
  - `[functions.<name>]`: `enabled`, `verify_jwt`, `entrypoint`.

  config.toml is the committed baseline; live Studio toggles (persisted in
  `auth.config`) layer on top, and CLI flags still win. Sections for services
  tinbase doesn't run (SMS, analytics, pooler, ports) are ignored.
- `dbSchemas`: only listed schemas are reachable through `/rest/v1` for anon/authenticated.
- Edge-function secrets from `supabase/functions/.env`, managed in the Studio.
- A demo project (init migration + seed) so a fresh `tinbase start` has data.
- `uriAllowList` config: extra redirect targets allowed beyond the site origin.

### Security
When bound to a non-loopback host, tinbase enforces deployment guardrails that
stay off for local dev:
- Refuses to start on a weak/default JWT secret or a Vault key derived from one
  (a warning on loopback). Set `--jwt-secret` and an explicit `vaultKey` first.
- `redirect_to` must match the site origin or `uriAllowList`, so a crafted
  magic-link/OAuth link can't send the session elsewhere.
- Webhooks get the same SSRF egress guard as `net.http_*`.

Always on:
- Rate limiting on login/signup/otp/recover (`429 over_request_rate_limit`).
- Studio "run as" SQL runs in a transaction with `SET LOCAL` + bound claims, so
  role/claims no longer leak across concurrent requests.
- Native Postgres binaries are checksum-verified before extraction.
- Signed-URL lifetimes capped at 7 days; keys with `..`/absolute/backslash/NUL rejected.
- Studio key moved to `sessionStorage`; shell served with CSP + `ETag`.

### Bug Fixes
- `tinbase db diff` no longer emits invalid DDL when a table is dropped (it
  referenced constraints/indexes on the vanished table).
- `gen types` merges overloaded functions into a union (no duplicate keys) and
  types `interval`/`point` as `string`, not `number`.
- `int8` beyond 2^53 returns as a string (native engine) instead of losing
  precision; migrations sort by code unit, not locale.
- `user.identities` is populated from `auth.identities` (was always `[]`).
- Health/root endpoints report the real package version (was `0.1.0`).
- A fresh clone builds with `npm install && npm run build` (`build:admin`
  now installs the `admin-ui/` dependencies itself).

### Breaking
- With `dbSchemas` set, anon/authenticated requests into a schema not in the list
  get a 406 instead of reaching it. Add any non-`public` schema your app uses.
- `supabase/config.toml` is now read (most of it was ignored before), so auth,
  `[api]` (schemas, max_rows), `[storage]` (limits, buckets), `[db.seed]`, and
  `[functions.*]` settings declared there now take effect. Built-in defaults are
  unchanged, so a project with no config.toml behaves as before; CLI flags still
  override config.toml. Notably, `[api].schemas` now drives the exposed-schema
  allowlist and `[api].max_rows` caps REST reads.

## [0.10.0] — 2026-07-13

Fidelity edges across PostgREST and Storage, plus the ability to run against a
Postgres you already have.

### Added
- **Connect to an external Postgres** — `tinbase start --database-url
  postgres://user:pass@host:5432/db` (or the `DATABASE_URL` env, or
  `createBackend({ databaseUrl })`) points REST/Auth/Storage at a Postgres you
  already run instead of the embedded engine. The wire client gained
  cleartext/md5/**SCRAM-SHA-256** auth for TCP, and the target is treated as
  shared/pre-existing (idempotent bootstrap; migrations/seed stay tracked).
  TLS/sslmode, realtime CDC without superuser, and pooling are follow-ups.
- **PostgREST aggregates in select** — `count()`, `col.sum()/avg()/max()/min()`
  (with alias/cast), and any non-aggregate column becomes an implicit `GROUP BY`
  key, e.g. `select=author_id,views.sum()`.
- **`.explain()`** — `Accept: application/vnd.pgrst.plan+{text,json}` returns the
  query plan (analyze/verbose/settings/buffers/wal options honored).
- **`.csv()`** — `Accept: text/csv` serializes results to CSV.
- **Spread embeds** — to-many and m2m spreads (`...rel(col)`) now aggregate each
  column into a JSON array (to-one keeps its scalar-merge behavior).
- **Storage resumable (TUS) uploads** — a minimal TUS 1.0.0 server at
  `/storage/v1/upload/resumable` (creation, creation-with-upload, PATCH by
  offset, HEAD, termination) for supabase-js's resumable upload flow.

### Changed
- **Image transformations are served as a no-op** (with a one-time warning)
  instead of 404ing: transform requests (`/render/image/…`) return the original
  object so apps still get their image. Real resize/re-encode needs a bundled
  image codec (still a follow-up).

## [0.9.0] — 2026-07-11

A security hardening pass and a set of GDPR / compliance building blocks. Based
on the audit and PRs by [@BankkRoll](https://github.com/BankkRoll) (#40, #41,
#42), reworked onto `main`.

### Security
- **Storage signed URLs are now purpose-scoped.** Download and upload tokens
  carry a `type` claim checked on redeem, so a download token can no longer be
  replayed against the upload endpoint. Signed-upload redeems now run as the
  token owner (RLS applies) instead of the RLS-bypassing service role.
- **`cron.schedule` / `net.http_*` restricted to `service_role`.** These run as
  the superuser owner; they are no longer granted to `authenticated`.
- **SSRF guard for `net.http_*`** — blocks loopback, private, link-local, and
  cloud-metadata targets and non-http(s) schemes, with a 10 MiB response cap.
- **OTP hardening** — per-email attempt limit with lockout; a login OTP can no
  longer redeem a recovery token (recovery requires `type=recovery`).
- **OAuth linking requires a provider-verified email**, closing an
  account-takeover-by-unverified-email vector.
- **JWT verification pinned to HS256** (rejects `alg:none` / alg-swap).
- **TOTP challenges are single-use** (no replay within the validity window).
- **Stored-XSS guard on served objects** — `X-Content-Type-Options: nosniff`
  always, and `Content-Disposition: attachment` for active types (html/svg/xml).
- **Realtime DELETE no longer leaks `old_record` across tenants** — non-service
  subscribers on RLS tables receive only the primary key on DELETE.
- **WebSocket rejects unmasked client frames** (RFC 6455 §5.1; closes with 1002).
- **Edge functions no longer leak host env** (`Deno.env` scoped to injected
  `SUPABASE_*`/declared secrets) and `Deno.exit` no longer kills the server.
- **Cron `0 seconds` interval floored to 1s**; an unparseable storage
  `file_size_limit` is now rejected (400) instead of silently disabling the cap.

### Added
- **GDPR data export** — `GET /auth/v1/admin/users/:id/export` (service_role)
  returns a user's profile, identities, sessions, and MFA factors as one JSON
  document, with credential/token columns stripped.
- **GDPR erasure** — admin user delete verifies existence (404 vs silent 200)
  and reports the auth rows removed by cascade.
- **Audit log** — append-only `auth.audit_log_entries` (GoTrue-compatible) for
  signup, login, failed login, logout, erasure, and data export; readable at
  `GET /auth/v1/admin/audit` (service_role). Writes are best-effort.
- **Vault encryption at rest** — the Vault stand-in now encrypts secrets with
  pgcrypto under a key held only in a session GUC (`vaultKey`, derived from
  `jwtSecret` by default). `decrypted_secrets` decrypts on read.
- **Data retention** — an in-process hourly sweep purges expired one-time
  tokens, MFA challenges, OAuth flow state, aged-out revoked refresh tokens, and
  audit entries past a window. Configurable via `retention`; `0` disables a sweep.
- **`COMPLIANCE.md`** mapping what tinbase provides vs. what the operator is
  responsible for.

### Changed
- The default mailer log records only recipient and subject, not the body (which
  carries OTP codes and magic links). Set `logMailBody: true` for full local
  logging; the `/inbox` dev UI still shows the full body.

### Migration notes
- **New databases** pick up the schema additions automatically. An **existing
  persisted database** created before this change needs, before OTP verify and
  the audit log / retention sweep work:
  - `alter table auth.one_time_tokens add column attempts int not null default 0;`
  - the `auth.audit_log_entries` table (created by the current bootstrap).
- **Behavior changes clients may observe:** signed *upload* URLs now enforce RLS;
  `verify` without a `type` no longer redeems recovery tokens; admin user delete
  returns 404 for a missing user; RLS-table realtime DELETE payloads contain only
  the primary key for non-service subscribers.

## [0.8.1] — 2026-07-10

Slims the `pgmem` engine and corrects its documented footprint.

### Changed
- **`@tinbase/pg-mem` → 3.2.0**, which drops `moment.js` (~5.2 MB, mostly unused locale
  data) and `json-stable-stringify` (+ its `get-intrinsic` chain, ~0.5 MB) for a
  zero-dependency date layer. The pgmem engine's install footprint falls from **~13 MB to
  ~6.7 MB** — still the lightest engine. Behavior-preserving: verified against the engine's
  full test suite and 256/256 differential conformance vs Postgres 16.

### Docs
- Corrected the pgmem install-size figures across the README and website (`/docs`,
  `/browser`, weight chart) to the re-measured **~6.7 MB** (the old ~3.6 MB counted the
  package alone, not its installed dependency tree).

## [0.8.0] — 2026-07-10

The `pgmem` engine now runs real Supabase workloads. Backed by the
[`@tinbase/pg-mem`](https://www.npmjs.com/package/@tinbase/pg-mem) fork, a full
Supabase-style bootstrap + **135 production migrations** (rapidnative) apply
**135/135 with nothing skipped** — 76 tables, inserts and Admin UI row edits working.

### Changed
- **`pgmem` engine dependency** is now `@tinbase/pg-mem` (via an npm alias, so
  `import('pg-mem')` is unchanged). The fork adds the Postgres surface real projects
  need — PL/pgSQL, triggers, RLS, correlated subqueries, `information_schema`
  constraints, dollar-quoted strings, array slicing, MERGE, ranges, full-text and
  declarative partitioning — none of which upstream `pg-mem@3.0.14` supports. It
  transitively pulls `@tinbase/pgsql-ast-parser`. (Both are public/MIT and track
  upstream PRs oguimbal/pg-mem#476 and oguimbal/pgsql-ast-parser#174.)
- **`pgmem` statement splitter** now respects `--`/`/* */` comments and `'…'`/`"…"`
  strings — it previously split on `;` inside them, the biggest source of spurious
  migration failures.
- **`pgmem` transaction errors** are no longer masked: pg-mem commits DDL immediately
  and can't restore a snapshot afterwards, so the failed rollback is swallowed and the
  real error surfaces.

### Added
- **`auth.uid()` / `auth.jwt()` / `auth.role()` / `auth.email()`** on the `pgmem`
  engine, so migrations' RLS policies referencing them compile and RLS-protected tables
  stay queryable/browsable.
- **`pgmem` migrations are tolerant** — a migration the preview engine can't run is
  skipped with a warning instead of aborting startup (local dev), and the Admin UI table
  list tolerates a per-table count failure instead of blanking.

### Docs
- README, website (`/docs`, `/browser`, feature matrix) now describe `pgmem` accurately:
  it runs PL/pgSQL, triggers and RLS-policy DDL via the `@tinbase/pg-mem` fork (migrations
  apply unchanged, nothing skipped), rather than the previous "no triggers / no RLS /
  RLS DDL skipped" subset.

## [0.7.1] — 2026-07-09

Docs/metadata accuracy pass after 0.7.0.

### Changed
- **`tinbase --help`** no longer describes the backend as "on PGlite" — native
  embedded Postgres is the default now. The header reads "Supabase-compatible
  backend, no Docker (embedded Postgres / PGlite)", and the npm `description`
  matches.
- **README:** the single-binary size is stated as **~58 MB** (measured), and the
  benchmark "install size" is clarified as **92 MB = the 58 MB executable + the
  Postgres binaries fetched on first run** (they were conflated). Test-count
  wording now cites the verifiable full suite (**168 tests**, both engines).

## [0.7.0] — 2026-07-09

Runs real Supabase projects. The headline is that a full production schema —
[Cap-go/capgo](https://github.com/Cap-go/capgo)'s **335 migrations + an 80 KB
seed** — now applies and is queryable via `@supabase/supabase-js` unchanged.
Getting there added a pg_net emulation, made the native engine the default, and
smoothed over the gaps between "stock Postgres" and a hosted Supabase project.
**168 integration tests pass on both the wasm and native engines.**

### Engines
- **Native embedded Postgres 17 is now the default** on macOS/Linux (x64/arm64)
  — ~59 MB RAM at boot vs PGlite's ~575–650 MB WASM heap. Windows still defaults
  to the WASM (PGlite) engine, and `--engine` / `TINBASE_ENGINE` override as
  before. The programmatic `createBackend()` default stays PGlite (browser-safe).
  First native run downloads ~12 MB of Postgres binaries (cached).

### Automation
- **pg_net emulation** — `net.http_post` / `net.http_get` / `net.http_delete`
  enqueue a request that an in-process worker sends, recording the reply in
  `net._http_response` (like pg_net's background worker). So the common Supabase
  pattern of a cron job hitting an Edge Function —
  `cron.schedule(..., $$ select net.http_post(...) $$)` — works with no C
  extension, on both engines.
- **Cron now matches in UTC**, like hosted pg_cron (was the process-local
  timezone).
- **pgmq** gained `drop_queue`, `purge_queue`, and `list_queues`.

### Real-project compatibility
Applying a real project's migrations surfaced several stock-Postgres/hosted-only
assumptions; each is now handled so the whole schema applies:
- **`CREATE EXTENSION` tolerance** — an extension tinbase can't install
  (pg_cron, pg_net, http, hypopg, supabase_vault, plpgsql_check, …) is skipped
  with a notice instead of aborting the migration; bundled extensions still get
  created.
- **Per-migration `search_path`** — reset to the default before each migration
  (the Supabase CLI applies each on a fresh connection), so a hardened file's
  `SET search_path TO ''` can't break unqualified calls (e.g. `gen_random_bytes`)
  in later files.
- **`CREATE INDEX CONCURRENTLY`** is applied without `CONCURRENTLY` (illegal
  inside tinbase's per-migration transaction; equivalent on a local dev DB).
- **Supabase Vault** — `vault.secrets`, `vault.decrypted_secrets`,
  `create_secret` / `update_secret` (dev-only plaintext; real Vault encrypts).
- **`moddatetime`** — pure-SQL stand-in for the contrib trigger function.
- **`auth.users`** gained the full GoTrue column set (instance_id,
  confirmation_token, recovery_token, email_change*, phone_change*,
  reauthentication*, …), so full-fidelity seed inserts work.

### Docs & project
- The repository moved to **github.com/tinbase/tinbase**.
- Website: a browser-rendered OG image, a dark-only theme (no longer follows the
  system light/dark preference), and refreshed engine/automation docs.
- Roadmap: **Phase 7 — connect to an external Postgres** (a community request).

### Notes
- Native is macOS/Linux only; Windows uses the WASM engine.
- Vault secrets are stored in cleartext locally — dev use only.

## [0.6.1] — 2026-07-08

### Fixed
- **`tinbase start` no longer crashes when the port is in use.** It now probes
  for a free port from the requested one and starts on the next available port
  with a notice (instead of an `EADDRINUSE` stack trace); if the range is
  exhausted it exits with a clear message. The printed URL, keys, and `siteUrl`
  reflect the actual bound port.

## [0.6.0] — 2026-07-08

The biggest release since the first public cut: a third database engine, MFA,
realtime authorization, edge-function bundling, and a much richer Studio. The
official `@supabase/supabase-js` SDK works unchanged, and **152 integration
tests pass on both the wasm and native engines**.

### Engines
- **New `--engine pgmem`** — an ultralight, pure-JS, in-memory Postgres subset
  (~3.6 MB install, no WASM), the lightest way to run tinbase in a browser or on
  a phone for local dev and previews.
- pg-mem runs REST CRUD, email/password auth, edge functions, realtime
  (broadcast/presence + `postgres_changes`), and database webhooks — change
  events are synthesized in JS since it has no triggers. Out of scope on pg-mem:
  RLS, cron, pgmq.

### Auth
- **MFA / TOTP** — `auth.mfa.enroll / challenge / verify`, factors on the user,
  `aal2` session elevation, QR + `otpauth://` URI. Pure WebCrypto.
- **Anonymous → permanent upgrade** — `updateUser({ email, password })` converts
  an anonymous user in place, keeping the same uid and data.
- **Local email inbox** at `/inbox` — an Inbucket/Mailpit-style viewer for
  magic-link, OTP, and recovery emails, with the code and link extracted.

### Realtime
- **Private channels with authorization** — `channel(name, { config: { private:
  true } })` is RLS-authorized against `realtime.messages` via `realtime.topic()`
  (SELECT = subscribe, INSERT = broadcast).
- **Broadcast-from-database** — `realtime.send(payload, event, topic, private)`
  pushes a broadcast to subscribers straight from SQL and triggers.

### Edge Functions
- **Bundling** — functions compile through esbuild: TypeScript, relative and
  multi-file imports, and `npm:` / `jsr:` / `https://` specifiers (rewritten to
  esm.sh, fetched and disk-cached). `esbuild` is an optional dependency; without
  it the loader falls back to a plain import.
- **Secrets** — `supabase/functions/.env` is exposed via `Deno.env` and
  `ctx.env` (local `--env-file` parity).

### Automation (no C extensions)
- **Database webhooks** (CDC → HTTP), **cron** (`cron.schedule()`), and a
  **pgmq** queue subset — all extension-free and working on both engines.

### Developer experience & Studio
- **CLI:** `db pull` (writes the schema delta as a migration and marks it
  applied) and `inspect` (per-table rows + on-disk size), alongside `db reset`
  and `db diff`.
- **Studio** (`/_/`) gained an RLS policy editor, functions/triggers browsers,
  and a live **Logs** pane (backed by `GET /admin/v1/logs`).
- **Website:** a Studio tour with screenshots, a dedicated in-browser guide, and
  an architecture diagram.

### Notes
- Remote function imports fetch on first run (network), then disk-cache.
- Still experimental — great for prototypes, local dev, and embedded/browser
  use; not for production yet.

## [0.2.0] / [0.1.0]

Earlier tagged previews: the core Supabase-compatible surface — REST (PostgREST
grammar), Auth (GoTrue), Storage, Realtime, RLS, migrations, and the single-file
binary — on the PGlite (wasm) and native Postgres engines.

[Unreleased]: https://github.com/tinbase/tinbase/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/tinbase/tinbase/releases/tag/v0.9.0
[0.8.1]: https://github.com/tinbase/tinbase/releases/tag/v0.8.1
[0.8.0]: https://github.com/tinbase/tinbase/releases/tag/v0.8.0
[0.7.1]: https://github.com/tinbase/tinbase/releases/tag/v0.7.1
[0.7.0]: https://github.com/tinbase/tinbase/releases/tag/v0.7.0
[0.6.1]: https://github.com/tinbase/tinbase/releases/tag/v0.6.1
[0.6.0]: https://github.com/tinbase/tinbase/releases/tag/v0.6.0
[0.2.0]: https://github.com/tinbase/tinbase/releases/tag/v0.2.0
[0.1.0]: https://github.com/tinbase/tinbase/releases/tag/v0.1.0
