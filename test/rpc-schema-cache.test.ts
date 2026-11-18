import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { testEngine } from './helpers.js'

/**
 * A VOLATILE function may run DDL, so REST used to drop every introspection cache after
 * each volatile RPC. Functions are volatile by default, so on a big schema every
 * `supabase.rpc()` made the next REST request re-run the information_schema
 * introspection: RingCode (649 migrations, 717 functions; 2026-11-19) waited ~42 s for a
 * one-row select after an RPC, and its dashboard sat on a spinner while its own RPCs kept
 * clearing the cache. The caches are now dropped only when the RPC actually changed the
 * schema (an event trigger bumps tinbase.ddl_epoch on DDL).
 */
const MIGRATION = `
create table notes (id serial primary key, body text);
grant select, insert, update, delete on notes to anon, authenticated;
grant usage, select on sequence notes_id_seq to anon, authenticated;

-- volatile (the default) and no DDL: the common case
create function touch_note(n int) returns int language sql as $$ update notes set body = body where id = n returning id $$;
-- volatile and DDL: adds a column the next REST request must see
create function add_flag() returns void language plpgsql security definer as $$ begin alter table notes add column flag boolean default true; end $$;
-- volatile and a trigger only (realtime installs these): no change to the REST shape
create function notes_noop() returns trigger language plpgsql as $$ begin return new; end $$;
create function add_note_trigger() returns void language plpgsql security definer as $$
begin create trigger notes_noop_tg before insert on notes for each row execute function notes_noop(); end $$;
-- volatile and DDL that removes things
create function drop_flag() returns void language plpgsql security definer as $$ begin alter table notes drop column flag; end $$;
create function make_tmp() returns void language plpgsql security definer as $$ begin create table tmp_t (id int primary key); end $$;
create function drop_tmp() returns void language plpgsql security definer as $$ begin drop table tmp_t; end $$;
-- volatile and DDL that changes nothing (the object exists)
create function ensure_notes() returns void language plpgsql security definer as $$ begin create table if not exists notes (id serial primary key); end $$;
grant execute on function touch_note(int), add_flag(), add_note_trigger(), drop_flag(), make_tmp(), drop_tmp(), ensure_notes() to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
`

let backend: TinbaseBackend
let introspections = 0

beforeAll(async () => {
  backend = await createBackend({
    engine: await testEngine(),
    migrations: [{ name: '20240101000000_rpc_cache', sql: MIGRATION }],
  })
  // count the column introspection getSchemaInfo runs on a cache miss
  const engine = backend.db.engine
  const query = engine.query.bind(engine)
  engine.query = ((sql: string, params?: unknown[]) => {
    if (/from information_schema\.columns/.test(sql)) introspections++
    return query(sql, params)
  }) as typeof engine.query
})

afterAll(async () => {
  await backend.close()
})

function rest(path: string, init: RequestInit = {}) {
  return backend.fetch(
    new Request(`http://localhost:54321/rest/v1/${path}`, {
      ...init,
      headers: { apikey: backend.anonKey, Authorization: `Bearer ${backend.anonKey}`, 'content-type': 'application/json' },
    })
  )
}
const rpc = (fn: string, body: object = {}) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) })

describe('volatile RPCs and the schema cache', () => {
  it('a volatile RPC that runs no DDL keeps the cache: the next select does not re-introspect', async () => {
    expect((await rest('notes', { method: 'POST', body: JSON.stringify({ body: 'a' }) })).status).toBe(201)
    expect((await rest('notes?select=id,body')).status).toBe(200)
    const before = introspections
    for (let i = 0; i < 3; i++) {
      expect((await rpc('touch_note', { n: 1 })).status).toBe(200)
      expect((await rest('notes?select=id,body')).status).toBe(200)
    }
    expect(introspections).toBe(before)
  })

  it('a volatile RPC that only creates a trigger keeps the cache too', async () => {
    const before = introspections
    expect((await rpc('add_note_trigger')).status).toBe(204)
    expect((await rest('notes?select=id,body')).status).toBe(200)
    expect(introspections).toBe(before)
  })

  it('a volatile RPC that runs DDL still refreshes the shape', async () => {
    expect((await rest('notes?select=flag')).status).toBe(400)
    expect((await rpc('add_flag')).status).toBe(204)
    const res = await rest('notes?select=id,flag')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 1, flag: true }])
  })

  it('a volatile RPC that drops a column or a table refreshes the shape', async () => {
    expect((await rpc('drop_flag')).status).toBe(204)
    expect((await rest('notes?select=flag')).status).toBe(400)
    expect((await rpc('make_tmp')).status).toBe(204)
    expect((await rest('tmp_t?select=id')).status).toBe(200)
    expect((await rpc('drop_tmp')).status).toBe(204)
    expect((await rest('tmp_t?select=id')).status).toBe(404)
  })

  it('an `if not exists` that changes nothing keeps the cache', async () => {
    expect((await rest('notes?select=id')).status).toBe(200)
    const before = introspections
    expect((await rpc('ensure_notes')).status).toBe(204)
    expect((await rest('notes?select=id')).status).toBe(200)
    expect(introspections).toBe(before)
  })
})

describe('without event triggers (pg-mem)', () => {
  it('a volatile RPC still drops the caches every time, as before', async () => {
    const { createPgmemEngine } = await import('../src/db/pgmem-engine.js')
    const { Database } = await import('../src/db/database.js')
    const db = await Database.create(await createPgmemEngine())
    await db.engine.exec('create table t (id int primary key)')
    await db.getSchemaInfo('public')
    let introspected = 0
    const query = db.engine.query.bind(db.engine)
    db.engine.query = ((sql: string, params?: unknown[]) => {
      if (/from information_schema\.columns/.test(sql)) introspected++
      return query(sql, params)
    }) as typeof db.engine.query
    await db.getSchemaInfo('public')
    expect(introspected).toBe(0)
    await db.invalidateIfSchemaChanged()
    await db.getSchemaInfo('public')
    expect(introspected).toBe(1)
    await db.engine.close()
  })
})
