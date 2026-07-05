/**
 * Parser for the PostgREST query grammar as emitted by supabase-js
 * (postgrest-js): select trees with embedded resources, filter operators,
 * and/or logic trees, ordering, and pagination.
 */

export interface SelectColumn {
  kind: 'column'
  /** raw column expression, may contain json arrows: data->>key */
  name: string
  alias?: string
  cast?: string
}

export interface SelectEmbed {
  kind: 'embed'
  /** relation (table) name or fk hint target */
  name: string
  alias?: string
  /** disambiguation hint: fk constraint name, column name, or junction table */
  hint?: string
  inner: boolean
  children: SelectItem[]
  spread: boolean
}

export type SelectItem = SelectColumn | SelectEmbed

export interface FilterCond {
  kind: 'filter'
  /** embed path, [] = base table */
  path: string[]
  column: string
  negated: boolean
  op: string
  value: string
  /** text-search config, e.g. fts(english).query */
  ftsConfig?: string
}

export interface LogicCond {
  kind: 'logic'
  path: string[]
  op: 'and' | 'or'
  negated: boolean
  conditions: Cond[]
}

export type Cond = FilterCond | LogicCond

export interface OrderTerm {
  path: string[]
  column: string
  asc: boolean
  nullsFirst?: boolean
}

export interface ParsedQuery {
  select: SelectItem[]
  conditions: Cond[]
  order: OrderTerm[]
  limits: Map<string, number>   // key = path joined with '.', '' = base
  offsets: Map<string, number>
  onConflict?: string[]
  columns?: string[]
}

export class ParseError extends Error {}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

export const FILTER_OPS: Record<string, string> = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'like', ilike: 'ilike', match: '~', imatch: '~*',
  is: 'is', in: 'in',
  cs: '@>', cd: '<@', ov: '&&',
  sl: '<<', sr: '>>', nxr: '&<', nxl: '&>', adj: '-|-',
  fts: '@@', plfts: '@@', phfts: '@@', wfts: '@@',
  isdistinct: 'is distinct from',
}

export function parseQuery(searchParams: URLSearchParams): ParsedQuery {
  const q: ParsedQuery = {
    select: [{ kind: 'column', name: '*' }],
    conditions: [],
    order: [],
    limits: new Map(),
    offsets: new Map(),
  }

  for (const [key, value] of searchParams.entries()) {
    if (key === 'select') {
      if (value.trim()) q.select = parseSelect(value)
      continue
    }
    if (key === 'on_conflict') {
      q.onConflict = value.split(',').map((s) => s.trim()).filter(Boolean)
      continue
    }
    if (key === 'columns') {
      q.columns = splitTopLevel(value, ',').map((s) => unquote(s.trim()))
      continue
    }

    const segments = key.split('.')
    const last = segments[segments.length - 1]

    if (last === 'order') {
      const path = segments.slice(0, -1)
      for (const term of splitTopLevel(value, ',')) {
        q.order.push(parseOrderTerm(term.trim(), path))
      }
      continue
    }
    if (last === 'limit' || last === 'offset') {
      const path = segments.slice(0, -1).join('.')
      const n = parseInt(value, 10)
      if (Number.isNaN(n) || n < 0) throw new ParseError(`invalid ${last}: ${value}`)
      ;(last === 'limit' ? q.limits : q.offsets).set(path, n)
      continue
    }
    if (last === 'or' || last === 'and') {
      const negated = segments[segments.length - 2] === 'not'
      const path = segments.slice(0, negated ? -2 : -1)
      q.conditions.push(parseLogicTree(last, value, path, negated))
      continue
    }
    if (RESERVED.has(key)) continue
    if (key === 'apikey') continue

    // plain filter: <path...>.<column>=<[not.]op.value>
    const path = segments.slice(0, -1)
    const column = segments[segments.length - 1]
    q.conditions.push(parseFilterValue(column, value, path))
  }
  return q
}

function parseFilterValue(column: string, raw: string, path: string[]): FilterCond {
  let negated = false
  let rest = raw
  if (rest.startsWith('not.')) {
    negated = true
    rest = rest.slice(4)
  }
  const dot = rest.indexOf('.')
  let op: string, value: string
  if (dot === -1) {
    op = rest
    value = ''
  } else {
    op = rest.slice(0, dot)
    value = rest.slice(dot + 1)
  }
  // fts ops may carry a config: fts(english).value
  const ftsMatch = op.match(/^(fts|plfts|phfts|wfts)\((.+)\)$/)
  if (ftsMatch) {
    return { kind: 'filter', path, column, negated, op: ftsMatch[1], value, ftsConfig: ftsMatch[2] }
  }
  if (!(op in FILTER_OPS)) throw new ParseError(`unknown filter operator: ${op}`)
  return { kind: 'filter', path, column, negated, op, value }
}

