'use client'
/**
 * Install-footprint comparison — the axis where pg-mem wins. Same horizontal-bar
 * grammar as the memory chart (tinbase rows in the brand accent, competitors
 * neutral, direct value labels, per-mark hover), but measuring what it costs to
 * *ship* the engine rather than runtime RAM.
 *
 * The range spans 3.6 MB → 2,291 MB, so bar length is on a log scale (a linear
 * one would render pg-mem an invisible sliver). Every bar carries its real MB
 * value as a direct label, so the log axis can't mislead — the numbers are the
 * source of truth, the bars are just relative weight.
 */
import { useState } from 'react'

const DATA = [
  { name: 'tinbase (pg-mem)', db: 'pure JS · no WASM', mb: 3.6, self: true, detail: 'dist + pg-mem — no native binary, no WASM blob; drops into any JS runtime or a browser tab' },
  { name: 'tinbase (wasm)', db: 'dist + PGlite', mb: 27, self: true, detail: 'dist + @electric-sql/pglite (the WASM Postgres blob)' },
  { name: 'PocketBase', db: 'Go binary', mb: 30, self: false, detail: 'single Go executable embedding SQLite · v0.39.5' },
  { name: 'tinbase (native)', db: 'dist + Postgres 17', mb: 36, self: true, detail: 'dist + downloaded native Postgres 17 binaries' },
  { name: 'tinbase (binary)', db: 'single executable', mb: 92, self: true, detail: 'compiled binary + Postgres 17 binaries — needs no runtime at all' },
  { name: 'Supabase local', db: '12 Docker images', mb: 2291, self: false, detail: 'sum of the default local stack Docker images (excludes Docker Desktop)' },
]
// log scale: labels carry the real value, bars carry relative weight
const LOG_MAX = Math.log10(Math.max(...DATA.map((d) => d.mb)))
const widthPct = (mb: number) => (Math.log10(mb) / LOG_MAX) * 100

export function InstallChart() {
  const [hover, setHover] = useState<number | null>(null)

  return (
    <figure aria-label="Install footprint in megabytes, lower is better">
      <figcaption className="mb-5 text-sm font-medium text-zinc-400">
        Install footprint (MB) · what it costs to ship the engine · lower is better
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
                style={{ width: `max(${widthPct(d.mb)}%, 4px)`, transition: 'opacity 120ms' }}
              />
              <span className="ml-2 text-sm tabular-nums text-zinc-400">
                {d.mb.toLocaleString()} MB
              </span>
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
        Log scale (the range spans 3.6 MB → 2.3 GB); the label on each bar is the actual size. Install
        sizes exclude the Node runtime you already have. pg-mem is the only engine with no WASM and no
        native binary — pure JavaScript.
      </p>
    </figure>
  )
}
