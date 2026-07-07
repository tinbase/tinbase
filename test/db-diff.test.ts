import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, snapshotSchema, diffSchemas, type TinbaseBackend } from '../src/index.js'

const BASE = `
create table authors (id serial primary key, name text not null);
create table posts (id serial primary key, title text);
`

const backends: TinbaseBackend[] = []
async function boot(migrationsSql: string): Promise<TinbaseBackend> {
  const b = await createBackend({ migrations: [{ name: '20240101000000_base', sql: migrationsSql }] })
  backends.push(b)
  return b
}

afterEach(async () => {
  while (backends.length) await backends.pop()!.close()
})

/** Snapshot two backends and diff shadow→live. */
async function diff(shadow: TinbaseBackend, live: TinbaseBackend): Promise<string[]> {
  const a = await snapshotSchema(shadow.db, 'public')
  const b = await snapshotSchema(live.db, 'public')
  return diffSchemas(a, b, 'public')
}

describe('db diff', () => {
  it('detects a new table', { timeout: 20000 }, async () => {
    const shadow = await boot(BASE)
    const live = await boot(BASE)
    await live.db.query(`create table comments (id serial primary key, body text not null)`)
    const ddl = await diff(shadow, live)
    expect(ddl.some((s) => s.includes('create table') && s.includes('comments'))).toBe(true)
    expect(ddl.join('\n')).toMatch(/"?body"? text not null/)
  })

  it('detects an added column with default and nullability', { timeout: 20000 }, async () => {
    const shadow = await boot(BASE)
    const live = await boot(BASE)
    await live.db.query(`alter table posts add column views int not null default 0`)
    const ddl = await diff(shadow, live)
    expect(ddl.join('\n')).toMatch(/add column "?views"? .*not null default 0/i)
  })

  it('detects dropped column, type change, and nullability change', { timeout: 20000 }, async () => {
    const shadow = await boot(BASE)
    const live = await boot(BASE)
    await live.db.query(`alter table posts drop column title`)
    await live.db.query(`alter table authors alter column name drop not null`)
    const ddl = (await diff(shadow, live)).join('\n')
    expect(ddl).toMatch(/drop column "?title"?/i)
    expect(ddl).toMatch(/alter column "?name"? drop not null/i)
  })

  it('detects new index and foreign key', { timeout: 20000 }, async () => {
    const shadow = await boot(BASE)
    const live = await boot(BASE)
    await live.db.query(`alter table posts add column author_id int`)
    await live.db.query(`alter table posts add constraint posts_author_fk foreign key (author_id) references authors(id)`)
    await live.db.query(`create index posts_title_idx on posts (title)`)
    const ddl = (await diff(shadow, live)).join('\n')
    expect(ddl).toMatch(/add constraint "?posts_author_fk"? foreign key/i)
    expect(ddl).toContain('posts_title_idx')
  })

  it('no changes → empty diff', { timeout: 20000 }, async () => {
    const shadow = await boot(BASE)
    const live = await boot(BASE)
    expect(await diff(shadow, live)).toEqual([])
  })

  it('generated DDL is replayable: applying it to shadow reproduces live', { timeout: 20000 }, async () => {
    const shadow = await boot(BASE)
    const live = await boot(BASE)
    await live.db.query(`create type kind as enum ('a','b')`)
    await live.db.query(`alter table posts add column k kind default 'a'`)
    await live.db.query(`create table tags (id serial primary key, label text unique)`)
    await live.db.query(`create index posts_title_idx on posts (title)`)

    const ddl = await diff(shadow, live)
    expect(ddl.length).toBeGreaterThan(0)
    // apply the diff to the shadow DB
    for (const stmt of ddl) await shadow.db.query(stmt)

    // now shadow should equal live — a re-diff must be empty
    const redX = await diff(shadow, live)
    expect(redX).toEqual([])
  })
})
