/**
 * Builds SQL from a ParsedQuery + schema introspection. All row data is
 * serialized to JSON inside Postgres (row_to_json/json_agg), so results come
 * back with correct JSON types and zero client-side type mapping.
 */
import { quoteIdent, quoteLiteral, type ColumnInfo, type ForeignKey, type SchemaInfo, type TableInfo } from '../db/database.js'
import { ApiError } from '../types.js'
import {
  FILTER_OPS,
  ParseError,
  splitTopLevel,
  unquote,
  type Cond,
  type FilterCond,
  type LogicCond,
  type ParsedQuery,
  type SelectEmbed,
  type SelectItem,
} from './parse.js'

interface Relationship {
  type: 'to-one' | 'to-many' | 'm2m'
  fk: ForeignKey
  junction?: { table: string; fkToBase: ForeignKey; fkToTarget: ForeignKey }
  targetTable: string
}

export interface BuiltQuery {
  sql: string
  params: unknown[]
  countSql?: string
}

const AGG_EMPTY = `'[]'::json`

export class QueryBuilder {
  private aliasCounter = 0
  private consumedPaths = new Set<string>([''])

  constructor(
    private schema: string,
    private info: SchemaInfo,
    private q: ParsedQuery
  ) {}

  private nextAlias(): string {
    return `_t${this.aliasCounter++}`
  }

  private qualify(table: string): string {
    return `${quoteIdent(this.schema)}.${quoteIdent(table)}`
  }

  private table(name: string): TableInfo {
    const t = this.info.tables.get(name)
    if (!t) {
      throw new ApiError(404, {
        code: 'PGRST205',
        message: `Could not find the table '${this.schema}.${name}' in the schema cache`,
        details: null,
        hint: null,
      })
    }
    return t
  }

  // ── public entrypoints ────────────────────────────────────────────────

  buildSelect(table: string, opts: { count?: boolean } = {}): BuiltQuery {
    this.table(table)
    const alias = 't0'
    const { exprs, innerConds } = this.buildSelectList(this.q.select, table, alias, [])
    const where = this.baseWhere(alias, innerConds)
    const order = this.renderOrder([], alias)
    const limitOffset = this.renderLimitOffset('')

    const core = `select ${exprs.join(', ')} from ${this.qualify(table)} as ${quoteIdent(alias)}${where}${order}${limitOffset}`
    this.assertAllPathsConsumed()
    return {
      sql: `select coalesce(json_agg(row_to_json(_r)), ${AGG_EMPTY}) as body from (${core}) _r`,
      params: [],
      countSql: opts.count
        ? `select count(*)::int as count from ${this.qualify(table)} as ${quoteIdent(alias)}${where}`
        : undefined,
    }
  }

