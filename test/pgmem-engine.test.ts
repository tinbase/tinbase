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

  it('email/password auth works', async () => {
    const { data, error } = await supabase.auth.signUp({ email: 'pm@example.com', password: 'password123' })
    expect(error).toBeNull()
    expect(data.session?.access_token).toBeTruthy()
  })
})
