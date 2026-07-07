import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, createPgmemEngine, type TinbaseBackend } from '../src/index.js'
import { serve, type RunningServer } from '../src/node/server.js'

/**
 * The pg-mem engine has no triggers or LISTEN/NOTIFY, so realtime
 * `postgres_changes` and database webhooks are driven by change events the REST
 * layer synthesizes in JS (every write goes through it in-process). Edge
 * functions and broadcast/presence are engine-independent and work as-is.
 *
 * Fidelity notes for this engine (no RLS, JS-synthesized CDC):
 *  - events are delivered unfiltered (no per-subscriber RLS check)
 *  - UPDATE carries the new record; old_record is null (RETURNING gives NEW only)
 *  - DELETE carries the deleted row as old_record
 */
const MIGRATION = `create table notes (id serial primary key, body text, done boolean default false);`

interface Captured {
  url: string
  body: any
}
const received: Captured[] = []
const webhookFetch: typeof fetch = async (input, init) => {
  received.push({ url: input.toString(), body: JSON.parse((init?.body as string) ?? '{}') })
  return new Response('ok', { status: 200 })
}

let backend: TinbaseBackend
let server: RunningServer
let client: SupabaseClient
let client2: SupabaseClient
const channels: RealtimeChannel[] = []
const wait = (ms = 500) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  const engine = await createPgmemEngine()
  backend = await createBackend({
    engine,
    migrations: [{ name: '20240101_notes', sql: MIGRATION }],
    functions: {
      hello: () =>
        new Response(JSON.stringify({ ok: true, from: 'pgmem' }), {
          headers: { 'content-type': 'application/json' },
        }),
    },
    webhookFetch,
    webhooks: [{ table: 'notes', url: 'https://hooks.test/notes' }],
  })
  server = await serve(backend, { port: 0 })
  const opts = { auth: { persistSession: false, autoRefreshToken: false } }
  client = createClient(server.url, backend.anonKey, opts)
  client2 = createClient(server.url, backend.anonKey, opts)
})

afterAll(async () => {
  for (const ch of channels) await ch.unsubscribe().catch(() => {})
  client.realtime.disconnect()
  client2.realtime.disconnect()
  await server.close()
  await backend.close()
})

function subscribed(channel: RealtimeChannel): Promise<void> {
  channels.push(channel)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe timeout')), 5000)
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer)
        resolve()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timer)
        reject(err ?? new Error(status))
      }
    })
  })
}

function waitFor<T>(setup: (resolve: (v: T) => void) => void, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('event timeout')), ms)
    setup((v) => {
      clearTimeout(timer)
      resolve(v)
    })
  })
}

describe('pg-mem: functions, realtime & webhooks', () => {
  it('invokes an edge function', async () => {
    const { data, error } = await client.functions.invoke('hello')
    expect(error).toBeNull()
    expect((data as any).ok).toBe(true)
    expect((data as any).from).toBe('pgmem')
  })

  it('receives postgres_changes INSERT (JS-synthesized)', async () => {
    const channel = client.channel('notes-inserts')
    const evt = waitFor<Record<string, unknown>>((resolve) => {
      channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notes' }, (p) =>
        resolve(p as unknown as Record<string, unknown>)
      )
    })
    await subscribed(channel)
    await client.from('notes').insert({ body: 'hello realtime' })
    const payload = await evt
    expect(payload.eventType).toBe('INSERT')
    expect((payload.new as { body: string }).body).toBe('hello realtime')
  })

  it('receives postgres_changes DELETE with the deleted row', async () => {
    const ins = await client.from('notes').insert({ body: 'to delete' }).select().single()
    const id = (ins.data as any).id
    const channel = client.channel('notes-deletes')
    const evt = waitFor<Record<string, unknown>>((resolve) => {
      channel.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'notes' }, (p) =>
        resolve(p as unknown as Record<string, unknown>)
      )
    })
    await subscribed(channel)
    await client.from('notes').delete().eq('id', id)
    const payload = await evt
    expect(payload.eventType).toBe('DELETE')
    expect((payload.old as { id: number }).id).toBe(id)
  })

  it('delivers broadcast between two clients', async () => {
    const recv = client2.channel('room', { config: { broadcast: { self: false } } })
    const got = waitFor<any>((resolve) => {
      recv.on('broadcast', { event: 'ping' }, (p) => resolve(p))
    })
    await subscribed(recv)
    const send = client.channel('room')
    await subscribed(send)
    await send.send({ type: 'broadcast', event: 'ping', payload: { n: 1 } })
    const msg = await got
    expect(msg.payload.n).toBe(1)
  })

  it('fires a database webhook on INSERT', async () => {
    received.length = 0
    await client.from('notes').insert({ body: 'webhook row' })
    await wait()
    const hook = received.find((r) => r.body.type === 'INSERT' && r.body.record?.body === 'webhook row')
    expect(hook).toBeTruthy()
    expect(hook!.url).toBe('https://hooks.test/notes')
    expect(hook!.body.table).toBe('notes')
    expect(hook!.body.old_record).toBeNull()
  })
})
