/**
 * Admin API (/admin/v1/*) backing tinbase studio at /_/.
 * Every endpoint requires the service_role key. This is a thin, introspection-
 * and-SQL surface; row CRUD goes through the normal PostgREST layer (with RLS
 * bypassed by the service_role), so the studio uses the same paths an app does.
 */
import { quoteIdent } from '../db/database.js'
import type { Database } from '../db/database.js'
import type { LogBuffer } from '../log-buffer.js'
import type { RequestContext } from '../types.js'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export class AdminApi {
  constructor(
    private db: Database,
    private logs?: LogBuffer
  ) {}

  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    if (ctx.role !== 'service_role') {
      return json(403, { error: 'admin API requires the service_role key' })
    }
    const path = url.pathname.replace(/^\/admin\/v1\/?/, '')
    const method = req.method.toUpperCase()

    try {
      if (path === 'tables' && method === 'GET') return await this.listTables(url)
      if (path === 'sql' && method === 'POST') return await this.runSql(req)
      if (path === 'stats' && method === 'GET') return await this.stats()
      if (path === 'schemas' && method === 'GET') return await this.schemas()
      if (path === 'migrations' && method === 'GET') return await this.migrations()
      if (path === 'policies' && method === 'GET') return await this.listPolicies(url)
      if (path === 'policies' && method === 'POST') return await this.createPolicy(req)
      if (path === 'policies' && method === 'DELETE') return await this.dropPolicy(url)
      if (path === 'functions' && method === 'GET') return await this.listFunctions(url)
      if (path === 'triggers' && method === 'GET') return await this.listTriggers(url)
      if (path === 'logs' && method === 'GET') return json(200, { logs: this.logs?.list() ?? [] })
      if (path === 'logs' && method === 'DELETE') {
        this.logs?.clear()
        return json(200, { ok: true })
      }
      return json(404, { error: `unknown admin endpoint: ${path}` })
    } catch (e) {
      return json(500, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async listTables(url: URL): Promise<Response> {
    const schema = url.searchParams.get('schema') ?? 'public'
    this.db.invalidateSchemaCache()
    const info = await this.db.getSchemaInfo(schema)
    const tables = []
    for (const t of info.tables.values()) {
      const count = await this.db.query<{ n: number }>(
        `select count(*)::int as n from ${quoteIdent(schema)}.${quoteIdent(t.name)}`
      )
      // foreign keys originating from this table, for column hints
      const fks = info.foreignKeys
        .filter((fk) => fk.srcSchema === schema && fk.srcTable === t.name)
        .map((fk) => ({ columns: fk.srcColumns, target: `${fk.tgtSchema}.${fk.tgtTable}`, targetColumns: fk.tgtColumns }))
      tables.push({
        name: t.name,
        primaryKey: t.primaryKey,
        rowCount: count.rows[0]?.n ?? 0,
        foreignKeys: fks,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.udtName,
          nullable: c.isNullable,
          hasDefault: c.hasDefault,
          isPrimaryKey: c.isPrimaryKey,
        })),
      })
    }
    return json(200, { schema, tables })
  }

  private async runSql(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { query?: string }
    if (!body.query?.trim()) return json(400, { error: 'query is required' })
    const started = Date.now()
    try {
      const res = await this.db.query(body.query)
      this.db.invalidateSchemaCache()
      return json(200, {
        rows: res.rows.slice(0, 2000),
        rowCount: res.rows.length,
        affectedRows: res.affectedRows ?? null,
        ms: Date.now() - started,
      })
    } catch (e) {
      const pg = e as { message?: string; code?: string; detail?: string; hint?: string }
      return json(400, { error: pg.message, code: pg.code, detail: pg.detail, hint: pg.hint })
    }
  }

  private async schemas(): Promise<Response> {
    const res = await this.db.query<{ name: string }>(
      `select schema_name as name from information_schema.schemata
       where schema_name not in ('pg_catalog','information_schema','pg_toast')
       order by schema_name`
    )
    return json(200, { schemas: res.rows.map((r) => r.name) })
  }

  private async migrations(): Promise<Response> {
    const res = await this.db.query<{ version: string; name: string | null; applied_at: string }>(
      `select version, name, applied_at from supabase_migrations.schema_migrations order by version`
    )
    return json(200, { migrations: res.rows })
  }

  private async listPolicies(url: URL): Promise<Response> {
    const schema = url.searchParams.get('schema') ?? 'public'
    const res = await this.db.query(
      `select schemaname as schema, tablename as table, policyname as name,
              cmd, permissive, roles, qual as using_expr, with_check
       from pg_policies where schemaname = $1
       order by tablename, policyname`,
      [schema]
    )
    return json(200, { policies: res.rows })
  }

  private async createPolicy(req: Request): Promise<Response> {
    const b = (await req.json().catch(() => ({}))) as {
      schema?: string
      table?: string
      name?: string
      command?: string // ALL | SELECT | INSERT | UPDATE | DELETE
      roles?: string
      using?: string
      check?: string
    }
    if (!b.table || !b.name) return json(400, { error: 'table and name are required' })
    const schema = b.schema ?? 'public'
    const cmd = (b.command ?? 'ALL').toUpperCase()
    const roles = b.roles?.trim() || 'public'
    let sql = `create policy ${quoteIdent(b.name)} on ${quoteIdent(schema)}.${quoteIdent(b.table)} for ${cmd} to ${roles}`
    if (b.using?.trim()) sql += ` using (${b.using})`
    if (b.check?.trim()) sql += ` with check (${b.check})`
    try {
      await this.db.query(sql)
      this.db.invalidateSchemaCache()
      return json(200, { ok: true })
    } catch (e) {
      const pg = e as { message?: string; code?: string; hint?: string }
      return json(400, { error: pg.message, code: pg.code, hint: pg.hint })
    }
  }

  private async dropPolicy(url: URL): Promise<Response> {
    const schema = url.searchParams.get('schema') ?? 'public'
    const table = url.searchParams.get('table')
    const name = url.searchParams.get('name')
    if (!table || !name) return json(400, { error: 'table and name are required' })
    try {
      await this.db.query(`drop policy ${quoteIdent(name)} on ${quoteIdent(schema)}.${quoteIdent(table)}`)
      return json(200, { ok: true })
    } catch (e) {
      return json(400, { error: (e as { message?: string }).message })
    }
  }

  private async listFunctions(url: URL): Promise<Response> {
    const schema = url.searchParams.get('schema') ?? 'public'
    const res = await this.db.query(
      `select p.proname as name,
              pg_get_function_identity_arguments(p.oid) as args,
              t.typname as returns, l.lanname as language,
              p.prosrc as body
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_type t on t.oid = p.prorettype
       join pg_language l on l.oid = p.prolang
       where n.nspname = $1 and p.prokind = 'f'
       order by p.proname`,
      [schema]
    )
    return json(200, { functions: res.rows })
  }

  private async listTriggers(url: URL): Promise<Response> {
    const schema = url.searchParams.get('schema') ?? 'public'
    const res = await this.db.query(
      `select tg.tgname as name, c.relname as table,
              case when (tg.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end as timing,
              array_remove(array[
                case when (tg.tgtype & 4) <> 0 then 'INSERT' end,
                case when (tg.tgtype & 8) <> 0 then 'DELETE' end,
                case when (tg.tgtype & 16) <> 0 then 'UPDATE' end], null) as events,
              p.proname as function
       from pg_trigger tg
       join pg_class c on c.oid = tg.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = tg.tgfoid
       where n.nspname = $1 and not tg.tgisinternal
       order by c.relname, tg.tgname`,
      [schema]
    )
    return json(200, { triggers: res.rows })
  }

  private async stats(): Promise<Response> {
    const one = async (sql: string) => (await this.db.query<{ n: number }>(sql)).rows[0]?.n ?? 0
    const users = await one(`select count(*)::int as n from auth.users`)
    const buckets = await one(`select count(*)::int as n from storage.buckets`)
    const objects = await one(`select count(*)::int as n from storage.objects`)
    const migrations = await one(`select count(*)::int as n from supabase_migrations.schema_migrations`)
    const tables = await one(
      `select count(*)::int as n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`
    )
    const size = await this.db.query<{ s: string; v: string }>(
      `select pg_size_pretty(pg_database_size(current_database())) as s, version() as v`
    )
    return json(200, {
      users,
      buckets,
      objects,
      migrations,
      tables,
      dbSize: size.rows[0]?.s ?? '?',
      version: (size.rows[0]?.v ?? '').split(' on ')[0],
    })
  }
}
