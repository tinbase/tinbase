import Image from 'next/image'
import Link from 'next/link'
import { GitHubIcon } from '@/components/github-icon'

// injected at build time from the root package.json (see next.config.ts)
const VERSION = `v${process.env.NEXT_PUBLIC_TINBASE_VERSION ?? '0.0.0'}`

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-2.5">
          <Link href="/" className="flex items-center gap-2.5 font-semibold">
            <Image src="/logo.svg" alt="" width={26} height={26} />
            tinbase
          </Link>
          <span className="hidden items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 py-0.5 pl-2 pr-1 text-[11px] text-zinc-500 sm:inline-flex">
            {VERSION}
            {/* ALPHA with a styled hover/focus tooltip */}
            <span tabIndex={0} className="group relative cursor-help rounded-full bg-amber-400/15 px-1.5 font-semibold uppercase tracking-wide text-amber-400 outline-none">
              alpha
              <span
                role="tooltip"
                className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-60 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[12px] font-normal normal-case leading-relaxed tracking-normal text-zinc-300 opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
              >
                <span className="font-semibold text-amber-400">Alpha</span> — not production-ready yet. Great for local
                development, prototypes, and embedded/browser use.
              </span>
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <Link href="/docs" className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800/60 hover:text-white">
            Docs
          </Link>
          <Link href="/studio" className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800/60 hover:text-white">
            Studio
          </Link>
          <Link href="/browser" className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800/60 hover:text-white">
            Browser
          </Link>
          <a href="/#benchmarks" className="hidden rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800/60 hover:text-white sm:block">
            Benchmarks
          </a>
          <a
            href="https://github.com/tinbase/tinbase"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800/60 hover:text-white"
          >
            <GitHubIcon /> GitHub
          </a>
        </div>
      </nav>
    </header>
  )
}
