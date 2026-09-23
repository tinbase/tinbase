import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, createPgmemEngine, type TinbaseBackend } from '../src/index.js'

/**
 * pg-mem is the ultralight in-memory subset engine (local dev / preview). It
 * runs the REST CRUD surface + email/password auth; RLS/realtime/functions are
 * intentionally absent. A real-ish migration's RLS DDL is tolerated (skipped),
 * not fatal.
 */
const MIGRATION = `
create table todos (
  id uuid primary key default gen_random_uuid(),
  owner uuid,
  title text not null,
  done boolean default false,
  tags text[] default '{}',
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
-- these are unsupported by pg-mem and must be skipped, not crash the migration
alter table todos enable row level security;
create policy own on todos for all to authenticated using (owner = auth.uid());

-- numeric/int8 vs text: pg-mem hands numeric and int8 back as strings (the
-- node-postgres convention); the REST layer must re-serialize them as JSON
-- numbers the way PostgREST does, while leaving numeric-LOOKING text alone.
create table athletes (
  id text primary key,
  name text,
  score numeric,
  scouts int8,
  zip text
);
create table sessions (
  id text primary key,
  athlete_id text references athletes(id),
  velocity numeric
);
-- Seeded via SQL literals, like a project's seed.sql: THIS is the path where
-- pg-mem produces numeric-as-string. Rows inserted through the REST API keep
-- their JSON-number values, so they can't catch the regression on their own.
insert into athletes (id, name, score, scouts, zip)
values ('seeded', 'From Seed', 97.1, 21, '02134');
`

let backend: TinbaseBackend
let supabase: ReturnType<typeof createClient>

beforeAll(async () => {
  const engine = await createPgmemEngine()
  backend = await createBackend({ engine, migrations: [{ name: '20240101_todos', sql: MIGRATION }] })
  supabase = createClient('http://localhost:54321', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
  })
})

afterAll(async () => {
  await backend.close()
})

describe('pg-mem engine (lite / preview)', () => {
  it('is a minimal-bootstrap engine', () => {
    expect(backend.db.engine.minimalBootstrap).toBe(true)
  })

  it('tolerates a migration with RLS DDL (skips it, applies the table)', async () => {
    const { error } = await supabase.from('todos').select()
    expect(error).toBeNull() // table exists → migration applied despite RLS lines
  })

  it('insert with array + jsonb, read back correctly', async () => {
    const { data, error } = await supabase
      .from('todos')
      .insert({ title: 'first', tags: ['a', 'b'], meta: { k: 1 } })
      .select()
      .single()
    expect(error).toBeNull()
    expect((data as any).id).toMatch(/^[0-9a-f-]{36}$/)
    expect((data as any).tags).toEqual(['a', 'b'])
    expect((data as any).meta).toEqual({ k: 1 })
  })

  it('select with filter, order, limit, count', async () => {
    await supabase.from('todos').insert([{ title: 'b' }, { title: 'c', done: true }])
    const filtered = await supabase.from('todos').select().eq('done', true)
    expect(filtered.error).toBeNull()
    expect(filtered.data!.length).toBe(1)

    const ordered = await supabase.from('todos').select('title').order('title').limit(1)
    expect((ordered.data![0] as any).title).toBe('b')

    const { count } = await supabase.from('todos').select('*', { count: 'exact', head: true })
    expect(count).toBeGreaterThanOrEqual(3)
  })

  it('update and delete (no-alias SQL path)', async () => {
    const upd = await supabase.from('todos').update({ done: true }).eq('title', 'first').select()
    expect(upd.error).toBeNull()
    expect((upd.data![0] as any).done).toBe(true)

    const del = await supabase.from('todos').delete().eq('title', 'first').select()
    expect(del.error).toBeNull()
    expect(del.data!.length).toBe(1)
  })

  it('keeps CDC events for mutations hidden by an inner embed', async () => {
    const events: string[] = []
    const unsubscribe = await backend.db.onCdcEvent((event) => {
      if (event.table === 'sessions') events.push(`${event.type}:${event.record?.id ?? event.old_record?.id}`)
    })
    try {
      const result = await supabase.from('sessions').insert([
        { id: 'matched', athlete_id: 'seeded', velocity: 1 },
        { id: 'unmatched', athlete_id: null, velocity: 2 },
      ]).select('id,athlete:athletes!inner(name)')
      expect(result.error).toBeNull()
      expect(result.data).toEqual([{ id: 'matched', athlete: { name: 'From Seed' } }])
      expect(events).toEqual(['INSERT:matched', 'INSERT:unmatched'])
      events.length = 0

      const updated = await supabase.from('sessions').update({ velocity: 3 })
        .in('id', ['matched', 'unmatched']).select('id,athlete:athletes!inner(name)')
      expect(updated.error).toBeNull()
      expect(updated.data).toEqual([{ id: 'matched', athlete: { name: 'From Seed' } }])
      expect(events).toEqual(['UPDATE:matched', 'UPDATE:unmatched'])
      events.length = 0

      const deleted = await supabase.from('sessions').delete()
        .in('id', ['matched', 'unmatched']).select('id,athlete:athletes!inner(name)')
      expect(deleted.error).toBeNull()
      expect(deleted.data).toEqual([{ id: 'matched', athlete: { name: 'From Seed' } }])
      expect(events).toEqual(['DELETE:matched', 'DELETE:unmatched'])
    } finally {
      unsubscribe()
    }
  })

  it('email/password auth works', async () => {
    const { data, error } = await supabase.auth.signUp({ email: 'pm@example.com', password: 'password123' })
    expect(error).toBeNull()
    expect(data.session?.access_token).toBeTruthy()
  })

  // Regression: numeric/int8 came back as strings ("98.4"), so app code doing
  // `athlete.score.toFixed(1)` crashed in preview while working on Supabase.
  describe('numeric JSON serialization (PostgREST parity)', () => {
    it('read returns numeric and int8 as JSON numbers, numeric-looking text as string', async () => {
      await supabase
        .from('athletes')
        .insert({ id: 'a1', name: 'Marcus', score: 98.4, scouts: 14, zip: '02134' })
      const { data, error } = await supabase.from('athletes').select().eq('id', 'a1').single()
      expect(error).toBeNull()
      expect((data as any).score).toBe(98.4)
      expect((data as any).scouts).toBe(14)
      expect((data as any).zip).toBe('02134') // text stays text
    })

    it('SQL-seeded rows (the seed.sql path) read back as numbers', async () => {
      const { data, error } = await supabase.from('athletes').select().eq('id', 'seeded').single()
      expect(error).toBeNull()
      expect((data as any).score).toBe(97.1)
      expect((data as any).scouts).toBe(21)
      expect((data as any).zip).toBe('02134')
    })

    it('mutation echo (insert ... select) returns numbers', async () => {
      const { data, error } = await supabase
        .from('athletes')
        .insert({ id: 'a2', name: 'Jae', score: 91.2, scouts: 7 })
        .select()
        .single()
      expect(error).toBeNull()
      expect((data as any).score).toBe(91.2)
      expect((data as any).scouts).toBe(7)
    })

    // The recursive case (numeric inside an embedded relation) is now covered in
    // @tinbase/pg-mem, whose json builders do the conversion: it has a nested
    // row_to_json/json_agg test. It can't be driven end-to-end from here anyway,
    // since embedded reads don't run on pg-mem yet - the builder's correlated
    // lateral subquery trips "Unknown alias" in the engine. FK *introspection*
    // does work; the remaining failure is SQL execution.
  })
})
