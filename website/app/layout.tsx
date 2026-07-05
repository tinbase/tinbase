import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const sans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'tinbase — the Supabase backend that fits in a tin',
  description:
    'A Docker-free, Supabase-compatible backend. One 57 MB binary, 44 MB of RAM, real Postgres, and the official supabase-js SDK works unchanged.',
  icons: [{ rel: 'icon', url: '/logo.svg', type: 'image/svg+xml' }],
  openGraph: {
    title: 'tinbase',
    description: 'PocketBase ergonomics, Supabase compatibility, real Postgres.',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth" data-scroll-behavior="smooth">
      <body className={`${sans.variable} ${mono.variable} bg-zinc-950 font-sans text-zinc-100 antialiased`}>
        {children}
      </body>
    </html>
  )
}
