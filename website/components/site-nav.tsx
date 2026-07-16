import Image from 'next/image'
import Link from 'next/link'
import { GitHubIcon } from '@/components/github-icon'
import { ThemeToggle } from '@/components/theme-toggle'

// injected at build time from the root package.json (see next.config.ts)
const VERSION = `v${process.env.NEXT_PUBLIC_TINBASE_VERSION ?? '0.0.0'}`

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
        <div className="flex min-w-0 shrink items-center gap-2.5">
          <Link href="/" className="flex shrink-0 items-center gap-2.5 font-semibold">
            <Image src="/logo.svg" alt="" width={26} height={26} />
            tinbase
          </Link>
          <span className="hidden items-center gap-1.5 rounded-full border border-border bg-surface-2 py-0.5 pl-2 pr-1 text-[11px] text-subtle sm:inline-flex">
            {VERSION}
            {/* ALPHA with a styled hover/focus tooltip */}
            <span tabIndex={0} className="group relative cursor-help rounded-full bg-warn-soft px-1.5 font-semibold uppercase tracking-wide text-warn outline-none">
              alpha
              <span
                role="tooltip"
                className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-60 -translate-x-1/2 rounded-lg border border-strong bg-surface-2 px-3 py-2 text-[12px] font-normal normal-case leading-relaxed tracking-normal text-fg opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
              >
                <span className="font-semibold text-warn">Alpha</span> — not production-ready yet. Great for local
                development, prototypes, and embedded/browser use.
              </span>
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 text-sm sm:gap-1">
          <Link href="/docs" className="rounded-md px-2 py-1.5 text-fg hover:bg-surface-2 hover:text-fg sm:px-3">
            Docs
          </Link>
          <Link href="/studio" className="rounded-md px-2 py-1.5 text-fg hover:bg-surface-2 hover:text-fg sm:px-3">
            Studio
          </Link>
          <Link href="/browser" className="rounded-md px-2 py-1.5 text-fg hover:bg-surface-2 hover:text-fg sm:px-3">
            Browser
          </Link>
          <Link href="/compare" className="hidden rounded-md px-3 py-1.5 text-fg hover:bg-surface-2 hover:text-fg sm:block">
            Compare
          </Link>
          <a href="/#benchmarks" className="hidden rounded-md px-3 py-1.5 text-fg hover:bg-surface-2 hover:text-fg md:block">
            Benchmarks
          </a>
          <a
            href="https://github.com/tinbase/tinbase"
            aria-label="GitHub"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-fg hover:bg-surface-2 hover:text-fg sm:px-3"
          >
            <GitHubIcon /> <span className="hidden sm:inline">GitHub</span>
          </a>
          <ThemeToggle />
        </div>
      </nav>
    </header>
  )
}
