import { ImageResponse } from 'next/og'

export const runtime = 'nodejs'
export const alt = 'tinbase — the Supabase-compatible backend that fits in a tin'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const Logo = (
  <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
    <path d="M24 34v56c0 8.8 16.1 16 36 16s36-7.2 36-16V34" fill="#059669" />
    <path d="M24 62c0 8.8 16.1 16 36 16s36-7.2 36-16" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="4" fill="none" />
    <ellipse cx="60" cy="34" rx="36" ry="16" fill="#34d399" />
    <circle cx="72" cy="31" r="7" fill="none" stroke="#065f46" strokeWidth="4" />
  </svg>
)

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#09090b',
          backgroundImage: 'radial-gradient(ellipse at top, #05966922, transparent 60%)',
          color: '#fafafa',
          fontFamily: 'sans-serif',
        }}
      >
        {Logo}
        <div style={{ display: 'flex', marginTop: 48, fontSize: 64, fontWeight: 700, letterSpacing: -2 }}>
          <span>The Supabase-compatible backend that fits in a&nbsp;</span>
          <span style={{ color: '#34d399' }}>tin</span>
        </div>
        <div style={{ display: 'flex', marginTop: 28, fontSize: 28, color: '#a1a1aa', textAlign: 'center', maxWidth: 900 }}>
          One small binary · real Postgres with RLS · supabase-js works unchanged · no Docker
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 44,
            padding: '14px 28px',
            borderRadius: 12,
            border: '1px solid #27272a',
            backgroundColor: '#18181b',
            fontSize: 26,
            color: '#34d399',
            fontFamily: 'monospace',
          }}
        >
          npx tinbase start
        </div>
      </div>
    ),
    size
  )
}
