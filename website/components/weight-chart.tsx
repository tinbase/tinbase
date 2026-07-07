'use client'
/**
 * Weight chart — horizontal grouped bars, two series per engine: install
 * footprint and memory under load. Both series are megabytes on one LINEAR
 * axis (not a dual-axis — same unit), so the differences are real lengths you
 * compare by eye. Each row shows the engine's logo, name, and the database
 * behind it.
 *
 * Non-tinbase rows (PocketBase, Supabase) are muted to grey so the tinbase
 * engines carry the colour and the eye. The install/RAM series stay legible on
 * muted rows by position — install is the upper bar of the pair, RAM the lower.
 *
 * The two browser-based tinbase engines (pg-mem, wasm) are hidden behind a
 * "Show browser-based options" toggle — the default view is the engines you'd
 * deploy on a server, plus the competitors.
 *
 * The Supabase local stack (2,291 / 1,626 MB) is a 12-container Docker install
 * an order of magnitude past every single-process engine; on a linear axis it
 * would flatten everything else, so its bars are drawn CLIPPED (torn end) with
 * their true numbers. PocketBase is the smallest footprint but is SQLite behind
 * a different, non-supabase-js API — flagged (†) so its win reads in context.
 *
 * Series colour is CVD-validated on the dark surface (aqua↔blue, worst-case
 * ΔE 69.8 deutan / 15.7 tritan).
 */
import { useState } from 'react'

const INSTALL = '#199e70' // aqua — install footprint (tinbase)
const RAM = '#3987e5' // blue — memory under load (tinbase)
const INSTALL_MUTED = '#6b7280' // grey — install (competitors)
const RAM_MUTED = '#4b5563' // darker grey — RAM (competitors)

const DATA = [
  { name: 'tinbase (pg-mem)', db: 'Postgres subset · in-memory', logo: '/logo.svg', self: true, browser: true, install: 3.6, ram: 185, note: 'pure JS, no WASM — lightest to ship; more RAM under load' },
  { name: 'tinbase (wasm)', db: 'real Postgres · PGlite', logo: '/logo.svg', self: true, browser: true, install: 27, ram: 640, note: 'PGlite WASM — portable, heavy heap' },
  { name: 'PocketBase', db: 'SQLite · different API', logo: '/pocketbase.svg', self: false, flag: true, install: 30, ram: 24, note: 'Go binary + SQLite · v0.39.5 — not supabase-js compatible' },
  { name: 'tinbase (native)', db: 'real Postgres 17', logo: '/logo.svg', self: true, install: 36, ram: 100, note: 'embedded native Postgres 17' },
  { name: 'tinbase (binary)', db: 'real Postgres 17', logo: '/logo.svg', self: true, install: 92, ram: 66, note: 'single executable, no runtime needed' },
  { name: 'Supabase local', db: 'Postgres · 12 containers', logo: '/supabase.svg', self: false, install: 2291, ram: 1626, note: '12 Docker containers · CLI 2.40 — off the chart' },
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
const barColor = (self: boolean, key: 'install' | 'ram') =>
  self ? (key === 'install' ? INSTALL : RAM) : key === 'install' ? INSTALL_MUTED : RAM_MUTED

export function WeightChart() {
  const [hover, setHover] = useState<{ name: string; key: 'install' | 'ram' } | null>(null)
  const [showBrowser, setShowBrowser] = useState(false)
  const rowsData = showBrowser ? DATA : DATA.filter((d) => !d.browser)

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

      <button
        type="button"
        onClick={() => setShowBrowser((v) => !v)}
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-emerald-400 transition-colors hover:text-emerald-300"
        aria-expanded={showBrowser}
      >
        {showBrowser ? 'Hide browser-based options' : 'Show browser-based options'}
        <span aria-hidden="true" className={'transition-transform ' + (showBrowser ? 'rotate-180' : '')}>
          ↓
        </span>
      </button>

      <div className="overflow-x-auto">
        <div className="min-w-[460px] space-y-4">
          {rowsData.map((d) => (
            <div
              key={d.name}
              className="grid grid-cols-[9rem_1fr] items-center gap-3 sm:grid-cols-[12.5rem_1fr]"
            >
              <div className="flex items-center justify-end gap-2 text-right">
                <div className="min-w-0">
                  <div
                    className={
                      'truncate text-sm ' +
                      (d.self ? 'font-semibold text-emerald-400' : 'text-zinc-500')
                    }
                  >
                    {d.name}
                    {d.flag && <sup className="text-amber-400"> †</sup>}
                  </div>
                  <div className={'truncate text-[11px] leading-tight ' + (d.self ? 'text-zinc-500' : 'text-zinc-600')}>
                    {d.db}
                  </div>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={d.logo}
                  alt=""
                  aria-hidden="true"
                  className={'size-5 shrink-0 ' + (d.self ? '' : 'opacity-70')}
                />
              </div>

              <div className="space-y-1">
                {SERIES.map((s) => {
                  const mb = d[s.key]
                  const clipped = mb > DOMAIN
                  const color = barColor(d.self, s.key)
                  const active = hover?.name === d.name && hover.key === s.key
                  const dim = hover !== null && !active
                  return (
                    <div
                      key={s.key}
                      className="relative flex h-4 items-center"
                      onMouseEnter={() => setHover({ name: d.name, key: s.key })}
                      onMouseLeave={() => setHover(null)}
                    >
                      <div
                        className="relative h-full rounded-r"
                        style={{
                          width: `max(${widthPct(mb)}%, 3px)`,
                          background: color,
                          opacity: dim ? 0.5 : 1,
                          transition: 'opacity 120ms',
                        }}
                      >
                        {clipped && (
                          // torn end: signals the bar runs past the axis
                          <span
                            className="absolute inset-y-0 -right-1 w-2"
                            style={{
                              background: `repeating-linear-gradient(45deg, ${color} 0 4px, #1a1a19 4px 7px)`,
                            }}
                          />
                        )}
                      </div>
                      <span
                        className={
                          'ml-2 whitespace-nowrap text-xs tabular-nums ' +
                          (d.self ? 'text-zinc-400' : 'text-zinc-500')
                        }
                      >
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
        tinbase engines in colour; PocketBase and Supabase muted for context.{' '}
        <span className="text-amber-400">†</span> PocketBase is the smallest footprint, but it is
        SQLite behind a different API — not a drop-in for supabase-js, unlike every tinbase engine.
        Linear scale; Supabase local (2,291 / 1,626 MB) is a 12-container Docker stack whose bars run
        off the axis (torn end) so the single-process engines stay comparable.
        {showBrowser && ' pg-mem and wasm run in the browser; pg-mem trades runtime RAM for the smallest real install (3.6 MB, pure JS, no WASM).'}{' '}
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
