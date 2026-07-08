import Link from 'next/link'
import { SiteNav } from '@/components/site-nav'
import { Code } from '@/components/code'
import { WeightChart } from '@/components/weight-chart'
import { FeatureMatrix } from '@/components/feature-matrix'
import { ArchitectureDiagram } from '@/components/architecture-diagram'

const SECTIONS = [
  { id: 'why', label: 'Why tinbase' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'getting-started', label: 'Getting started' },
  { id: 'cli', label: 'CLI reference' },
  { id: 'engines', label: 'Engines' },
  { id: 'single-binary', label: 'Single binary' },
  { id: 'studio', label: 'Studio' },
  { id: 'functions', label: 'Edge Functions' },
  { id: 'automation', label: 'Webhooks, cron & queues' },
  { id: 'types', label: 'Typed clients' },
  { id: 'rls', label: 'Row Level Security' },
  { id: 'embedding', label: 'Embedding & browser' },
  { id: 'feature-completeness', label: 'Feature completeness' },
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

function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={`leading-relaxed text-zinc-400${className ? ' ' + className : ''}`}>{children}</p>
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

          <H2 id="why">Why tinbase</H2>
          <P>
            tinbase came out of{' '}
            <a className="text-emerald-400 hover:text-emerald-300" href="https://lifo.sh">
              lifo
            </a>{' '}
            and{' '}
            <a className="text-emerald-400 hover:text-emerald-300" href="https://rapidnative.com">
              RapidNative
            </a>{' '}
            with a hard goal: run an entire dev stack — database, auth, storage, realtime — in the
            browser and on phones, with no VMs and no cloud behind it. The first step was cutting the
            memory overhead of running that backend locally; the next was making the same backend run
            in-process inside a browser tab.
          </P>
          <P>
            That is why every service is a pure <code className={IC}>(Request) =&gt; Response</code>{' '}
            fetch handler and the database can be pure JavaScript. Along the way it became a
            Docker-free, drop-in replacement for local Supabase development that covers most use cases
            — so it is open source for everyone.
          </P>

          <H2 id="architecture">Architecture</H2>
          <P>
            The official <code className={IC}>supabase-js</code> SDK talks to a single{' '}
            <code className={IC}>(Request) =&gt; Response</code> fetch handler. That handler routes to the service
            implementations — PostgREST-compatible REST, GoTrue-compatible auth, Storage, the Realtime Phoenix
            protocol, Edge Functions, and the Studio admin API — and every one of them sits on a single swappable{' '}
            <code className={IC}>DbEngine</code> adapter. Swap the engine (PGlite / native / pg-mem) without changing a
            line above it. In Node the handler is wrapped in an HTTP + WebSocket server; in the browser you call it
            in-process — see <Link className="text-emerald-400 hover:text-emerald-300" href="/browser">running in the browser</Link>.
          </P>
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
            <ArchitectureDiagram />
          </div>

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
      --engine <e>      wasm (default), native, or pgmem`}</Pre>

          <H2 id="engines">Engines</H2>
          <P>
            <strong className="text-zinc-200">wasm</strong> (default) runs PGlite — Postgres compiled
            to WebAssembly. Zero setup, runs anywhere Node runs including the browser. Its WASM heap
            sits around ~575–650 MB and does not shrink under load.
          </P>
          <P>
            <strong className="text-zinc-200">native</strong> runs embedded native Postgres 17. The
            first run downloads platform binaries (~12 MB, cached in{' '}
            <code className={IC}>~/.cache/tinbase</code>), then <code className={IC}>initdb</code>{' '}
            with memory-lean settings. ~59 MB of RAM at boot. It listens only on a private unix
            socket (0700 directory, trust auth) — never TCP. macOS and Linux on x64/arm64.
          </P>
          <P>
            <strong className="text-zinc-200">pgmem</strong> is an ultralight, pure-JS, in-memory
            subset via <a className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300" href="https://github.com/oguimbal/pg-mem">pg-mem</a> —
            a <strong className="text-zinc-200">~3.6 MB install with no WASM</strong>, the lightest
            option for the browser (RapidNative local-dev and previews). It runs the REST CRUD surface,
            email/password auth, <strong className="text-zinc-200">edge functions, realtime
            (broadcast/presence + <code className={IC}>postgres_changes</code>), and database webhooks</strong>.
            pg-mem has no triggers or LISTEN/NOTIFY, so realtime and webhook change events are
            synthesized in JS by the REST layer (every write passes through it in-process). What&apos;s{' '}
            <em>not</em> here: <strong className="text-zinc-200">RLS</strong> (so realtime/webhook events
            are delivered unfiltered, not per-subscriber), <strong className="text-zinc-200">cron</strong>,
            and <strong className="text-zinc-200">pgmq</strong> — RLS DDL in migrations is skipped, not
            fatal. Local-dev / preview only — never production.
          </P>
          <P>
            The wasm and native engines run identical bootstrap, migrations, RLS, and realtime CDC.
            The full test suite passes on both:{' '}
            <code className={IC}>TINBASE_TEST_ENGINE=native npm test</code>.
          </P>

          <H2 id="single-binary">Single binary</H2>
          <Pre>{`npm run build:binary   # requires bun; emits dist-bin/tinbase (~57 MB)
./tinbase start        # that's the whole deployment`}</Pre>
          <P>
            One compiled executable — no Node, npm, or Docker on the target machine. It defaults to
            the native engine and serves REST, Auth, Storage, and Realtime WebSockets at ~49 MB of RAM
            at boot, ~66 MB under load.
          </P>

          <H2 id="studio">Studio</H2>
          <P>
            A built-in dashboard ships at <code className={IC}>/_/</code>, shaped like Supabase
            Studio (React + Radix + Tailwind). Log in with the{' '}
            <code className={IC}>service_role</code> key printed at startup. See the{' '}
            <Link className="text-emerald-400 hover:text-emerald-300" href="/studio">full Studio tour with screenshots</Link>:
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
            Supabase-style <code className={IC}>Deno.serve(handler)</code> functions (with{' '}
            <code className={IC}>Deno.env</code>) run unchanged, as do <code className={IC}>export default</code>{' '}
            handlers. The CLI loads them from{' '}
            <code className={IC}>supabase/functions/&lt;name&gt;/index.&#123;ts,js,mjs&#125;</code>, or
            pass them to <code className={IC}>createBackend(&#123; functions &#125;)</code>. Functions
            using only Web APIs work as-is; <code className={IC}>npm:</code>/<code className={IC}>jsr:</code>/URL
            imports still need a bundling step.
          </P>
          <Pre lang="ts">{`// supabase/functions/hello/index.mjs
Deno.serve(async (req) => {
  const { name = 'world' } = await req.json().catch(() => ({}))
  return new Response(
    JSON.stringify({ message: \`Hello \${name}!\` }),
    { headers: { 'content-type': 'application/json' } }
  )
})`}</Pre>

          <H2 id="automation">Webhooks, cron &amp; queues</H2>
          <P>
            The automation layer works with no extension on either engine — tinbase implements it
            natively rather than needing pg_net/pg_cron/pgmq installed.
          </P>
          <P>
            <b className="text-zinc-200">Database webhooks</b> fire an HTTP request when rows change,
            with Supabase&apos;s exact payload (<code className={IC}>type/table/schema/record/old_record</code>).
            Configure via <code className={IC}>createBackend(&#123; webhooks &#125;)</code>,{' '}
            <code className={IC}>backend.webhooks.register()</code>, or <code className={IC}>supabase/webhooks.json</code>.
          </P>
          <P>
            <b className="text-zinc-200">Cron</b> — drop-in with pg_cron&apos;s API:{' '}
            <code className={IC}>select cron.schedule(&apos;nightly&apos;, &apos;0 0 * * *&apos;, &apos;delete from logs&apos;)</code>{' '}
            (also the <code className={IC}>&apos;N seconds&apos;</code> form), <code className={IC}>cron.unschedule(...)</code>,
            and the <code className={IC}>cron.job</code> / <code className={IC}>cron.job_run_details</code> tables.
            An in-process scheduler runs due jobs and logs each run.
          </P>
          <P>
            Two behaviours differ from hosted pg_cron, and both matter. Schedules are evaluated in the
            server&apos;s <b className="text-zinc-200">local timezone</b> — hosted pg_cron runs in UTC, so a{' '}
            <code className={IC}>0 0 * * *</code> job fires at local midnight here, not UTC. And there is{' '}
            <b className="text-zinc-200">no <code className={IC}>pg_net</code></b>: a job can&apos;t make an
            outbound HTTP request, so the common Supabase pattern of{' '}
            <code className={IC}>cron.schedule(..., $$ select net.http_post(...) $$)</code> won&apos;t run.
            Schedule SQL (call a function, <code className={IC}>pgmq.send</code>, a cleanup query), and use{' '}
            <b className="text-zinc-200">Database Webhooks</b> for change-driven HTTP. Jobs also run only while
            tinbase is up (no catch-up of missed runs) and execute with service-role privileges (RLS bypassed).
            Cron runs on the wasm and native engines, not pg-mem.
          </P>
          <P>
            <b className="text-zinc-200">Queues</b> — a pgmq subset: call from SQL or the client.
          </P>
          <Pre lang="ts">{`await supabase.schema('pgmq').rpc('send', { queue_name: 'jobs', msg: { task: 'email' } })
const { data } = await supabase.schema('pgmq').rpc('read', { queue_name: 'jobs', vt: 30, qty: 5 })`}</Pre>

          <H2 id="types">Typed clients</H2>
          <P>
            Generate a Supabase-shaped <code className={IC}>Database</code> type from the live schema,
            the same as <code className={IC}>supabase gen types typescript</code>:
          </P>
          <Pre lang="bash">{`tinbase gen types typescript > database.types.ts`}</Pre>
          <Pre lang="ts">{`import type { Database } from './database.types'
const supabase = createClient<Database>(url, anonKey)  // fully typed queries`}</Pre>

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
            backend in-process — in the browser, PGlite persists to IndexedDB/OPFS. There&apos;s a{' '}
            <Link className="text-emerald-400 hover:text-emerald-300" href="/browser">dedicated guide to running in the browser</Link>{' '}
            (including the lighter pure-JS pg-mem engine):
          </P>
          <Pre lang="ts">{`import { createBackend } from 'tinbase'

const backend = await createBackend({
  // dataDir: 'idb://my-app'   <- browser persistence
  migrations: [{ name: '20240101000000_init', sql: '...' }],
})

const supabase = createClient('http://localhost', backend.anonKey, {
  global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
})`}</Pre>

          <H2 id="feature-completeness">Feature completeness</H2>
          <P>
            Where tinbase stands against the Supabase surface, mapped from the{' '}
            <a className="text-emerald-400 hover:text-emerald-300" href="https://github.com/sanketsahu/tinbase/blob/main/ROADMAP.md">
              roadmap
            </a>
. <span className="text-emerald-400">✓ Yes</span>{' '}
            means it&apos;s implemented and covered by the test suite against the real supabase-js;{' '}
            <span className="text-amber-400">◑ Partial</span> and{' '}
            <span className="text-zinc-400">– Planned</span> are honest about the rest.
          </P>
          <FeatureMatrix />

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
                  ['Edge Functions', '~70%', 'npm:/jsr: import resolution, secrets'],
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
            Roughly 80% of the supabase-js SDK surface overall — and ~90% of what a typical CRUD +
            auth + storage + realtime app actually calls.
          </P>
          <P className="mt-3">
            Beyond the client SDK, the local platform features real projects rely on also work:{' '}
            <b className="text-zinc-200">type generation</b>, <b className="text-zinc-200">RLS</b>{' '}
            (enforced on REST, Storage, and realtime), <b className="text-zinc-200">database webhooks</b>,{' '}
            <b className="text-zinc-200">cron</b>, <b className="text-zinc-200">queues (pgmq)</b>,{' '}
            the <b className="text-zinc-200">Studio</b> dashboard, and Supabase-CLI migration
            conventions with <code className={IC}>db reset</code> / <code className={IC}>db diff</code>.
          </P>

          <H2 id="benchmarks">Benchmarks</H2>
          <P>
            Same workload for every backend: boot with one migrated table, then 1,000 single-row
            inserts followed by 1,000 filtered list queries. Memory is the physical footprint of the
            whole process tree (vmmap) for native processes and the sum of docker stats for
            containers. Apple Silicon, macOS 15.
          </P>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
            <WeightChart />
          </div>
          <P>
            The two axes tell different stories: pg-mem uses the most RAM under load of the tinbase
            engines, yet is by far the lightest to <em>ship</em> — a 3.6 MB pure-JS install with no
            WASM and no native binary, ideal for the browser and embedded previews.
          </P>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-zinc-300">
                  <th className="py-2 pr-4 font-semibold"></th>
                  <th className="py-2 pr-4 font-semibold text-emerald-400">tinbase (binary)</th>
                  <th className="py-2 pr-4 font-semibold text-emerald-400">tinbase (native)</th>
                  <th className="py-2 pr-4 font-semibold text-emerald-400">tinbase (pg-mem)</th>
                  <th className="py-2 pr-4 font-semibold text-emerald-400">tinbase (wasm)</th>
                  <th className="py-2 pr-4 font-semibold">PocketBase</th>
                  <th className="py-2 font-semibold">Supabase local</th>
                </tr>
              </thead>
              <tbody className="text-zinc-400">
                {[
                  ['Database', 'real Postgres 17 + RLS', 'real Postgres 17 + RLS', 'in-memory subset', 'real Postgres (PGlite) + RLS', 'SQLite', 'Postgres 17'],
                  ['Memory at boot', '49 MB', '59 MB', '71 MB', '~610 MB', '15 MB', '1,441 MB'],
                  ['Memory under load', '66 MB', '100 MB', '185 MB', '~640 MB', '24 MB', '1,626 MB'],
                  ['Data on disk (1k rows)', '39 MB', '39 MB', '0 (in-memory)', '40 MB', '7 MB', '70 MB'],
                  ['Install size', '92 MB, no runtime', '36 MB + Node', '3.6 MB + Node', '27 MB + Node', '30 MB', '2,291 MB + Docker'],
                  ['Processes', '2', '2', '1', '1', '1', '12 containers'],
                  ['1,000 inserts', '0.4 s', '0.5 s', '0.8 s', '0.8 s', '0.3 s', '1.1 s'],
                  ['1,000 filtered reads', '0.3 s', '0.4 s', '0.8 s', '0.9 s', '0.3 s', '1.0 s'],
                ].map(([label, ...cells]) => (
                  <tr key={label} className="border-b border-zinc-800/60">
                    <td className="py-2 pr-4 font-medium text-zinc-200">{label}</td>
                    {cells.map((c, i) => (
                      <td key={i} className={'py-2 pr-4' + (i < 4 ? ' text-zinc-200' : '')}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <P className="text-xs text-zinc-500">
            The wasm figure is essentially PGlite&apos;s WASM heap, which measures anywhere in
            ~575–650 MB depending on GC timing — treat it as a band, not a point. pg-mem is a pure-JS
            in-memory subset (no RLS, cron, or pgmq; realtime/webhooks work but deliver unfiltered) but
            a 3.6 MB install with no WASM, the lightest option for the browser.
          </P>
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