  buildInsert(
    table: string,
    rows: Record<string, unknown>[],
    opts: {
      upsert?: 'merge-duplicates' | 'ignore-duplicates'
      missingDefault?: boolean
      returning: boolean
    }
  ): BuiltQuery {
    const tinfo = this.table(table)
    if (rows.length === 0) {
      throw new ApiError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null })
    }
    const columns =
      this.q.columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))]
    for (const c of columns) this.requireColumn(tinfo, c)

    const params: unknown[] = []
    const valuesSql = rows
      .map((row) => {
        const cells = columns.map((c) => {
          if (!(c in row)) {
            const col = tinfo.columns.find((x) => x.name === c)!
            return opts.missingDefault && col.hasDefault ? 'default' : 'null'
          }
          return this.pushParam(params, tinfo, c, row[c])
        })
        return `(${cells.join(', ')})`
      })
      .join(', ')

    let conflict = ''
    if (opts.upsert) {
      const target = this.q.onConflict ?? tinfo.primaryKey
      if (target.length === 0) {
        throw new ApiError(400, {
          code: 'PGRST120',
          message: `there is no unique or primary key constraint matching the ON CONFLICT specification`,
          details: null,
          hint: null,
        })
      }
      const targetSql = target.map(quoteIdent).join(', ')
      if (opts.upsert === 'ignore-duplicates') {
        conflict = ` on conflict (${targetSql}) do nothing`
      } else {
        const updates = columns
          .filter((c) => !target.includes(c))
          .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
        conflict =
          updates.length > 0
            ? ` on conflict (${targetSql}) do update set ${updates.join(', ')}`
            : ` on conflict (${targetSql}) do nothing`
      }
    }

    const insert = `insert into ${this.qualify(table)} (${columns.map(quoteIdent).join(', ')}) values ${valuesSql}${conflict}`
    if (!opts.returning) return { sql: insert, params }
    return { sql: this.wrapMutation(insert, table), params }
  }

  buildUpdate(table: string, body: Record<string, unknown>, opts: { returning: boolean }): BuiltQuery {
    const tinfo = this.table(table)
    const keys = Object.keys(body)
    if (keys.length === 0) {
      throw new ApiError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null })
    }
    for (const c of keys) this.requireColumn(tinfo, c)
    const params: unknown[] = []
    const sets = keys.map((c) => `${quoteIdent(c)} = ${this.pushParam(params, tinfo, c, body[c])}`)
    const alias = 't0'
    const where = this.baseWhere(alias, [])
    const update = `update ${this.qualify(table)} as ${quoteIdent(alias)} set ${sets.join(', ')}${where} returning *`
    this.assertAllPathsConsumed()
    if (!opts.returning) return { sql: update.replace(/ returning \*$/, ''), params }
    return { sql: this.wrapMutation(update, table, true), params }
  }

  buildDelete(table: string, opts: { returning: boolean }): BuiltQuery {
    this.table(table)
    const alias = 't0'
    const where = this.baseWhere(alias, [])
    const del = `delete from ${this.qualify(table)} as ${quoteIdent(alias)}${where} returning *`
    this.assertAllPathsConsumed()
    if (!opts.returning) return { sql: del.replace(/ returning \*$/, ''), params: [] }
    return { sql: this.wrapMutation(del, table, true), params: [] }
  }

  /** Wrap a mutation in a CTE so the response can apply select= (incl. embeds). */
  private wrapMutation(mutation: string, table: string, alreadyHasReturning = false): string {
    const withReturning = alreadyHasReturning ? mutation : `${mutation} returning *`
    const { exprs, innerConds } = this.buildSelectList(this.q.select, table, '_mut', [])
    if (innerConds.length > 0) {
      throw new ApiError(400, {
        code: 'PGRST100',
        message: 'inner join embeds are not supported on mutation responses',
        details: null,
        hint: null,
      })
    }
    return `with _mut as (${withReturning}) select coalesce(json_agg(row_to_json(_r)), ${AGG_EMPTY}) as body from (select ${exprs.join(', ')} from _mut) _r`
  }

  // ── select list & embeds ──────────────────────────────────────────────

  private buildSelectList(
    items: SelectItem[],
    table: string,
    alias: string,
    path: string[]
  ): { exprs: string[]; innerConds: string[] } {
    const exprs: string[] = []
    const innerConds: string[] = []
    for (const item of items) {
      if (item.kind === 'column') {
        if (item.name === '*') {
          exprs.push(`${quoteIdent(alias)}.*`)
          continue
        }
        const expr = renderColumnExpr(alias, item.name)
        const cast = item.cast ? `::${sanitizeCast(item.cast)}` : ''
        const outName = item.alias ?? defaultAliasFor(item.name)
        exprs.push(`${expr}${cast} as ${quoteIdent(outName)}`)
      } else {
        const built = this.buildEmbed(item, table, alias, path)
        exprs.push(...built.exprs)
        if (built.innerCond) innerConds.push(built.innerCond)
      }
    }
    if (exprs.length === 0) exprs.push(`${quoteIdent(alias)}.*`)
    return { exprs, innerConds }
  }

  private buildEmbed(
    embed: SelectEmbed,
    baseTable: string,
    baseAlias: string,
    parentPath: string[]
  ): { exprs: string[]; innerCond?: string } {
    const rel = this.findRelationship(baseTable, embed)
    const path = [...parentPath, embed.alias ?? embed.name]
    const pathKey = path.join('.')
    this.consumedPaths.add(pathKey)

    const childAlias = this.nextAlias()
    const children = embed.children.length > 0 ? embed.children : [{ kind: 'column' as const, name: '*' }]
    const { exprs: childExprs, innerConds: childInner } = this.buildSelectList(
      children,
      rel.targetTable,
      childAlias,
      path
    )

    // correlation + filters scoped to this embed path
    const conds: string[] = [...childInner]
    let fromClause: string
    if (rel.type === 'to-one') {
      fromClause = `${this.qualify(rel.targetTable)} as ${quoteIdent(childAlias)}`
      rel.fk.srcColumns.forEach((src, i) => {
        conds.push(
          `${quoteIdent(childAlias)}.${quoteIdent(rel.fk.tgtColumns[i])} = ${quoteIdent(baseAlias)}.${quoteIdent(src)}`
        )
      })
    } else if (rel.type === 'to-many') {
      fromClause = `${this.qualify(rel.targetTable)} as ${quoteIdent(childAlias)}`
      rel.fk.srcColumns.forEach((src, i) => {
        conds.push(
          `${quoteIdent(childAlias)}.${quoteIdent(src)} = ${quoteIdent(baseAlias)}.${quoteIdent(rel.fk.tgtColumns[i])}`
        )
      })
    } else {
      const j = rel.junction!
      const jAlias = this.nextAlias()
      const joinConds = j.fkToTarget.srcColumns.map(
        (src, i) =>
          `${quoteIdent(jAlias)}.${quoteIdent(src)} = ${quoteIdent(childAlias)}.${quoteIdent(j.fkToTarget.tgtColumns[i])}`
      )
      fromClause = `${this.qualify(rel.targetTable)} as ${quoteIdent(childAlias)} join ${this.qualify(j.table)} as ${quoteIdent(jAlias)} on ${joinConds.join(' and ')}`
      j.fkToBase.srcColumns.forEach((src, i) => {
        conds.push(
          `${quoteIdent(jAlias)}.${quoteIdent(src)} = ${quoteIdent(baseAlias)}.${quoteIdent(j.fkToBase.tgtColumns[i])}`
        )
      })
    }

    for (const cond of this.q.conditions) {
      if (cond.path.join('.') === pathKey) {
        conds.push(this.renderCond(cond, childAlias))
      }
    }

    const where = conds.length > 0 ? ` where ${conds.join(' and ')}` : ''
    const order = this.renderOrder(path, childAlias)
    const limitOffset = this.renderLimitOffset(pathKey)
    const outName = embed.alias ?? embed.name

    if (embed.spread) {
      if (rel.type !== 'to-one' && rel.type !== 'm2m') {
        // to-many spread is a newer PostgREST feature; not supported here
        throw new ParseError(`spread embeds are only supported for to-one relationships: ...${embed.name}`)
      }
      const exprs = children.map((c) => {
        if (c.kind !== 'column' || c.name === '*') {
          throw new ParseError('spread embeds support explicit columns only')
        }
        const expr = renderColumnExpr(childAlias, c.name)
        const cast = c.cast ? `::${sanitizeCast(c.cast)}` : ''
        const out = c.alias ?? defaultAliasFor(c.name)
        return `(select ${expr}${cast} from ${fromClause}${where}) as ${quoteIdent(out)}`
      })
      const innerCond = embed.inner ? `exists (select 1 from ${fromClause}${where})` : undefined
      return { exprs, innerCond }
    }

    const sub = `select ${childExprs.join(', ')} from ${fromClause}${where}${order}${limitOffset}`
    const expr =
      rel.type === 'to-one'
        ? `(select row_to_json(_sub) from (${sub}) _sub) as ${quoteIdent(outName)}`
        : `coalesce((select json_agg(row_to_json(_sub)) from (${sub}) _sub), ${AGG_EMPTY}) as ${quoteIdent(outName)}`

    const innerCond = embed.inner ? `exists (select 1 from ${fromClause}${where})` : undefined
    return { exprs: [expr], innerCond }
  }

  private findRelationship(baseTable: string, embed: SelectEmbed): Relationship {
    const target = embed.name
    const fks = this.info.foreignKeys
    let candidates: Relationship[] = []

    for (const fk of fks) {
      if (fk.srcSchema === this.schema && fk.tgtSchema === this.schema) {
        if (fk.srcTable === baseTable && fk.tgtTable === target) {
          candidates.push({ type: 'to-one', fk, targetTable: target })
        }
        if (fk.srcTable === target && fk.tgtTable === baseTable) {
          candidates.push({ type: 'to-many', fk, targetTable: target })
        }
      }
    }

    if (candidates.length === 0) {
      // many-to-many through a junction table
      for (const [jname] of this.info.tables) {
        if (jname === baseTable || jname === target) continue
        const toBase = fks.filter((fk) => fk.srcTable === jname && fk.tgtTable === baseTable)
        const toTarget = fks.filter((fk) => fk.srcTable === jname && fk.tgtTable === target)
        for (const fkToBase of toBase) {
          for (const fkToTarget of toTarget) {
            candidates.push({
              type: 'm2m',
              fk: fkToBase,
              junction: { table: jname, fkToBase, fkToTarget },
              targetTable: target,
            })
          }
        }
      }
    }

    if (embed.hint) {
      const h = embed.hint
      candidates = candidates.filter(
        (c) =>
          c.fk.constraintName === h ||
          c.fk.srcColumns.includes(h) ||
          c.fk.tgtColumns.includes(h) ||
          c.junction?.table === h ||
          c.junction?.fkToTarget.constraintName === h
      )
    }

    if (candidates.length === 1) return candidates[0]
    if (candidates.length === 0) {
      throw new ApiError(400, {
        code: 'PGRST200',
        message: `Could not find a relationship between '${baseTable}' and '${target}' in the schema cache`,
        details: `Searched for a foreign key relationship between '${baseTable}' and '${target}' in the schema '${this.schema}', but no matches were found.`,
        hint: null,
      })
    }
    throw new ApiError(300, {
      code: 'PGRST201',
      message: `Could not embed because more than one relationship was found for '${baseTable}' and '${target}'`,
      details: candidates.map((c) => c.fk.constraintName).join(', '),
      hint: `Try changing '${target}' to one of the following: '${target}!${candidates[0].fk.constraintName}'. Find the desired relationship in the 'details' key.`,
    })
  }

  // ── conditions / order / pagination ───────────────────────────────────

  private baseWhere(alias: string, extraConds: string[]): string {
    const conds = this.q.conditions
      .filter((c) => c.path.length === 0)
      .map((c) => this.renderCond(c, alias))
    conds.push(...extraConds)
    return conds.length > 0 ? ` where ${conds.join(' and ')}` : ''
  }

  renderCond(cond: Cond, alias: string): string {
    if (cond.kind === 'logic') return this.renderLogic(cond, alias)
    return renderFilter(cond, alias)
  }

  private renderLogic(node: LogicCond, alias: string): string {
    if (node.conditions.length === 0) return 'true'
    const parts = node.conditions.map((c) =>
      c.kind === 'logic' ? this.renderLogic(c, alias) : renderFilter(c, alias)
    )
    const joined = `(${parts.join(` ${node.op} `)})`
    return node.negated ? `not ${joined}` : joined
  }

  renderOrder(path: string[], alias: string): string {
    const pathKey = path.join('.')
    const terms = this.q.order.filter((o) => o.path.join('.') === pathKey)
    if (terms.length === 0) return ''
    const parts = terms.map((t) => {
      let s = `${renderColumnExpr(alias, t.column)} ${t.asc ? 'asc' : 'desc'}`
      if (t.nullsFirst === true) s += ' nulls first'
      if (t.nullsFirst === false) s += ' nulls last'
      return s
    })
    return ` order by ${parts.join(', ')}`
  }

  renderLimitOffset(pathKey: string): string {
    let s = ''
    const limit = this.q.limits.get(pathKey)
    const offset = this.q.offsets.get(pathKey)
    if (limit !== undefined) s += ` limit ${limit}`
    if (offset !== undefined) s += ` offset ${offset}`
    return s
  }

  private assertAllPathsConsumed(): void {
    for (const cond of this.q.conditions) {
      const key = cond.path.join('.')
      if (key !== '' && !this.consumedPaths.has(key)) {
        throw new ApiError(400, {
          code: 'PGRST108',
          message: `Cannot apply filter to '${key}': relation is not part of the select`,
          details: null,
          hint: null,
        })
      }
    }
    for (const key of [...this.q.limits.keys(), ...this.q.offsets.keys()]) {
      if (key !== '' && !this.consumedPaths.has(key)) {
        throw new ApiError(400, {
          code: 'PGRST108',
          message: `Cannot paginate '${key}': relation is not part of the select`,
          details: null,
          hint: null,
        })
      }
    }
  }

  // ── params & casts ────────────────────────────────────────────────────

  private requireColumn(tinfo: TableInfo, name: string): ColumnInfo {
    const col = tinfo.columns.find((c) => c.name === name)
    if (!col) {
      throw new ApiError(400, {
        code: 'PGRST204',
        message: `Could not find the '${name}' column of '${tinfo.name}' in the schema cache`,
        details: null,
        hint: null,
      })
    }
    return col
  }

  private pushParam(params: unknown[], tinfo: TableInfo, column: string, value: unknown): string {
    const col = tinfo.columns.find((c) => c.name === column)
    const udt = col?.udtName ?? 'text'
    const cast = udtToCast(udt)
    if (value === null || value === undefined) {
      params.push(null)
      return `$${params.length}${cast}`
    }
    if (udt === 'json' || udt === 'jsonb') {
      params.push(JSON.stringify(value))
      return `$${params.length}${cast}`
    }
    if (udt.startsWith('_') && Array.isArray(value)) {
      params.push(pgArrayLiteral(value))
      return `$${params.length}${cast}`
    }
    if (typeof value === 'object') {
      params.push(JSON.stringify(value))
      return `$${params.length}${cast}`
    }
    params.push(String(value))
    return `$${params.length}${cast}`
  }
}

