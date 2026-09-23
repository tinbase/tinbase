/**
 * Parity scenarios: the same supabase-js programs we run against tinbase and,
 * when available, a real `supabase start`. Each scenario returns a plain result
 * object; the harness normalizes volatile values (ids, timestamps, tokens)
 * before comparing or asserting. `expect` is an optional self-check so the
 * harness produces a pass/fail scoreboard even without a real Supabase to diff.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface Scenario {
  name: string
  module: 'rest' | 'auth' | 'storage' | 'rpc' | 'realtime'
  run: (ctx: ScenarioCtx) => Promise<unknown>
  /** Self-check on the normalized result; return true if it looks correct. */
  expect?: (result: any) => boolean
  /**
   * Documented, intentional deviation from real Supabase — excluded from the
   * `--compare` conformance count (still self-scored). Use sparingly, and only
   * for choices recorded in the scope section of the README/ROADMAP.
   */
  tinbaseOnly?: boolean
}

export interface ScenarioCtx {
  anon: SupabaseClient
  service: SupabaseClient
  /** unique-ish suffix so repeated runs don't collide on unique columns */
  tag: string
}

const ok = (r: any) => !r?.error

export const SCENARIOS: Scenario[] = [
  // ── REST ──
  {
    name: 'select all posts',
    module: 'rest',
    run: async ({ anon }) => anon.from('posts').select('id,title,published').order('id'),
    expect: (r) => ok(r) && Array.isArray(r.data) && r.data.length >= 2,
  },
  {
    name: 'filter eq + gt',
    module: 'rest',
    run: async ({ anon }) => anon.from('posts').select('title').eq('published', true).gt('views', 10),
    expect: (r) => ok(r) && r.data.length === 1,
  },
  {
    name: 'or filter',
    module: 'rest',
    run: async ({ anon }) => anon.from('posts').select('title').or('views.gt.90,title.eq.Second'),
    expect: (r) => ok(r) && r.data.length === 2,
  },
  {
    name: 'array contains',
    module: 'rest',
    run: async ({ anon }) => anon.from('posts').select('title').contains('tags', ['b']),
    expect: (r) => ok(r) && r.data.length === 2,
  },
  {
    name: 'to-one embed',
    module: 'rest',
    run: async ({ anon }) => anon.from('posts').select('title, authors(name)').eq('id', 1).single(),
    expect: (r) => ok(r) && r.data?.authors?.name === 'Ada',
  },
  {
    name: 'to-many embed',
    module: 'rest',
    run: async ({ anon }) => anon.from('authors').select('name, posts(title)').eq('id', 1).single(),
    expect: (r) => ok(r) && Array.isArray(r.data?.posts),
  },
  {
    name: 'count exact head',
    module: 'rest',
    run: async ({ anon }) => {
      const { count, error } = await anon.from('posts').select('*', { count: 'exact', head: true })
      return { count, error }
    },
    expect: (r) => ok(r) && r.count >= 2,
  },
  {
    name: 'insert + delete roundtrip',
    module: 'rest',
    run: async ({ service, tag }) => {
      const ins = await service.from('authors').insert({ name: `p-${tag}`, email: `p-${tag}@x.com` }).select().single()
      const del = await service.from('authors').delete().eq('id', (ins.data as any)?.id).select()
      return { inserted: !!ins.data, deleted: del.data?.length, error: ins.error || del.error }
    },
    expect: (r) => ok(r) && r.inserted && r.deleted === 1,
  },
  {
    name: 'mutation representation with inner embed',
    module: 'rest',
    run: async ({ service, tag }) => {
      const title = `inner-${tag}`
      const inserted = await service.from('posts').insert([
        { title: `${title}-matched`, author_id: 1 },
        { title: `${title}-unmatched`, author_id: null },
      ]).select('id')
      if (inserted.error || !inserted.data) return { error: inserted.error }
      const ids = inserted.data.map((row: { id: number }) => row.id)
      const updated = await service.from('posts').update({ body: title }, { count: 'exact' }).in('id', ids)
        .select('title,author:authors!inner(name)').eq('author.name', 'Ada')
      const persisted = await service.from('posts').select('title,body').in('id', ids).order('title')
      await service.from('posts').delete().in('id', ids)
      return { returned: updated.data?.map((row: { title: string }) => row.title), count: updated.count,
        persisted: persisted.data, error: updated.error || persisted.error }
    },
    expect: (r) => ok(r) && r.count === 1 && r.returned?.length === 1 && r.returned[0]?.endsWith('-matched') &&
      r.persisted?.length === 2 &&
      r.persisted.every((row: { title: string; body: string | null }) => row.body && row.title.startsWith(row.body)),
  },
  {
    name: 'singular mutation with empty inner representation rolls back',
    module: 'rest',
    run: async ({ service, tag }) => {
      const title = `inner-single-${tag}`
      const inserted = await service.from('posts').insert({ title, author_id: null }).select('id').single()
      if (inserted.error || !inserted.data) return { error: inserted.error }
      const id = (inserted.data as { id: number }).id
      const updated = await service.from('posts').update({ body: title }).eq('id', id)
        .select('title,author:authors!inner(name)').single()
      const persisted = await service.from('posts').select('body').eq('id', id).single()
      await service.from('posts').delete().eq('id', id)
      return { code: updated.error?.code, body: (persisted.data as { body: string | null } | null)?.body,
        error: persisted.error }
    },
    expect: (r) => ok(r) && r.code === 'PGRST116' && r.body === null,
  },
  {
    name: 'unique violation error code',
    module: 'rest',
    run: async ({ service }) => service.from('authors').insert({ name: 'dup', email: 'ada@example.com' }),
    expect: (r) => r.error?.code === '23505',
  },

  {
    name: 'unexposed schema rejected for anon',
    module: 'rest',
    run: async ({ anon }) => anon.schema('auth' as any).from('users').select('id'),
    // PostgREST db-schemas: anon can only reach exposed schemas (default: public)
    expect: (r) => r.error?.code === 'PGRST106',
  },
  {
    name: 'service_role bypasses schema allowlist',
    module: 'rest',
    // tinbase fuses pg-meta into REST, so the service_role key passes the schema
    // profile gate that anon hits PGRST106 on (real PostgREST 406s everyone).
    // Documented scope choice. Past the gate, normal grants still apply — so a
    // grant-less table yields 42501, NOT the allowlist's PGRST106.
    tinbaseOnly: true,
    run: async ({ service }) => service.schema('storage' as any).from('buckets').select('id').limit(1),
    expect: (r) => ok(r) && Array.isArray(r.data),
  },

  // ── RPC ──
  {
    name: 'rpc scalar',
    module: 'rpc',
    run: async ({ anon }) => anon.rpc('add_two', { a: 40, b: 2 }),
    expect: (r) => ok(r) && r.data === 42,
  },

  // ── Auth ──
  {
    name: 'signup returns session',
    module: 'auth',
    run: async ({ anon, tag }) => {
      const r = await anon.auth.signUp({ email: `u-${tag}@example.com`, password: 'password123' })
      return { hasToken: !!r.data.session?.access_token, email: r.data.user?.email, error: r.error }
    },
    expect: (r) => ok(r) && r.hasToken,
  },
  {
    name: 'signin wrong password rejected',
    module: 'auth',
    run: async ({ anon, tag }) => {
      await anon.auth.signUp({ email: `w-${tag}@example.com`, password: 'password123' })
      await anon.auth.signOut()
      return anon.auth.signInWithPassword({ email: `w-${tag}@example.com`, password: 'nope' })
    },
    expect: (r) => !!r.error,
  },
  {
    name: 'RLS isolates rows between users',
    module: 'auth',
    run: async ({ anon, service, tag }) => {
      await anon.auth.signUp({ email: `a-${tag}@example.com`, password: 'password123' })
      await anon.from('notes').insert({ content: 'secret' })
      await anon.auth.signOut()
      await anon.auth.signUp({ email: `b-${tag}@example.com`, password: 'password123' })
      const asB = await anon.from('notes').select()
      await anon.auth.signOut()
      const asService = await service.from('notes').select()
      return { bSees: asB.data?.length, serviceSees: (asService.data?.length ?? 0) >= 1, error: asB.error }
    },
    expect: (r) => ok(r) && r.bSees === 0 && r.serviceSees,
  },

  // ── Storage ──
  {
    name: 'bucket + upload + download',
    module: 'storage',
    run: async ({ service, tag }) => {
      const bucket = `b${tag}`
      await service.storage.createBucket(bucket, { public: true })
      const up = await service.storage.from(bucket).upload('hello.txt', new Blob(['hi'], { type: 'text/plain' }))
      const down = await service.storage.from(bucket).download('hello.txt')
      const text = down.data ? await down.data.text() : null
      return { uploaded: !!up.data, text, error: up.error || down.error }
    },
    expect: (r) => ok(r) && r.uploaded && r.text === 'hi',
  },
]
