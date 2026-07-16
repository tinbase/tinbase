import type { Metadata } from 'next'
import { SiteNav } from '@/components/site-nav'
import { LinkCard, MarketingFooter, CtaBand, SectionHead } from '@/components/marketing'
import { COMPETITORS, altSlug, vsSlug } from '@/lib/comparisons'

export const metadata: Metadata = {
  title: 'Compare tinbase — vs Supabase, Firebase, PocketBase, Appwrite',
  description:
    'How tinbase compares to Supabase, Firebase, PocketBase, and Appwrite: a Docker-free, single-process backend on real Postgres, wire-compatible with supabase-js. Honest, feature-by-feature comparisons.',
  alternates: { canonical: '/compare' },
  openGraph: {
    type: 'website',
    url: '/compare',
    title: 'Compare tinbase — vs Supabase, Firebase, PocketBase, Appwrite',
    description:
      'Honest, feature-by-feature comparisons of tinbase against Supabase, Firebase, PocketBase, and Appwrite.',
  },
}

export default function CompareHub() {
  return (
    <>
      <SiteNav />
      <main className="mx-auto max-w-6xl px-6">
        <section className="py-16 sm:py-20">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent">Compare</p>
          <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            How tinbase compares
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-lg text-muted">
            tinbase is a Docker-free backend that runs real Postgres in a single process and is
            wire-compatible with supabase-js. Here is an honest look at how it stacks up against the
            backends you are probably weighing it against, including where each one is the better
            choice.
          </p>
        </section>

        <section className="border-t border-border py-14">
          <SectionHead title="Head-to-head comparisons" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {COMPETITORS.map((c) => (
              <LinkCard
                key={c.id}
                href={`/compare/${vsSlug(c)}`}
                icon={c.icon}
                title={`tinbase vs ${c.name}`}
                body={c.otherInAWord}
              />
            ))}
          </div>
        </section>

        <section className="border-t border-border py-14">
          <SectionHead title="Alternatives" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {COMPETITORS.map((c) => (
              <LinkCard
                key={c.id}
                href={`/${altSlug(c)}`}
                icon={c.icon}
                title={`${c.name} alternative`}
                body={c.altEyebrow}
              />
            ))}
          </div>
        </section>

        <CtaBand />
      </main>
      <MarketingFooter />
    </>
  )
}
