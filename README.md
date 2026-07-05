# tinbase

A pure-JS, Docker-free Supabase backend built on [PGlite](https://pglite.dev) (Postgres compiled to WASM). It speaks the same wire protocols as hosted Supabase, so the **official `@supabase/supabase-js` SDK works unchanged** - REST, Auth, Storage, and Realtime.

Think PocketBase ergonomics ("one command and it just works"), but 1:1 with Supabase's APIs and migration conventions.

```
npx tinbase start
```

- **No Docker, no external services.** One runtime dependency: `@electric-sql/pglite`.
- **Real Postgres semantics.** RLS policies, `auth.uid()`, triggers, FKs - it is Postgres.
- **Supabase CLI migration conventions.** Reads `supabase/migrations/*.sql` and `supabase/seed.sql`; tracks them in `supabase_migrations.schema_migrations`. Your migration files stay portable to hosted Supabase.
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

  -p, --port <n>        port (default 54321)
      --dir <path>      project dir containing supabase/ (default cwd)
      --data-dir <path> PGlite data dir (default <dir>/.tinbase/db)
      --jwt-secret <s>  JWT secret (or TINBASE_JWT_SECRET)
      --memory          in-memory database, no persistence
```

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
| Realtime | `/realtime/v1` | Phoenix protocol (v1 JSON and v2 array/binary serializers), `postgres_changes` (INSERT/UPDATE/DELETE, filters) fed by triggers + `pg_notify`, broadcast (incl. binary payloads), presence. WebSocket server is a ~150-line RFC 6455 implementation - no `ws` dependency |

### RLS works like real Supabase

Every REST/storage request runs inside a transaction with `SET LOCAL role` and `request.jwt.claims`, so policies like this behave identically to hosted Supabase:

```sql
create policy "own rows" on todos
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
```

## Known gaps

- `postgres_changes` does not apply RLS to fan-out (all subscribers see change events); hosted Supabase filters via WALRUS.
- Spread embeds (`...rel(col)`) support flat column lists only; aggregate functions in `select` are not implemented.
- Auth: no OAuth providers, magic links, or OTP (endpoints accept and no-op); no email delivery.
- `pg_notify` payloads cap at ~8 kB - realtime events for larger rows arrive with `record: null` and an `errors` entry, like Supabase's "payload too large".
- One writer at a time (PGlite is single-connection); requests are serialized through a transaction queue. Fine for dev tools and small apps, not for high-concurrency production.

## Tests

53 integration tests + 4 realtime e2e tests run the real `@supabase/supabase-js` against the backend (REST via in-process fetch, realtime over actual WebSockets):

```bash
npm test
```

## Why

1. A lighter Supabase for local dev and self-contained apps - `npx tinbase start` instead of Docker Compose.
2. The whole backend can run **in the browser** (PGlite WASM + fetch-handler architecture), e.g. inside [lifo.sh](https://lifo.sh).
