import { PGlite, type Transaction, type Results } from '@electric-sql/pglite'
import { BOOTSTRAP_SQL } from './bootstrap.js'
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

export type Querier = (sql: string, params?: unknown[]) => Promise<Results>

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

  private constructor(public pg: PGlite) {}

  static async create(dataDir?: string): Promise<Database> {
    const pg = dataDir ? new PGlite(dataDir) : new PGlite()
    await pg.waitReady
    await pg.exec(BOOTSTRAP_SQL)
    return new Database(pg)
  }

  /** Superuser query — used by auth/storage internals and introspection. */
  query(sql: string, params?: unknown[]): Promise<Results> {
    return this.pg.query(sql, params)
  }

  exec(sql: string): Promise<unknown> {
    return this.pg.exec(sql)
  }

  /**
   * Run `fn` inside a transaction with the request's Postgres role and JWT
   * claims applied via SET LOCAL — this is what makes RLS behave exactly
   * like hosted Supabase.
   */
  async withContext<T>(ctx: RequestContext, fn: (q: Querier) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx: Transaction) => {
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
      const seen = await this.pg.query(
        `select 1 from supabase_migrations.schema_migrations where version = $1`,
        [version]
      )
      if (seen.rows.length > 0) continue
      await this.pg.transaction(async (tx) => {
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
      const seen = await this.pg.query(
        `select 1 from supabase_migrations.seed_files where path = 'supabase/seed.sql' and hash = $1`,
        [hash]
      )
      if (seen.rows.length === 0) {
        await this.pg.transaction(async (tx) => {
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
    const res = await this.pg.query<{ version: string; name: string | null }>(
      `select version, name from supabase_migrations.schema_migrations order by version`
    )
    return res.rows
  }

  // ── Introspection ────────────────────────────────────────────────────

  invalidateSchemaCache(): void {
    this.schemaCache.clear()
    this.fnCache.clear()
  }

  async getSchemaInfo(schema: string): Promise<SchemaInfo> {
    const cached = this.schemaCache.get(schema)
    if (cached) return cached

    const cols = await this.pg.query<{
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

    const pks = await this.pg.query<{ table_name: string; column_name: string }>(
      `select kcu.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.constraint_schema = tc.constraint_schema
       where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = $1`,
      [schema]
    )

    const fks = await this.pg.query<{
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
    const res = await this.pg.query<{
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
    await this.pg.exec(`
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
      await this.pg.listen('tinbase_cdc', (payload: string) => {
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

  async close(): Promise<void> {
    await this.pg.close()
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
