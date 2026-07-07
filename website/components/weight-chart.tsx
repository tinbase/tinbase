'use client'
/**
 * Combined weight chart — grouped vertical bars, two series per engine:
 * install footprint and memory under load. Both series are megabytes, so they
 * share one axis honestly (this is NOT a dual-axis chart — same unit, one
 * scale).
 *
 * The values span 3.6 MB → 2,291 MB, so bar HEIGHT is on a log scale; a linear
 * one would flatten every small engine to nothing. Each bar carries its real MB
 * as a direct label, so the log axis reports weight, not truth — the numbers do.
 *
 * Colour encodes the series (install vs RAM), validated for CVD on the dark
 * surface (aqua↔blue, worst-case ΔE 69.8 deutan / 15.7 tritan). tinbase-vs-
 * competitor identity rides on the x-axis label weight, not colour.
 */
import { useState } from 'react'

const INSTALL = '#199e70' // aqua — install footprint
const RAM = '#3987e5' // blue — memory under load

const DATA = [
  { name: 'pg-mem', sub: 'tinbase', self: true, install: 3.6, ram: 185, note: 'pure JS, no WASM — lightest to ship; more RAM under load' },
  { name: 'wasm', sub: 'tinbase', self: true, install: 27, ram: 640, note: 'PGlite WASM — portable, heavy heap' },
  { name: 'PocketBase', sub: 'SQLite', self: false, install: 30, ram: 24, note: 'Go binary + SQLite · v0.39.5' },
  { name: 'native', sub: 'tinbase', self: true, install: 36, ram: 100, note: 'embedded native Postgres 17' },
  { name: 'binary', sub: 'tinbase', self: true, install: 92, ram: 66, note: 'single executable, no runtime needed' },
  { name: 'Supabase', sub: 'local', self: false, install: 2291, ram: 1626, note: '12 Docker containers · CLI 2.40' },
]
const LOG_MAX = Math.log10(Math.max(...DATA.flatMap((d) => [d.install, d.ram])))
// cap at 90% so the value label above the tallest bar stays inside the plot
const heightPct = (mb: number) => (Math.log10(mb) / LOG_MAX) * 90

const SERIES = [
  { key: 'install' as const, label: 'Install footprint', color: INSTALL },
  { key: 'ram' as const, label: 'Memory under load', color: RAM },
]

export function WeightChart() {
  const [hover, setHover] = useState<{ i: number; key: 'install' | 'ram' } | null>(null)

  return (
    <figure aria-label="Install footprint and memory under load in megabytes, lower is better">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <figcaption className="text-sm font-medium text-zinc-400">
          Install footprint vs memory under load (MB) · lower is better
        </figcaption>
        <div className="flex items-center gap-4 text-xs text-zinc-400">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block size-3 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[520px]">
          <div className="flex h-64 items-end gap-2 border-b border-zinc-800">
            {DATA.map((d, i) => (
              <div key={d.name} className="flex h-full flex-1 items-end justify-center gap-1.5">
                {SERIES.map((s) => {
                  const mb = d[s.key]
                  const active = hover?.i === i && hover.key === s.key
                  const dim = hover !== null && !active
                  return (
                    <div
                      key={s.key}
                      className="relative flex h-full w-full max-w-9 flex-col justify-end"
                      onMouseEnter={() => setHover({ i, key: s.key })}
                      onMouseLeave={() => setHover(null)}
                    >
                      <span className="mb-1 text-center text-[10px] tabular-nums leading-none text-zinc-400">
                        {mb.toLocaleString()}
                      </span>
                      <div
                        className="w-full rounded-t"
                        style={{
                          height: `max(${heightPct(mb)}%, 3px)`,
                          background: s.color,
                          opacity: dim ? 0.45 : 1,
                          transition: 'opacity 120ms',
                        }}
                      />
                      {active && (
                        <div className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 shadow-lg">
                          <span className="font-semibold">{mb.toLocaleString()} MB</span>
                          <span className="text-zinc-400"> {s.label.toLowerCase()} · {d.note}</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          <div className="mt-2 flex gap-2">
            {DATA.map((d) => (
              <div key={d.name} className="flex-1 text-center leading-tight">
                <div className={'text-xs ' + (d.self ? 'font-semibold text-zinc-100' : 'text-zinc-400')}>
                  {d.name}
                </div>
                <div className="text-[10px] text-zinc-500">{d.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-5 text-xs text-zinc-500">
        Log scale (values span 3.6 MB → 2.3 GB); the label above each bar is the actual size.
        Bold labels are tinbase engines. pg-mem is the only engine with no WASM and no native binary —
        it trades runtime RAM for the smallest possible install. Physical footprint of the whole
        process tree (vmmap / docker stats), Apple Silicon · macOS 15 ·{' '}
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
