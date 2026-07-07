import Image from 'next/image'
import Link from 'next/link'
import { WeightChart } from '@/components/weight-chart'
import { SiteNav } from '@/components/site-nav'
import { Badge, Card, LinkButton } from '@/components/ui'
import { Code } from '@/components/code'
import { GitHubIcon } from '@/components/github-icon'

const FEATURES = [
  {
    title: 'supabase-js works unchanged',
    body: 'REST, Auth, Storage, and Realtime speak the same wire protocols as hosted Supabase. Point the official SDK at tinbase and your app just runs.',
  },
  {
    title: 'Real Postgres, really small',
    body: 'RLS policies, auth.uid(), jsonb, triggers, foreign keys. Choose embedded native Postgres 17 (59 MB RAM) or PGlite WASM for zero-setup portability.',
  },
  {
    title: 'One file to deploy',
    body: 'A single 57 MB executable with no Node, npm, or Docker on the target machine. Postgres binaries (12 MB) auto-download on first run.',
  },
  {
    title: 'Your migrations stay portable',
    body: 'Reads supabase/migrations/*.sql and seed.sql exactly like the Supabase CLI, tracked in the same table. Outgrow tinbase? Push the same files to hosted Supabase.',
  },
  {
    title: 'Auth, including OAuth',
    body: 'Email/password, anonymous, OTP, magic links, password recovery, and OAuth (Google/GitHub + generic) with PKCE — all through supabase.auth, reading your existing config.toml providers.',
  },
  {
    title: 'Edge Functions',
    body: 'supabase.functions.invoke() runs your handlers in-process, loaded from supabase/functions/ with the verified auth context and env keys.',
  },
  {
    title: 'Webhooks, cron & queues',
    body: 'Database webhooks (CDC → HTTP), cron.schedule() jobs, and a pgmq queue subset — the automation layer, natively, with no pg_net/pg_cron/pgmq extension needed.',
  },
  {
    title: 'Typed clients & Studio',
    body: 'tinbase gen types typescript for a fully typed createClient<Database>, plus a Supabase-Studio-style dashboard at /_/ (tables, SQL, auth, storage, RLS policies).',
  },
  {
    title: 'Realtime with RLS',
    body: 'postgres_changes, broadcast, and presence — with per-subscriber RLS filtering so users only receive change events for rows they can see.',
  },
  {
    title: 'Runs in the browser',
    body: 'Every service is a pure fetch handler. Hand it to supabase-js as a custom fetch and the entire backend — database included — runs in-process, no server.',
  },
]

const CODE = `import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://127.0.0.1:54321', ANON_KEY)

await supabase.auth.signUp({ email, password })
await supabase.from('todos').insert({ title: 'hello' })

const { data } = await supabase
  .from('todos')
  .select('*, author:users(name)')
  .eq('done', false)

supabase.channel('feed')
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'todos' },
      handleNewTodo)
  .subscribe()`

