# Changelog

All notable changes to tinbase are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow semver
(pre-1.0, minor bumps may include breaking changes).

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

[0.6.1]: https://github.com/tinbase/tinbase/releases/tag/v0.6.1
[0.6.0]: https://github.com/tinbase/tinbase/releases/tag/v0.6.0
[0.2.0]: https://github.com/tinbase/tinbase/releases/tag/v0.2.0
[0.1.0]: https://github.com/tinbase/tinbase/releases/tag/v0.1.0