// ── shared rendering helpers ────────────────────────────────────────────

/** "data->a->>b" → "data"->'a'->>'b' ; numeric keys become array indexes. */
export function renderColumnExpr(alias: string, raw: string): string {
  const tokens = raw.split(/(->>|->)/)
  const base = unquote(tokens[0].trim())
  let expr = `${quoteIdent(alias)}.${quoteIdent(base)}`
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i]
    const key = tokens[i + 1]?.trim() ?? ''
    expr += /^\d+$/.test(key) ? `${op}${key}` : `${op}${quoteLiteral(unquote(key))}`
  }
  return expr
}

function defaultAliasFor(raw: string): string {
  const tokens = raw.split(/->>|->/)
  return unquote(tokens[tokens.length - 1].trim())
}

function sanitizeCast(cast: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_ ]*(\[\])?$/.test(cast)) throw new ParseError(`invalid cast: ${cast}`)
  return cast
}

function udtToCast(udt: string): string {
  const arr = udt.startsWith('_')
  const base = arr ? udt.slice(1) : udt
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(base)) return ''
  return `::${quoteIdent(base)}${arr ? '[]' : ''}`
}

export function pgArrayLiteral(arr: unknown[]): string {
  const items = arr.map((el): string => {
    if (el === null || el === undefined) return 'NULL'
    if (Array.isArray(el)) return pgArrayLiteral(el)
    if (typeof el === 'number' || typeof el === 'boolean') return String(el)
    const s = typeof el === 'object' ? JSON.stringify(el) : String(el)
    return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  })
  return `{${items.join(',')}}`
}