/** or=(age.gte.18,and(a.eq.1,b.eq.2),name.not.like.*x*) */
function parseLogicTree(op: 'and' | 'or', raw: string, path: string[], negated: boolean): LogicCond {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) {
    throw new ParseError(`malformed logic tree: ${raw}`)
  }
  const inner = trimmed.slice(1, -1)
  const conditions: Cond[] = []
  for (const part of splitTopLevel(inner, ',')) {
    const p = part.trim()
    const nested = p.match(/^(not\.)?(and|or)(\(.*\))$/s)
    if (nested) {
      conditions.push(parseLogicTree(nested[2] as 'and' | 'or', nested[3], path, !!nested[1]))
      continue
    }
    // column.[not.]op.value - column may contain -> arrows but no dots
    const dot = p.indexOf('.')
    if (dot === -1) throw new ParseError(`malformed condition: ${p}`)
    const column = p.slice(0, dot)
    conditions.push(parseFilterValue(unquote(column), p.slice(dot + 1), path))
  }
  return { kind: 'logic', path, op, negated, conditions }
}

function parseOrderTerm(term: string, path: string[]): OrderTerm {
  const parts = term.split('.')
  const column = unquote(parts[0])
  let asc = true
  let nullsFirst: boolean | undefined
  for (const p of parts.slice(1)) {
    if (p === 'asc') asc = true
    else if (p === 'desc') asc = false
    else if (p === 'nullsfirst') nullsFirst = true
    else if (p === 'nullslast') nullsFirst = false
    else throw new ParseError(`invalid order term: ${term}`)
  }
  return { path, column, asc, nullsFirst }
}

/** Split on a delimiter, ignoring delimiters inside parens and double quotes. */
export function splitTopLevel(str: string, delim: string): string[] {
  const out: string[] = []
  let depth = 0
  let inQuote = false
  let current = ''
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (inQuote) {
      current += ch
      if (ch === '"') inQuote = false
      continue
    }
    if (ch === '"') {
      inQuote = true
      current += ch
    } else if (ch === '(') {
      depth++
      current += ch
    } else if (ch === ')') {
      depth--
      current += ch
    } else if (ch === delim && depth === 0) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current !== '') out.push(current)
  return out
}

export function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replaceAll('\\"', '"')
  }
  return s
}

/**
 * select=a,b:c,d::text,rel!hint!inner(x,nested(y)),...spread(a)
 */
export function parseSelect(value: string): SelectItem[] {
  return splitTopLevel(value, ',').map((item) => parseSelectItem(item.trim()))
}

function parseSelectItem(item: string): SelectItem {
  if (item === '') throw new ParseError('empty select item')

  let spread = false
  if (item.startsWith('...')) {
    spread = true
    item = item.slice(3)
  }

  // alias:rest - a ':' not part of '::'
  let alias: string | undefined
  const aliasIdx = findAliasColon(item)
  if (aliasIdx !== -1) {
    alias = unquote(item.slice(0, aliasIdx))
    item = item.slice(aliasIdx + 1)
  }

  const parenIdx = item.indexOf('(')
  if (parenIdx !== -1 && item.endsWith(')')) {
    // embed: name[!hint][!inner](children)
    const head = item.slice(0, parenIdx)
    const body = item.slice(parenIdx + 1, -1)
    const headParts = head.split('!')
    const name = unquote(headParts[0])
    let hint: string | undefined
    let inner = false
    for (const part of headParts.slice(1)) {
      if (part === 'inner') inner = true
      else if (part === 'left') { /* left is the default */ }
      else hint = unquote(part)
    }
    const children = body.trim() === '' ? [] : parseSelect(body)
    return { kind: 'embed', name, alias, hint, inner, children, spread }
  }

  if (spread) throw new ParseError(`spread requires an embed: ...${item}`)

  // column: name[::cast], name may be quoted or contain -> arrows
  let cast: string | undefined
  const castIdx = item.lastIndexOf('::')
  if (castIdx !== -1) {
    cast = item.slice(castIdx + 2)
    if (!/^[a-zA-Z_][a-zA-Z0-9_ \[\]]*$/.test(cast)) throw new ParseError(`invalid cast: ${cast}`)
    item = item.slice(0, castIdx)
  }
  return { kind: 'column', name: unquote(item), alias, cast }
}

/** Index of an alias ':' (not '::'), outside quotes/parens; -1 when absent. */
function findAliasColon(item: string): number {
  let inQuote = false
  for (let i = 0; i < item.length; i++) {
    const ch = item[i]
    if (ch === '"') inQuote = !inQuote
    if (inQuote) continue
    if (ch === '(') return -1
    if (ch === ':') {
      if (item[i + 1] === ':') { i++; continue }
      return i
    }
  }
  return -1
}
