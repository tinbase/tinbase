# Changelog

All notable changes to tinbase are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow semver
(pre-1.0, minor bumps may include breaking changes).

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
