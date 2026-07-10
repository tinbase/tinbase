'use client'

import { useEffect, useState } from 'react'

/**
 * Light/dark toggle. The initial theme is applied before paint by the inline
 * script in layout.tsx (localStorage → system preference), so this component
 * only reflects and flips the current state. Choosing a theme persists it;
 * clearing localStorage returns to following the OS.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(true)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    setDark(document.documentElement.classList.contains('dark'))
  }, [])

  const toggle = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {
      /* storage blocked — still toggles for this session */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={mounted ? `Switch to ${dark ? 'light' : 'dark'} theme` : 'Toggle theme'}
      title="Toggle theme"
      className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {/* sun when dark (click → light), moon when light (click → dark) */}
      {mounted && dark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  )
}
