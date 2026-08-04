/**
 * The Database facade over a DbEngine: bootstraps a fresh database into a
 * Supabase-shaped project, applies migrations/seeds the way the Supabase CLI
 * does, introspects schema/functions (with caching), and drives the realtime
 * CDC pipeline. Everything above the engine (REST, auth, storage, realtime)
 * goes through this class.
 */
import { BOOTSTRAP_SQL, MINIMAL_BOOTSTRAP_SQL } from './bootstrap.js'
import { PGMQ_SQL, CRON_SQL, NET_SQL, EXT_COMPAT_SQL, VAULT_SQL } from './emulated.js'
import { rewriteMigrationSql } from './sql-compat.js'

// tinbase's default session search_path (matches bootstrap + Supabase's, with
// the extensions schema on the path). Reset to this before each migration so a
// migration's own `SET search_path` can't leak across our single connection.
const DEFAULT_SEARCH_PATH_SQL = `set search_path to "$user", public, extensions`
import { createPgliteEngine } from './pglite-engine.js'
import type { DbEngine, EngineResults, EngineTx } from './engine.js'
import type { MigrationFile, RequestContext } from '../types.js'

/** One column of an introspected table. */
export interface ColumnInfo {
  name: string
  /** underlying pg type name (pg_type.typname / information_schema.udt_name). */
  udtName: string
  isNullable: boolean
  hasDefault: boolean
  isPrimaryKey: boolean
}

/** A foreign-key constraint, with source and target columns paired by position. */
export interface ForeignKey {
  constraintName: string
  srcSchema: string
  srcTable: string
  srcColumns: string[]
  tgtSchema: string
  tgtTable: string
  tgtColumns: string[]
}

/** An introspected table: its columns and primary-key column names. */
export interface TableInfo {
  schema: string
  name: string
  columns: ColumnInfo[]
  primaryKey: string[]
  /**
   * Column-sets with a uniqueness guarantee (each PRIMARY KEY / UNIQUE
   * constraint, columns in definition order). Used to decide embed cardinality:
   * a foreign key whose columns are a unique key on the referencing side is a
   * one-to-one relationship (PostgREST serializes it as an object, not array).
   */
  uniqueKeys: string[][]
}

/** One argument of a database function. */
export interface FunctionArg {
  name: string
  type: string
}

/** An introspected database function (used to route RPC calls). */
export interface FunctionInfo {
  schema: string
  name: string
  returnsSet: boolean
  returnType: string
  /** pg_type.typtype: b=base, c=composite, p=pseudo, d=domain, e=enum */
  returnTypType: string
  /** pg_proc.provolatile: v=volatile, s=stable, i=immutable. Volatile calls may run DDL. */
  volatility: string
  args: FunctionArg[]
}

/** Introspected shape of one schema: tables keyed by name, plus its foreign keys. */
export interface SchemaInfo {
  tables: Map<string, TableInfo>
  foreignKeys: ForeignKey[]
}

/** A function that runs a parameterized query, e.g. one bound to a transaction. */
export type Querier = (sql: string, params?: unknown[]) => Promise<EngineResults>

/**
 * A change-data-capture event for one row, shaped like Supabase Realtime's
 * `postgres_changes` payload. Emitted by the SQL trigger on the real engines
 * and synthesized in JS on pg-mem (see {@link Database.emitCdc}).
 */
export interface CdcEvent {
  schema: string
  table: string
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  commit_timestamp: string
  /** post-image; null on DELETE (and on a payload that was too large). */
  record: Record<string, unknown> | null
  /** pre-image; null on INSERT (and on a payload that was too large). */
  old_record: Record<string, unknown> | null
  /** set when the row was dropped from the payload, e.g. 'Payload too large'. */
  errors?: string[]
}

/**
 * The database facade: wraps a {@link DbEngine} with bootstrap, migration
 * application, schema introspection (cached), and the realtime CDC pipeline.
 */
export class Database {
  private schemaCache = new Map<string, SchemaInfo>()
  private fnCache = new Map<string, FunctionInfo[]>()
  private cdcListeners = new Set<(e: CdcEvent) => void>()
  private cdcStarted = false

  private constructor(public engine: DbEngine) {}

