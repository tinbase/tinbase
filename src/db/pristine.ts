/**
 * Whether a database still holds only what its project files put there.
 *
 * A hosted preview's database starts from the project's migrations and seed. Most
 * are never used beyond that: a host that parks idle projects can drop such a
 * database outright and rebuild it from the files when the project is opened
 * again, and only keep a dump of the ones that hold something people wrote.
 *
 * The baseline is a snapshot of the data, taken when the database is created and
 * re-taken whenever migrations or the seed apply to a database that still matches
 * its last snapshot, since that state is again exactly what the files produce.
 * Once anything else has written to it, the snapshot is never refreshed again:
 * the database is marked diverged for good, so the check errs only toward keeping.
 *
 * What counts as data: every row of every table in the app's own schemas (and
 * their shape: columns, functions, policies), which accounts exist, uploaded
 * objects, buckets, cron jobs and vault secret names. Sign-ins, sessions, refresh
 * tokens and audit rows do not count - a demo login must not make a database
 * worth keeping.
 *
 * A write that lands while migrations are being applied to a pristine database
 * is folded into the new baseline: tinbase serves everything over one connection
 * and the migrations commit one by one, so there is no point at which both can be
 * held still. The window is as long as applying the migrations.
 */
import type { DbEngine } from './engine.js'

/** Schemas tinbase creates and manages itself; everything else belongs to the app. */
export const MANAGED_SCHEMAS = [
  'auth',
  'cron',
  'extensions',
  'graphql',
  'graphql_public',
  'net',
  'pgmq',
  'pgsodium',
  'realtime',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'tinbase',
  'vault',
]

/** Managed tables whose contents are still the app's data, read without the noisy columns. */
const MANAGED_SOURCES: Array<{ name: string; sql: string }> = [
  { name: 'auth.users', sql: 'select id from auth.users' },
  { name: 'storage.buckets', sql: 'select id, name, public from storage.buckets' },
  { name: 'storage.objects', sql: 'select bucket_id, name from storage.objects' },
  { name: 'cron.job', sql: 'select jobname, schedule, command, active from cron.job' },
  { name: 'vault.secrets', sql: 'select name from vault.secrets' },
]

const SNAPSHOT_SQL = `
create table if not exists tinbase.seed_snapshot (
  id int primary key default 1 check (id = 1),
  state text not null check (state in ('pristine', 'diverged')),
  fingerprint jsonb,
  reason text,
  recorded_at timestamptz not null default now()
);
`

/** Row count and content hash per table, plus a hash of the app schemas' shape. */
export interface Fingerprint {
  shape: string
  tables: Record<string, { rows: number; hash: string }>
}

export interface PristineState {
  /** true only when the database matches its last snapshot */
  pristine: boolean
  state: 'pristine' | 'diverged' | 'unknown'
  /** why it is not pristine */
  reason?: string
}

