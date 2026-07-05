'use client'
/**
 * Memory-footprint comparison. Horizontal bars, one measure — tinbase rows in
 * the brand accent, competitors in neutral; identity lives in the row labels
 * and every bar carries a direct value label (contrast relief for the muted
 * bars). Per-mark hover tooltip.
 */
import { useState } from 'react'

const DATA = [
  { name: 'PocketBase', db: 'SQLite', mb: 25, self: false, detail: 'Go binary embedding SQLite · v0.39.5' },
  { name: 'tinbase (binary)', db: 'real Postgres + RLS', mb: 64, self: true, detail: 'single file · real Postgres 17 with RLS' },
  { name: 'tinbase (wasm)', db: 'real Postgres + RLS', mb: 347, self: true, detail: 'PGlite · real Postgres with RLS, runs in the browser' },
  { name: 'Supabase local', db: 'Postgres', mb: 1626, self: false, detail: '12 Docker containers · CLI 2.40' },
]
const MAX = Math.max(...DATA.map((d) => d.mb))

export function FootprintChart() {
  const [hover, setHover] = useState<number | null>(null)

  return (
    <figure aria-label="Memory under load in megabytes, lower is better">
      <figcaption className="mb-5 text-sm font-medium text-zinc-400">
        Memory under load (MB) · 1,000 inserts + 1,000 filtered reads · lower is better
      </figcaption>
      <div className="space-y-3">
        {DATA.map((d, i) => (
          <div
            key={d.name}
            className="group relative grid grid-cols-[9.5rem_1fr] items-center gap-3 sm:grid-cols-[12rem_1fr]"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="truncate text-right">
              <span className={'text-sm ' + (d.self ? 'font-semibold text-emerald-400' : 'text-zinc-400')}>
                {d.name}
              </span>
              <span className="block text-[11px] leading-tight text-zinc-500">{d.db}</span>
            </span>
            <div className="relative flex h-6 items-center">
              <div
                className={
                  'h-5 rounded-r ' +
                  (d.self ? 'bg-emerald-500' : 'bg-zinc-600') +
                  (hover === i ? ' opacity-100' : hover === null ? ' opacity-100' : ' opacity-50')
                }
                style={{ width: `max(${(d.mb / MAX) * 100}%, 4px)`, transition: 'opacity 120ms' }}
              />
              <span className="ml-2 text-sm tabular-nums text-zinc-400">{d.mb.toLocaleString()}</span>
              {hover === i && (
                <div className="pointer-events-none absolute -top-9 left-0 z-10 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 shadow-lg">
                  <span className="font-semibold">{d.mb.toLocaleString()} MB</span>
                  <span className="text-zinc-400"> · {d.detail}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-5 text-xs text-zinc-500">
        Physical footprint of the whole process tree (vmmap / docker stats), Apple Silicon · macOS 15 ·{' '}
        <a
          className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300"
          href="https://github.com/sanketsahu/tinbase/blob/main/bench/footprint.ts"
        >
          bench/footprint.ts
        </a>
      </p>
    </figure>
  )
}
