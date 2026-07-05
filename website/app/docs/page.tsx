import { SiteNav } from '@/components/site-nav'
import { Code } from '@/components/code'

const SECTIONS = [
  { id: 'getting-started', label: 'Getting started' },
  { id: 'cli', label: 'CLI reference' },
  { id: 'engines', label: 'Engines' },
  { id: 'single-binary', label: 'Single binary' },
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

export const metadata = { title: 'Docs — tinbase' }

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

  -p, --port <n>        port (default 54321)
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
                  ['Auth (auth-js)', '~40%', 'OAuth, magic links, OTP, MFA, SSO'],
                  ['Storage (storage-js)', '~80%', 'resumable uploads, image transforms'],
                  ['Realtime (realtime-js)', '~70%', 'RLS-filtered fan-out, private channels'],
                  ['Edge Functions', '0%', 'everything'],
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
            Roughly 65% of the SDK surface overall — but ~90% of what a typical CRUD + auth + storage
            + realtime app actually calls.
          </P>

          <H2 id="benchmarks">Benchmarks</H2>
          <P>
            Methodology, raw numbers, and a reproducible script live in the repo:{' '}
            <a className="text-emerald-400 hover:text-emerald-300" href="https://github.com/sanketsahu/tinbase/blob/main/bench/footprint.ts">
              bench/footprint.ts
            </a>{' '}
            and{' '}
            <a className="text-emerald-400 hover:text-emerald-300" href="https://github.com/sanketsahu/tinbase/blob/main/bench/results.json">
              bench/results.json
            </a>
            . Summary: tinbase (binary, real Postgres with RLS) 44 MB boot / 64 MB under load;
            PocketBase (SQLite) 16 / 25 MB; Supabase local (Postgres) 1,441 / 1,626 MB across 12
            containers.
          </P>
        </main>
      </div>
    </>
  )
}
