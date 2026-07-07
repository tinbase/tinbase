import { SiteNav } from '@/components/site-nav'
import { Code } from '@/components/code'
import { FootprintChart } from '@/components/footprint-chart'

const SECTIONS = [
  { id: 'why', label: 'Why tinbase' },
  { id: 'getting-started', label: 'Getting started' },
  { id: 'cli', label: 'CLI reference' },
  { id: 'engines', label: 'Engines' },
  { id: 'single-binary', label: 'Single binary' },
  { id: 'studio', label: 'Studio' },
  { id: 'functions', label: 'Edge Functions' },
  { id: 'rls', label: 'Row Level Security' },
  { id: 'embedding', label: 'Embedding & browser' },
  { id: 'coverage', label: 'API coverage' },
  { id: 'benchmarks', label: 'Benchmarks' },
]

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-24 border-t border-zinc-800/80 pt-10 text-2xl font-bold tracking-tight first:border-0 first:pt-0">
      {children}
    </h2>
  )
}

function Pre({ children, lang = 'bash' }: { children: string; lang?: string }) {
  return <Code code={children} lang={lang} className="rounded-lg p-4" />
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="leading-relaxed text-zinc-400">{children}</p>
}

const IC = 'rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[0.85em] text-emerald-300'

export const metadata = {
  title: 'Docs',
  description:
    'Getting started, CLI reference, engines, single-binary builds, Row Level Security, embedding in the browser, API coverage, and benchmarks for tinbase.',
  alternates: { canonical: '/docs' },
}

