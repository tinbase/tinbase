import { quoteIdent, quoteLiteral, type Database, type FunctionInfo } from '../db/database.js'
import { ApiError, type RequestContext } from '../types.js'
import { QueryBuilder, pgArrayLiteral, renderColumnExpr } from './build.js'
import { errorToResponse, jsonResponse } from './errors.js'
import { ParseError, parseQuery, type ParsedQuery } from './parse.js'

interface Prefer {
  return?: 'representation' | 'minimal' | 'headers-only'
  count?: 'exact' | 'planned' | 'estimated'
  resolution?: 'merge-duplicates' | 'ignore-duplicates'
  missing?: 'default' | 'null'
}

function parsePrefer(header: string | null): Prefer {
  const prefer: Prefer = {}
  if (!header) return prefer
  for (const token of header.split(',')) {
    const [k, v] = token.trim().split('=')
    if (k === 'return') prefer.return = v as Prefer['return']
    else if (k === 'count') prefer.count = v as Prefer['count']
    else if (k === 'resolution') prefer.resolution = v as Prefer['resolution']
    else if (k === 'missing') prefer.missing = v as Prefer['missing']
  }
  return prefer
}

const OBJECT_MEDIA = 'application/vnd.pgrst.object+json'

export class RestHandler {
  constructor(private db: Database) {}

  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    try {
      const rest = url.pathname.replace(/^\/rest\/v1\/?/, '')
      if (rest === '') return jsonResponse(200, { info: { title: 'tinbase', version: '0.1.0' } })

      const method = req.method.toUpperCase()
      const schema =
        (method === 'GET' || method === 'HEAD'
          ? req.headers.get('accept-profile')
          : req.headers.get('content-profile')) ?? 'public'

      if (rest.startsWith('rpc/')) {
        return await this.handleRpc(req, ctx, url, schema, decodeURIComponent(rest.slice(4)))
      }
      return await this.handleTable(req, ctx, url, schema, decodeURIComponent(rest))
    } catch (e) {
      return errorToResponse(e)
    }
  }

  // ── tables ────────────────────────────────────────────────────────────

  private async handleTable(
    req: Request,
    ctx: RequestContext,
    url: URL,
    schema: string,
    table: string
  ): Promise<Response> {
    const method = req.method.toUpperCase()
    const prefer = parsePrefer(req.headers.get('prefer'))
    const wantsObject = (req.headers.get('accept') ?? '').includes(OBJECT_MEDIA)
    const q = parseQuery(url.searchParams)
    const info = await this.db.getSchemaInfo(schema)
    const builder = new QueryBuilder(schema, info, q)

    switch (method) {
      case 'GET':
      case 'HEAD': {
        const built = builder.buildSelect(table, { count: prefer.count !== undefined })
        const { rows, count } = await this.db.withContext(ctx, async (query) => {
          const res = await query(built.sql, built.params)
          let count: number | null = null
          if (built.countSql) {
            const c = await query(built.countSql, [])
            count = (c.rows[0] as { count: number }).count
          }
          return { rows: (res.rows[0] as { body: unknown[] }).body, count }
        })
        return this.dataResponse(rows, {
          status: 200,
          count,
          offset: q.offsets.get('') ?? 0,
          wantsObject,
          head: method === 'HEAD',
        })
      }

      case 'POST': {
        const body = await readJsonBody(req)
        const rows = Array.isArray(body) ? body : [body]
        const returning = prefer.return === 'representation' || wantsObject
        const built = builder.buildInsert(table, rows as Record<string, unknown>[], {
          upsert: prefer.resolution,
          missingDefault: prefer.missing === 'default',
          returning,
        })
        return this.runMutation(ctx, built, { status: 201, returning, wantsObject, prefer })
      }

      case 'PATCH': {
        const body = await readJsonBody(req)
        if (Array.isArray(body)) {
          throw new ApiError(400, {
            code: 'PGRST102',
            message: 'JSON object expected for UPDATE',
            details: null,
            hint: null,
          })
        }
        const returning = prefer.return === 'representation' || wantsObject
        const built = builder.buildUpdate(table, body as Record<string, unknown>, { returning })
        return this.runMutation(ctx, built, { status: 200, returning, wantsObject, prefer })
      }

      case 'DELETE': {
        const returning = prefer.return === 'representation' || wantsObject
        const built = builder.buildDelete(table, { returning })
        return this.runMutation(ctx, built, { status: 200, returning, wantsObject, prefer })
      }

      default:
        return jsonResponse(405, { code: 'PGRST105', message: `Method ${method} not allowed`, details: null, hint: null })
    }
  }

  private async runMutation(
    ctx: RequestContext,
    built: { sql: string; params: unknown[] },
    opts: { status: number; returning: boolean; wantsObject: boolean; prefer: Prefer }
  ): Promise<Response> {
    const { rows, affected } = await this.db.withContext(ctx, async (query) => {
      const res = await query(built.sql, built.params)
      if (opts.returning) {
        return { rows: (res.rows[0] as { body: unknown[] }).body, affected: null }
      }
      return { rows: null, affected: res.affectedRows ?? 0 }
    })

    const countHeader: Record<string, string> =
      opts.prefer.count !== undefined
        ? { 'content-range': `*/${rows ? rows.length : (affected ?? 0)}` }
        : {}

    if (!opts.returning) {
      return new Response(null, { status: opts.status === 201 ? 201 : 204, headers: countHeader })
    }
    return this.dataResponse(rows!, {
      status: opts.status,
      count: opts.prefer.count !== undefined ? rows!.length : null,
      offset: 0,
      wantsObject: opts.wantsObject,
      head: false,
    })
  }

  private dataResponse(
    rows: unknown[],
    opts: { status: number; count: number | null; offset: number; wantsObject: boolean; head: boolean }
  ): Response {
    const total = opts.count !== null ? String(opts.count) : '*'
    const rangePart =
      rows.length > 0 ? `${opts.offset}-${opts.offset + rows.length - 1}` : '*'
    const headers: Record<string, string> = {
      'content-range': `${rangePart}/${total}`,
    }

    if (opts.wantsObject) {
      if (rows.length !== 1) {
        return jsonResponse(406, {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
          details: `The result contains ${rows.length} rows`,
          hint: null,
        })
      }
      headers['content-type'] = `${OBJECT_MEDIA}; charset=utf-8`
      return new Response(opts.head ? null : JSON.stringify(rows[0]), {
        status: opts.status,
        headers,
      })
    }
    headers['content-type'] = 'application/json; charset=utf-8'
    return new Response(opts.head ? null : JSON.stringify(rows), { status: opts.status, headers })
  }

  // ── rpc ───────────────────────────────────────────────────────────────

  private async handleRpc(
    req: Request,
    ctx: RequestContext,
    url: URL,
    schema: string,
    fnName: string
  ): Promise<Response> {
    const method = req.method.toUpperCase()
    if (!['GET', 'POST', 'HEAD'].includes(method)) {
      return jsonResponse(405, { code: 'PGRST105', message: `Method ${method} not allowed`, details: null, hint: null })
    }
    const prefer = parsePrefer(req.headers.get('prefer'))
    const wantsObject = (req.headers.get('accept') ?? '').includes(OBJECT_MEDIA)

    const fns = await this.db.getFunctions(schema, fnName)
    if (fns.length === 0) {
      throw new ApiError(404, {
        code: 'PGRST202',
        message: `Could not find the function ${schema}.${fnName} in the schema cache`,
        details: null,
        hint: null,
      })
    }

    // collect args: POST body, or query params matching arg names on GET/HEAD
    let args: Record<string, unknown> = {}
    const searchParams = new URLSearchParams(url.searchParams)
    if (method === 'POST') {
      const raw = await req.text()
      if (raw.trim() !== '') {
        try {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>
          } else {
            throw new ApiError(400, { code: 'PGRST102', message: 'RPC arguments must be a JSON object', details: null, hint: null })
          }
        } catch (e) {
          if (e instanceof ApiError) throw e
          throw new ApiError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null })
        }
      }
    } else {
      const allArgNames = new Set(fns.flatMap((f) => f.args.map((a) => a.name)))
      for (const [k, v] of url.searchParams.entries()) {
        if (allArgNames.has(k)) {
          args[k] = v
          searchParams.delete(k)
        }
      }
    }

    const fn = pickOverload(fns, Object.keys(args))
    const call = renderCall(schema, fn, args)
    const q = parseQuery(searchParams)

    // void
    if (fn.returnType === 'void' && !fn.returnsSet) {
      await this.db.withContext(ctx, (query) => query(`select ${call}`, []))
      return new Response(null, { status: 204 })
    }

    // scalar (non-set base/domain/enum type)
    if (!fn.returnsSet && ['b', 'd', 'e'].includes(fn.returnTypType)) {
      const res = await this.db.withContext(ctx, (query) =>
        query(`select to_json(${call}) as result`, [])
      )
      const value = (res.rows[0] as { result: unknown }).result
      return jsonResponse(200, value)
    }

    // set-returning scalar
    if (fn.returnsSet && ['b', 'd', 'e'].includes(fn.returnTypType)) {
      const res = await this.db.withContext(ctx, (query) =>
        query(`select coalesce(json_agg(_v), '[]'::json) as body from ${call} as _t(_v)`, [])
      )
      return jsonResponse(200, (res.rows[0] as { body: unknown }).body)
    }

    // table/composite results: apply select/filters/order/pagination
    const alias = '_f'
    const exprs: string[] = []
    for (const item of q.select) {
      if (item.kind === 'embed') {
        throw new ParseError('embedded resources are not supported on RPC results')
      }
      if (item.name === '*') {
        exprs.push(`${quoteIdent(alias)}.*`)
      } else {
        const out = item.alias ?? item.name.split(/->>|->/).pop()!.trim()
        const cast = item.cast ? `::${item.cast}` : ''
        exprs.push(`${renderColumnExpr(alias, item.name)}${cast} as ${quoteIdent(out)}`)
      }
    }

    const info = await this.db.getSchemaInfo(schema)
    const builder = new QueryBuilder(schema, info, q)
    const conds = q.conditions.map((c) => builder.renderCond(c, alias))
    const where = conds.length > 0 ? ` where ${conds.join(' and ')}` : ''
    const order = builder.renderOrder([], alias)
    const limitOffset = builder.renderLimitOffset('')

    const core = `select ${exprs.join(', ')} from ${call} as ${quoteIdent(alias)}${where}${order}${limitOffset}`
    const sql = `select coalesce(json_agg(row_to_json(_r)), '[]'::json) as body from (${core}) _r`
    const countSql =
      prefer.count !== undefined
        ? `select count(*)::int as count from ${call} as ${quoteIdent(alias)}${where}`
        : undefined

    const { rows, count } = await this.db.withContext(ctx, async (query) => {
      const res = await query(sql, [])
      let count: number | null = null
      if (countSql) {
        const c = await query(countSql, [])
        count = (c.rows[0] as { count: number }).count
      }
      return { rows: (res.rows[0] as { body: unknown[] }).body, count }
    })

    return this.dataResponse(rows, {
      status: 200,
      count,
      offset: q.offsets.get('') ?? 0,
      wantsObject,
      head: method === 'HEAD',
    })
  }
}

