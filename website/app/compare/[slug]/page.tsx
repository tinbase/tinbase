import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { SiteNav } from '@/components/site-nav'
import { ComparisonTable } from '@/components/comparison-table'
import { LinkButton } from '@/components/ui'
import {
  SectionHead,
  FaqSection,
  ChooseGrid,
  LinkCard,
  CtaBand,
  MarketingFooter,
} from '@/components/marketing'
import { GitHubIcon } from '@/components/github-icon'
import {
  COMPETITORS,
  competitorFromVsSlug,
  altSlug,
  vsSlug,
} from '@/lib/comparisons'

export const dynamicParams = false

export function generateStaticParams() {
  return COMPETITORS.map((c) => ({ slug: vsSlug(c) }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const c = competitorFromVsSlug(slug)
  if (!c) return {}
  return {
    title: c.vsTitle,
    description: c.vsDescription,
    alternates: { canonical: `/compare/${slug}` },
    openGraph: {
      type: 'article',
      url: `/compare/${slug}`,
      title: c.vsTitle,
      description: c.vsDescription,
    },
    twitter: { card: 'summary_large_image', title: c.vsTitle, description: c.vsDescription },
  }
}

export default async function ComparePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const c = competitorFromVsSlug(slug)
  if (!c) notFound()

  const others = COMPETITORS.filter((x) => x.id !== c.id)

  return (
    <>
      <SiteNav />
      <main className="mx-auto max-w-6xl px-6">
        {/* hero */}
        <section className="py-16 sm:py-20">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent">
            Comparison
          </p>
          <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            tinbase <span className="text-subtle">vs</span> {c.name}
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-lg text-muted">{c.vsIntro}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <LinkButton href="/docs">Get started</LinkButton>
            <LinkButton variant="outline" href="https://github.com/tinbase/tinbase">
              <GitHubIcon /> Star on GitHub
            </LinkButton>
          </div>
        </section>

        {/* at a glance */}
        <section className="border-t border-border py-14">
          <SectionHead title="At a glance" />
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6">
              <div className="text-sm font-semibold uppercase tracking-wide text-accent">tinbase</div>
              <p className="mt-3 leading-relaxed text-muted">{c.tinbaseInAWord}</p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-6">
              <div className="text-sm font-semibold uppercase tracking-wide text-fg">{c.name}</div>
              <p className="mt-3 leading-relaxed text-muted">{c.otherInAWord}</p>
            </div>
          </div>
        </section>

        {/* full table */}
        <section className="border-t border-border py-14">
          <SectionHead eyebrow="Feature by feature" title={`tinbase vs ${c.name}, compared`} />
          <p className="mt-3 max-w-2xl text-muted">
            Colour is a hint, not a verdict: green marks a tinbase strength, amber an area where it is
            still catching up. Footprint figures come from the{' '}
            <Link className="text-accent hover:text-accent-hover" href="/docs#benchmarks">
              reproducible benchmarks
            </Link>
            .
          </p>
          <div className="mt-8">
            <ComparisonTable rows={c.rows} competitorName={c.name} />
          </div>
        </section>

        {/* who should choose what */}
        <section className="border-t border-border py-14">
          <SectionHead title="Which should you choose?" />
          <ChooseGrid
            otherLabel={`Choose ${c.name} if`}
            tinbasePoints={c.chooseTinbase}
            otherPoints={c.chooseOther}
          />
        </section>

        {/* related */}
        <section className="border-t border-border py-14">
          <SectionHead title="Keep exploring" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <LinkCard
              href={`/${altSlug(c)}`}
              icon={c.icon}
              title={`${c.name} alternative`}
              body={`Why tinbase works as a ${c.name} alternative, and the migration path.`}
            />
            {others.map((o) => (
              <LinkCard
                key={o.id}
                href={`/compare/${vsSlug(o)}`}
                icon={o.icon}
                title={`tinbase vs ${o.name}`}
                body={o.otherInAWord}
              />
            ))}
          </div>
        </section>

        <FaqSection items={c.faqs} />
        <CtaBand />
      </main>
      <MarketingFooter />
    </>
  )
}
