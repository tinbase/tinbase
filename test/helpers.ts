import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createBackend, type TinbaseBackend } from '../src/index.js'

export const TEST_MIGRATION = `
create table authors (
  id serial primary key,
  name text not null,
  email text unique,
  meta jsonb default '{}'::jsonb
);

create table posts (
  id serial primary key,
  title text not null,
  body text,
  author_id int references authors(id),
  published boolean default false,
  views int default 0,
  tags text[] default '{}',
  search tsvector,
  created_at timestamptz default now()
);

create table categories (id serial primary key, name text not null);

create table post_categories (
  post_id int references posts(id) on delete cascade,
  category_id int references categories(id) on delete cascade,
  primary key (post_id, category_id)
);

create table secrets (
  id serial primary key,
  owner uuid default auth.uid(),
  content text
);
alter table secrets enable row level security;
create policy secrets_owner on secrets for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

create function add_numbers(a int, b int) returns int
language sql as $$ select a + b $$;

create function get_posts_by_author(author int) returns setof posts
language sql as $$ select * from posts where author_id = author $$;

create function touch_nothing() returns void
language sql as $$ select 1 $$;
`

export const TEST_SEED = `
insert into authors (name, email, meta) values
  ('Ada', 'ada@example.com', '{"country":"UK","age":36}'),
  ('Linus', 'linus@example.com', '{"country":"FI","age":54}'),
  ('Grace', 'grace@example.com', '{"country":"US","age":85}');

insert into posts (title, body, author_id, published, views, tags, search) values
  ('Analytical Engines', 'Notes on computation', 1, true, 100, '{math,history}', to_tsvector('english', 'Analytical Engines and computation')),
  ('Git Internals', 'Plumbing and porcelain', 2, true, 250, '{git,unix}', to_tsvector('english', 'Git internals plumbing')),
  ('Kernel Design', 'Monolith vs microkernel', 2, false, 50, '{unix,os}', to_tsvector('english', 'Kernel design monolith')),
  ('COBOL at Scale', 'Legacy that works', 3, true, 75, '{cobol}', to_tsvector('english', 'COBOL at scale legacy'));

insert into categories (name) values ('Computing'), ('History'), ('Unix');

insert into post_categories (post_id, category_id) values
  (1, 1), (1, 2), (2, 1), (2, 3), (3, 3), (4, 1);
`

export interface TestEnv {
  backend: TinbaseBackend
  /** anon-key client */
  supabase: SupabaseClient
  /** service-role client (bypasses RLS) */
  admin: SupabaseClient
  close: () => Promise<void>
}

/**
 * The engine the suite is running on, or undefined for the default (PGlite).
 * Tests that build their own backend should use this, otherwise they silently
 * stay on PGlite even under TINBASE_TEST_ENGINE=native.
 */
export async function testEngine() {
  // TINBASE_TEST_ENGINE=native runs the whole suite on embedded Postgres
  if (process.env.TINBASE_TEST_ENGINE !== 'native') return undefined
  const { createNativeEngine } = await import('../src/node/native/engine.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return await createNativeEngine({ dataDir: join(mkdtempSync(join(tmpdir(), 'tinbase-test-')), 'pgdata') })
}

export async function createTestEnv(): Promise<TestEnv> {
  const engine = await testEngine()

  const backend = await createBackend({
    engine,
    migrations: [{ name: '20240101000000_test_schema', sql: TEST_MIGRATION }],
    seedSql: TEST_SEED,
  })

  const fetchAdapter: typeof fetch = (input, init) => backend.fetch(new Request(input, init))

  const clientOpts = {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchAdapter },
  }
  const supabase = createClient('http://localhost:54321', backend.anonKey, clientOpts)
  const admin = createClient('http://localhost:54321', backend.serviceRoleKey, clientOpts)

  return { backend, supabase, admin, close: () => backend.close() }
}

/**
 * A port nothing is listening on, from the OS (bind to 0, read it, close).
 *
 * The CLI tests used to guess one from the worker's pid (`54300 + pid % 200`). On a machine already
 * running a tinbase (54321, 54322, ...) or with another test file's guess landing on the same number,
 * `tinbase start` moved to the next free port, while the test kept talking to the guessed one, i.e. to
 * somebody else's server, and failed with ECONNRESET when that server went away.
 */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

/**
 * fetch on a new connection every time (`Connection: close`).
 *
 * The CLI tests run commands with execFileSync between requests, which blocks this process's event
 * loop for as long as the command runs (3-6 s on a busy Mac). The server closes an idle keep-alive
 * connection after 5 s; with the loop blocked, the client never sees that close and its next request
 * reuses the dead connection: ECONNRESET, while the server is perfectly healthy.
 */
export function freshFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('connection', 'close')
  return fetch(url, { ...init, headers })
}
