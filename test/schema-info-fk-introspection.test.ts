/**
 * getSchemaInfo lists foreign keys from pg_catalog (PGlite, native) or information_schema (pg-mem).
 *
 * oversight.webapp's Reach (Nov 2026) had 134 foreign keys. The information_schema listing took 90 s
 * on PGlite, and the RapidNative editor runs PGlite on the page's main thread, so the tab froze on the
 * first table request. The pg_catalog listing must return the same foreign keys, fast.
 */
import { describe, expect, it } from 'vitest'
import { Database, FK_SQL_INFORMATION_SCHEMA, FK_SQL_PG_CATALOG } from '../src/db/database.js'
import { createPgmemEngine } from '../src/db/pgmem-engine.js'
import { testEngine } from './helpers.js'

const SCHEMA = `
create schema other;
create table other.orgs (id int primary key);
create table teams (id int, org int, primary key (id, org));
create table people (
  id int primary key,
  team_id int,
  team_org int,
  manager_id int references people(id),
  org_id int references other.orgs(id),
  constraint people_team_fk foreign key (team_id, team_org) references teams(id, org)
);
`

const sorted = (fks: any[]) => JSON.parse(JSON.stringify(fks)).sort((a: any, b: any) => a.constraintName.localeCompare(b.constraintName))

async function fksOn(engine?: any) {
  const db = await Database.create(engine)
  await db.engine.exec(SCHEMA)
  return sorted((await db.getSchemaInfo('public')).foreignKeys)
}

describe('getSchemaInfo foreign keys', () => {
  it('finds composite, self and cross-schema keys', async () => {
    const catalog = await fksOn(await testEngine())
    expect(catalog.map((f: any) => f.constraintName)).toEqual(['people_manager_id_fkey', 'people_org_id_fkey', 'people_team_fk'])
    const team = catalog.find((f: any) => f.constraintName === 'people_team_fk')
    expect(team).toMatchObject({ srcColumns: ['team_id', 'team_org'], tgtColumns: ['id', 'org'] })
    expect(catalog.find((f: any) => f.constraintName === 'people_org_id_fkey')).toMatchObject({ tgtSchema: 'other', tgtTable: 'orgs' })
  })

  it('pg_catalog returns exactly the rows the information_schema listing did', async () => {
    const db = await Database.create(await testEngine())
    await db.engine.exec(SCHEMA)
    const a = (await db.engine.query(FK_SQL_PG_CATALOG, ['public'])).rows
    const b = (await db.engine.query(FK_SQL_INFORMATION_SCHEMA, ['public'])).rows
    expect(a.length).toBe(4)
    expect(a).toEqual(b.map((r: any) => ({ ...r, ordinal: Number(r.ordinal) })))
  })

  it('pg-mem (no pg_constraint key arrays) still lists its foreign keys', async () => {
    const db = await Database.create(await createPgmemEngine())
    await db.engine.exec('create table a (id int primary key); create table b (id int primary key, a_id int references a(id));')
    const fks = (await db.getSchemaInfo('public')).foreignKeys
    expect(fks).toHaveLength(1)
    expect(fks[0]).toMatchObject({ srcTable: 'b', srcColumns: ['a_id'], tgtTable: 'a', tgtColumns: ['id'] })
  })

  it('lists 150 foreign keys in seconds, not minutes', async () => {
    const db = await Database.create(await testEngine())
    const sql = ['create table hub (id int primary key);']
    for (let t = 0; t < 30; t++) {
      const cols = Array.from({ length: 5 }, (_, c) => `h${c} int references hub(id)`).join(', ')
      sql.push(`create table t${t} (id int primary key, ${cols});`)
    }
    await db.engine.exec(sql.join('\n'))
    const started = Date.now()
    const info = await db.getSchemaInfo('public')
    expect(info.foreignKeys).toHaveLength(150)
    expect(Date.now() - started).toBeLessThan(5000)
  }, 120_000)
})