export default function Home() {
  return (
    <>
      <SiteNav />
      <main className="mx-auto max-w-6xl px-6">
        {/* hero */}
        <section className="flex flex-col items-center py-24 text-center">
          <Image src="/logo.svg" alt="tinbase logo" width={88} height={88} priority />
          <Badge className="mt-8">Supabase-compatible backend, without Docker · Open source (MIT)</Badge>
          <h1 className="mt-6 max-w-3xl text-balance text-5xl font-bold tracking-tight sm:text-6xl">
            The Supabase-compatible backend that fits in a <span className="text-emerald-400">tin</span>
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg text-zinc-400">
            A Supabase-compatible backend in a single 57 MB binary — real Postgres with Row Level
            Security, Auth, Storage, and Realtime. The official supabase-js SDK works unchanged.
            No Docker.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <LinkButton href="/docs">Get started</LinkButton>
            <LinkButton variant="outline" href="https://github.com/sanketsahu/tinbase">
              <GitHubIcon /> Star on GitHub
            </LinkButton>
          </div>
          <code className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 font-mono text-sm text-emerald-300">
            npx tinbase start
          </code>
          <p className="mt-6 flex items-center gap-2 text-sm text-amber-400/90">
            <span aria-hidden="true">⚠</span> Experimental — great for prototypes, local dev, and
            embedded use. Not meant for production yet.
          </p>
        </section>

        {/* benchmark */}
        <section id="benchmarks" className="scroll-mt-20 border-t border-zinc-800/80 py-20">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-emerald-400">
            Benchmark
          </p>
          <h2 className="text-3xl font-bold tracking-tight">A weight class you can deploy anywhere</h2>
          <p className="mt-3 max-w-2xl text-zinc-400">
            The Supabase local stack is a 12-container, 2.3 GB Docker install. tinbase serves the same
            APIs from a single file at a fraction of the memory.
          </p>
          <Card className="mt-10 p-8">
            <WeightChart />
          </Card>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Card>
              <div className="text-3xl font-bold text-emerald-400">57 MB</div>
              <div className="mt-1 text-sm text-zinc-400">single executable, no runtime prerequisite</div>
            </Card>
            <Card>
              <div className="text-3xl font-bold text-emerald-400">~2 s</div>
              <div className="mt-1 text-sm text-zinc-400">from command to serving requests</div>
            </Card>
            <Card>
              <div className="text-3xl font-bold text-emerald-400">120 / 120</div>
              <div className="mt-1 text-sm text-zinc-400">tests pass with the real supabase-js</div>
            </Card>
          </div>
        </section>

        {/* code */}
        <section className="border-t border-zinc-800/80 py-20">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold tracking-tight">Keep the SDK you already know</h2>
              <p className="mt-4 text-zinc-400">
                tinbase implements the PostgREST query grammar (filters, embedded resources, RPC),
                GoTrue auth flows, the Storage API, and the Realtime Phoenix protocol — verified by
                running the official SDK against it.
              </p>
              <p className="mt-4 text-zinc-400">
                Row Level Security behaves exactly like hosted Supabase: every request runs with your
                JWT claims applied, so <code className="font-mono text-sm text-emerald-300">auth.uid()</code>{' '}
                policies work as-is.
              </p>
              <Link
                href="/docs"
                className="mt-6 inline-block text-sm font-semibold text-emerald-400 hover:text-emerald-300"
              >
                Read the docs →
              </Link>
            </div>
            <Code code={CODE} lang="ts" />
          </div>
        </section>

        {/* why it was built */}
        <section className="border-t border-zinc-800/80 py-20">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">Why tinbase exists</h2>
            <p className="mt-5 leading-relaxed text-zinc-400">
              tinbase was built for{' '}
              <a href="https://lifo.sh" className="font-medium text-emerald-400 hover:text-emerald-300">
                lifo
              </a>{' '}
              — a project that maps Linux APIs into the browser — to let{' '}
              <span className="text-zinc-200">Expo apps run fully in the browser with real
              full-stack capability</span>: a database, auth, storage, and realtime, with no server
              behind them. That is why every tinbase service is a pure fetch handler and the
              database is Postgres compiled to WASM — the whole backend can live in-process,
              inside a browser tab.
            </p>
            <p className="mt-4 leading-relaxed text-zinc-400">
              It is part of{' '}
              <a href="https://rapidnative.com" className="font-medium text-emerald-400 hover:text-emerald-300">
                RapidNative
              </a>
              . The same architecture turned out to make a great standalone local backend — so it is
              open source for everyone.
            </p>
          </div>
        </section>

        {/* features */}
        <section className="border-t border-zinc-800/80 py-20">
          <h2 className="text-3xl font-bold tracking-tight">Why tinbase</h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <Card key={f.title}>
                <h3 className="font-semibold text-emerald-400">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{f.body}</p>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800/80 py-10">
        <div className="mx-auto max-w-6xl space-y-6 px-6">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm text-zinc-500">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
              Related projects
            </span>
            <a href="https://lifo.sh" className="hover:text-zinc-300">
              <span className="font-medium text-zinc-300">Lifo</span> — Linux APIs in the browser
            </a>
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
              Used by
            </span>
            <a href="https://rapidnative.com" className="hover:text-zinc-300">
              <span className="font-medium text-zinc-300">RapidNative</span> — Expo apps, full-stack in the browser
            </a>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-zinc-500">
          <span>
            Built by{' '}
            <a href="https://x.com/sanketsahu" className="font-medium text-zinc-300 hover:text-white">
              Sanket Sahu (@sanketsahu)
            </a>{' '}
            · MIT
          </span>
          <div className="flex items-center gap-6">
            <Link href="/docs" className="hover:text-zinc-300">Docs</Link>
            <a href="/docs#benchmarks" className="hover:text-zinc-300">
              Benchmarks
            </a>
            <a href="https://x.com/sanketsahu" aria-label="Sanket Sahu on X" className="hover:text-zinc-300">
              <svg viewBox="0 0 24 24" fill="currentColor" className="size-4" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              href="https://github.com/sanketsahu"
              aria-label="Sanket Sahu on GitHub"
              className="flex items-center hover:text-zinc-300"
            >
              <GitHubIcon />
            </a>
          </div>
          </div>
        </div>
      </footer>
    </>
  )
}