function renderFilter(f: FilterCond, alias: string): string {
  const colExpr = renderColumnExpr(alias, f.column)
  let expr: string
  switch (f.op) {
    case 'is': {
      const v = f.value.toLowerCase()
      if (!['null', 'true', 'false', 'unknown', 'not_null'].includes(v)) {
        throw new ParseError(`invalid is value: ${f.value}`)
      }
      expr = v === 'not_null' ? `${colExpr} is not null` : `${colExpr} is ${v}`
      break
    }
    case 'in': {
      const raw = f.value.trim()
      if (!raw.startsWith('(') || !raw.endsWith(')')) throw new ParseError(`invalid in value: ${f.value}`)
      const items = splitTopLevel(raw.slice(1, -1), ',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .map((s) => quoteLiteral(unquote(s)))
      expr = items.length > 0 ? `${colExpr} in (${items.join(', ')})` : 'false'
      break
    }
    case 'like':
    case 'ilike':
      expr = `${colExpr} ${FILTER_OPS[f.op]} ${quoteLiteral(f.value.replaceAll('*', '%'))}`
      break
    case 'fts':
    case 'plfts':
    case 'phfts':
    case 'wfts': {
      const fn = { fts: 'to_tsquery', plfts: 'plainto_tsquery', phfts: 'phraseto_tsquery', wfts: 'websearch_to_tsquery' }[
        f.op
      ]!
      expr = f.ftsConfig
        ? `${colExpr} @@ ${fn}(${quoteLiteral(f.ftsConfig)}, ${quoteLiteral(f.value)})`
        : `${colExpr} @@ ${fn}(${quoteLiteral(f.value)})`
      break
    }
    case 'cs':
    case 'cd':
    case 'ov':
    case 'sl':
    case 'sr':
    case 'nxr':
    case 'nxl':
    case 'adj':
      expr = `${colExpr} ${FILTER_OPS[f.op]} ${quoteLiteral(f.value)}`
      break
    case 'isdistinct':
      expr = `${colExpr} is distinct from ${quoteLiteral(f.value)}`
      break
    default: {
      const op = FILTER_OPS[f.op]
      if (!op) throw new ParseError(`unknown operator: ${f.op}`)
      expr = `${colExpr} ${op} ${quoteLiteral(f.value)}`
    }
  }
  return f.negated ? `not (${expr})` : expr
}
