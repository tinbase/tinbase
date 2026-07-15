import Image from 'next/image'
import Link from 'next/link'
import { WeightChart } from '@/components/weight-chart'
import { FeatureIcon } from '@/components/feature-icon'
import { ArchitectureDiagram } from '@/components/architecture-diagram'
import { IntroVideo } from '@/components/intro-video'
import { SiteNav } from '@/components/site-nav'
import { Badge, Card, LinkButton } from '@/components/ui'
import { Code } from '@/components/code'
import { GitHubIcon } from '@/components/github-icon'

const FEATURES = [
  {
    title: 'supabase-js works unchanged',
    icon: 'link',
    body: 'REST, Auth, Storage, and Realtime speak the same wire protocols as hosted Supabase. Point the official SDK at tinbase and your app just runs.',
  },
  {
    title: 'Real Postgres, really small',
    icon: 'database',
    body: 'RLS policies, auth.uid(), jsonb, triggers, foreign keys. Choose embedded native Postgres 17 (59 MB RAM) or PGlite WASM for zero-setup portability.',
  },
  {
    title: 'One file to deploy',
    icon: 'box',
    body: 'A single 58 MB executable with no Node, npm, or Docker on the target machine. Postgres binaries (12 MB) auto-download on first run.',
  },
  {
    title: 'Your migrations stay portable',
    icon: 'transfer',
    body: 'Reads supabase/migrations/*.sql and seed.sql exactly like the Supabase CLI, tracked in the same table. Outgrow tinbase? Push the same files to hosted Supabase.',
  },
  {
    title: 'Auth, including OAuth',
    icon: 'lock',
    body: 'Email/password, anonymous, OTP, magic links, password recovery, and OAuth (Google/GitHub + generic) with PKCE — all through supabase.auth, reading your existing config.toml providers.',
  },
  {
    title: 'Edge Functions',
    icon: 'bolt',
    body: 'supabase.functions.invoke() runs your handlers in-process, loaded from supabase/functions/ with the verified auth context and env keys.',
  },
  {
    title: 'Webhooks, cron & queues',
    icon: 'clock',
    body: 'Database webhooks (CDC → HTTP), cron.schedule() jobs, and a pgmq queue subset — the automation layer, natively, with no pg_net/pg_cron/pgmq extension needed.',
  },
  {
    title: 'Typed clients & Studio',
    icon: 'code',
    body: 'tinbase gen types typescript for a fully typed createClient<Database>, plus a Supabase-Studio-style dashboard at /_/ (tables, SQL, auth, storage, RLS policies).',
  },
  {
    title: 'Realtime with RLS',
    icon: 'broadcast',
    body: 'postgres_changes, broadcast, and presence — with per-subscriber RLS filtering so users only receive change events for rows they can see.',
  },
  {
    title: 'Runs in the browser',
    icon: 'browser',
    body: 'Every service is a pure fetch handler. Hand it to supabase-js as a custom fetch and the entire backend — database included — runs in-process, no server.',
  },
  {
    title: 'Or bring your own Postgres',
    icon: 'database',
    body: 'Point tinbase at a Postgres you already run with --database-url — REST, Auth, and Storage against your own database, over TCP with SCRAM auth and an idempotent, shared-safe bootstrap.',
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
          <Badge className="mt-8 max-w-full text-center leading-snug">
            {'Supabase-compatible backend, without Docker · Open source (MIT)'}
          </Badge>
          <h1 className="mt-6 max-w-3xl text-balance text-5xl font-bold tracking-tight sm:text-6xl">
            The Supabase-compatible backend that fits in a <span className="text-accent">tin</span>
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg text-muted">
            Local Supabase dev without Docker — one process, real Postgres, and it even runs in the
            browser. The official supabase-js SDK works unchanged.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <LinkButton href="/docs">Get started</LinkButton>
            <LinkButton variant="outline" href="https://github.com/tinbase/tinbase">
              <GitHubIcon /> Star on GitHub
            </LinkButton>
          </div>
          <code className="mt-8 rounded-lg border border-border bg-surface-2 px-4 py-2.5 font-mono text-sm text-accent">
            npx tinbase start
          </code>
        </section>

        {/* intro video */}
        <section className="pb-8">
          <IntroVideo
            videoId="cab67bcccefd9a7693331e44f782c181"
            title="tinbase intro"
            className="mx-auto max-w-4xl"
          />
          <p className="mt-4 text-center text-sm text-subtle">
            Watch: a Supabase-compatible backend in a single process, in about two minutes.
          </p>
        </section>

        {/* benchmark */}
        <section id="benchmarks" className="scroll-mt-20 border-t border-border py-20">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent">
            Benchmark
          </p>
          <h2 className="text-3xl font-bold tracking-tight">A weight class you can deploy anywhere</h2>
          <p className="mt-3 max-w-2xl text-muted">
            The Supabase local stack is a 12-container, 2.3 GB Docker install. tinbase serves the same
            APIs from a single file at a fraction of the memory.
          </p>
          <Card className="mt-10 p-8">
            <WeightChart />
          </Card>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Card>
              <div className="text-3xl font-bold text-accent">58 MB</div>
              <div className="mt-1 text-sm text-muted">single executable, no runtime prerequisite</div>
            </Card>
            <Card>
              <div className="text-3xl font-bold text-accent">~2 s</div>
              <div className="mt-1 text-sm text-muted">from command to serving requests</div>
            </Card>
            <Card>
              <div className="text-3xl font-bold text-accent">168 / 168</div>
              <div className="mt-1 text-sm text-muted">integration tests pass · both engines</div>
            </Card>
          </div>
        </section>

        {/* code */}
        <section className="border-t border-border py-20">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold tracking-tight">Keep the SDK you already know</h2>
              <p className="mt-4 text-muted">
                tinbase implements the PostgREST query grammar (filters, embedded resources, RPC),
                GoTrue auth flows, the Storage API, and the Realtime Phoenix protocol — verified by
                running the official SDK against it.
              </p>
              <p className="mt-4 text-muted">
                Row Level Security behaves exactly like hosted Supabase: every request runs with your
                JWT claims applied, so <code className="font-mono text-sm text-accent">auth.uid()</code>{' '}
                policies work as-is.
              </p>
              <Link
                href="/docs"
                className="mt-6 inline-block text-sm font-semibold text-accent hover:text-accent-hover"
              >
                Read the docs →
              </Link>
            </div>
            <Code code={CODE} lang="ts" />
          </div>
        </section>

        {/* architecture */}
        <section className="border-t border-border py-20">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent">Architecture</p>
          <h2 className="text-3xl font-bold tracking-tight">One fetch handler, three engines</h2>
          <p className="mt-3 max-w-2xl text-muted">
            supabase-js talks to a single <code className="font-mono text-sm text-accent">(Request) ⇒ Response</code>{' '}
            handler that fans out to the service handlers, all sitting on one swappable database engine. The same handler
            is an HTTP + WebSocket server in Node, or runs in-process in a browser tab.
          </p>
          <Card className="mt-10 p-6 sm:p-8">
            <ArchitectureDiagram />
          </Card>
        </section>

        {/* studio teaser */}
        <section className="border-t border-border py-20">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent">Studio</p>
          <h2 className="text-3xl font-bold tracking-tight">A dashboard in the box</h2>
          <p className="mt-3 max-w-2xl text-muted">
            A Supabase-Studio-style dashboard ships at <code className="font-mono text-sm text-accent">/_/</code> —
            table editor, SQL, auth, RLS policies, storage, and live logs. No extra process.
          </p>
          <Link href="/studio" className="group mt-8 block">
            <Card className="overflow-hidden p-0 transition-colors group-hover:border-strong">
              <Image
                src="/screenshots/table-editor.png"
                alt="tinbase Studio table editor"
                width={1440}
                height={900}
                className="h-auto w-full"
                unoptimized
              />
            </Card>
            <span className="mt-4 inline-block text-sm font-semibold text-accent group-hover:text-accent-hover">
              Tour the Studio →
            </span>
          </Link>
        </section>

        {/* why it was built */}
        <section className="border-t border-border py-20">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">Why tinbase exists</h2>
            <p className="mt-5 leading-relaxed text-muted">
              tinbase came out of{' '}
              <a href="https://lifo.sh" className="font-medium text-accent hover:text-accent-hover">
                lifo
              </a>{' '}
              and{' '}
              <a href="https://rapidnative.com" className="font-medium text-accent hover:text-accent-hover">
                RapidNative
              </a>{' '}
              with a hard goal: run an <span className="text-fg">entire dev stack — database, auth,
              storage, realtime — in the browser and on phones</span>, with no VMs and no cloud behind it.
              The first step was cutting the memory overhead of running that backend locally at all; the
              next was making the very same backend run in-process, inside a browser tab.
            </p>
            <p className="mt-4 leading-relaxed text-muted">
              That is why every service is a pure fetch handler and the database can be pure JavaScript.
              Along the way it became something else too: a Docker-free, drop-in replacement for local
              Supabase development that covers most use cases — so it is open source for everyone.
            </p>
          </div>
        </section>

        {/* features */}
        <section className="border-t border-border py-20">
          <div className="flex items-center gap-3">
            <Image src="/logo.svg" alt="" width={32} height={32} aria-hidden="true" />
            <h2 className="text-3xl font-bold tracking-tight">Why tinbase</h2>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <Card key={f.title}>
                <span className="flex size-9 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-accent">
                  <FeatureIcon name={f.icon} className="size-5" />
                </span>
                <h3 className="mt-4 font-semibold text-accent">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-10">
        <div className="mx-auto max-w-6xl space-y-6 px-6">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm text-subtle">
            <span className="text-xs font-semibold uppercase tracking-wider text-subtle">
              Related projects
            </span>
            <a href="https://lifo.sh" className="hover:text-fg">
              <span className="font-medium text-fg">Lifo</span> — Linux APIs in the browser
            </a>
            <a href="https://jetplane.vercel.app" className="hover:text-fg">
              <span className="font-medium text-fg">jetplane</span> — low-footprint Expo dev servers
            </a>
            <span className="text-xs font-semibold uppercase tracking-wider text-subtle">
              Used by
            </span>
            <a href="https://rapidnative.com" className="hover:text-fg">
              <span className="font-medium text-fg">RapidNative</span> — Expo apps, full-stack in the browser
            </a>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-subtle">
          <span>
            Built by{' '}
            <a href="https://x.com/sanketsahu" className="font-medium text-fg hover:text-fg">
              Sanket Sahu (@sanketsahu)
            </a>{' '}
            · MIT
          </span>
          <div className="flex items-center gap-6">
            <Link href="/docs" className="hover:text-fg">Docs</Link>
            <a href="/docs#benchmarks" className="hover:text-fg">
              Benchmarks
            </a>
            <a href="https://x.com/sanketsahu" aria-label="Sanket Sahu on X" className="hover:text-fg">
              <svg viewBox="0 0 24 24" fill="currentColor" className="size-4" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              href="https://github.com/sanketsahu"
              aria-label="Sanket Sahu on GitHub"
              className="flex items-center hover:text-fg"
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