export default function Docs() {
  return (
    <>
      <SiteNav />
      <div className="mx-auto flex max-w-6xl gap-12 px-6 py-12">
        <aside className="sticky top-24 hidden h-fit w-52 shrink-0 lg:block">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Documentation</div>
          <nav className="mt-4 space-y-1">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="block rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800/60 hover:text-white">
                {s.label}
              </a>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 max-w-3xl space-y-6">
          <h1 className="text-4xl font-bold tracking-tight">Documentation</h1>

          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <strong className="font-semibold">Experimental.</strong> tinbase is young and moving
            fast — great for prototypes, local development, demos, and embedded/browser use. It is
            not meant for production usage yet.
          </div>

          <H2 id="why">Why tinbase</H2>
          <P>
            tinbase was built for{' '}
            <a className="text-emerald-400 hover:text-emerald-300" href="https://lifo.sh">
              lifo
            </a>{' '}
            (lifo.sh) — a project that maps Linux APIs into the browser — to let Expo apps run fully
            in the browser with full-stack capability: database, auth, storage, and realtime with no
            server behind them. It is part of{' '}
            <a className="text-emerald-400 hover:text-emerald-300" href="https://rapidnative.com">
              RapidNative
            </a>
            .
          </P>
          <P>
            That origin drives the architecture: every service is a pure{' '}
            <code className={IC}>(Request) =&gt; Response</code> fetch handler and the default
            engine is Postgres compiled to WASM, so the entire backend can run in-process inside a
            browser tab — or as a tiny server on your machine. The same design turned out to make an
            excellent standalone local Supabase replacement, so it is open source for everyone.
          </P>

          <H2 id="getting-started">Getting started</H2>
          <P>
            tinbase is a Supabase-compatible backend in a single process. In a project with a{' '}
            <code className={IC}>supabase/</code> directory (or none — it still boots):
          </P>
          <Pre>{`npx tinbase start

#   API URL: http://127.0.0.1:54321
#   anon key: eyJ...
#   service_role key: eyJ...`}</Pre>
          <P>
            Migrations in <code className={IC}>supabase/migrations/*.sql</code> and{' '}
            <code className={IC}>supabase/seed.sql</code> are applied on boot, using the same file
            conventions and tracking table as the Supabase CLI — so they remain portable to hosted
            Supabase. Then point the official SDK at it:
          </P>
          <Pre lang="ts">{`import { createClient } from '@supabase/supabase-js'
const supabase = createClient('http://127.0.0.1:54321', ANON_KEY)`}</Pre>

          <H2 id="cli">CLI reference</H2>
          <Pre>{`tinbase start      # boot the server (applies pending migrations first)
tinbase migrate    # apply pending migrations and exit
tinbase status     # list applied migrations
tinbase keys       # print anon / service_role keys
tinbase gen types  # emit a TypeScript Database type
tinbase db reset   # wipe + re-run migrations and seed
tinbase db diff    # DDL for out-of-migration schema changes

  -p, --port <n>        port (default 54321; or TINBASE_PORT / PORT env)
      --dir <path>      project dir containing supabase/ (default cwd)
      --data-dir <path> data dir (default <dir>/.tinbase/db)
      --jwt-secret <s>  JWT secret (or TINBASE_JWT_SECRET)
      --memory          in-memory database (wasm engine)
      --engine <e>      wasm (default) or native`}</Pre>

          <H2 id="engines">Engines</H2>
          <P>
            <strong className="text-zinc-200">wasm</strong> (default) runs PGlite — Postgres compiled
            to WebAssembly. Zero setup, runs anywhere Node runs including the browser; costs ~350 MB
            of RAM.
          </P>
          <P>
            <strong className="text-zinc-200">native</strong> runs embedded native Postgres 17. The
            first run downloads platform binaries (~12 MB, cached in{' '}
            <code className={IC}>~/.cache/tinbase</code>), then <code className={IC}>initdb</code>{' '}
            with memory-lean settings. ~53 MB of RAM at boot. It listens only on a private unix
            socket (0700 directory, trust auth) — never TCP. macOS and Linux on x64/arm64.
          </P>
          <P>
            Both engines run identical bootstrap, migrations, RLS, and realtime CDC. The full test
            suite passes on both: <code className={IC}>TINBASE_TEST_ENGINE=native npm test</code>.
          </P>

          <H2 id="single-binary">Single binary</H2>
          <Pre>{`npm run build:binary   # requires bun; emits dist-bin/tinbase (~57 MB)
./tinbase start        # that's the whole deployment`}</Pre>
          <P>
            One compiled executable — no Node, npm, or Docker on the target machine. It defaults to
            the native engine and serves REST, Auth, Storage, and Realtime WebSockets at 44 MB of RAM
            at boot, 64 MB under load.
          </P>

          <H2 id="studio">Studio</H2>
          <P>
            A built-in dashboard ships at <code className={IC}>/_/</code>, shaped like Supabase
            Studio (React + Radix + Tailwind). Log in with the{' '}
            <code className={IC}>service_role</code> key printed at startup:
          </P>
          <ul className="ml-5 list-disc space-y-1 text-neutral-400 text-zinc-400">
            <li>
              <b className="text-zinc-200">Table Editor</b> — browse tables with pagination and row
              counts; insert, edit, and delete rows
            </li>
            <li>
              <b className="text-zinc-200">SQL Editor</b> — run SQL with result grids and Postgres
              error details
            </li>
            <li>
              <b className="text-zinc-200">Authentication</b> — list, create, delete users, reset
              passwords
            </li>
            <li>
              <b className="text-zinc-200">Storage</b> — create/delete buckets, upload/delete
              objects, toggle public access
            </li>
            <li>
              <b className="text-zinc-200">Database</b> — stats overview and applied migrations
            </li>
          </ul>
          <P>
            It compiles to a single self-contained HTML file, so it works inside the single binary
            too.
          </P>

          <H2 id="functions">Edge Functions</H2>
          <P>
            <code className={IC}>supabase.functions.invoke()</code> runs your handlers in-process.
            A function is any fetch handler; the CLI loads them from{' '}
            <code className={IC}>supabase/functions/&lt;name&gt;/index.&#123;ts,js,mjs&#125;</code>{' '}
            (default export), or you pass them to{' '}
            <code className={IC}>createBackend(&#123; functions &#125;)</code>. Each call receives the
            verified auth context and the project&apos;s env keys.
          </P>
          <Pre lang="ts">{`// supabase/functions/hello/index.mjs
export default async function handler(req, ctx) {
  const { name = 'world' } = await req.json().catch(() => ({}))
  return new Response(
    JSON.stringify({ message: \`Hello \${name}!\`, role: ctx.auth.role }),
    { headers: { 'content-type': 'application/json' } }
  )
}`}</Pre>

          <H2 id="rls">Row Level Security</H2>
          <P>
            Every REST and Storage request runs inside a transaction with{' '}
            <code className={IC}>SET LOCAL role</code> and{' '}
            <code className={IC}>request.jwt.claims</code> applied, so policies behave exactly like
            hosted Supabase:
          </P>
          <Pre lang="sql">{`create policy "own rows" on todos
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());`}</Pre>

          <H2 id="embedding">Embedding &amp; browser</H2>
          <P>
            The core is a pure <code className={IC}>(Request) =&gt; Response</code> fetch handler.
            Serve it over HTTP in Node, or hand it to supabase-js as a custom fetch and run the whole
            backend in-process — in the browser, PGlite persists to IndexedDB/OPFS:
          </P>
          <Pre lang="ts">{`import { createBackend } from 'tinbase'

const backend = await createBackend({
  // dataDir: 'idb://my-app'   <- browser persistence
  migrations: [{ name: '20240101000000_init', sql: '...' }],
})

const supabase = createClient('http://localhost', backend.anonKey, {
  global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
})`}</Pre>

          <H2 id="coverage">API coverage</H2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-zinc-300">
                  <th className="py-2 pr-4 font-semibold">Module</th>
                  <th className="py-2 pr-4 font-semibold">Coverage</th>
                  <th className="py-2 font-semibold">Notable gaps</th>
                </tr>
              </thead>
              <tbody className="text-zinc-400">
                {[
                  ['Database (postgrest-js)', '~85%', 'aggregates in select, .explain(), .csv()'],
                  ['Auth (auth-js)', '~80%', 'MFA, SSO/SAML, phone auth'],
                  ['Storage (storage-js)', '~80%', 'resumable uploads, image transforms'],
                  ['Realtime (realtime-js)', '~85%', 'per-row DELETE RLS, private channels'],
                  ['Edge Functions', '~60%', 'Deno runtime compat, import maps'],
                  ['Type generation', '~85%', 'composite-type args, multi-schema'],
                ].map(([m, c, g]) => (
                  <tr key={m} className="border-b border-zinc-800/60">
                    <td className="py-2 pr-4 text-zinc-200">{m}</td>
                    <td className="py-2 pr-4 font-semibold text-emerald-400">{c}</td>
                    <td className="py-2">{g}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <P>
            Roughly 80% of the SDK surface overall — but ~90% of what a typical CRUD + auth + storage
            + realtime app actually calls.
          </P>

          <H2 id="benchmarks">Benchmarks</H2>
          <P>
            Same workload for every backend: boot with one migrated table, then 1,000 single-row
            inserts followed by 1,000 filtered list queries. Memory is the physical footprint of the
            whole process tree (vmmap) for native processes and the sum of docker stats for
            containers. Apple Silicon, macOS 15.
          </P>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
            <FootprintChart />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-zinc-300">
                  <th className="py-2 pr-4 font-semibold"></th>
                  <th className="py-2 pr-4 font-semibold text-emerald-400">tinbase (binary)</th>
                  <th className="py-2 pr-4 font-semibold text-emerald-400">tinbase (wasm)</th>
                  <th className="py-2 pr-4 font-semibold">PocketBase</th>
                  <th className="py-2 font-semibold">Supabase local</th>
                </tr>
              </thead>
              <tbody className="text-zinc-400">
                {[
                  ['Database', 'real Postgres 17 + RLS', 'real Postgres (PGlite) + RLS', 'SQLite', 'Postgres 17'],
                  ['Memory at boot', '44 MB', '573 MB', '16 MB', '1,441 MB'],
                  ['Memory under load', '64 MB', '347 MB', '25 MB', '1,626 MB'],
                  ['Data on disk (1k rows)', '38 MB', '39 MB', '7 MB', '70 MB'],
                  ['Install size', '92 MB, no runtime', '26 MB + Node', '30 MB', '2,291 MB + Docker'],
                  ['Processes', '2', '1', '1', '12 containers'],
                  ['1,000 inserts', '0.4 s', '0.8 s', '0.3 s', '1.1 s'],
                  ['1,000 filtered reads', '0.4 s', '0.8 s', '0.3 s', '1.0 s'],
                ].map(([label, ...cells]) => (
                  <tr key={label} className="border-b border-zinc-800/60">
                    <td className="py-2 pr-4 font-medium text-zinc-200">{label}</td>
                    {cells.map((c, i) => (
                      <td key={i} className={'py-2 pr-4' + (i < 2 ? ' text-zinc-200' : '')}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <P>
            Methodology, raw numbers, and a reproducible script live in the repo:{' '}
            <a className="text-emerald-400 hover:text-emerald-300" href="https://github.com/sanketsahu/tinbase/blob/main/bench/footprint.ts">
              bench/footprint.ts
            </a>{' '}
            and{' '}
            <a className="text-emerald-400 hover:text-emerald-300" href="https://github.com/sanketsahu/tinbase/blob/main/bench/results.json">
              bench/results.json
            </a>
            .
          </P>
        </main>
      </div>
    </>
  )
}
