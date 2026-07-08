import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const sans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

const SITE_URL = 'https://tinbase.vercel.app'
const TITLE = 'tinbase — the Supabase-compatible backend that fits in a tin'
const DESCRIPTION =
  'Local Supabase dev without Docker — one process, real Postgres with Row Level Security, Auth, Storage, and Realtime, and it even runs in the browser. The official supabase-js SDK works unchanged.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: '%s · tinbase' },
  description: DESCRIPTION,
  keywords: [
    'supabase alternative',
    'supabase local',
    'pocketbase alternative',
    'postgres backend',
    'pglite',
    'supabase-js',
    'self-hosted backend',
    'baas',
    'single binary backend',
  ],
  authors: [{ name: 'Sanket Sahu', url: 'https://x.com/sanketsahu' }],
  creator: 'Sanket Sahu',
  alternates: { canonical: '/' },
  icons: [{ rel: 'icon', url: '/logo.svg', type: 'image/svg+xml' }],
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'tinbase',
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    creator: '@sanketsahu',
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: '#09090b',
}

const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'SoftwareApplication',
      name: 'tinbase',
      description: DESCRIPTION,
      url: SITE_URL,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS, Linux',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      license: 'https://opensource.org/licenses/MIT',
      author: {
        '@type': 'Person',
        name: 'Sanket Sahu',
        url: 'https://x.com/sanketsahu',
        sameAs: ['https://github.com/sanketsahu', 'https://x.com/sanketsahu'],
      },
      downloadUrl: 'https://github.com/tinbase/tinbase/releases',
      softwareVersion: '0.1.0',
      releaseNotes: 'https://github.com/tinbase/tinbase/releases',
    },
    {
      '@type': 'SoftwareSourceCode',
      name: 'tinbase',
      codeRepository: 'https://github.com/tinbase/tinbase',
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Node.js',
      license: 'https://opensource.org/licenses/MIT',
    },
    {
      '@type': 'WebSite',
      name: 'tinbase',
      url: SITE_URL,
    },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth" data-scroll-behavior="smooth">
      <body className={`${sans.variable} ${mono.variable} bg-zinc-950 font-sans text-zinc-100 antialiased`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
        {children}
      </body>
    </html>
  )
}
