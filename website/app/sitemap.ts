import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: 'https://tinbase.vercel.app', lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: 'https://tinbase.vercel.app/docs', lastModified: new Date(), changeFrequency: 'weekly', priority: 0.8 },
  ]
}
