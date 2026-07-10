import Link from 'next/link'
import { SiteNav } from '@/components/site-nav'
import { Code } from '@/components/code'
import { LinkButton } from '@/components/ui'
import { ArchitectureDiagram } from '@/components/architecture-diagram'

export const metadata = {
  title: 'In the browser',
  description:
    'tinbase is a pure fetch handler, so the whole backend — database, auth, storage, realtime — can run in-process inside a browser tab, no server.',
  alternates: { canonical: '/browser' },
}

const IN_PROCESS = `import { createClient } from '@supabase/supabase-js'
import { createBackend, createPgmemEngine } from 'tinbase'

// a whole backend — in memory, inside the page
const backend = await createBackend({
  engine: await createPgmemEngine(),   // pure JS, nothing to download
  migrations: [{
    name: 'init',
    sql: 'create table todos (id serial primary key, text text, done boolean default false)',
  }],
})

// hand it to supabase-js as a custom fetch — no server, no network
const supabase = createClient('http://localhost', backend.anonKey, {
  global: { fetch: (input, init) => backend.fetch(new Request(input, init)) },
})

await supabase.from('todos').insert({ text: 'ship it' })
const { data } = await supabase.from('todos').select()`

const PGLITE = `import { createBackend } from 'tinbase'

// omit \`engine\` → PGlite (real Postgres in WASM).
// persist across reloads with an IndexedDB-backed data dir:
const backend = await createBackend({ dataDir: 'idb://my-app' })`

const ENGINES = [
  ['Footprint', '~6.7 MB install · pure JS · no WASM', '~575–650 MB heap · WASM'],
  ['Fidelity', 'CRUD, auth, functions, realtime, webhooks + PL/pgSQL, triggers, RLS policies', 'full Postgres — enforced RLS, extensions'],
  ['Persistence', 'in-memory', 'IndexedDB / OPFS'],
  ['Best for', 'phones, previews, the lightest embed', 'full Postgres parity in the browser'],
]

export default function BrowserPage() {
  return (
    <>
      <SiteNav />
      <main className="mx-auto max-w-5xl px-6 py-16">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent">In the browser</p>
        <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          The whole backend, in a tab
        </h1>
        <p className="mt-5 max-w-2xl text-pretty text-lg text-muted">
          Every tinbase service is a pure{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-sm text-accent">
            (Request) ⇒ Response
          </code>{' '}
          fetch handler. There is no HTTP layer to stand up — hand the handler to supabase-js as its{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-sm text-accent">fetch</code> and the
          database, auth, storage, and realtime all run <span className="text-fg">in-process</span>, inside the
          page. No server. No network round-trip.
        </p>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-fg">Run it in-process</h2>
          <p className="mt-2 max-w-2xl text-[15px] text-muted">
            The same <code className="font-mono text-sm text-accent">supabase-js</code> you use everywhere, pointed
            at a backend that lives in the same JavaScript heap:
          </p>
          <div className="mt-4">
            <Code code={IN_PROCESS} lang="ts" />
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-xl font-semibold text-fg">Pick an engine for the browser</h2>
          <p className="mt-2 max-w-2xl text-[15px] text-muted">
            Two of the three engines run in a browser. <span className="text-fg">pg-mem</span> is pure JavaScript
            and the lightest thing to embed; <span className="text-fg">PGlite</span> is real Postgres compiled to
            WASM when you want full fidelity.
          </p>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-fg">
                  <th className="py-2 pr-4 font-semibold"></th>
                  <th className="py-2 pr-4 font-semibold text-accent">pg-mem</th>
                  <th className="py-2 font-semibold text-accent">PGlite (wasm)</th>
                </tr>
              </thead>
              <tbody className="text-muted">
                {ENGINES.map(([label, a, b]) => (
                  <tr key={label} className="border-b border-border">
                    <td className="py-2 pr-4 font-medium text-fg">{label}</td>
                    <td className="py-2 pr-4">{a}</td>
                    <td className="py-2">{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 max-w-2xl text-sm text-subtle">
            pg-mem now runs PL/pgSQL, triggers and RLS-policy DDL (via the <a href="https://www.npmjs.com/package/@tinbase/pg-mem" className="underline decoration-border underline-offset-2 hover:text-fg">@tinbase/pg-mem</a> fork),
            but as a superuser so RLS isn&apos;t enforced per-request, and cron/pgmq are absent — it&apos;s meant for local dev and
            previews. For full, enforced Postgres semantics in the browser, use PGlite — and persist across reloads with an IndexedDB data dir:
          </p>
          <div className="mt-4">
            <Code code={PGLITE} lang="ts" />
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-xl font-semibold text-fg">How it fits together</h2>
          <p className="mt-2 max-w-2xl text-[15px] text-muted">
            The same fetch handler serves an HTTP + WebSocket server in Node, or runs directly in the page in the
            browser — only the transport changes.
          </p>
          <div className="mt-6 rounded-xl border border-border bg-surface p-6">
            <ArchitectureDiagram />
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-xl font-semibold text-fg">Why it was built this way</h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            tinbase came out of{' '}
            <a href="https://lifo.sh" className="font-medium text-accent hover:text-accent-hover">
              lifo
            </a>{' '}
            — a project that maps Linux APIs into the browser — and{' '}
            <a href="https://rapidnative.com" className="font-medium text-accent hover:text-accent-hover">
              RapidNative
            </a>
            , where Expo apps run full-stack in the browser and on phones. Both need a real backend with no server behind
            it, which is exactly why every service here is a fetch handler and the database can be pure JavaScript.
          </p>
        </section>

        <div className="mt-16 flex flex-wrap gap-3">
          <LinkButton href="/docs#embedding">Embedding docs</LinkButton>
          <Link
            href="/studio"
            className="inline-flex h-10 items-center rounded-lg border border-strong px-5 text-sm font-semibold text-fg hover:bg-surface-2"
          >
            See the Studio →
          </Link>
        </div>
      </main>
    </>
  )
}
