import type { MetadataRoute } from 'next'
import { COMPETITORS, altSlug, vsSlug } from '@/lib/comparisons'

const BASE = 'https://tinbase.dev'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE}/docs`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${BASE}/studio`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE}/browser`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE}/compare`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
  ]

  const comparisonPages: MetadataRoute.Sitemap = COMPETITORS.flatMap((c) => [
    { url: `${BASE}/${altSlug(c)}`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE}/compare/${vsSlug(c)}`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
  ])

  return [...staticPages, ...comparisonPages]
}
