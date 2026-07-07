import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve, type RunningServer } from '../src/node/server.js'
import { createBackend, type TinbaseBackend } from '../src/index.js'

const MIGRATION = `
create table notes (
  id uuid primary key default gen_random_uuid(),
  owner uuid default auth.uid(),
  content text
);
alter table notes enable row level security;
create policy notes_owner on notes for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

create table public_feed (id serial primary key, msg text);
`

let backend: TinbaseBackend
let server: RunningServer
const opened: RealtimeChannel[] = []
const clients: SupabaseClient[] = []

function mkClient(): SupabaseClient {
  const c = createClient(server.url, backend.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  clients.push(c)
  return c
}

function subscribed(ch: RealtimeChannel): Promise<void> {
  opened.push(ch)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('subscribe timeout')), 5000)
    ch.subscribe((s, err) => {
      if (s === 'SUBSCRIBED') { clearTimeout(t); resolve() }
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { clearTimeout(t); reject(err ?? new Error(s)) }
    })
  })
}

beforeAll(async () => {
  backend = await createBackend({ migrations: [{ name: '20240101000000_rls', sql: MIGRATION }] })
  server = await serve(backend, { port: 0 })
})

afterAll(async () => {
  for (const ch of opened) await ch.unsubscribe().catch(() => {})
  for (const c of clients) c.realtime.disconnect()
  await server.close()
  await backend.close()
})

describe('realtime RLS filtering', () => {
  it("a user does not receive INSERT events for another user's private rows", async () => {
    const alice = mkClient()
    const bob = mkClient()
    await alice.auth.signUp({ email: `a-${Date.now()}@x.com`, password: 'password123' })
    await bob.auth.signUp({ email: `b-${Date.now()}@x.com`, password: 'password123' })

    // Bob subscribes to notes changes with his user token
    const bobEvents: any[] = []
    const bobCh = bob.channel('notes-bob')
    bobCh.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notes' }, (p) => bobEvents.push(p.new))
    await subscribed(bobCh)

    // Alice inserts a private note (owner = alice via auth.uid())
    const ins = await alice.from('notes').insert({ content: 'alice secret' }).select().single()
    expect(ins.error).toBeNull()

    await new Promise((r) => setTimeout(r, 700))
    // Bob must NOT have received Alice's row
    expect(bobEvents).toHaveLength(0)

    await alice.auth.signOut()
    await bob.auth.signOut()
  })

  it('a user DOES receive INSERT events for their own rows', async () => {
    const alice = mkClient()
    await alice.auth.signUp({ email: `own-${Date.now()}@x.com`, password: 'password123' })

    const events: any[] = []
    const ch = alice.channel('notes-own')
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notes' }, (p) => events.push(p.new))
    await subscribed(ch)

    await alice.from('notes').insert({ content: 'my own note' })
    await new Promise((r) => setTimeout(r, 700))
    expect(events.length).toBe(1)
    expect(events[0].content).toBe('my own note')
    await alice.auth.signOut()
  })

  it('non-RLS tables still broadcast to everyone (anon included)', async () => {
    const anon = mkClient()
    const events: any[] = []
    const ch = anon.channel('feed')
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'public_feed' }, (p) => events.push(p.new))
    await subscribed(ch)

    await backend.db.query(`insert into public_feed (msg) values ('hello all')`)
    await new Promise((r) => setTimeout(r, 700))
    expect(events.length).toBe(1)
  })
})
