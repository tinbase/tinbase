import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

describe('select', () => {
  it('selects all rows', async () => {
    const { data, error } = await env.supabase.from('posts').select()
    expect(error).toBeNull()
    expect(data).toHaveLength(4)
  })

  it('selects specific columns with aliases and casts', async () => {
    const { data, error } = await env.supabase.from('posts').select('heading:title, views::text').limit(1)
    expect(error).toBeNull()
    expect(data![0]).toHaveProperty('heading')
    expect(typeof (data![0] as Record<string, unknown>).views).toBe('string')
  })

  it('filters: eq, neq, gt, in, like, or', async () => {
    const eq = await env.supabase.from('posts').select().eq('published', true)
    expect(eq.data).toHaveLength(3)

    const gt = await env.supabase.from('posts').select().gt('views', 90)
    expect(gt.data).toHaveLength(2)

    const inq = await env.supabase.from('posts').select().in('id', [1, 3])
    expect(inq.data).toHaveLength(2)

    const like = await env.supabase.from('posts').select().ilike('title', '%git%')
    expect(like.data).toHaveLength(1)

    const or = await env.supabase.from('posts').select().or('views.gt.200,title.eq.COBOL at Scale')
    expect(or.data).toHaveLength(2)
  })

  it('filters on array and jsonb columns', async () => {
    const cs = await env.supabase.from('posts').select().contains('tags', ['unix'])
    expect(cs.data).toHaveLength(2)

    const json = await env.supabase.from('authors').select().eq('meta->>country', 'FI')
    expect(json.data).toHaveLength(1)
    expect((json.data![0] as { name: string }).name).toBe('Linus')
  })

  it('negated filters', async () => {
    const { data } = await env.supabase.from('posts').select().not('published', 'eq', true)
    expect(data).toHaveLength(1)
  })

  it('full text search', async () => {
    const { data, error } = await env.supabase.from('posts').select().textSearch('search', 'plumbing', {
      type: 'plain',
      config: 'english',
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('order, limit, offset, range', async () => {
    const { data } = await env.supabase.from('posts').select('title').order('views', { ascending: false }).limit(2)
    expect((data![0] as { title: string }).title).toBe('Git Internals')

    const ranged = await env.supabase.from('posts').select('id').order('id').range(1, 2)
    expect(ranged.data!.map((r) => (r as { id: number }).id)).toEqual([2, 3])
  })

  it('single and maybeSingle', async () => {
    const single = await env.supabase.from('posts').select().eq('id', 1).single()
    expect(single.error).toBeNull()
    expect((single.data as { title: string }).title).toBe('Analytical Engines')

    const none = await env.supabase.from('posts').select().eq('id', 999).maybeSingle()
    expect(none.error).toBeNull()
    expect(none.data).toBeNull()

    const multi = await env.supabase.from('posts').select().maybeSingle()
    expect(multi.error).not.toBeNull()
  })

  it('count exact', async () => {
    const { count, data } = await env.supabase.from('posts').select('*', { count: 'exact' }).limit(1)
    expect(count).toBe(4)
    expect(data).toHaveLength(1)

    const headOnly = await env.supabase.from('posts').select('*', { count: 'exact', head: true })
    expect(headOnly.count).toBe(4)
    expect(headOnly.data).toBeNull()
  })
})

describe('embedded resources', () => {
  it('to-one embed', async () => {
    const { data, error } = await env.supabase.from('posts').select('title, authors(name, email)').eq('id', 2).single()
    expect(error).toBeNull()
    expect((data as { authors: { name: string } }).authors.name).toBe('Linus')
  })

  it('to-one embed with alias', async () => {
    const { data } = await env.supabase.from('posts').select('title, author:authors(name)').eq('id', 1).single()
    expect((data as { author: { name: string } }).author.name).toBe('Ada')
  })

  it('to-many embed', async () => {
    const { data } = await env.supabase.from('authors').select('name, posts(title)').eq('id', 2).single()
    const posts = (data as { posts: { title: string }[] }).posts
    expect(posts).toHaveLength(2)
  })

  it('to-many embed with order and limit', async () => {
    const { data } = await env.supabase
      .from('authors')
      .select('name, posts(title, views)')
      .eq('id', 2)
      .order('views', { ascending: false, referencedTable: 'posts' })
      .limit(1, { referencedTable: 'posts' })
      .single()
    const posts = (data as { posts: { title: string }[] }).posts
    expect(posts).toHaveLength(1)
    expect(posts[0].title).toBe('Git Internals')
  })

  it('many-to-many embed through junction', async () => {
    const { data, error } = await env.supabase.from('posts').select('title, categories(name)').eq('id', 1).single()
    expect(error).toBeNull()
    const cats = (data as { categories: { name: string }[] }).categories.map((c) => c.name).sort()
    expect(cats).toEqual(['Computing', 'History'])
  })

  it('nested embeds', async () => {
    const { data } = await env.supabase
      .from('categories')
      .select('name, posts(title, authors(name))')
      .eq('id', 3)
      .single()
    const posts = (data as { posts: { title: string; authors: { name: string } }[] }).posts
    expect(posts.length).toBe(2)
    expect(posts.every((p) => p.authors.name === 'Linus')).toBe(true)
  })

  it('inner join filters parent rows', async () => {
    const { data } = await env.supabase.from('authors').select('name, posts!inner(title)').eq('posts.published', false)
    expect(data).toHaveLength(1)
    expect((data![0] as { name: string }).name).toBe('Linus')
  })

  it('filter on embedded relation without inner keeps parents', async () => {
    const { data } = await env.supabase.from('authors').select('name, posts(title)').eq('posts.published', true)
    expect(data).toHaveLength(3)
  })
})

describe('mutations', () => {
  it('insert with representation', async () => {
    const { data, error } = await env.supabase
      .from('authors')
      .insert({ name: 'Barbara', email: 'barbara@example.com' })
      .select()
      .single()
    expect(error).toBeNull()
    expect((data as { id: number }).id).toBeGreaterThan(3)
  })

  it('bulk insert', async () => {
    const { data } = await env.supabase
      .from('categories')
      .insert([{ name: 'Hardware' }, { name: 'AI' }])
      .select()
    expect(data).toHaveLength(2)
  })

  it('insert minimal returns no data', async () => {
    const { data, error, status } = await env.supabase.from('categories').insert({ name: 'Temp' })
    expect(error).toBeNull()
    expect(status).toBe(201)
    expect(data).toBeNull()
  })

  it('upsert merge-duplicates', async () => {
    const first = await env.supabase.from('authors').select('id, name').eq('email', 'ada@example.com').single()
    const { data, error } = await env.supabase
      .from('authors')
      .upsert({ id: (first.data as { id: number }).id, name: 'Ada Lovelace', email: 'ada@example.com' })
      .select()
      .single()
    expect(error).toBeNull()
    expect((data as { name: string }).name).toBe('Ada Lovelace')
  })

  it('upsert ignore-duplicates', async () => {
    const { error } = await env.supabase
      .from('authors')
      .upsert({ id: 1, name: 'SHOULD NOT APPLY', email: 'nobody@example.com' }, { ignoreDuplicates: true })
    expect(error).toBeNull()
    const check = await env.supabase.from('authors').select('name').eq('id', 1).single()
    expect((check.data as { name: string }).name).toBe('Ada Lovelace')
  })

  it('update with filter and representation', async () => {
    const { data, error } = await env.supabase.from('posts').update({ views: 300 }).eq('id', 2).select().single()
    expect(error).toBeNull()
    expect((data as { views: number }).views).toBe(300)
  })

  it('delete with returning', async () => {
    const ins = await env.supabase.from('categories').insert({ name: 'DeleteMe' }).select().single()
    const { data, error } = await env.supabase
      .from('categories')
      .delete()
      .eq('id', (ins.data as { id: number }).id)
      .select()
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('insert returning embed', async () => {
    const { data, error } = await env.supabase
      .from('posts')
      .insert({ title: 'New Post', author_id: 1 })
      .select('title, authors(name)')
      .single()
    expect(error).toBeNull()
    expect((data as { authors: { name: string } }).authors.name).toBe('Ada Lovelace')
  })

  it('unique violation maps to 409-style error', async () => {
    const { error } = await env.supabase.from('authors').insert({ name: 'Dup', email: 'ada@example.com' })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23505')
  })
})

describe('rpc', () => {
  it('scalar function', async () => {
    const { data, error } = await env.supabase.rpc('add_numbers', { a: 2, b: 40 })
    expect(error).toBeNull()
    expect(data).toBe(42)
  })

  it('set-returning function with filters', async () => {
    const { data, error } = await env.supabase.rpc('get_posts_by_author', { author: 2 }).eq('published', true)
    expect(error).toBeNull()
    expect((data as unknown[]).length).toBe(1)
  })

  it('void function', async () => {
    const { error } = await env.supabase.rpc('touch_nothing')
    expect(error).toBeNull()
  })

  it('missing function yields PGRST202', async () => {
    const { error } = await env.supabase.rpc('nope')
    expect(error).not.toBeNull()
    expect(error!.code).toBe('PGRST202')
  })
})

describe('row level security', () => {
  it('anon cannot read RLS-protected table', async () => {
    const { data, error } = await env.supabase.from('secrets').select()
    // no policy for anon: RLS filters everything out (no error, empty set)
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('authenticated users are isolated by policy', async () => {
    const a = await env.supabase.auth.signUp({ email: 'rls-a@example.com', password: 'password123' })
    expect(a.error).toBeNull()

    const insertA = await env.supabase.from('secrets').insert({ content: 'alpha secret' }).select().single()
    expect(insertA.error).toBeNull()

    await env.supabase.auth.signOut()
    const b = await env.supabase.auth.signUp({ email: 'rls-b@example.com', password: 'password123' })
    expect(b.error).toBeNull()

    const listB = await env.supabase.from('secrets').select()
    expect(listB.error).toBeNull()
    expect(listB.data).toHaveLength(0)

    // service role bypasses RLS
    const all = await env.admin.from('secrets').select()
    expect(all.data!.length).toBeGreaterThanOrEqual(1)
    await env.supabase.auth.signOut()
  })
})
