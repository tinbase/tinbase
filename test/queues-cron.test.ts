import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, cronMatches, CronService, type TinbaseBackend } from '../src/index.js'

let backend: TinbaseBackend
let supabase: ReturnType<typeof createClient>

beforeAll(async () => {
  backend = await createBackend({})
  supabase = createClient('http://localhost:54321', backend.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
  })
})
afterAll(async () => {
  await backend.close()
})

describe('pgmq queues (via supabase-js rpc)', () => {
  it('send → read → delete roundtrip', async () => {
    await supabase.schema('pgmq').rpc('create', { queue_name: 'jobs' })
    const sent = await supabase.schema('pgmq').rpc('send', { queue_name: 'jobs', msg: { task: 'email', to: 'a@b.com' } })
    expect(sent.error).toBeNull()
    expect(typeof sent.data).toBe('number')

    const read = await supabase.schema('pgmq').rpc('read', { queue_name: 'jobs', vt: 30, qty: 5 })
    expect(read.error).toBeNull()
    expect((read.data as any[]).length).toBe(1)
    const m = (read.data as any[])[0]
    expect(m.message).toEqual({ task: 'email', to: 'a@b.com' })
    expect(m.read_ct).toBe(1)

    const del = await supabase.schema('pgmq').rpc('delete', { queue_name: 'jobs', msg_id: m.msg_id })
    expect(del.data).toBe(true)
  })

  it('read respects visibility timeout (message hidden after read)', async () => {
    await supabase.schema('pgmq').rpc('send', { queue_name: 'jobs', msg: { n: 1 } })
    const first = await supabase.schema('pgmq').rpc('read', { queue_name: 'jobs', vt: 30, qty: 10 })
    expect((first.data as any[]).length).toBe(1)
    // immediately reading again sees nothing (still within the 30s vt)
    const second = await supabase.schema('pgmq').rpc('read', { queue_name: 'jobs', vt: 30, qty: 10 })
    expect((second.data as any[]).length).toBe(0)
  })

  it('pop reads and removes in one call; archive moves to the archive table', async () => {
    await supabase.schema('pgmq').rpc('create', { queue_name: 'q2' })
    const id = (await supabase.schema('pgmq').rpc('send', { queue_name: 'q2', msg: { x: 1 } })).data
    const popped = await supabase.schema('pgmq').rpc('pop', { queue_name: 'q2' })
    expect((popped.data as any[])[0].message).toEqual({ x: 1 })

    const id2 = (await supabase.schema('pgmq').rpc('send', { queue_name: 'q2', msg: { y: 2 } })).data
    const arch = await supabase.schema('pgmq').rpc('archive', { queue_name: 'q2', msg_id: id2 })
    expect(arch.data).toBe(true)
    const inArchive = await backend.db.query(`select * from pgmq.a_q2 where msg_id = $1`, [id2])
    expect(inArchive.rows.length).toBe(1)
    void id
  })
})

describe('cron', () => {
  it('cron.schedule() records a job that migrations/SQL can call', async () => {
    const r = await backend.db.query(`select cron.schedule('nightly', '0 0 * * *', 'select 1') as id`)
    expect(typeof (r.rows[0] as any).id).toBe('number')
    const jobs = await backend.db.query(`select jobname, schedule from cron.job where jobname = 'nightly'`)
    expect((jobs.rows[0] as any).schedule).toBe('0 0 * * *')
    await backend.db.query(`select cron.unschedule('nightly')`)
    const after = await backend.db.query(`select 1 from cron.job where jobname = 'nightly'`)
    expect(after.rows.length).toBe(0)
  })

  it('cronMatches handles *, ranges, lists, and steps (in UTC)', () => {
    // built in UTC — cron fields are matched in UTC to mirror hosted pg_cron
    const at = (m: number, h: number, dom = 1, mon = 1, dow = 1) => new Date(Date.UTC(2026, mon - 1, dom, h, m))
    expect(cronMatches('* * * * *', at(37, 9))).toBe(true)
    expect(cronMatches('0 0 * * *', at(0, 0))).toBe(true)
    expect(cronMatches('0 0 * * *', at(1, 0))).toBe(false)
    expect(cronMatches('*/15 * * * *', at(30, 9))).toBe(true)
    expect(cronMatches('*/15 * * * *', at(31, 9))).toBe(false)
    expect(cronMatches('0 9-17 * * *', at(0, 13))).toBe(true)
    expect(cronMatches('0 9-17 * * *', at(0, 20))).toBe(false)
    expect(cronMatches('0 0,12 * * *', at(0, 12))).toBe(true)
  })

  it("runs a due 'N seconds' job and logs it", async () => {
    // dedicated backend with a fast-ticking cron and a job that writes a row
    const b = await createBackend({ migrations: [{ name: '20240101_c', sql: 'create table cron_hits (at timestamptz default now())' }] })
    try {
      await b.db.query(`select cron.schedule('ping', '1 seconds', 'insert into cron_hits default values')`)
      await new Promise((r) => setTimeout(r, 2500))
      const hits = await b.db.query(`select count(*)::int as n from cron_hits`)
      expect((hits.rows[0] as any).n).toBeGreaterThanOrEqual(1)
      const runs = await b.db.query(`select status from cron.job_run_details order by runid desc limit 1`)
      expect((runs.rows[0] as any).status).toBe('succeeded')
    } finally {
      await b.close()
    }
  }, 15000)

  it("throttles a '0 seconds' job to at most once per second (no busy loop)", async () => {
    const b = await createBackend({ migrations: [{ name: '20240101_z', sql: 'create table zhits (at timestamptz default now())' }] })
    try {
      // drive the scheduler with a controllable clock instead of the real timer
      let t = new Date('2024-01-01T00:00:00Z').getTime()
      const svc = new CronService(b.db, 1000, () => new Date(t))
      await b.db.query(`select cron.schedule('busy', '0 seconds', 'insert into zhits default values')`)
      await svc.tick() // t=0     → runs
      t += 500
      await svc.tick() // t=500ms → must NOT run (interval floored to 1s)
      const n1 = await b.db.query(`select count(*)::int as n from zhits`)
      expect((n1.rows[0] as any).n).toBe(1)
      t += 600
      await svc.tick() // t=1100ms → runs again
      const n2 = await b.db.query(`select count(*)::int as n from zhits`)
      expect((n2.rows[0] as any).n).toBe(2)
    } finally {
      await b.close()
    }
  }, 15000)
})
