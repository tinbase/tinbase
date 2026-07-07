import { BOOTSTRAP_SQL, MINIMAL_BOOTSTRAP_SQL } from './bootstrap.js'
import { PGMQ_SQL, CRON_SQL } from './emulated.js'
import { createPgliteEngine } from './pglite-engine.js'
import type { DbEngine, EngineResults, EngineTx } from './engine.js'
import type { MigrationFile, RequestContext } from '../types.js'

export interface ColumnInfo {
  name: string
  udtName: string
  isNullable: boolean
  hasDefault: boolean
  isPrimaryKey: boolean
}

export interface ForeignKey {
  constraintName: string
  srcSchema: string
  srcTable: string
  srcColumns: string[]
  tgtSchema: string
  tgtTable: string
  tgtColumns: string[]
}

export interface TableInfo {
  schema: string
  name: string
  columns: ColumnInfo[]
  primaryKey: string[]
}

export interface FunctionArg {
  name: string
  type: string
}

export interface FunctionInfo {
  schema: string
  name: string
  returnsSet: boolean
  returnType: string
  /** pg_type.typtype: b=base, c=composite, p=pseudo, d=domain, e=enum */
  returnTypType: string
  args: FunctionArg[]
}

export interface SchemaInfo {
  tables: Map<string, TableInfo>
  foreignKeys: ForeignKey[]
}

export type Querier = (sql: string, params?: unknown[]) => Promise<EngineResults>

export interface CdcEvent {
  schema: string
  table: string
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  commit_timestamp: string
  record: Record<string, unknown> | null
  old_record: Record<string, unknown> | null
  errors?: string[]
}

export class Database {
  private schemaCache = new Map<string, SchemaInfo>()
  private fnCache = new Map<string, FunctionInfo[]>()
  private cdcListeners = new Set<(e: CdcEvent) => void>()
  private cdcStarted = false

  private constructor(public engine: DbEngine) {}

  /** Create a Database on PGlite (default) or any custom DbEngine. */
  static async create(dataDirOrEngine?: string | DbEngine): Promise<Database> {
    const engine =
      dataDirOrEngine && typeof dataDirOrEngine === 'object'
        ? dataDirOrEngine
        : await createPgliteEngine(dataDirOrEngine)
    if (engine.minimalBootstrap) {
      // subset engine (pg-mem): schemas + tables only, no plpgsql/RLS/extensions
      await engine.exec(MINIMAL_BOOTSTRAP_SQL)
    } else {
      await engine.exec(BOOTSTRAP_SQL)
      // emulated extensions (pgmq queues, cron) — pure SQL, so pgmq.*/cron.* work
      // with no C extension on either engine
      await engine.exec(PGMQ_SQL)
      await engine.exec(CRON_SQL)
    }
    return new Database(engine)
  }

  /** Superuser query — used by auth/storage internals and introspection. */
  query<T = any>(sql: string, params?: unknown[]): Promise<EngineResults<T>> {
    return this.engine.query<T>(sql, params)
  }

  exec(sql: string): Promise<unknown> {
    return this.engine.exec(sql)
  }

  /**
   * Run `fn` inside a transaction with the request's Postgres role and JWT
   * claims applied via SET LOCAL — this is what makes RLS behave exactly
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

  async runMigrations(migrations: MigrationFile[], seedSql?: string): Promise<string[]> {
    const applied: string[] = []
    const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name))
    for (const m of sorted) {
      const version = m.name.match(/^(\d+)/)?.[1] ?? m.name
      const seen = await this.engine.query(
        `select 1 from supabase_migrations.schema_migrations where version = $1`,
        [version]
      )
      if (seen.rows.length > 0) continue
      await this.engine.transaction(async (tx) => {
        await tx.exec(m.sql)
        await tx.query(
          `insert into supabase_migrations.schema_migrations (version, name, statements)
           values ($1, $2, $3)`,
          [version, m.name, [m.sql]]
        )
      })
      applied.push(m.name)
    }
    if (seedSql) {
      const hash = await sha256Hex(seedSql)
      const seen = await this.engine.query(
        `select 1 from supabase_migrations.seed_files where path = 'supabase/seed.sql' and hash = $1`,
        [hash]
      )
      if (seen.rows.length === 0) {
        await this.engine.transaction(async (tx) => {
          await tx.exec(seedSql)
          await tx.query(
            `insert into supabase_migrations.seed_files (path, hash) values ('supabase/seed.sql', $1)
             on conflict (path) do update set hash = excluded.hash, applied_at = now()`,
            [hash]
          )
        })
        applied.push('seed.sql')
      }
    }
    if (applied.length > 0) this.invalidateSchemaCache()
    return applied
  }

  async listAppliedMigrations(): Promise<{ version: string; name: string | null }[]> {
    const res = await this.engine.query<{ version: string; name: string | null }>(
      `select version, name from supabase_migrations.schema_migrations order by version`
    )
    return res.rows
  }

  // ── Introspection ────────────────────────────────────────────────────

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
         kcu.column_name as src_column,
         ccu.table_schema as tgt_schema, ccu.table_name as tgt_table,
         ccu.column_name as tgt_column,
         kcu.ordinal_position as ordinal
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.constraint_schema = tc.constraint_schema
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name
        and ccu.constraint_schema = tc.constraint_schema
       where tc.constraint_type = 'FOREIGN KEY'
         and (tc.table_schema = $1 or ccu.table_schema = $1)
       order by tc.constraint_name, kcu.ordinal_position`,
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

  async getFunctions(schema: string, name: string): Promise<FunctionInfo[]> {
    const key = `${schema}.${name}`
    const cached = this.fnCache.get(key)
    if (cached) return cached
    const res = await this.engine.query<{
      name: string
      returns_set: boolean
      return_type: string
      return_typtype: string
      identity_args: string
    }>(
      `select p.proname as name, p.proretset as returns_set,
              t.typname as return_type, t.typtype as return_typtype,
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
      args: parseIdentityArgs(r.identity_args),
    }))
    this.fnCache.set(key, fns)
    return fns
  }

  // ── Realtime CDC ─────────────────────────────────────────────────────

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

  async onCdcEvent(cb: (e: CdcEvent) => void): Promise<() => void> {
    this.cdcListeners.add(cb)
    if (!this.cdcStarted) {
      this.cdcStarted = true
      await this.engine.listen('tinbase_cdc', (payload: string) => {
        try {
          const event = JSON.parse(payload) as CdcEvent
          for (const listener of this.cdcListeners) listener(event)
        } catch {
          // malformed payload — drop
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
   * NOTE: these engines have no RLS, so events are delivered unfiltered — the
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

  async close(): Promise<void> {
    await this.engine.close()
  }
}

/** Parse pg_get_function_identity_arguments output: "a integer, b text[]". */
function parseIdentityArgs(identity: string): FunctionArg[] {
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

export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw new Error('invalid identifier')
  return `"${name.replaceAll('"', '""')}"`
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
