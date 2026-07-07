/**
 * Schema snapshot + diff — the engine behind `tinbase db diff`.
 *
 * Snapshots a schema (tables, columns, constraints, indexes, enums) into a
 * structured form, then emits the DDL to turn one snapshot into another. Used
 * to capture changes made outside migrations (e.g. in the Studio SQL editor)
 * into a new migration, the way `supabase db diff` (migra) does.
 *
 * Covered: enums (create + add value), tables (create/drop), columns
 * (add/drop/alter type/nullability/default), and named constraints + indexes
 * (add/drop by definition). Not yet diffed: functions, triggers, policies,
 * views — noted so the output never silently claims completeness.
 */
import { quoteIdent } from './database.js'
import type { Database } from './database.js'

interface ColumnSnap {
  name: string
  type: string
  nullable: boolean
  default: string | null
}
interface TableSnap {
  name: string
  columns: Map<string, ColumnSnap>
  order: string[]
}
export interface SchemaSnapshot {
  tables: Map<string, TableSnap>
  /** constraint/index name → definition, keyed by table */
  constraints: Map<string, Map<string, string>>
  indexes: Map<string, Map<string, string>>
  enums: Map<string, string[]>
}

export async function snapshotSchema(db: Database, schema = 'public'): Promise<SchemaSnapshot> {
  const cols = await db.query<{ table: string; column: string; type: string; nullable: boolean; default: string | null }>(
    `select c.relname as table, a.attname as column,
            format_type(a.atttypid, a.atttypmod) as type,
            not a.attnotnull as nullable,
            pg_get_expr(d.adbin, d.adrelid) as default
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
     where n.nspname = $1 and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     order by c.relname, a.attnum`,
    [schema]
  )
  const tables = new Map<string, TableSnap>()
  for (const c of cols.rows) {
    let t = tables.get(c.table)
    if (!t) {
      t = { name: c.table, columns: new Map(), order: [] }
      tables.set(c.table, t)
    }
    t.columns.set(c.column, { name: c.column, type: c.type, nullable: c.nullable, default: c.default })
    t.order.push(c.column)
  }

  const cons = await db.query<{ table: string; name: string; def: string; conindid: number }>(
    `select c.relname as table, con.conname as name, pg_get_constraintdef(con.oid) as def, con.conindid::int as conindid
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and con.contype in ('p','u','f','c')`,
    [schema]
  )
  const constraints = new Map<string, Map<string, string>>()
  const constraintIndexOids = new Set<number>()
  for (const c of cons.rows) {
    if (!constraints.has(c.table)) constraints.set(c.table, new Map())
    constraints.get(c.table)!.set(c.name, c.def)
    if (c.conindid) constraintIndexOids.add(c.conindid)
  }

  // indexes not backing a constraint (those are emitted via the constraint)
  const idx = await db.query<{ table: string; name: string; def: string; indexrelid: number }>(
    `select c.relname as table, ic.relname as name, pg_get_indexdef(i.indexrelid) as def, i.indexrelid::int as indexrelid
     from pg_index i
     join pg_class ic on ic.oid = i.indexrelid
     join pg_class c on c.oid = i.indrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1`,
    [schema]
  )
  const indexes = new Map<string, Map<string, string>>()
  for (const r of idx.rows) {
    if (constraintIndexOids.has(r.indexrelid)) continue
    if (!indexes.has(r.table)) indexes.set(r.table, new Map())
    indexes.get(r.table)!.set(r.name, r.def)
  }

  const en = await db.query<{ name: string; labels: string[] }>(
    `select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
     from pg_type t join pg_enum e on e.enumtypid = t.oid
     join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = $1 group by t.typname`,
    [schema]
  )
  const enums = new Map<string, string[]>()
  for (const r of en.rows) enums.set(r.name, r.labels)

  return { tables, constraints, indexes, enums }
}

