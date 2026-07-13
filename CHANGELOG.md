# Changelog

All notable changes to tinbase are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow semver
(pre-1.0, minor bumps may include breaking changes).

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

[0.7.1]: https://github.com/tinbase/tinbase/releases/tag/v0.7.1
[0.7.0]: https://github.com/tinbase/tinbase/releases/tag/v0.7.0
[0.6.1]: https://github.com/tinbase/tinbase/releases/tag/v0.6.1
[0.6.0]: https://github.com/tinbase/tinbase/releases/tag/v0.6.0
[0.2.0]: https://github.com/tinbase/tinbase/releases/tag/v0.2.0
[0.1.0]: https://github.com/tinbase/tinbase/releases/tag/v0.1.0
