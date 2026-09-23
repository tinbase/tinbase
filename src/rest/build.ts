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
  type OrderTerm,
  type SelectEmbed,
  type SelectItem,
} from './parse.js'

/** A resolved embed relationship between a base table and an embedded target. */
interface Relationship {
  /** to-one (base holds the fk), to-many (target holds the fk), or m2m via a junction */
  type: 'to-one' | 'to-many' | 'm2m'
  /** the foreign key driving the join; for m2m this is the junction's fk to the base */
  fk: ForeignKey
  /** junction table and its two fks, present only for m2m relationships */
  junction?: { table: string; fkToBase: ForeignKey; fkToTarget: ForeignKey }
  /** name of the embedded target table */
  targetTable: string
  /**
   * True when the relationship yields at most one row and must serialize as a
   * single object, not an array. Always so for `to-one`; also for a `to-many`
   * whose fk on the target is a unique key (a one-to-one, per PostgREST).
   */
  single?: boolean
}

/** A built SQL statement plus its bind params and an optional separate count query. */
export interface BuiltQuery {
  /** SQL text with `$n` placeholders */
  sql: string
  /** positional bind values for the placeholders */
  params: unknown[]
  /** separate exact-count query, emitted only when the client asked for a count */
  countSql?: string
}

/** json_agg fallback for an empty result set: a literal empty JSON array. */
const AGG_EMPTY = `'[]'::json`

/** Builds SQL for one PostgREST request against a single schema's introspection. */
export class QueryBuilder {
  private aliasCounter = 0
  private consumedPaths = new Set<string>([''])

  /** pg-mem can't bind a table alias in UPDATE/DELETE; omit it for subset engines. */
  private aliasMutations: boolean
  private captureMutationRows: boolean

  constructor(
    private schema: string,
    private info: SchemaInfo,
    private q: ParsedQuery,
    opts?: { aliasMutations?: boolean; captureMutationRows?: boolean }
  ) {
    this.aliasMutations = opts?.aliasMutations ?? true
    this.captureMutationRows = opts?.captureMutationRows ?? false
  }

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

  /** Build the SELECT (with embeds/filters/order/pagination), plus an optional count query. */
  buildSelect(table: string, opts: { count?: boolean } = {}): BuiltQuery {
    this.table(table)
    const alias = 't0'
    if (this.q.select.some((i) => i.kind === 'column' && i.aggregate)) {
      return this.buildAggregateSelect(table, alias, opts)
    }
    const { exprs, innerConds } = this.buildSelectList(this.q.select, table, alias, [])
    const where = this.baseWhere(alias, innerConds)
    const order = this.renderOrder([], alias, table)
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

  /**
   * Aggregate select: `count()`, `col.sum()`, `col.avg()`, `col.max()`,
   * `col.min()`. Any non-aggregate column becomes an implicit GROUP BY key, so
   * `select=author_id,views.sum()` yields one row per author. Output keys are
   * the aggregate name (or the column's alias) and the grouping column names.
   */
  private buildAggregateSelect(table: string, alias: string, opts: { count?: boolean }): BuiltQuery {
    const selExprs: string[] = []
    const groupExprs: string[] = []
    for (const item of this.q.select) {
      if (item.kind !== 'column') {
        throw new ParseError('embedded resources cannot be combined with aggregate functions')
      }
      if (item.name === '*') {
        throw new ParseError('"*" cannot be combined with aggregate functions')
      }
      const cast = item.cast ? `::${sanitizeCast(item.cast)}` : ''
      if (item.aggregate) {
        const call =
          item.name === ''
            ? `${item.aggregate}(*)` // bare count()
            : `${item.aggregate}(${renderColumnExpr(alias, item.name)})`
        const out = item.alias ?? item.aggregate
        selExprs.push(`${call}${cast} as ${quoteIdent(out)}`)
      } else {
        const expr = renderColumnExpr(alias, item.name)
        const out = item.alias ?? defaultAliasFor(item.name)
        selExprs.push(`${expr}${cast} as ${quoteIdent(out)}`)
        groupExprs.push(expr)
      }
    }
    const where = this.baseWhere(alias, [])
    const groupBy = groupExprs.length > 0 ? ` group by ${groupExprs.join(', ')}` : ''
    const body = `select ${selExprs.join(', ')} from ${this.qualify(table)} as ${quoteIdent(alias)}${where}${groupBy}`
    const core = `${body}${this.renderOrder([], alias, table)}${this.renderLimitOffset('')}`
    this.assertAllPathsConsumed()
    return {
      sql: `select coalesce(json_agg(row_to_json(_r)), ${AGG_EMPTY}) as body from (${core}) _r`,
      params: [],
      countSql: opts.count ? `select count(*)::int as count from (${body}) _c` : undefined,
    }
  }

  /**
   * Build a multi-row INSERT, optionally with ON CONFLICT upsert semantics.
   * @param opts.upsert merge-duplicates (do update) or ignore-duplicates (do nothing)
   * @param opts.missingDefault emit `default` for absent columns instead of `null`
   * @param opts.returning wrap in a CTE so select= can shape the returned rows
   */
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
    if (!opts.returning) {
      this.assertAllPathsConsumed()
      return { sql: insert, params }
    }
    return { sql: this.wrapMutation(insert, table), params }
  }