/** DDL to turn `from` into `to`, scoped to one schema. Empty array = no changes. */
export function diffSchemas(from: SchemaSnapshot, to: SchemaSnapshot, schema = 'public'): string[] {
  const out: string[] = []
  const q = (n: string) => quoteIdent(n)
  const tbl = (t: string) => `${q(schema)}.${q(t)}`

  // ── enums ──
  for (const [name, labels] of to.enums) {
    if (!from.enums.has(name)) {
      out.push(`create type ${q(schema)}.${q(name)} as enum (${labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ')});`)
    } else {
      const before = from.enums.get(name)!
      for (const label of labels) {
        if (!before.includes(label)) out.push(`alter type ${q(schema)}.${q(name)} add value '${label.replace(/'/g, "''")}';`)
      }
    }
  }

  // ── new tables ──
  for (const [name, t] of to.tables) {
    if (from.tables.has(name)) continue
    const colDefs = t.order.map((cn) => columnClause(t.columns.get(cn)!, q))
    out.push(`create table ${tbl(name)} (\n${colDefs.map((c) => `  ${c}`).join(',\n')}\n);`)
  }

  // ── column-level diffs on shared tables ──
  for (const [name, toT] of to.tables) {
    const fromT = from.tables.get(name)
    if (!fromT) continue
    for (const cn of toT.order) {
      const toC = toT.columns.get(cn)!
      const fromC = fromT.columns.get(cn)
      if (!fromC) {
        out.push(`alter table ${tbl(name)} add column ${columnClause(toC, q)};`)
        continue
      }
      if (fromC.type !== toC.type) out.push(`alter table ${tbl(name)} alter column ${q(cn)} type ${toC.type};`)
      if (fromC.nullable !== toC.nullable)
        out.push(`alter table ${tbl(name)} alter column ${q(cn)} ${toC.nullable ? 'drop not null' : 'set not null'};`)
      if ((fromC.default ?? null) !== (toC.default ?? null)) {
        out.push(
          toC.default === null
            ? `alter table ${tbl(name)} alter column ${q(cn)} drop default;`
            : `alter table ${tbl(name)} alter column ${q(cn)} set default ${toC.default};`
        )
      }
    }
    for (const cn of fromT.order) {
      if (!toT.columns.has(cn)) out.push(`alter table ${tbl(name)} drop column ${q(cn)};`)
    }
  }

  // ── dropped tables ──
  for (const name of from.tables.keys()) {
    if (!to.tables.has(name)) out.push(`drop table ${tbl(name)};`)
  }

  // ── constraints (drop changed/removed, then add new) ──
  diffNamed(from.constraints, to.constraints, {
    drop: (table, cname) => out.push(`alter table ${tbl(table)} drop constraint ${q(cname)};`),
    add: (table, cname, def) => out.push(`alter table ${tbl(table)} add constraint ${q(cname)} ${def};`),
  })

  // ── indexes (drop changed/removed, then add new) ──
  diffNamed(from.indexes, to.indexes, {
    drop: (_table, iname) => out.push(`drop index ${q(schema)}.${q(iname)};`),
    add: (_table, _iname, def) => out.push(`${def};`),
  })

  return out
}

/**
 * Render a column definition. A `serial`-style column introspects as an integer
 * with a `nextval('..._seq')` default and an owned sequence; re-emit it as
 * serial/bigserial/smallserial so the sequence is recreated with the table
 * (a bare `default nextval(...)` would reference a sequence that doesn't exist yet).
 */
function columnClause(c: ColumnSnap, q: (n: string) => string): string {
  const isSerialDefault = c.default !== null && /^nextval\(/i.test(c.default)
  if (isSerialDefault) {
    const serial = c.type === 'bigint' ? 'bigserial' : c.type === 'smallint' ? 'smallserial' : 'serial'
    return `${q(c.name)} ${serial}` + (c.nullable ? '' : ' not null')
  }
  let s = `${q(c.name)} ${c.type}`
  if (!c.nullable) s += ' not null'
  if (c.default !== null) s += ` default ${c.default}`
  return s
}

function diffNamed(
  from: Map<string, Map<string, string>>,
  to: Map<string, Map<string, string>>,
  ops: { drop: (table: string, name: string, def: string) => void; add: (table: string, name: string, def: string) => void }
): void {
  // drops (and changed → drop first)
  for (const [table, defs] of from) {
    const toDefs = to.get(table) ?? new Map()
    for (const [name, def] of defs) {
      const toDef = toDefs.get(name)
      if (toDef === undefined || toDef !== def) ops.drop(table, name, def)
    }
  }
  // adds (and changed → re-add)
  for (const [table, defs] of to) {
    const fromDefs = from.get(table) ?? new Map()
    for (const [name, def] of defs) {
      const fromDef = fromDefs.get(name)
      if (fromDef === undefined || fromDef !== def) ops.add(table, name, def)
    }
  }
}
