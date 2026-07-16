import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { SiteNav } from '@/components/site-nav'
import { Code } from '@/components/code'
import { FeatureIcon } from '@/components/feature-icon'
import { ComparisonTable } from '@/components/comparison-table'
import { Badge, LinkButton } from '@/components/ui'
import {
  SectionHead,
  FaqSection,
  ChooseGrid,
  LinkCard,
  CtaBand,
  MarketingFooter,
} from '@/components/marketing'
import {
  COMPETITORS,
  competitorFromAltSlug,
  altSlug,
  vsSlug,
} from '@/lib/comparisons'

export const dynamicParams = false

export function generateStaticParams() {
  return COMPETITORS.map((c) => ({ slug: altSlug(c) }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const c = competitorFromAltSlug(slug)
  if (!c) return {}
  return {
    title: c.altTitle,
    description: c.altDescription,
    alternates: { canonical: `/${slug}` },
    openGraph: {
      type: 'article',
      url: `/${slug}`,
      title: c.altTitle,
      description: c.altDescription,
    },
    twitter: { card: 'summary_large_image', title: c.altTitle, description: c.altDescription },
  }
}

const SNIPPET = `import { createClient } from '@supabase/supabase-js'

// tinbase speaks the same wire protocol, so the official SDK is unchanged
const supabase = createClient('http://127.0.0.1:54321', ANON_KEY)

await supabase.auth.signUp({ email, password })
await supabase.from('todos').insert({ title: 'hello' })
const { data } = await supabase.from('todos').select('*').eq('done', false)`

export default async function AlternativePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const c = competitorFromAltSlug(slug)
  if (!c) notFound()

  const others = COMPETITORS.filter((x) => x.id !== c.id)

  return (
    <>
      <SiteNav />
      <main className="mx-auto max-w-6xl px-6">
        {/* hero */}
        <section className="flex flex-col items-center py-20 text-center sm:py-24">
          <Image src="/logo.svg" alt="tinbase logo" width={72} height={72} priority />
          <Badge className="mt-8 max-w-full text-center leading-snug">
            {c.altEyebrow + ' · Open source (MIT)'}
          </Badge>
          <h1 className="mt-6 max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            {c.headingLead}
            <span className="text-accent">{c.name}</span>
            {c.headingTail}
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg text-muted">{c.altIntro}</p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <LinkButton href="/docs">Get started</LinkButton>
            <LinkButton variant="outline" href={`/compare/${vsSlug(c)}`}>
              tinbase vs {c.name} →
            </LinkButton>
          </div>
          <code className="mt-8 rounded-lg border border-border bg-surface-2 px-4 py-2.5 font-mono text-sm text-accent">
            npx tinbase start
          </code>
        </section>

        {/* positioning */}
        <section className="border-t border-border py-16">
          <SectionHead eyebrow="The honest version" title={`Is tinbase a ${c.name} alternative?`} />
          <div className="mt-6 max-w-3xl space-y-4">
            <p className="leading-relaxed text-muted">{c.whatItIs}</p>
            {c.positioning.map((para, i) => (
              <p key={i} className="leading-relaxed text-muted">
                {para}
              </p>
            ))}
          </div>
        </section>

        {/* reasons */}
        <section className="border-t border-border py-16">
          <SectionHead eyebrow="Why switch" title={`Why teams pick tinbase over ${c.name}`} />
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {c.reasons.map((r) => (
              <div key={r.title} className="rounded-xl border border-border bg-surface p-6">
                <span className="flex size-9 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-accent">
                  <FeatureIcon name={r.icon} className="size-5" />
                </span>
                <h3 className="mt-4 font-semibold text-accent">{r.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{r.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* comparison table */}
        <section className="border-t border-border py-16">
          <SectionHead eyebrow="Side by side" title={`tinbase vs ${c.name}`} />
          <p className="mt-3 max-w-2xl text-muted">
            The short version. For the full breakdown and when {c.name} is the better call, see the{' '}
            <Link className="text-accent hover:text-accent-hover" href={`/compare/${vsSlug(c)}`}>
              complete tinbase vs {c.name} comparison
            </Link>
            .
          </p>
          <div className="mt-8">
            <ComparisonTable rows={c.rows} competitorName={c.name} />
          </div>
        </section>

        {/* honest tradeoffs */}
        <section className="border-t border-border py-16">
          <SectionHead title="Pick the right tool" />
          <ChooseGrid
            otherLabel={`Stick with ${c.name} if`}
            tinbasePoints={c.chooseTinbase}
            otherPoints={c.chooseOther}
          />
        </section>

        {/* getting started */}
        <section className="border-t border-border py-16">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <SectionHead eyebrow="Getting started" title="Keep the SDK you already know" />
              <p className="mt-4 text-muted">
                tinbase implements the PostgREST query grammar, GoTrue auth, the Storage API, and the
                Realtime protocol, verified by running the official supabase-js against it. Point the
                client at tinbase and your code runs.
              </p>
              <Link
                href="/docs"
                className="mt-6 inline-block text-sm font-semibold text-accent hover:text-accent-hover"
              >
                Read the docs →
              </Link>
            </div>
            <Code code={SNIPPET} lang="ts" />
          </div>
        </section>

        {/* related */}
        <section className="border-t border-border py-16">
          <SectionHead title="Compare with other backends" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <LinkCard
              href={`/compare/${vsSlug(c)}`}
              icon={c.icon}
              title={`tinbase vs ${c.name}`}
              body={`The full, feature-by-feature comparison with ${c.name}.`}
            />
            {others.map((o) => (
              <LinkCard
                key={o.id}
                href={`/${altSlug(o)}`}
                icon={o.icon}
                title={`${o.name} alternative`}
                body={o.altEyebrow}
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
