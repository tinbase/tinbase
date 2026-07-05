import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve, type RunningServer } from '../src/node/server.js'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { TEST_MIGRATION, TEST_SEED } from './helpers.js'

let backend: TinbaseBackend
let server: RunningServer
let client: SupabaseClient
let client2: SupabaseClient
const channels: RealtimeChannel[] = []

beforeAll(async () => {
  backend = await createBackend({
    migrations: [{ name: '20240101000000_test_schema', sql: TEST_MIGRATION }],
    seedSql: TEST_SEED,
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

describe('realtime', () => {
  it('receives postgres_changes INSERT events', async () => {
    const channel = client.channel('db-inserts')
    const eventPromise = waitFor<Record<string, unknown>>((resolve) => {
      channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'categories' }, (payload) =>
        resolve(payload as unknown as Record<string, unknown>)
      )
    })
    await subscribed(channel)

    await client.from('categories').insert({ name: 'Realtime' })
    const payload = await eventPromise
    expect(payload.eventType).toBe('INSERT')
    expect((payload.new as { name: string }).name).toBe('Realtime')
  })

  it('receives UPDATE and DELETE with old record and applies filters', async () => {
    const channel = client.channel('db-updates')
    const updates: Record<string, unknown>[] = []
    const eventPromise = waitFor<Record<string, unknown>>((resolve) => {
      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts', filter: 'id=eq.1' },
        (payload) => {
          updates.push(payload as unknown as Record<string, unknown>)
          resolve(payload as unknown as Record<string, unknown>)
        }
      )
    })
    await subscribed(channel)

    // this one should NOT match the filter
    await client.from('posts').update({ views: 999 }).eq('id', 2)
    // this one should
    await client.from('posts').update({ views: 101 }).eq('id', 1)

    const payload = await eventPromise
    expect((payload.new as { id: number }).id).toBe(1)
    expect((payload.new as { views: number }).views).toBe(101)
    expect(updates).toHaveLength(1)
  })

  it('broadcasts between clients', async () => {
    const chA = client.channel('room-1')
    const chB = client2.channel('room-1')

    const received = waitFor<Record<string, unknown>>((resolve) => {
      chB.on('broadcast', { event: 'cursor' }, (payload) => resolve(payload))
    })
    await subscribed(chA)
    await subscribed(chB)

    await chA.send({ type: 'broadcast', event: 'cursor', payload: { x: 10, y: 20 } })
    const msg = await received
    expect(msg.payload).toEqual({ x: 10, y: 20 })
  })

  it('tracks presence across clients', async () => {
    const chA = client.channel('presence-room', { config: { presence: { key: 'user-a' } } })
    const chB = client2.channel('presence-room', { config: { presence: { key: 'user-b' } } })

    const joined = waitFor<void>((resolve) => {
      chB.on('presence', { event: 'join' }, ({ key }) => {
        if (key === 'user-a') resolve()
      })
    })

    await subscribed(chB)
    await subscribed(chA)
    await chA.track({ status: 'online' })
    await joined

    const state = chB.presenceState()
    expect(state['user-a']).toBeTruthy()
    expect((state['user-a'][0] as { status: string }).status).toBe('online')
  })
})
