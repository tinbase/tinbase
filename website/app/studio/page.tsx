import Image from 'next/image'
import Link from 'next/link'
import { SiteNav } from '@/components/site-nav'
import { LinkButton } from '@/components/ui'

export const metadata = {
  title: 'Studio',
  description:
    'tinbase ships a built-in dashboard at /_/ — table editor, SQL editor, auth, RLS policies, storage, database overview, and live logs.',
  alternates: { canonical: '/studio' },
}

const SHOTS: { src: string; title: string; body: string }[] = [
  {
    src: '/screenshots/table-editor.png',
    title: 'Table editor',
    body: 'Browse and edit rows in any table. Columns show their Postgres types, primary keys, and foreign-key hints; insert, update, and delete inline.',
  },
  {
    src: '/screenshots/sql-editor.png',
    title: 'SQL editor',
    body: 'Run arbitrary SQL against the database with a results grid, row count, and timing. Errors come back with the Postgres message and SQLSTATE.',
  },
  {
    src: '/screenshots/auth.png',
    title: 'Authentication',
    body: 'Inspect and manage users — create, confirm, update metadata, and delete. The same GoTrue-compatible users your app signs in.',
  },
  {
    src: '/screenshots/policies.png',
    title: 'RLS policies',
    body: 'View and author row-level-security policies per table with a real editor — SELECT / INSERT / UPDATE / DELETE, roles, and USING / WITH CHECK expressions.',
  },
  {
    src: '/screenshots/storage.png',
    title: 'Storage',
    body: 'Browse buckets and objects, upload files, and toggle public access — backed by storage.objects with RLS, like hosted Supabase.',
  },
  {
    src: '/screenshots/database.png',
    title: 'Database',
    body: 'A schema overview at a glance: tables, applied migrations, functions, triggers, database size, and the Postgres version.',
  },
  {
    src: '/screenshots/logs.png',
    title: 'Logs',
    body: 'Live server logs — every request plus internal events (mail, webhooks, cron) — color-coded by level, auto-refreshing, with a clear button.',
  },
]

export default function StudioPage() {
  return (
    <>
      <SiteNav />
      <main className="mx-auto max-w-5xl px-6 py-16">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent">Studio</p>
        <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          A dashboard in the box
        </h1>
        <p className="mt-5 max-w-2xl text-pretty text-lg text-muted">
          Every tinbase server serves a Supabase-Studio-style dashboard at{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-sm text-accent">/_/</code>. No extra
          process, no separate install — sign in with the <span className="text-fg">service_role</span> key printed
          at startup. Built with React, Radix, and Tailwind, compiled to a single self-contained HTML file.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <LinkButton href="/docs#studio">Studio docs</LinkButton>
          <LinkButton variant="outline" href="/browser">
            Runs in the browser too →
          </LinkButton>
        </div>

        <div className="mt-14 space-y-16">
          {SHOTS.map((s, i) => (
            <section key={s.src} className="scroll-mt-20" id={s.title.toLowerCase().replace(/\s+/g, '-')}>
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-sm text-subtle tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                <h2 className="text-xl font-semibold text-fg">{s.title}</h2>
              </div>
              <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">{s.body}</p>
              <div className="mt-5 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
                <Image
                  src={s.src}
                  alt={`tinbase Studio — ${s.title}`}
                  width={1440}
                  height={900}
                  className="h-auto w-full"
                  unoptimized
                />
              </div>
            </section>
          ))}
        </div>

        <div className="mt-16 rounded-xl border border-border bg-surface p-6 text-center">
          <p className="text-fg">
            Studio is one of the ways in — the same APIs power the SDK and your app.
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <LinkButton href="/docs">Read the docs</LinkButton>
            <Link
              href="https://github.com/tinbase/tinbase"
              className="inline-flex h-10 items-center rounded-lg border border-strong px-5 text-sm font-semibold text-fg hover:bg-surface-2"
            >
              GitHub
            </Link>
          </div>
        </div>
      </main>
    </>
  )
}
