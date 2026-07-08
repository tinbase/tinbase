import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}
const received: Captured[] = []

// mock HTTP endpoint for pg_net delivery: records every request the worker sends
const netFetch: typeof fetch = async (input, init) => {
  received.push({
    url: input.toString(),
    method: (init?.method as string) ?? 'GET',
    headers: (init?.headers as Record<string, string>) ?? {},
    body: (init?.body as string) ?? null,
  })
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
}

let backend: TinbaseBackend
const wait = (ms = 900) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  backend = await createBackend({ netFetch })
})
afterAll(async () => {
  await backend.close()
})

describe('pg_net emulation (net.http_*)', () => {
  it('net.http_post enqueues, the worker sends it, and records the response', async () => {
    received.length = 0
    const r = await backend.db.query(
      `select net.http_post('https://api.test/hook', '{"event":"ping"}'::jsonb, '{}'::jsonb, '{"X-Custom":"1"}'::jsonb) as id`
    )
    const reqId = (r.rows[0] as any).id
    expect(typeof reqId).toBe('number')

    await wait()

    // the worker performed the HTTP call with body + headers
    expect(received).toHaveLength(1)
    expect(received[0].url).toBe('https://api.test/hook')
    expect(received[0].method).toBe('POST')
    expect(received[0].headers['Content-Type']).toBe('application/json')
    expect(received[0].headers['X-Custom']).toBe('1')
    expect(JSON.parse(received[0].body!)).toEqual({ event: 'ping' })

    // the response was recorded and the queue drained
    const resp = await backend.db.query(`select status_code from net._http_response where id = $1`, [reqId])
    expect((resp.rows[0] as any).status_code).toBe(200)
    const q = await backend.db.query(`select count(*)::int as n from net.http_request_queue where id = $1`, [reqId])
    expect((q.rows[0] as any).n).toBe(0)
  })

  it('net.http_get folds params into the query string and sends no body', async () => {
    received.length = 0
    await backend.db.query(`select net.http_get('https://api.test/search', '{"q":"tin"}'::jsonb)`)
    await wait()
    expect(received).toHaveLength(1)
    expect(received[0].method).toBe('GET')
    expect(received[0].url).toBe('https://api.test/search?q=tin')
    expect(received[0].body).toBeNull()
  })

  it('a cron job can call net.http_post (the Supabase cron → HTTP pattern)', async () => {
    received.length = 0
    await backend.db.query(
      `select cron.schedule('ping-hook', '1 seconds', $$ select net.http_post('https://api.test/cron', '{"from":"cron"}'::jsonb) $$)`
    )
    await wait(3000)
    await backend.db.query(`select cron.unschedule('ping-hook')`)

    const hits = received.filter((c) => c.url === 'https://api.test/cron')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(hits[0].body!)).toEqual({ from: 'cron' })
  }, 15000)
})