  /** Build an UPDATE scoped by the base filters; SET comes from the JSON body. */
  buildUpdate(table: string, body: Record<string, unknown>, opts: { returning: boolean }): BuiltQuery {
    const tinfo = this.table(table)
    const keys = Object.keys(body)
    if (keys.length === 0) {
      throw new ApiError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null })
    }
    for (const c of keys) this.requireColumn(tinfo, c)
    const params: unknown[] = []
    const sets = keys.map((c) => `${quoteIdent(c)} = ${this.pushParam(params, tinfo, c, body[c])}`)
    const alias = this.aliasMutations ? 't0' : ''
    const asClause = alias ? ` as ${quoteIdent(alias)}` : ''
    const where = this.baseWhere(alias, [])
    const update = `update ${this.qualify(table)}${asClause} set ${sets.join(', ')}${where} returning *`
    if (!opts.returning) {
      this.assertAllPathsConsumed()
      return { sql: update.replace(/ returning \*$/, ''), params }
    }
    return { sql: this.wrapMutation(update, table, true), params }
  }

  /** Build a DELETE scoped by the base filters. */
  buildDelete(table: string, opts: { returning: boolean }): BuiltQuery {
    this.table(table)
    const alias = this.aliasMutations ? 't0' : ''
    const asClause = alias ? ` as ${quoteIdent(alias)}` : ''
    const where = this.baseWhere(alias, [])
    const del = `delete from ${this.qualify(table)}${asClause}${where} returning *`
    if (!opts.returning) {
      this.assertAllPathsConsumed()
      return { sql: del.replace(/ returning \*$/, ''), params: [] }
    }
    return { sql: this.wrapMutation(del, table, true), params: [] }
  }

  /** Wrap a mutation in a CTE so the response can apply select= (incl. embeds). */
  private wrapMutation(mutation: string, table: string, alreadyHasReturning = false): string {
    const withReturning = alreadyHasReturning ? mutation : `${mutation} returning *`
    const { exprs, innerConds } = this.buildSelectList(this.q.select, table, '_mut', [])
    this.assertAllPathsConsumed()
    const where = innerConds.length > 0 ? ` where ${innerConds.join(' and ')}` : ''
    // Minimal-bootstrap engines synthesize CDC in JS. Keep all affected rows
    // separate from the representation, which !inner can filter down.
    const changes = this.captureMutationRows
      ? `, (select coalesce(json_agg(row_to_json(_mut)), ${AGG_EMPTY}) from _mut) as changes`
      : ''
    return `with _mut as (${withReturning}) select coalesce(json_agg(row_to_json(_r)), ${AGG_EMPTY}) as body${changes} from (select ${exprs.join(', ')} from _mut${where}) _r`
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
    if (rel.type === 'to-one' || rel.type === 'to-many') {
      fromClause = `${this.qualify(rel.targetTable)} as ${quoteIdent(childAlias)}`
      conds.push(...QueryBuilder.correlate(rel, baseAlias, childAlias))
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
    const order = this.renderOrder(path, childAlias, rel.targetTable)
    const limitOffset = this.renderLimitOffset(pathKey)
    const outName = embed.alias ?? embed.name

    if (embed.spread) {
      // a single-valued embed (to-one, or a one-to-one reverse embed) spreads
      // one row's columns; to-many / m2m aggregate each into a JSON array.
      const toOne = rel.single === true
      const exprs = children.map((c) => {
        if (c.kind !== 'column' || c.name === '*') {
          throw new ParseError('spread embeds support explicit columns only')
        }
        const expr = renderColumnExpr(childAlias, c.name)
        const cast = c.cast ? `::${sanitizeCast(c.cast)}` : ''
        const out = c.alias ?? defaultAliasFor(c.name)
        return toOne
          ? `(select ${expr}${cast} from ${fromClause}${where}) as ${quoteIdent(out)}`
          : `coalesce((select json_agg(${expr}${cast}${order}) from ${fromClause}${where}), ${AGG_EMPTY}) as ${quoteIdent(out)}`
      })
      const innerCond = embed.inner ? `exists (select 1 from ${fromClause}${where})` : undefined
      return { exprs, innerCond }
    }

    const sub = `select ${childExprs.join(', ')} from ${fromClause}${where}${order}${limitOffset}`
    const expr =
      rel.single === true
        ? `(select row_to_json(_sub) from (${sub}) _sub) as ${quoteIdent(outName)}`
        : `coalesce((select json_agg(row_to_json(_sub)) from (${sub}) _sub), ${AGG_EMPTY}) as ${quoteIdent(outName)}`

    const innerCond = embed.inner ? `exists (select 1 from ${fromClause}${where})` : undefined
    return { exprs: [expr], innerCond }
  }

  /** Whether `columns` (order-independent) form a PK/UNIQUE key on `table`. */
  private isUniqueKey(table: string, columns: string[]): boolean {
    const t = this.info.tables.get(table)
    if (!t) return false
    const want = [...columns].sort().join(' ')
    return t.uniqueKeys.some((key) => key.length === columns.length && [...key].sort().join(' ') === want)
  }

  /**
   * Conditions correlating an embedded target to its parent row. For `to-one`
   * the fk lives on the base, for `to-many` on the target, so the two sides swap.
   * Shared by the embed subquery and `order=relation(column)` so a change to one
   * cannot silently order by a different join than it selects.
   */
  private static correlate(rel: Relationship, baseAlias: string, childAlias: string): string[] {
    if (rel.type === 'to-one') {
      return rel.fk.srcColumns.map(
        (src, i) =>
          `${quoteIdent(childAlias)}.${quoteIdent(rel.fk.tgtColumns[i])} = ${quoteIdent(baseAlias)}.${quoteIdent(src)}`
      )
    }
    return rel.fk.srcColumns.map(
      (src, i) =>
        `${quoteIdent(childAlias)}.${quoteIdent(src)} = ${quoteIdent(baseAlias)}.${quoteIdent(rel.fk.tgtColumns[i])}`
    )
  }

  private findRelationship(baseTable: string, embed: SelectEmbed): Relationship {
    const target = embed.name
    const fks = this.info.foreignKeys
    let candidates: Relationship[] = []

    for (const fk of fks) {
      if (fk.srcSchema === this.schema && fk.tgtSchema === this.schema) {
        if (fk.srcTable === baseTable && fk.tgtTable === target) {
          candidates.push({ type: 'to-one', fk, targetTable: target, single: true })
        }
        if (fk.srcTable === target && fk.tgtTable === baseTable) {
          // A reverse embed is normally one-to-many (array), but when the fk on
          // the target is itself a unique key it's one-to-one -> single object.
          candidates.push({ type: 'to-many', fk, targetTable: target, single: this.isUniqueKey(target, fk.srcColumns) })
        }
      }
    }

    if (candidates.length === 0) {
      // PostgREST also accepts an fk column on the base table (`asset_id(*)`)
      // or an fk constraint name in place of the target table name.
      for (const fk of fks) {
        if (fk.srcSchema !== this.schema || fk.tgtSchema !== this.schema) continue
        if (fk.srcTable === baseTable && (fk.srcColumns.includes(target) || fk.constraintName === target)) {
          candidates.push({ type: 'to-one', fk, targetTable: fk.tgtTable, single: true })
        } else if (fk.tgtTable === baseTable && fk.constraintName === target) {
          candidates.push({ type: 'to-many', fk, targetTable: fk.srcTable, single: this.isUniqueKey(fk.srcTable, fk.srcColumns) })
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

  /** Render one condition (leaf filter or and/or subtree) as a SQL boolean expression. */
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

  /**
   * Render the `order by` clause for the terms scoped to the given embed path
   * (`[]` = base). `table` is the table `alias` refers to, needed only to resolve
   * `order=relation(column)` terms; omit it where there is no relational context
   * (an RPC result), and such a term will report that rather than mis-resolving.
   */
  renderOrder(path: string[], alias: string, table?: string): string {
    const pathKey = path.join('.')
    const terms = this.q.order.filter((o) => o.path.join('.') === pathKey)
    if (terms.length === 0) return ''
    const parts = terms.map((t) => {
      let s = `${t.relation ? this.embeddedOrderExpr(t, alias, table) : renderColumnExpr(alias, t.column)} ${
        t.asc ? 'asc' : 'desc'
      }`
      if (t.nullsFirst === true) s += ' nulls first'
      if (t.nullsFirst === false) s += ' nulls last'
      return s
    })
    return ` order by ${parts.join(', ')}`
  }

  /**
   * A correlated scalar subquery for `order=relation(column)`.
   *
   * Embeds are rendered as correlated subqueries rather than joins here, so
   * ordering by one follows the same shape instead of restructuring the query
   * into a LEFT JOIN the way PostgREST does. The result matches: exactly one
   * value per base row, NULL where the related row is absent.
   */
  private embeddedOrderExpr(term: OrderTerm, baseAlias: string, table?: string): string {
    const relation = term.relation!
    if (!table) {
      throw new ParseError(`cannot order by '${relation}(${term.column})' here: no embedded resources in this context`)
    }
    const rel = this.findRelationship(table, {
      kind: 'embed',
      name: relation,
      hint: term.relationHint,
      children: [],
      inner: false,
      spread: false,
    })
    // Ordering needs one value per base row. A to-many embed has many, so
    // PostgREST rejects it too - say which relationship it was, since the same
    // name can resolve either way depending on where the fk sits.
    if (!rel.single) {
      throw new ParseError(
        `cannot order by '${relation}(${term.column})': ` +
          `'${relation}' is a to-many relationship from '${table}', which has no single value per row`
      )
    }
    const childAlias = this.nextAlias()
    const conds = QueryBuilder.correlate(rel, baseAlias, childAlias)
    const col = renderColumnExpr(childAlias, term.column)
    return `(select ${col} from ${this.qualify(rel.targetTable)} as ${quoteIdent(childAlias)} where ${conds.join(' and ')} limit 1)`
  }

  /** Render `limit`/`offset` for the given path key (`''` = base); empty when neither is set. */
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
    if (Array.isArray(value)) {
      params.push(pgArrayLiteral(value))
      // recognized array udt (`_text`) gets a `::text[]` cast; for engines that
      // report an unhelpful udt (pg-mem says "array"), skip the cast and let the
      // target column coerce the literal
      return `$${params.length}${udt.startsWith('_') ? cast : ''}`
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

/**
 * Render a (possibly JSON-arrowed) column reference: `data->a->>b` becomes
 * `"data"->'a'->>'b'`; numeric keys become array indexes.
 * SECURITY: the base column is quoted as an identifier and text keys are quoted
 * as literals, so a hostile column/key name can't break out of the expression.
 */
export function renderColumnExpr(alias: string, raw: string): string {
  const tokens = raw.split(/(->>|->)/)
  const base = unquote(tokens[0].trim())
  // empty alias → unqualified column (used for UPDATE/DELETE on subset engines)
  let expr = alias ? `${quoteIdent(alias)}.${quoteIdent(base)}` : quoteIdent(base)
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

/**
 * Validate a `::type` cast against an identifier-plus-`[]` allowlist and return it.
 * SECURITY: casts are interpolated raw into SQL, so this reject is the only guard
 * against injection through the cast token.
 * @throws ParseError when the cast is not a bare type name (optionally array).
 */
export function sanitizeCast(cast: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_ ]*(\[\])?$/.test(cast)) throw new ParseError(`invalid cast: ${cast}`)
  return cast
}

function udtToCast(udt: string): string {
  const arr = udt.startsWith('_')
  const base = arr ? udt.slice(1) : udt
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(base)) return ''
  return `::${quoteIdent(base)}${arr ? '[]' : ''}`
}

/**
 * Serialize a JS array into a Postgres array literal (`{a,b,...}`), recursing
 * for nested arrays. Elements are double-quoted with backslash/quote escaping so
 * the literal survives being bound as a parameter and cast to the target type.
 */
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
