/**
 * Shared building blocks for the SEO landing pages (alternatives + comparisons).
 * Kept deliberately small and server-rendered — no client JS.
 */
import Link from 'next/link'
import { GitHubIcon } from '@/components/github-icon'
import { LinkButton } from '@/components/ui'
import { FeatureIcon } from '@/components/feature-icon'
import type { Faq } from '@/lib/comparisons'

/** Eyebrow + H2 section heading, matching the home page rhythm. */
export function SectionHead({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <>
      {eyebrow && (
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent">{eyebrow}</p>
      )}
      <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
    </>
  )
}

/**
 * FAQ list that also emits FAQPage structured data so the questions are
 * eligible for rich results. Answers are plain text (no markup).
 */
export function FaqSection({ items }: { items: Faq[] }) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  }
  return (
    <section className="border-t border-border py-16">
      <SectionHead title="Frequently asked questions" />
      <dl className="mt-8 space-y-6">
        {items.map((f) => (
          <div key={f.q} className="border-b border-border pb-6 last:border-0">
            <dt className="font-semibold text-fg">{f.q}</dt>
            <dd className="mt-2 leading-relaxed text-muted">{f.a}</dd>
          </div>
        ))}
      </dl>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </section>
  )
}

/** "Choose X if ..." two-column honest summary. */
export function ChooseGrid({
  tinbaseLabel = 'Choose tinbase if',
  otherLabel,
  tinbasePoints,
  otherPoints,
}: {
  tinbaseLabel?: string
  otherLabel: string
  tinbasePoints: string[]
  otherPoints: string[]
}) {
  return (
    <div className="mt-8 grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6">
        <h3 className="font-semibold text-accent">{tinbaseLabel}</h3>
        <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-muted">
          {tinbasePoints.map((p) => (
            <li key={p} className="flex gap-2.5">
              <span aria-hidden className="mt-0.5 shrink-0 text-accent">✓</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-xl border border-border bg-surface p-6">
        <h3 className="font-semibold text-fg">{otherLabel}</h3>
        <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-muted">
          {otherPoints.map((p) => (
            <li key={p} className="flex gap-2.5">
              <span aria-hidden className="mt-0.5 shrink-0 text-subtle">→</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** A card that links elsewhere (other comparisons, docs). */
export function LinkCard({
  href,
  icon,
  title,
  body,
}: {
  href: string
  icon: string
  title: string
  body: string
}) {
  return (
    <Link
      href={href}
      className="group flex gap-4 rounded-xl border border-border bg-surface p-5 transition-colors hover:border-strong"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-accent">
        <FeatureIcon name={icon} className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block font-semibold text-fg group-hover:text-accent">{title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-muted">{body}</span>
      </span>
    </Link>
  )
}

/** Bottom "get started" call to action, shared across landing pages. */
export function CtaBand() {
  return (
    <section className="border-t border-border py-16 text-center">
      <h2 className="text-3xl font-bold tracking-tight">Try it in one command</h2>
      <p className="mx-auto mt-3 max-w-xl text-muted">
        No Docker, no sign-up. Point the supabase-js SDK you already know at a real Postgres backend
        running in a single process.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <LinkButton href="/docs">Get started</LinkButton>
        <LinkButton variant="outline" href="https://github.com/tinbase/tinbase">
          <GitHubIcon /> Star on GitHub
        </LinkButton>
      </div>
      <code className="mt-7 inline-block rounded-lg border border-border bg-surface-2 px-4 py-2.5 font-mono text-sm text-accent">
        npx tinbase start
      </code>
    </section>
  )
}

/** Compact site footer for the marketing pages. */
export function MarketingFooter() {
  return (
    <footer className="border-t border-border py-10">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 text-sm text-subtle">
        <span>
          Built by{' '}
          <a href="https://x.com/sanketsahu" className="font-medium text-fg hover:text-fg">
            Sanket Sahu (@sanketsahu)
          </a>{' '}
          · MIT
        </span>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Link href="/" className="hover:text-fg">Home</Link>
          <Link href="/docs" className="hover:text-fg">Docs</Link>
          <Link href="/compare" className="hover:text-fg">Compare</Link>
          <a href="https://github.com/tinbase/tinbase" className="hover:text-fg">GitHub</a>
        </div>
      </div>
    </footer>
  )
}
