'use client'
/**
 * Weight chart — horizontal grouped bars, two series per engine: install
 * footprint and memory under load. Both series are megabytes on one LINEAR
 * axis (not a dual-axis — same unit), so the differences are real lengths you
 * compare by eye. Each row names the engine AND the database behind it, so a
 * reader sees at a glance which are real Postgres and which are not.
 *
 * The Supabase local stack (2,291 MB install / 1,626 MB RAM) is a 12-container
 * Docker install, an order of magnitude past every single-process engine. On a
 * linear axis it would flatten everything else, so the axis is sized to the
 * real engines and Supabase's bars are drawn CLIPPED (torn end) with their true
 * numbers — its bulk reads as "off the chart" rather than erasing the rest.
 *
 * PocketBase is the smallest footprint, but it is SQLite behind a different,
 * non-supabase-js API — flagged (†) so its win is read in context, not as a
 * drop-in comparison.
 *
 * Colour encodes the series (install vs RAM), CVD-validated on the dark surface
 * (aqua↔blue, worst-case ΔE 69.8 deutan / 15.7 tritan). tinbase-vs-competitor
 * identity rides on the row-label weight, not colour.
 */
import { useState } from 'react'

const INSTALL = '#199e70' // aqua — install footprint
const RAM = '#3987e5' // blue — memory under load

const DATA = [
  { name: 'tinbase (pg-mem)', db: 'Postgres subset · in-memory', self: true, install: 3.6, ram: 185, note: 'pure JS, no WASM — lightest to ship; more RAM under load' },
  { name: 'tinbase (wasm)', db: 'real Postgres · PGlite', self: true, install: 27, ram: 640, note: 'PGlite WASM — portable, heavy heap' },
  { name: 'PocketBase', db: 'SQLite · different API', self: false, flag: true, install: 30, ram: 24, note: 'Go binary + SQLite · v0.39.5 — not supabase-js compatible' },
  { name: 'tinbase (native)', db: 'real Postgres 17', self: true, install: 36, ram: 100, note: 'embedded native Postgres 17' },
  { name: 'tinbase (binary)', db: 'real Postgres 17', self: true, install: 92, ram: 66, note: 'single executable, no runtime needed' },
  { name: 'Supabase local', db: 'Postgres · 12 containers', self: false, install: 2291, ram: 1626, note: '12 Docker containers · CLI 2.40 — off the chart' },
]
// Linear axis sized to the single-process engines; the Docker stack is clipped.
// MAXW < 100 reserves room for the value label (and torn end) after each bar.
const DOMAIN = 720
const MAXW = 86
const widthPct = (mb: number) => (Math.min(mb, DOMAIN) / DOMAIN) * MAXW

const SERIES = [
  { key: 'install' as const, label: 'Install footprint', color: INSTALL },
  { key: 'ram' as const, label: 'Memory under load', color: RAM },
]

export function WeightChart() {
  const [hover, setHover] = useState<{ i: number; key: 'install' | 'ram' } | null>(null)

  return (
    <figure aria-label="Install footprint and memory under load in megabytes, lower is better">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
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
       <div className="min-w-[460px] space-y-4">
        {DATA.map((d, i) => (
          <div
            key={d.name}
            className="grid grid-cols-[8.5rem_1fr] items-center gap-3 sm:grid-cols-[12rem_1fr]"
          >
            <div className="truncate text-right">
              <div className={'truncate text-sm ' + (d.self ? 'font-semibold text-emerald-400' : 'text-zinc-300')}>
                {d.name}
                {d.flag && <sup className="text-amber-400"> †</sup>}
              </div>
              <div className="truncate text-[11px] leading-tight text-zinc-500">{d.db}</div>
            </div>

            <div className="space-y-1">
              {SERIES.map((s) => {
                const mb = d[s.key]
                const clipped = mb > DOMAIN
                const active = hover?.i === i && hover.key === s.key
                const dim = hover !== null && !active
                return (
                  <div
                    key={s.key}
                    className="relative flex h-4 items-center"
                    onMouseEnter={() => setHover({ i, key: s.key })}
                    onMouseLeave={() => setHover(null)}
                  >
                    <div
                      className="relative h-full rounded-r"
                      style={{
                        width: `max(${widthPct(mb)}%, 3px)`,
                        background: s.color,
                        opacity: dim ? 0.45 : 1,
                        transition: 'opacity 120ms',
                      }}
                    >
                      {clipped && (
                        // torn end: signals the bar runs past the axis
                        <span
                          className="absolute inset-y-0 -right-1 w-2"
                          style={{
                            background: `repeating-linear-gradient(45deg, ${s.color} 0 4px, #1a1a19 4px 7px)`,
                          }}
                        />
                      )}
                    </div>
                    <span className={'ml-2 whitespace-nowrap text-xs tabular-nums ' + (clipped ? 'text-zinc-300' : 'text-zinc-400')}>
                      {mb.toLocaleString()}
                    </span>
                    {active && (
                      <div className="pointer-events-none absolute -top-8 left-0 z-10 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 shadow-lg">
                        <span className="font-semibold">{mb.toLocaleString()} MB</span>
                        <span className="text-zinc-400"> {s.label.toLowerCase()} · {d.note}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
       </div>
      </div>

      <p className="mt-6 text-xs text-zinc-500">
        <span className="text-amber-400">†</span> PocketBase is the smallest footprint, but it is
        SQLite behind a different API — not a drop-in for supabase-js, unlike every tinbase engine.
        Linear scale; Supabase local (2,291 / 1,626 MB) is a 12-container Docker stack whose bars run
        off the axis (torn end) so the single-process engines stay comparable. pg-mem trades runtime
        RAM for the smallest real install: 3.6 MB, pure JS, no WASM. Physical footprint of the whole
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