  /** Create a Database on PGlite (default) or any custom DbEngine. */
  static async create(dataDirOrEngine?: string | DbEngine, opts?: { vaultKey?: string }): Promise<Database> {
    const engine =
      dataDirOrEngine && typeof dataDirOrEngine === 'object'
        ? dataDirOrEngine
        : await createPgliteEngine(dataDirOrEngine)
    if (engine.minimalBootstrap) {
      // subset engine (pg-mem): schemas + tables only, no plpgsql/RLS/extensions
      await engine.exec(MINIMAL_BOOTSTRAP_SQL)
    } else {
      await engine.exec(BOOTSTRAP_SQL)
      // emulated extensions (pgmq queues, cron, pg_net) - pure SQL, so
      // pgmq.*/cron.*/net.* work with no C extension on either engine
      await engine.exec(PGMQ_SQL)
      await engine.exec(CRON_SQL)
      await engine.exec(NET_SQL)
      await engine.exec(EXT_COMPAT_SQL)
      await engine.exec(VAULT_SQL)
      // Vault encryption key, held only in this session GUC (never in a table).
      // Set at the session level so it survives migrations' search_path resets.
      if (opts?.vaultKey) {
        await engine.query(`select set_config('app.settings.vault_key', $1, false)`, [opts.vaultKey])
      }
    }
    return new Database(engine)
  }

  /** Superuser query - used by auth/storage internals and introspection. */
  query<T = any>(sql: string, params?: unknown[]): Promise<EngineResults<T>> {
    return this.engine.query<T>(sql, params)
  }

  /** Run one or more SQL statements with no params (superuser). */
  exec(sql: string): Promise<unknown> {
    return this.engine.exec(sql)
  }

