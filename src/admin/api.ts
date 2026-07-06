/**
 * Admin API (/admin/v1/*) backing the dashboard at /_/.
 * Every endpoint requires the service_role key.
 */
import type { Database } from '../db/database.js'
import type { RequestContext } from '../types.js'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export class AdminApi {
  constructor(private db: Database) {}

  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    if (ctx.role !== 'service_role') {
      return json(403, { error: 'admin API requires the service_role key' })
    }
    const path = url.pathname.replace(/^\/admin\/v1\/?/, '')
    const method = req.method.toUpperCase()

    try {
      if (path === 'tables' && method === 'GET') {
        const schema = url.searchParams.get('schema') ?? 'public'
        this.db.invalidateSchemaCache()
        const info = await this.db.getSchemaInfo(schema)
        const tables = []
        for (const t of info.tables.values()) {
          const count = await this.db.query<{ n: number }>(
            `select count(*)::int as n from "${schema.replaceAll('"', '""')}"."${t.name.replaceAll('"', '""')}"`
          )
          tables.push({
            name: t.name,
            primaryKey: t.primaryKey,
            rowCount: count.rows[0]?.n ?? 0,
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

      if (path === 'sql' && method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { query?: string }
        if (!body.query?.trim()) return json(400, { error: 'query is required' })
        const started = Date.now()
        try {
          const res = await this.db.query(body.query)
          this.db.invalidateSchemaCache()
          return json(200, {
            rows: res.rows.slice(0, 1000),
            rowCount: res.rows.length,
            affectedRows: res.affectedRows ?? null,
            ms: Date.now() - started,
          })
        } catch (e) {
          const pg = e as { message?: string; code?: string; detail?: string; hint?: string }
          return json(400, { error: pg.message, code: pg.code, detail: pg.detail, hint: pg.hint })
        }
      }

      if (path === 'stats' && method === 'GET') {
        const users = await this.db.query<{ n: number }>(`select count(*)::int as n from auth.users`)
        const buckets = await this.db.query<{ n: number }>(`select count(*)::int as n from storage.buckets`)
        const objects = await this.db.query<{ n: number }>(`select count(*)::int as n from storage.objects`)
        const migrations = await this.db.query<{ n: number }>(
          `select count(*)::int as n from supabase_migrations.schema_migrations`
        )
        const size = await this.db.query<{ s: string }>(`select pg_size_pretty(pg_database_size(current_database())) as s`)
        return json(200, {
          users: users.rows[0]?.n ?? 0,
          buckets: buckets.rows[0]?.n ?? 0,
          objects: objects.rows[0]?.n ?? 0,
          migrations: migrations.rows[0]?.n ?? 0,
          dbSize: size.rows[0]?.s ?? '?',
        })
      }

      return json(404, { error: `unknown admin endpoint: ${path}` })
    } catch (e) {
      return json(500, { error: e instanceof Error ? e.message : String(e) })
    }
  }
}