function ident(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

async function appSchemas(engine: DbEngine): Promise<string[]> {
  const r = await engine.query<{ nspname: string }>(
    `select nspname from pg_namespace
     where nspname <> 'information_schema' and nspname not like 'pg\\_%' and nspname <> all($1)
       and not exists (select 1 from pg_depend d
                       where d.classid = 'pg_namespace'::regclass and d.objid = pg_namespace.oid and d.deptype = 'e')
     order by 1`,
    [MANAGED_SCHEMAS]
  )
  return r.rows.map((x) => x.nspname)
}

async function hashRows(engine: DbEngine, from: string): Promise<{ rows: number; hash: string }> {
  // Hash each row, then the sorted row hashes: independent of physical order, so
  // an untouched table hashes the same after a dump and reload.
  const r = await engine.query<{ n: string | number; h: string | null }>(
    `select count(*) as n, md5(coalesce(string_agg(rh, '' order by rh), '')) as h
     from (select md5(t::text) as rh from (${from}) t) s`
  )
  return { rows: Number(r.rows[0]?.n ?? 0), hash: r.rows[0]?.h ?? '' }
}

/** Compute the current fingerprint. */
export async function fingerprint(engine: DbEngine): Promise<Fingerprint> {
  const schemas = await appSchemas(engine)
  const tables: Fingerprint['tables'] = {}

  const rel = await engine.query<{ schema: string; name: string }>(
    `select n.nspname as schema, c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and not c.relispartition and n.nspname = any($1)
       and not exists (select 1 from pg_depend d
                       where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
     order by 1, 2`,
    [schemas]
  )
  for (const t of rel.rows) {
    tables[`${t.schema}.${t.name}`] = await hashRows(engine, `select * from ${ident(t.schema)}.${ident(t.name)}`)
  }
  for (const s of MANAGED_SOURCES) {
    const [schema, table] = s.name.split('.')
    const exists = await engine.query(`select to_regclass($1) is not null as ok`, [`${schema}.${table}`])
    if (exists.rows[0]?.ok) tables[s.name] = await hashRows(engine, s.sql)
  }

  const shape = await engine.query<{ h: string | null }>(
    `select md5(coalesce(string_agg(x, E'\\n' order by x), '')) as h from (
       select format('col %s.%s.%s %s %s', table_schema, table_name, column_name, data_type, is_nullable) as x
         from information_schema.columns where table_schema = any($1)
       union all
       select format('fn %s.%s(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = any($1)
           and not exists (select 1 from pg_depend d
                           where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       union all
       select format('pol %s.%s.%s', schemaname, tablename, policyname)
         from pg_policies where schemaname = any($1) or schemaname = 'storage'
     ) s`,
    [schemas]
  )
  return { shape: shape.rows[0]?.h ?? '', tables }
}

/** The first difference between two fingerprints, or null when they match. */
export function difference(was: Fingerprint, now: Fingerprint): string | null {
  for (const [name, t] of Object.entries(now.tables)) {
    const before = was.tables[name]
    if (!before) return `${name} is new`
    if (before.rows !== t.rows) return `${name} has ${t.rows} rows, was ${before.rows}`
    if (before.hash !== t.hash) return `${name} rows changed`
  }
  for (const name of Object.keys(was.tables)) {
    if (!now.tables[name]) return `${name} was dropped`
  }
  if (was.shape !== now.shape) return 'schema changed outside migrations'
  return null
}

async function ensureTable(engine: DbEngine): Promise<void> {
  await engine.exec(SNAPSHOT_SQL)
}

async function write(engine: DbEngine, state: 'pristine' | 'diverged', fp: Fingerprint | null, reason?: string) {
  await engine.query(
    `insert into tinbase.seed_snapshot (id, state, fingerprint, reason, recorded_at)
     values (1, $1, $2::jsonb, $3, now())
     on conflict (id) do update set state = excluded.state, fingerprint = excluded.fingerprint,
       reason = excluded.reason, recorded_at = excluded.recorded_at`,
    [state, fp ? JSON.stringify(fp) : null, reason ?? null]
  )
}

/** Take the snapshot now: the current state becomes the baseline. */
export async function recordSnapshot(engine: DbEngine): Promise<void> {
  await ensureTable(engine)
  await write(engine, 'pristine', await fingerprint(engine))
}

/**
 * Compare the database with its snapshot. A difference marks it diverged for
 * good, so a database that has held real data is never treated as disposable.
 */
export async function checkPristine(engine: DbEngine): Promise<PristineState> {
  await ensureTable(engine)
  const r = await engine.query<{ state: string; fingerprint: Fingerprint | string | null; reason: string | null }>(
    `select state, fingerprint, reason from tinbase.seed_snapshot where id = 1`
  )
  const row = r.rows[0]
  if (!row) return { pristine: false, state: 'unknown', reason: 'no seed snapshot recorded' }
  if (row.state === 'diverged') return { pristine: false, state: 'diverged', reason: row.reason ?? undefined }
  const was: Fingerprint = typeof row.fingerprint === 'string' ? JSON.parse(row.fingerprint) : row.fingerprint!
  const diff = difference(was, await fingerprint(engine))
  if (!diff) return { pristine: true, state: 'pristine' }
  await write(engine, 'diverged', null, diff)
  return { pristine: false, state: 'diverged', reason: diff }
}

/** True when nothing beyond tinbase's own bootstrap is in the database yet. */
async function isEmpty(engine: DbEngine): Promise<boolean> {
  const r = await engine.query<{ n: string | number }>(
    `select (select count(*) from supabase_migrations.schema_migrations)
          + (select count(*) from supabase_migrations.seed_files)
          + (select count(*) from auth.users) as n`
  )
  if (Number(r.rows[0]?.n ?? 0) > 0) return false
  // Only the app's own tables: the bootstrap may create default buckets or jobs.
  const fp = await fingerprint(engine)
  return Object.entries(fp.tables).every(([name, t]) => MANAGED_SOURCES.some((s) => s.name === name) || t.rows === 0)
}

/**
 * Start tracking a database the first time tinbase opens it. A new, empty
 * database gets its baseline. One that already held migrations or data before
 * tinbase recorded snapshots is marked diverged: nothing says what in it came
 * from the files.
 */
export async function initSnapshot(engine: DbEngine): Promise<void> {
  await ensureTable(engine)
  const r = await engine.query(`select 1 from tinbase.seed_snapshot where id = 1`)
  if (r.rows.length > 0) return
  if (await isEmpty(engine)) await recordSnapshot(engine)
  else await write(engine, 'diverged', null, 'existed before tinbase recorded seed snapshots')
}