function pickOverload(fns: FunctionInfo[], providedNames: string[]): FunctionInfo {
  const provided = new Set(providedNames)
  let best: FunctionInfo | null = null
  for (const fn of fns) {
    const names = new Set(fn.args.map((a) => a.name))
    const allProvidedKnown = [...provided].every((p) => names.has(p))
    if (!allProvidedKnown) continue
    if (fn.args.length === provided.size) return fn
    if (!best) best = fn
  }
  return best ?? fns[0]
}

function renderCall(schema: string, fn: FunctionInfo, args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(args)) {
    const arg = fn.args.find((a) => a.name === name)
    if (!arg) {
      throw new ApiError(404, {
        code: 'PGRST202',
        message: `Could not find the function ${schema}.${fn.name}(${Object.keys(args).sort().join(', ')}) in the schema cache`,
        details: null,
        hint: `Perhaps you meant to call the function ${schema}.${fn.name}(${fn.args.map((a) => a.name).join(', ')})`,
      })
    }
    parts.push(`${quoteIdent(name)} := ${renderArgLiteral(arg.type, value)}`)
  }
  return `${quoteIdent(schema)}.${quoteIdent(fn.name)}(${parts.join(', ')})`
}

function renderArgLiteral(type: string, value: unknown): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_ .,()\[\]]*$/.test(type)) {
    throw new ApiError(400, { code: 'PGRST100', message: `unsupported argument type: ${type}`, details: null, hint: null })
  }
  if (value === null || value === undefined) return `null::${type}`
  if (type.endsWith('[]') && Array.isArray(value)) {
    return `${quoteLiteral(pgArrayLiteral(value))}::${type}`
  }
  if (typeof value === 'object') return `${quoteLiteral(JSON.stringify(value))}::${type}`
  if (typeof value === 'number' || typeof value === 'boolean') return `${quoteLiteral(String(value))}::${type}`
  return `${quoteLiteral(String(value))}::${type}`
}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = req.headers.get('content-type') ?? ''
  if (contentType && !contentType.includes('application/json')) {
    throw new ApiError(415, {
      code: 'PGRST107',
      message: `Content-Type not acceptable: ${contentType}`,
      details: null,
      hint: null,
    })
  }
  const raw = await req.text()
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null })
  }
}
