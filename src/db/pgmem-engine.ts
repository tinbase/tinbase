/**
 * pg-mem engine — an ultralight, pure-JS, in-memory Postgres *subset* for
 * local dev / previews (RapidNative) where footprint matters more than full
 * fidelity. A ~3.6 MB install with no WASM, vs PGlite's ~600 MB heap.
 *
 * What works: the REST CRUD surface (select/insert/update/delete, filters,
 * embeds, count), email/password auth, edge functions, realtime
 * (broadcast/presence + postgres_changes), and database webhooks. Because
 * pg-mem has no triggers/LISTEN/NOTIFY, change events for realtime and webhooks
 * are synthesized in JS by the REST layer (see Database.emitCdc) — every write
 * goes through it in-process.
 *
 * What's explicitly NOT here (it is a subset, not a faithful Postgres):
 *   - NO row-level security (policies are skipped; RLS is not enforced) — so
 *     realtime/webhook events are delivered UNFILTERED, not per-subscriber
 *   - NO PL/pgSQL functions, pgmq, or cron
 *   - reduced introspection; UPDATE change events carry no old_record
 *
 * Use it for throwaway local data and previews, never production.
 */
import type { DbEngine, EngineResults, EngineTx } from './engine.js'
import { Mutex } from './engine.js'

/** Split SQL into statements, respecting $tag$…$tag$ dollar-quoted blocks. */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  let dollarTag: string | null = null
  while (i < sql.length) {
    const ch = sql[i]
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        cur += dollarTag
        i += dollarTag.length
        dollarTag = null
        continue
      }
      cur += ch
      i++
      continue
    }
    const m = ch === '$' ? sql.slice(i).match(/^\$[a-zA-Z_]*\$/) : null
    if (m) {
      dollarTag = m[0]
      cur += dollarTag
      i += dollarTag.length
      continue
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Statements a real Supabase migration may contain that pg-mem can't run. */
function isSkippable(stmt: string): boolean {
  const s = stmt.toLowerCase().replace(/\s+/g, ' ').trim()
  return (
    /^create( or replace)? policy/.test(s) ||
    /^drop policy/.test(s) ||
    /row level security/.test(s) ||
    /^create extension/.test(s) ||
    /^create( or replace)? trigger/.test(s) ||
    /^create( or replace)? function/.test(s) && /language\s+plpgsql/.test(s) ||
    /^do \$/.test(s) ||
    /^grant /.test(s) ||
    /^revoke /.test(s) ||
    /^comment on/.test(s) ||
    /^create publication/.test(s) ||
    /^alter publication/.test(s)
  )
}

export async function createPgmemEngine(): Promise<DbEngine> {
  let newDb, DataType
  try {
    ;({ newDb, DataType } = await import('pg-mem'))
  } catch {
    throw new Error('the pg-mem engine requires the optional `pg-mem` dependency — run `npm install pg-mem`')
  }

  const db = newDb({ autoCreateForeignKeyIndices: true })

  // functions our REST/bootstrap SQL needs that pg-mem lacks
  // impure: true so pg-mem evaluates them per row (not once per statement) —
  // otherwise every row in a multi-row insert gets the same UUID → PK collision
  db.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => crypto.randomUUID() })
  db.public.registerFunction({ name: 'uuid_generate_v4', returns: DataType.uuid, impure: true, implementation: () => crypto.randomUUID() })
  db.public.registerFunction({
    name: 'row_to_json',
    args: [DataType.record],
    returns: DataType.jsonb,
    implementation: ((r: unknown) => r) as never,
  })
  // set_config/current_setting exist in pg-mem; RLS context is a harmless no-op here

  const { Client } = db.adapters.createPg()
  const client = new Client()
  await client.connect()
  const mutex = new Mutex()

  const run = async <T>(sql: string, params?: unknown[]): Promise<EngineResults<T>> => {
    const res = await client.query(params && params.length ? { text: sql, values: params } : sql)
    return { rows: (res.rows ?? []) as T[], affectedRows: res.rowCount ?? undefined }
  }

  /**
   * Tolerant exec: run statements one at a time and skip the ones a real
   * Supabase migration contains that pg-mem can't do — RLS policies, plpgsql
   * functions/triggers, extensions, grants. Genuine errors on supported DDL
   * still throw. Skipped statements are logged so nothing silently vanishes.
   */
  const exec = async (sql: string): Promise<void> => {
    for (const stmt of splitStatements(sql)) {
      try {
        await client.query(stmt)
      } catch (e) {
        if (isSkippable(stmt)) {
          console.warn(`  [pgmem] skipped unsupported statement: ${stmt.replace(/\s+/g, ' ').slice(0, 70)}…`)
          continue
        }
        throw e
      }
    }
  }

  const tx: EngineTx = {
    query: (sql, params) => run(sql, params),
    exec,
  }

  return {
    minimalBootstrap: true,
    query: (sql, params) => mutex.run(() => run(sql, params)),
    exec: (sql) => mutex.run(() => exec(sql)),
    transaction: (fn) =>
      mutex.run(async () => {
        // pg-mem is single-connection in-memory; serialize and use a snapshot so
        // a thrown fn rolls back
        const restore = db.backup()
        try {
          return await fn(tx)
        } catch (e) {
          restore.restore()
          throw e
        }
      }),
    // no LISTEN/NOTIFY in pg-mem — realtime/webhooks simply don't fire
    listen: async () => () => {},
    close: async () => {
      await client.end()
    },
  }
}
