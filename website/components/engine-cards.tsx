/* Card grid for the docs "Engines" section — one scannable card per engine. */
import type { ReactNode } from 'react'

const ic = 'rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-accent'
const a = 'underline decoration-border underline-offset-2 hover:text-fg'

const BADGE_TONE = {
  default: 'border-border text-subtle',
  new: 'border-emerald-500/30 bg-emerald-500/10 text-accent',
  preview: 'border-amber-500/30 bg-[var(--warn-soft)] text-warn',
} as const

function EngineCard({
  name,
  badge,
  tone = 'default',
  tagline,
  facts,
}: {
  name: string
  badge: string
  tone?: keyof typeof BADGE_TONE
  tagline: ReactNode
  facts: { label: string; value: ReactNode }[]
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <code className="font-mono text-sm font-semibold text-accent">{name}</code>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${BADGE_TONE[tone]}`}>{badge}</span>
      </div>
      <p className="mt-3 text-sm font-medium leading-snug text-fg">{tagline}</p>
      <dl className="mt-4 space-y-2 text-sm">
        {facts.map((f) => (
          <div key={f.label} className="flex gap-3">
            <dt className="w-[4.5rem] shrink-0 text-xs uppercase tracking-wide text-subtle">{f.label}</dt>
            <dd className="flex-1 leading-relaxed text-muted">{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function EngineCards() {
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2">
      <EngineCard
        name="native"
        badge="Default · macOS/Linux"
        tagline="Embedded Postgres 17 — real Postgres, PocketBase-class footprint"
        facts={[
          { label: 'Memory', value: '~59 MB at boot' },
          {
            label: 'Setup',
            value: (
              <>
                first run downloads ~12 MB binaries (cached in <code className={ic}>~/.cache/tinbase</code>)
              </>
            ),
          },
          { label: 'Access', value: 'private unix socket, trust auth — never TCP' },
          { label: 'Platform', value: 'macOS / Linux on x64 / arm64' },
        ]}
      />

      <EngineCard
        name="wasm"
        badge="Default · Windows · Browser"
        tagline="PGlite — Postgres compiled to WebAssembly"
        facts={[
          { label: 'Setup', value: 'none — runs anywhere Node runs, including a browser tab' },
          { label: 'Memory', value: '~575–650 MB WASM heap (does not shrink under load)' },
          { label: 'Parity', value: 'identical bootstrap, migrations, RLS, and realtime CDC to native' },
        ]}
      />

      <EngineCard
        name="pgmem"
        badge="Preview · local-dev only"
        tone="preview"
        tagline={
          <>
            Ultralight pure-JS, in-memory — no WASM — via{' '}
            <a className={a} href="https://www.npmjs.com/package/@tinbase/pg-mem">
              @tinbase/pg-mem
            </a>
            , our{' '}
            <a className={a} href="https://github.com/oguimbal/pg-mem">
              pg-mem
            </a>{' '}
            fork
          </>
        }
        facts={[
          {
            label: 'Runs',
            value:
              'a full Supabase bootstrap + real migrations unchanged (PL/pgSQL, triggers, RLS DDL, correlated subqueries, MERGE, partitioning); REST, auth, edge functions, realtime, webhooks',
          },
          {
            label: 'Caveats',
            value: (
              <>
                <code className={ic}>LISTEN</code>/<code className={ic}>NOTIFY</code> are no-ops (CDC synthesized in
                JS); RLS created but <span className="text-fg">not enforced</span> (superuser); no cron / pgmq
              </>
            ),
          },
          { label: 'Use', value: 'local-dev / preview — never production' },
        ]}
      />

      <EngineCard
        name="--database-url"
        badge="New in 0.10"
        tone="new"
        tagline="Bring your own external Postgres — REST, Auth, and Storage run against a database you already run"
        facts={[
          {
            label: 'Connect',
            value: (
              <>
                <code className={ic}>tinbase start --database-url postgres://…</code>, the{' '}
                <code className={ic}>DATABASE_URL</code> env, or <code className={ic}>createBackend(&#123; databaseUrl &#125;)</code>
              </>
            ),
          },
          { label: 'Auth', value: 'TCP with SCRAM-SHA-256 (or md5)' },
          { label: 'Shared', value: 'idempotent bootstrap; migrations/seed stay tracked — never assumes an empty or exclusive DB' },
          {
            label: 'Soon',
            value: (
              <>
                TLS / <code className={ic}>sslmode</code> (managed providers), realtime CDC without superuser, pooling
              </>
            ),
          },
        ]}
      />
    </div>
  )
}