  /**
   * Run `fn` inside a transaction with the request's Postgres role and JWT
   * claims applied via SET LOCAL - this is what makes RLS behave exactly
   * like hosted Supabase.
   */
  async withContext<T>(ctx: RequestContext, fn: (q: Querier) => Promise<T>): Promise<T> {
    return this.engine.transaction(async (tx: EngineTx) => {
      await tx.query(
        `select set_config('role', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [ctx.role, ctx.claims ? JSON.stringify(ctx.claims) : '']
      )
      return fn((sql, params) => tx.query(sql, params))
    })
  }

  // ── Migrations (Supabase CLI conventions) ────────────────────────────

  /**
   * Apply any not-yet-recorded migrations (in lexicographic version order) and
   * an optional seed, each in its own transaction, then invalidate the schema
   * cache. Returns the names of what was applied this run.
   *
   * @throws whatever a migration throws, except on the pg-mem engine where an
   *   unsupported migration is skipped with a warning instead of aborting.
   */
  async runMigrations(migrations: MigrationFile[], seedSql?: string): Promise<string[]> {
    const applied: string[] = []
    // Plain code-unit comparison (not localeCompare, which is locale-dependent
    // and can reorder `_`/digits) so migrations apply in the same order on every
    // machine, matching the Supabase CLI's lexicographic version ordering.
    const sorted = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const m of sorted) {
      const version = m.name.match(/^(\d+)/)?.[1] ?? m.name
      const seen = await this.engine.query(
        `select 1 from supabase_migrations.schema_migrations where version = $1`,
        [version]
      )
      if (seen.rows.length > 0) continue
      const applyMigration = () =>
        this.engine.transaction(async (tx) => {
          // The Supabase CLI applies each migration on a fresh connection, so a
          // top-level `SET search_path TO ''` in one file never leaks to the next.
          // tinbase runs every migration on one connection, so reset to the
          // default first - otherwise a hardened migration's search_path change
          // breaks unqualified calls (e.g. gen_random_bytes) in later files.
          await tx.exec(DEFAULT_SEARCH_PATH_SQL)
          await tx.exec(rewriteMigrationSql(m.sql))
          await tx.query(
            `insert into supabase_migrations.schema_migrations (version, name, statements)
             values ($1, $2, $3)`,
            [version, m.name, [m.sql]]
          )
        })
      try {
        await applyMigration()
        applied.push(m.name)
      } catch (e) {
        // The pgmem preview engine is a Postgres subset; a migration may use a
        // feature it doesn't implement. Skip it (with a warning) rather than
        // aborting startup, so the rest of the schema still comes up for local dev.
        if (this.engine.minimalBootstrap) {
          console.warn(
            `  [pgmem] skipped migration ${m.name}: ${(e as Error)?.message?.split('\n')[0] ?? e}`
          )
          continue
        }
        throw e
      }
    }
    if (seedSql) {
      const hash = await sha256Hex(seedSql)
      const seen = await this.engine.query(
        `select 1 from supabase_migrations.seed_files where path = 'supabase/seed.sql' and hash = $1`,
        [hash]
      )
      if (seen.rows.length === 0) {
        try {
          await this.engine.transaction(async (tx) => {
            await tx.exec(DEFAULT_SEARCH_PATH_SQL)
            await tx.exec(rewriteMigrationSql(seedSql))
            await tx.query(
              `insert into supabase_migrations.seed_files (path, hash) values ('supabase/seed.sql', $1)
               on conflict (path) do update set hash = excluded.hash, applied_at = now()`,
              [hash]
            )
          })
          applied.push('seed.sql')
        } catch (e) {
          // A broken seed (e.g. a sample row violating an FK) must not brick
          // the database: the schema is already up, so boot with empty tables
          // instead of failing startup. The transaction rolled back, so nothing
          // partial persists — and the hash was not recorded, so a corrected
          // seed still applies on the next boot or migrate.
          console.warn(
            `  seed.sql failed - continuing without seed data: ${(e as Error)?.message?.split('\n')[0] ?? e}`
          )
        }
      }
    }
    if (applied.length > 0) {
      // a migration/seed may have left the session search_path at '' - restore
      // the default so runtime queries resolve extension functions unqualified
      await this.engine.exec(DEFAULT_SEARCH_PATH_SQL)
      this.invalidateSchemaCache()
    }
    return applied
  }

  /** Every migration recorded as applied, oldest version first. */
  async listAppliedMigrations(): Promise<{ version: string; name: string | null }[]> {
    const res = await this.engine.query<{ version: string; name: string | null }>(
      `select version, name from supabase_migrations.schema_migrations order by version`
    )
    return res.rows
  }

  // ── Introspection ────────────────────────────────────────────────────

  /** Drop all cached introspection; call after any DDL changes the schema. */
  invalidateSchemaCache(): void {
    this.schemaCache.clear()
    this.fnCache.clear()
    this.rlsCache.clear()
  }

  private rlsCache = new Map<string, Set<string>>()

  /** Names of tables in `schema` that have row-level security enabled. */
  async getRlsTables(schema: string): Promise<Set<string>> {
    const cached = this.rlsCache.get(schema)
    if (cached) return cached
    const res = await this.engine.query<{ relname: string }>(
      `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relrowsecurity = true`,
      [schema]
    )
    const set = new Set(res.rows.map((r) => r.relname))
    this.rlsCache.set(schema, set)
    return set
  }

  /** Introspect a schema's tables, columns, PKs, and FKs. Cached per schema. */
  async getSchemaInfo(schema: string): Promise<SchemaInfo> {
    const cached = this.schemaCache.get(schema)
    if (cached) return cached

    const cols = await this.engine.query<{
      table_name: string
      column_name: string
      udt_name: string
      is_nullable: string
      has_default: boolean
    }>(
      `select table_name, column_name, udt_name, is_nullable,
              column_default is not null as has_default
       from information_schema.columns
       where table_schema = $1
       order by ordinal_position`,
      [schema]
    )

    const pks = await this.engine.query<{ table_name: string; column_name: string }>(
      `select kcu.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.constraint_schema = tc.constraint_schema
       where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = $1`,
      [schema]
    )

    // PRIMARY KEY + UNIQUE constraints, grouped per constraint (in column order)
    // so embed cardinality can tell one-to-one from one-to-many.
    const uniq = await this.engine.query<{
      table_name: string
      constraint_name: string
      column_name: string
      ordinal: number
    }>(
      `select kcu.table_name, kcu.constraint_name, kcu.column_name, kcu.ordinal_position as ordinal
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.constraint_schema = tc.constraint_schema
       where tc.constraint_type in ('PRIMARY KEY', 'UNIQUE') and tc.table_schema = $1
       order by kcu.constraint_name, kcu.ordinal_position`,
      [schema]
    )
    // table -> constraint -> ordered column list
    const uniqByTable = new Map<string, Map<string, string[]>>()
    for (const u of uniq.rows) {
      if (!uniqByTable.has(u.table_name)) uniqByTable.set(u.table_name, new Map())
      const byConstraint = uniqByTable.get(u.table_name)!
      if (!byConstraint.has(u.constraint_name)) byConstraint.set(u.constraint_name, [])
      byConstraint.get(u.constraint_name)!.push(u.column_name)
    }

    const fks = await this.engine.query<{
      constraint_name: string
      src_schema: string
      src_table: string
      src_column: string
      tgt_schema: string
      tgt_table: string
      tgt_column: string
      ordinal: number
    }>(
      `select
         tc.constraint_name,
         tc.table_schema as src_schema, tc.table_name as src_table,
         src.column_name as src_column,
         tgt.table_schema as tgt_schema, tgt.table_name as tgt_table,
         tgt.column_name as tgt_column,
         src.ordinal_position as ordinal
       from information_schema.table_constraints tc
       join information_schema.referential_constraints rc
         on rc.constraint_name = tc.constraint_name
        and rc.constraint_schema = tc.constraint_schema
       join information_schema.key_column_usage src
         on src.constraint_name = tc.constraint_name
        and src.constraint_schema = tc.constraint_schema
       join information_schema.key_column_usage tgt
         on tgt.constraint_name = rc.unique_constraint_name
        and tgt.constraint_schema = rc.unique_constraint_schema
        and tgt.ordinal_position = src.ordinal_position
       where tc.constraint_type = 'FOREIGN KEY'
         and (tc.table_schema = $1 or tgt.table_schema = $1)
       order by tc.constraint_name, src.ordinal_position`,
      [schema]
    )

    const pkSet = new Map<string, Set<string>>()
    for (const pk of pks.rows) {
      if (!pkSet.has(pk.table_name)) pkSet.set(pk.table_name, new Set())
      pkSet.get(pk.table_name)!.add(pk.column_name)
    }

    const tables = new Map<string, TableInfo>()
    for (const c of cols.rows) {
      if (!tables.has(c.table_name)) {
        tables.set(c.table_name, {
          schema,
          name: c.table_name,
          columns: [],
          primaryKey: [...(pkSet.get(c.table_name) ?? [])],
          uniqueKeys: [...(uniqByTable.get(c.table_name)?.values() ?? [])],
        })
      }
      tables.get(c.table_name)!.columns.push({
        name: c.column_name,
        udtName: c.udt_name,
        isNullable: c.is_nullable === 'YES',
        hasDefault: c.has_default,
        isPrimaryKey: pkSet.get(c.table_name)?.has(c.column_name) ?? false,
      })
    }

    const fkMap = new Map<string, ForeignKey>()
    for (const fk of fks.rows) {
      let entry = fkMap.get(fk.constraint_name)
      if (!entry) {
        entry = {
          constraintName: fk.constraint_name,
          srcSchema: fk.src_schema,
          srcTable: fk.src_table,
          srcColumns: [],
          tgtSchema: fk.tgt_schema,
          tgtTable: fk.tgt_table,
          tgtColumns: [],
        }
        fkMap.set(fk.constraint_name, entry)
      }
      if (!entry.srcColumns.includes(fk.src_column)) entry.srcColumns.push(fk.src_column)
      if (!entry.tgtColumns.includes(fk.tgt_column)) entry.tgtColumns.push(fk.tgt_column)
    }

    const info: SchemaInfo = { tables, foreignKeys: [...fkMap.values()] }
    this.schemaCache.set(schema, info)
    return info
  }

  /**
   * All overloads of a function by schema + name (cached). Multiple rows mean
   * the name is overloaded on argument types.
   */
  async getFunctions(schema: string, name: string): Promise<FunctionInfo[]> {
    const key = `${schema}.${name}`
    const cached = this.fnCache.get(key)
    if (cached) return cached
    const res = await this.engine.query<{
      name: string
      returns_set: boolean
      return_type: string
      return_typtype: string
      volatility: string
      identity_args: string
    }>(
      `select p.proname as name, p.proretset as returns_set,
              t.typname as return_type, t.typtype as return_typtype,
              p.provolatile as volatility,
              pg_get_function_identity_arguments(p.oid) as identity_args
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_type t on t.oid = p.prorettype
       where n.nspname = $1 and p.proname = $2`,
      [schema, name]
    )
    const fns = res.rows.map((r) => ({
      schema,
      name: r.name,
      returnsSet: r.returns_set,
      returnType: r.return_type,
      returnTypType: r.return_typtype,
      volatility: r.volatility,
      args: parseIdentityArgs(r.identity_args),
    }))
    this.fnCache.set(key, fns)
    return fns
  }

  // ── Realtime CDC ─────────────────────────────────────────────────────

  /** Idempotently attach the CDC notify trigger to a table (real engines only). */
  async ensureCdcTrigger(schema: string, table: string): Promise<void> {
    const s = quoteIdent(schema)
    const t = quoteIdent(table)
    await this.engine.exec(`
      do $$ begin
        if not exists (
          select from pg_trigger tg
          join pg_class c on c.oid = tg.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
          where tg.tgname = 'tinbase_cdc'
            and n.nspname = ${quoteLiteral(schema)}
            and c.relname = ${quoteLiteral(table)}
        ) then
          create trigger tinbase_cdc
            after insert or update or delete on ${s}.${t}
            for each row execute function tinbase.cdc_notify();
        end if;
      end $$;
    `)
  }

  /**
   * Register a CDC listener; the first call starts the single LISTEN on the
   * shared `tinbase_cdc` channel. Returns an unsubscribe fn.
   */
  async onCdcEvent(cb: (e: CdcEvent) => void): Promise<() => void> {
    this.cdcListeners.add(cb)
    if (!this.cdcStarted) {
      this.cdcStarted = true
      await this.engine.listen('tinbase_cdc', (payload: string) => {
        try {
          const event = JSON.parse(payload) as CdcEvent
          for (const listener of this.cdcListeners) listener(event)
        } catch {
          // malformed payload - drop
        }
      })
    }
    return () => this.cdcListeners.delete(cb)
  }

  /**
   * True when the engine can't run the trigger + `pg_notify` CDC pipeline
   * (pg-mem has no triggers/LISTEN/NOTIFY). For those engines the REST layer
   * synthesizes change events in JS via {@link emitCdc}, since every write goes
   * through it in-process.
   */
  get jsCdc(): boolean {
    return !!this.engine.minimalBootstrap
  }

  /**
   * Feed synthetic CDC events into the same listener set the trigger path uses,
   * so realtime `postgres_changes` and database webhooks fire on engines without
   * triggers/NOTIFY (pg-mem). Called by the REST handler after a committed
   * mutation, one event per affected row.
   *
   * NOTE: these engines have no RLS, so events are delivered unfiltered - the
   * per-subscriber row check in the realtime layer is a no-op here.
   */
  emitCdc(
    meta: { schema: string; table: string; type: CdcEvent['type'] },
    rows: Record<string, unknown>[]
  ): void {
    if (this.cdcListeners.size === 0 || rows.length === 0) return
    const commit_timestamp = new Date().toISOString()
    for (const row of rows) {
      const record = meta.type === 'DELETE' ? null : row
      const old_record = meta.type === 'DELETE' ? row : null
      let event: CdcEvent = { ...meta, commit_timestamp, record, old_record }
      // mirror the trigger's ~8kB pg_notify payload cap
      if (JSON.stringify(record ?? old_record ?? {}).length > 7500) {
        event = { ...event, record: null, old_record: null, errors: ['Payload too large'] }
      }
      for (const listener of this.cdcListeners) listener(event)
    }
  }

  /** Close the underlying engine and its connection. */
  async close(): Promise<void> {
    await this.engine.close()
  }
}

/** Parse pg_get_function_identity_arguments output: "a integer, b text[]". */
export function parseIdentityArgs(identity: string): FunctionArg[] {
  if (!identity.trim()) return []
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of identity) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)
  return parts.map((part) => {
    const tokens = part.trim().split(/\s+/)
    while (tokens.length > 1 && ['IN', 'OUT', 'INOUT', 'VARIADIC'].includes(tokens[0])) {
      tokens.shift()
    }
    if (tokens.length === 1) return { name: '', type: tokens[0] }
    const name = tokens[0].replace(/^"|"$/g, '')
    return { name, type: tokens.slice(1).join(' ') }
  })
}

/**
 * Double-quote an identifier for safe interpolation into SQL.
 * @throws if the name contains a NUL, which Postgres identifiers can't hold.
 */
export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw new Error('invalid identifier')
  return `"${name.replaceAll('"', '""')}"`
}

/** Single-quote a string literal for safe interpolation into SQL. */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
