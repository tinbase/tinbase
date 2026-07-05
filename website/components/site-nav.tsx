import Image from 'next/image'
import Link from 'next/link'
import { GitHubIcon } from '@/components/github-icon'

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5 font-semibold">
          <Image src="/logo.svg" alt="" width={26} height={26} />
          tinbase
        </Link>
        <div className="flex items-center gap-1 text-sm">
          <Link href="/docs" className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800/60 hover:text-white">
            Docs
          </Link>
          <Link href="/#benchmarks" className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800/60 hover:text-white">
            Benchmarks
          </Link>
          <a
            href="https://github.com/sanketsahu/tinbase"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800/60 hover:text-white"
          >
            <GitHubIcon /> GitHub
          </a>
        </div>
      </nav>
    </header>
  )
}
