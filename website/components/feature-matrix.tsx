/**
 * Feature-completeness matrix, mapped from ROADMAP.md — what works today, what
 * is partial, and what is still planned, across every surface. Kept honest:
 * only "Yes" for things exercised by the test suite.
 */
import { Fragment } from 'react'

type Status = 'yes' | 'partial' | 'no'
type Row = [feature: string, status: Status, note: string]
type Group = { area: string; coverage: string; rows: Row[] }

const GROUPS: Group[] = [
  {
    area: 'Database · REST (PostgREST)',
    coverage: '~85%',
    rows: [
      ['Select + filters (eq/neq/gt/lt/like/ilike/in/is, or/and trees)', 'yes', ''],
      ['Embedded resources (to-one, to-many, m2m, nested, !inner, aliases, hints)', 'yes', ''],
      ['Insert, bulk insert, upsert (merge/ignore)', 'yes', ''],
      ['Update, delete', 'yes', ''],
      ['count (exact/planned/estimated), single / maybeSingle', 'yes', ''],
      ['Full-text search, JSON-path filters, casts', 'yes', ''],
      ['order / limit / offset (top-level and per-embed)', 'yes', ''],
      ['RPC (scalar, setof, void, filters on results)', 'yes', ''],
      ['Spread embeds (…rel(col))', 'partial', 'flat column lists only'],
      ['Aggregates in select (count/sum/avg/…)', 'no', 'planned (Phase 6)'],
      ['.explain(), .csv()', 'no', 'planned'],
    ],
  },
  {
    area: 'Auth (GoTrue)',
    coverage: '~90%',
    rows: [
      ['Email / password sign-up + sign-in', 'yes', ''],
      ['Anonymous sign-in', 'yes', ''],
      ['Anonymous → permanent upgrade', 'yes', 'keeps the same uid'],
      ['Session refresh + rotation, getUser / updateUser / signOut', 'yes', ''],
      ['OAuth (Google, GitHub, generic OIDC) + PKCE', 'yes', ''],
      ['MFA / TOTP (enroll → challenge → verify, aal2)', 'yes', ''],
      ['Magic link / OTP / password recovery', 'yes', 'viewable in the local /inbox'],
      ['Identity linking (auth.identities)', 'yes', ''],
      ['Admin user CRUD (service_role)', 'yes', ''],
      ['Phone / SMS auth', 'no', 'planned'],
      ['SSO / SAML', 'no', 'planned'],
    ],
  },
  {
    area: 'Realtime',
    coverage: '~90%',
    rows: [
      ['postgres_changes (INSERT / UPDATE / DELETE)', 'yes', ''],
      ['RLS-filtered postgres_changes', 'yes', 'DELETE re-check is limited'],
      ['Broadcast + presence', 'yes', ''],
      ['Private channels (RLS authorization via realtime.messages)', 'yes', ''],
      ['Broadcast-from-database (realtime.send)', 'yes', ''],
      ['Per-row DELETE RLS (WALRUS)', 'partial', 'authenticated/service only'],
    ],
  },
  {
    area: 'Storage',
    coverage: '~80%',
    rows: [
      ['Bucket CRUD, upload (raw + multipart), download', 'yes', ''],
      ['Public objects, signed URLs, signed upload URLs', 'yes', ''],
      ['List with folders, move / copy, remove, size/MIME limits', 'yes', ''],
      ['RLS on storage.objects', 'yes', ''],
      ['Image transformations (resize/quality)', 'no', 'planned (Phase 6)'],
      ['Resumable (TUS) uploads', 'no', 'planned'],
    ],
  },
  {
    area: 'Edge Functions',
    coverage: '~85%',
    rows: [
      ['supabase.functions.invoke()', 'yes', ''],
      ['Deno.serve / Deno.env / export default handlers', 'yes', ''],
      ['TypeScript + relative / multi-file imports (bundled)', 'yes', ''],
      ['npm: / jsr: / URL imports', 'yes', 'via esm.sh, fetched on first run'],
      ['Function secrets (supabase/functions/.env)', 'yes', ''],
    ],
  },
  {
    area: 'Automation',
    coverage: 'extension-free',
    rows: [
      ['Database webhooks (CDC → HTTP)', 'yes', 'Supabase webhook payload'],
      ['Cron jobs (cron.schedule)', 'yes', 'pg_cron API — matches in UTC'],
      ['HTTP from SQL (net.http_post/get)', 'yes', 'pg_net emulation'],
      ['Queues (pgmq: send/read/pop/archive/drop/purge/list)', 'yes', 'replaces pgmq'],
      ['Secrets (Supabase Vault)', 'yes', 'create_secret / decrypted_secrets'],
    ],
  },
  {
    area: 'Migrations, CLI & Studio',
    coverage: '~80%',
    rows: [
      ['supabase/migrations + seed conventions', 'yes', 'portable to hosted Supabase'],
      ['Runs real projects unchanged (CREATE EXTENSION tolerated, CONCURRENTLY, per-file search_path)', 'yes', 'e.g. Cap-go/capgo: 335 migrations + seed'],
      ['db reset, db diff, db pull, inspect', 'yes', ''],
      ['gen types (TypeScript Database type)', 'yes', ''],
      ['Studio: table editor, SQL, auth, RLS editor, storage, logs', 'yes', 'at /_/'],
      ['Studio: table/column designer UI', 'no', 'planned'],
    ],
  },
  {
    area: 'Engines & extensions',
    coverage: '',
    rows: [
      ['Native embedded Postgres 17 — default (macOS/Linux)', 'yes', ''],
      ['PGlite (WASM Postgres) — browser-ready, default on Windows', 'yes', ''],
      ['pg-mem (pure-JS, in-memory subset)', 'yes', 'no RLS / cron / pgmq'],
      ['Single-file binary', 'yes', ''],
      ['Common extensions (uuid-ossp, pgcrypto, citext, pg_trgm, …)', 'yes', 'where the engine bundles them'],
      ['pgvector (vector search)', 'no', 'needs bundled extension binaries (Phase 4)'],
    ],
  },
]

const BADGE: Record<Status, { label: string; cls: string }> = {
  yes: { label: '✓ Yes', cls: 'text-emerald-400' },
  partial: { label: '◑ Partial', cls: 'text-amber-400' },
  no: { label: '– Planned', cls: 'text-zinc-500' },
}

export function FeatureMatrix() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <tbody>
          {GROUPS.map((g) => (
            <Fragment key={g.area}>
              <tr>
                <td colSpan={3} className="border-b border-zinc-800 pb-2 pt-6">
                  <span className="text-[13px] font-semibold uppercase tracking-wide text-zinc-200">{g.area}</span>
                  {g.coverage && <span className="ml-2 text-xs text-emerald-400">{g.coverage}</span>}
                </td>
              </tr>
              {g.rows.map(([feature, status, note]) => (
                <tr key={g.area + feature} className="border-b border-zinc-800/50 align-top">
                  <td className="py-2 pr-4 text-zinc-300">{feature}</td>
                  <td className={'w-24 whitespace-nowrap py-2 pr-4 font-medium ' + BADGE[status].cls}>{BADGE[status].label}</td>
                  <td className="w-52 py-2 text-xs text-zinc-500">{note}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
