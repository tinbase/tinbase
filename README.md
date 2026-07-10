<p align="center"><img src="assets/logo.svg" width="96" alt="tinbase logo"></p>

# tinbase

Local Supabase dev without Docker — one process, real Postgres, and it even runs in the browser. It speaks the same wire protocols as hosted Supabase, so the **official `@supabase/supabase-js` SDK works unchanged** - REST, Auth, Storage, and Realtime.

A pure-JS backend built on [PGlite](https://pglite.dev) (Postgres compiled to WASM), with an embedded-native-Postgres and an ultralight pure-JS ([`@tinbase/pg-mem`](https://www.npmjs.com/package/@tinbase/pg-mem)) engine too. One command, real Row Level Security, and 1:1 with Supabase's APIs and migration conventions.

> [!WARNING]
> **Alpha — not production-ready yet.** Great for local development, prototypes, and embedded/browser use.

```
npx tinbase start
```

- **No Docker, no external services.** One runtime dependency: `@electric-sql/pglite`.
- **Real Postgres semantics.** RLS policies, `auth.uid()`, triggers, FKs - it is Postgres.
- **Three engines, one API.** Default is embedded native Postgres 17 (macOS/Linux): ~59 MB of RAM at boot, PocketBase-class footprint, zero semantic differences; the first run downloads ~12 MB of binaries. `--engine wasm` runs PGlite (Postgres compiled to WASM) instead - portable, browser-ready, and the default on Windows. `--engine pgmem` is an ultralight pure-JS in-memory engine for local dev / previews - see [Engines](#engines).
- **Supabase CLI migration conventions.** Reads `supabase/migrations/*.sql` and `supabase/seed.sql`; tracks them in `supabase_migrations.schema_migrations`. Your migration files stay portable to hosted Supabase.
- **Runs real projects unchanged.** A project's `CREATE EXTENSION` statements for extensions tinbase can't install (pg_cron, pg_net, http, hypopg, …) are skipped rather than aborting; `CREATE INDEX CONCURRENTLY` is applied without the (transaction-illegal) `CONCURRENTLY`; each migration runs with a fresh `search_path` like the Supabase CLI; and Vault, pgmq, cron, pg_net, and `moddatetime` are emulated. As a test, [Cap-go/capgo](https://github.com/Cap-go/capgo)'s **335 migrations + seed apply and query cleanly**.
- **Browser-ready core.** Every service is a pure `(Request) => Response` fetch handler. In Node it's served over HTTP; in the browser you can hand it to supabase-js as a custom `fetch` and run the whole backend in-process (PGlite already runs in the browser via IndexedDB/OPFS).

## Quick start

```bash
# in a project with a supabase/ directory (or none - it still boots)
npx tinbase start

#   API URL: http://127.0.0.1:54321
#   anon key: eyJ...
#   service_role key: eyJ...
```

Point the ordinary supabase-js client at it:

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://127.0.0.1:54321', ANON_KEY)

await supabase.auth.signUp({ email: 'me@example.com', password: 'secret123' })
await supabase.from('todos').insert({ title: 'hello' })
const { data } = await supabase.from('todos').select('*, author:users(name)').eq('done', false)

supabase
  .channel('feed')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'todos' }, console.log)
  .subscribe()
```

### CLI

```
tinbase start      # boot the server (applies pending migrations first)
tinbase migrate    # apply pending migrations and exit
tinbase status     # list applied migrations
tinbase keys       # print anon / service_role keys
tinbase gen types  # print a TypeScript Database type for the schema
tinbase db reset   # wipe the database + storage, re-run migrations and seed
tinbase db diff    # DDL for schema changes not yet in migrations (-f <name> to save one)

  -p, --port <n>        port (default 54321; or TINBASE_PORT / PORT env)
      --dir <path>      project dir containing supabase/ (default cwd)
      --data-dir <path> PGlite data dir (default <dir>/.tinbase/db)
      --jwt-secret <s>  JWT secret (or TINBASE_JWT_SECRET)
      --memory          in-memory database, no persistence (wasm engine)
      --engine <e>      native (default), wasm, or pgmem
```

### Engines

- **native** (default on macOS/Linux): embedded native Postgres 17. First run downloads platform binaries (~12 MB, from [theseus-rs/postgresql-binaries](https://github.com/theseus-rs/postgresql-binaries), cached in `~/.cache/tinbase`), then `initdb` with memory-lean settings. ~59 MB RAM at boot. Listens only on a private unix socket (0700 dir, trust auth) - never TCP. macOS/Linux on x64/arm64.
- **wasm** (default on Windows): PGlite. Zero setup, runs anywhere Node runs - and in the browser. Its WASM heap sits around ~575-650 MB and does not shrink under load.

- **pgmem** (`--engine pgmem`): an ultralight, pure-JS, in-memory engine via [`@tinbase/pg-mem`](https://www.npmjs.com/package/@tinbase/pg-mem) — our fork of [pg-mem](https://github.com/oguimbal/pg-mem) — **no WASM**, so it's the lightest option for the browser (RapidNative local-dev / previews). The fork adds the Postgres surface real projects rely on: **PL/pgSQL, triggers, row-level-security policies, correlated subqueries, `information_schema` constraints, MERGE, range/full-text types, and declarative partitioning**. A full Supabase-style bootstrap and real migration sets now apply **unchanged — nothing skipped** (RLS/trigger/PL-pgSQL DDL runs). Runs the REST CRUD surface, email/password auth, **edge functions, realtime (broadcast/presence + `postgres_changes`), and database webhooks**. Caveats vs the Postgres engines: `LISTEN`/`NOTIFY` are no-ops, so realtime/webhook change events are synthesized in JS by the REST layer (every write goes through it in-process); the engine runs with superuser rights, so **RLS policies are created but not enforced per-request** (events are delivered unfiltered, not per-subscriber); **cron** and **pgmq** are absent. Local-dev / preview only — never production.

The wasm and native engines run the identical bootstrap, migrations, RLS, and realtime CDC - the test suite passes on both (`TINBASE_TEST_ENGINE=native npm test`).

### Single-binary build

```bash
npm run build:binary   # requires bun; emits dist-bin/tinbase (~58 MB)

./tinbase start        # that's the whole deployment
```

One compiled executable, no Node or npm on the target machine. It defaults to the native engine (Postgres binaries auto-download on first run, 12 MB) and serves everything - REST, Auth, Storage, Realtime WebSockets - at ~49 MB of RAM at boot (~66 MB under load). Runs under Bun's runtime via a Bun-native server (`Bun.serve` + built-in WebSockets); the same CLI on Node uses the node:http server.

## Embedding (Node or browser)

```ts
import { createBackend } from 'tinbase'

const backend = await createBackend({
  // dataDir: 'idb://my-app'  <- browser persistence
  migrations: [{ name: '20240101000000_init', sql: 'create table notes (...)' }],
})

// supabase-js talks to it in-process - no HTTP server, no network
const supabase = createClient('http://localhost', backend.anonKey, {
  global: { fetch: (input, init) => backend.fetch(new Request(input, init)) },
})
```

Node-only helpers live in `tinbase/node`:

```ts
import { serve, FsStorageDriver, loadSupabaseProject } from 'tinbase/node'

const project = await loadSupabaseProject(process.cwd())
const backend = await createBackend({ ...project, storageDriver: new FsStorageDriver('./files') })
const server = await serve(backend, { port: 54321 })
```

## What's implemented

| Service | Endpoint | Coverage |
| --- | --- | --- |
| REST (PostgREST) | `/rest/v1` | select with embedded resources (to-one, to-many, many-to-many via junction, nested, `!inner`, aliases, hints, casts, JSON paths), all common filter operators incl. `or`/`and` trees, full-text search, order/limit/offset (top-level and per-embed), `single`/`maybeSingle`, `count`, insert/bulk insert, upsert (merge/ignore), update, delete, `Prefer` handling, RPC (scalar, `setof`, void, filters on results), PostgREST-shaped errors |
| Auth (GoTrue) | `/auth/v1` | email/password signup + sign-in, anonymous sign-in, session refresh with rotation, `getUser`, `updateUser`, sign-out, admin user CRUD (service key), GoTrue-shaped errors. JWTs are HS256 via WebCrypto; passwords are PBKDF2 |
| Storage | `/storage/v1` | bucket CRUD, upload (raw + multipart), download, public objects, signed URLs, signed upload URLs, list with folder entries, move/copy, remove, size/MIME limits. Metadata lives in `storage.objects` with RLS enforced; bytes go through a pluggable driver (fs in Node, memory anywhere) |
| Edge Functions | `/functions/v1` | `supabase.functions.invoke()` - Supabase-style `Deno.serve(handler)` functions (with `Deno.env`) run unchanged, as do `export default` handlers; loaded from `supabase/functions/<name>/index.{ts,js,mjs}` by the CLI or passed via `createBackend({ functions })`. Web-API functions work as-is; `npm:`/`jsr:`/URL imports still need bundling |
| Queues (pgmq) | `pgmq.*` | Message queues via a pure-SQL pgmq subset (create/send/read/pop/delete/archive, visibility timeouts). Call from SQL or `supabase.schema('pgmq').rpc(...)`. No extension |
| Cron | `cron.*` | Scheduled jobs, drop-in with pg_cron's API — `cron.schedule(name, '*/5 * * * *', 'sql')` (also the `'N seconds'` form), `cron.unschedule(...)`, and the `cron.job` / `cron.job_run_details` tables. Schedules match in **UTC**, like hosted pg_cron; an in-process scheduler runs due jobs and logs to `cron.job_run_details`. Jobs run while tinbase is up, with service-role privileges. No extension |
| HTTP from SQL (pg_net) | `net.*` | `net.http_post` / `net.http_get` / `net.http_delete(...)` enqueue a request that an in-process worker sends, recording the reply in `net._http_response`. Lets a cron job or trigger call an Edge Function or any URL — the common Supabase `cron.schedule(..., $$ select net.http_post(...) $$)` pattern works unchanged. No extension |
| Database Webhooks | config | Fire HTTP requests on table INSERT/UPDATE/DELETE with Supabase's exact payload (`type`/`table`/`schema`/`record`/`old_record`). Configured via `createBackend({ webhooks })`, `backend.webhooks.register()`, or `supabase/webhooks.json`. Built on the CDC pipeline — no extension needed |
| Studio (Admin UI) | `/_/` | A Supabase-Studio-style dashboard (React + Radix + Tailwind): Table Editor with full row CRUD, SQL editor, user management, bucket/object CRUD, and a database overview. One self-contained HTML file (works in the single binary); log in with the service_role key |
| Realtime | `/realtime/v1` | Phoenix protocol (v1 JSON and v2 array/binary serializers), `postgres_changes` (INSERT/UPDATE/DELETE, filters) fed by triggers + `pg_notify`, broadcast (incl. binary payloads), presence. WebSocket server is a ~150-line RFC 6455 implementation - no `ws` dependency |

### RLS works like real Supabase

Every REST/storage request runs inside a transaction with `SET LOCAL role` and `request.jwt.claims`, so policies like this behave identically to hosted Supabase:

```sql
create policy "own rows" on todos
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
```

## Studio

tinbase ships with a built-in dashboard at [`/_/`](http://127.0.0.1:54321/_/) - the same shape as Supabase Studio:

- **Table Editor** - browse tables with pagination and row counts; insert, edit, and delete rows (type-aware, primary-key based)
- **SQL Editor** - run arbitrary SQL with result grids and Postgres error details
- **Authentication** - list, create, delete users and reset passwords
- **Storage** - create/delete buckets, upload/delete objects, toggle public access
- **RLS Policies** - list, create, and drop policies per table
- **Database** - stats, migrations, functions, and triggers

It is a React app compiled to a single self-contained HTML file, so it also works inside the single binary. Sign in with the `service_role` key printed at startup.

## Extensions

The extensions Supabase enables by default are available out of the box, so migrations that call `uuid_generate_v4()`, `gen_random_uuid()`, `crypt()`, `citext`, `pg_trgm`, and friends just work: **uuid-ossp, pgcrypto, citext, pg_trgm, ltree, hstore, fuzzystrmatch**. They live in the `extensions` schema (like hosted Supabase) and are on the search path, so both qualified and unqualified calls resolve.

## Typed clients

Generate a Supabase-shaped `Database` type from the live schema, the same as `supabase gen types typescript`:

```bash
tinbase gen types typescript > database.types.ts
```

```ts
import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
const supabase = createClient<Database>(url, anonKey)  // fully typed queries
```

Emits Tables (Row/Insert/Update/Relationships), Views, Functions, and Enums.

## Footprint: tinbase vs PocketBase vs Supabase local

![Memory footprint comparison](assets/footprint.svg)

Measured on an Apple Silicon Mac (48 GB), macOS 15. Same workload for all three: boot with one migrated table, then 1,000 single-row inserts followed by 1,000 filtered list queries. Memory is physical footprint (`vmmap`) for native processes and the sum of `docker stats` for containers. Reproduce with [`bench/footprint.ts`](bench/footprint.ts); raw numbers in [`bench/results.json`](bench/results.json).

| | tinbase (single binary) | tinbase (native) | tinbase (pg-mem) | tinbase (wasm) | PocketBase v0.39.5 | Supabase local |
| --- | --- | --- | --- | --- | --- | --- |
| Database | real Postgres 17 + RLS | real Postgres 17 + RLS | in-memory, pure-JS¹ | real Postgres (PGlite) + RLS | SQLite | Postgres 17 |
| Runtime memory at boot | 49 MB | 59 MB | 71 MB | ~610 MB² | 15 MB | 1,441 MB |
| Runtime memory after workload | 66 MB | 100 MB | 185 MB | ~640 MB² | 24 MB | 1,626 MB |
| Data on disk (1k rows) | 39 MB | 39 MB | 0 (in-memory) | 40 MB | 7 MB | 70 MB |
| Install size | 92 MB (58 MB binary + PG) | 36 MB³ | 3.6 MB³ | 27 MB³ | 30 MB | 2,291 MB⁴ |
| Processes | 2 | 2 | 1 | 1 | 1 | 12 containers + Docker |
| 1,000 inserts | 0.4 s | 0.5 s | 0.8 s | 0.8 s | 0.3 s | 1.1 s |
| 1,000 filtered reads | 0.3 s | 0.4 s | 0.8 s | 0.9 s | 0.3 s | 1.0 s |

¹ **pgmem** is a pure-JS in-memory engine (local dev / preview) via the [`@tinbase/pg-mem`](https://www.npmjs.com/package/@tinbase/pg-mem) fork. It now runs PL/pgSQL, triggers and RLS-policy DDL (migrations apply unchanged, nothing skipped), but the engine runs as superuser so RLS isn't enforced per-request (realtime/webhook events are unfiltered), and **cron**/**pgmq** are absent. Pure JS (no WASM), the lightest option for the browser. See [Engines](#engines).
² The wasm figure is essentially PGlite's WASM heap, which measures anywhere in ~575–650 MB depending on GC timing — treat it as a band, not a point. It does not shrink under load.
³ Native: Postgres 17 binaries + `dist`. pg-mem: `dist` + `pg-mem`. Wasm: `dist` + `@electric-sql/pglite`. All exclude the Node runtime you already have.
⁴ Sum of the Docker image sizes the default local stack runs, excluding Docker Desktop itself.

**How to read this honestly:**

- **vs Supabase local**: same SDK, same APIs, ~16-24x less memory (native engine / single binary), ~25-65x smaller install, 2 processes instead of a 12-container stack, and boots in ~2 s instead of a minute. That's the entire point of the project.
- **vs PocketBase**: the single binary lands in PocketBase's weight class - ~2.7x the RAM (66 vs 24 MB under load), one downloadable file, no runtime prerequisite - while running *real Postgres* (RLS, jsonb, FKs, triggers) behind Supabase's exact wire APIs, so your code and migration files move to hosted Supabase unchanged. PocketBase is still the lightest option if you don't need any of that.
- The wasm engine trades memory for portability: its ~575-650 MB is PGlite's WASM heap (the API layers add single-digit MB), and it's the only engine that runs in a browser. On servers, use the native engine or single binary.

## How complete is it?

Rough coverage of the supabase-js SDK surface, measured against what each sub-library can express (all "supported" claims are exercised by the test suite):

| Module | Coverage | Supported | Missing |
| --- | --- | --- | --- |
| Database (`postgrest-js`) | ~85% | full filter grammar, embeds (to-one/to-many/m2m/nested/`!inner`), JSON paths, upsert, count, single/maybeSingle, RPC | aggregates in select, full spread embeds, `.explain()`, `.csv()`, geojson |
| Auth (`auth-js`) | ~80% | email/password, anonymous sign-in, OTP + magic links + password recovery (pluggable mailer), OAuth providers (Google/GitHub presets + generic) with PKCE and identity linking, refresh rotation, user updates, admin CRUD | MFA, SSO/SAML, phone auth |
| Storage (`storage-js`) | ~80% | buckets, upload/download, signed URLs + signed uploads, list/move/copy/remove, size/MIME limits | resumable (TUS) uploads, image transformations |
| Realtime (`realtime-js`) | ~85% | postgres_changes with filters + **per-subscriber RLS filtering** (INSERT/UPDATE), broadcast (incl. binary), presence, v1+v2 serializers | per-row DELETE RLS, private channel auth, DB-triggered broadcast |
| Edge Functions (`functions-js`) | ~70% | `invoke()`; **Deno.serve/Deno.env-style functions run unchanged** + export-default; auth context, project-dir loading | `npm:`/`jsr:`/URL import resolution, `supabase functions deploy` |
| Type generation | ~85% | `tinbase gen types typescript` → `Database` type (Tables/Views/Functions/Enums/Relationships) | composite-type args, multi-schema output |

**Overall: roughly 80% of the supabase-js SDK surface - and ~90% of what a typical CRUD + auth + storage + realtime app actually calls.**

Beyond the client SDK, the local platform features real projects depend on also work: **type generation**, **RLS** (enforced on REST, Storage, and realtime), **database webhooks**, **cron**, **queues (pgmq)**, the **Studio** dashboard, and Supabase-CLI migration conventions (`db reset` / `db diff`). The remaining gaps are OAuth logins' provider variety, the Deno edge-function runtime, and pgvector (needs an extension binary).

## Known gaps

- `postgres_changes` applies RLS per subscriber for INSERT/UPDATE (the row is re-checked by primary key as that user). DELETE events can't be re-queried (the row is gone), so they are delivered to authenticated/service subscribers but not filtered per-row — hosted Supabase does this via WAL-level policy evaluation (WALRUS).
- Spread embeds (`...rel(col)`) support flat column lists only; aggregate functions in `select` are not implemented.
- Auth: OAuth works for any OAuth2/OIDC provider (Google & GitHub have built-in presets; configure via `TINBASE_OAUTH_<PROVIDER>_CLIENT_ID`/`_CLIENT_SECRET`). Still missing: MFA, SSO/SAML, phone auth. OTP/magic-link/recovery emails go through a pluggable `mailer` (default logs to console).
- `pg_notify` payloads cap at ~8 kB - realtime events for larger rows arrive with `record: null` and an `errors` entry, like Supabase's "payload too large".
- One writer at a time: PGlite is single-connection, and the native engine currently serializes requests over one connection for parity (a connection pool is a straightforward future upgrade). Fine for dev tools and small apps, not for high-concurrency production.

## Tests

The integration suite drives the real `@supabase/supabase-js` against the backend (REST via in-process fetch, realtime over actual WebSockets); the full suite — **168 tests** — passes on both the wasm and native engines:

```bash
npm test
```

## Roadmap

tinbase aims to be a local, Docker-free replacement for `supabase start` where **almost everything just works**. The North Star, the in-scope/out-of-scope line, the current coverage table, and the phased plan live in [ROADMAP.md](ROADMAP.md).

## Why

tinbase was built for [lifo](https://lifo.sh) - a project that maps Linux APIs into the browser - to let **Expo apps run fully in the browser with full-stack capability** (database, auth, storage, realtime, no server). It is part of [RapidNative](https://rapidnative.com). That origin drives the architecture:

1. Every service is a pure fetch handler, and the `wasm` engine is Postgres compiled to WASM (PGlite), so with it the whole backend can run **in-process inside a browser tab**.
2. The same design makes a lighter Supabase for local dev and self-contained apps - `npx tinbase start` instead of Docker Compose.
