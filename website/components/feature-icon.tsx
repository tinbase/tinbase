/**
 * Small monoline icons for the "Why tinbase" feature cards. Stroke-based,
 * inherit currentColor, 24-grid. Keyed by name so each feature picks its own.
 */
import type { ReactNode } from 'react'

const ICONS: Record<string, ReactNode> = {
  // supabase-js works unchanged — a chain link (it just connects)
  link: (
    <>
      <path d="M9.5 14.5l5-5" />
      <path d="M11 6.5l1-1a3.5 3.5 0 0 1 5 5l-1 1" />
      <path d="M13 17.5l-1 1a3.5 3.5 0 0 1-5-5l1-1" />
    </>
  ),
  // real Postgres — a database cylinder
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  // one file to deploy — a cube
  box: (
    <>
      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </>
  ),
  // migrations stay portable — transfer arrows
  transfer: (
    <>
      <path d="M4 9h13l-3.5-3.5" />
      <path d="M20 15H7l3.5 3.5" />
    </>
  ),
  // auth — a padlock
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  // edge functions — a lightning bolt
  bolt: <path d="M13 3L5 13h5l-1 8 8-11h-5l1-7z" />,
  // webhooks, cron & queues — a clock
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  // typed clients & studio — code chevrons
  code: (
    <>
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
    </>
  ),
  // realtime — broadcast arcs
  broadcast: (
    <>
      <path d="M5.5 10.5a9 9 0 0 1 13 0" />
      <path d="M8 13.5a5 5 0 0 1 8 0" />
      <circle cx="12" cy="17" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  // runs in the browser — a browser window
  browser: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18" />
      <path d="M6.5 7h.01M9 7h.01" />
    </>
  ),
}

export function FeatureIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICONS[name] ?? null}
    </svg>
  )
}
