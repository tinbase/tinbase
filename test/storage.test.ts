import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
  await env.supabase.auth.signUp({ email: 'files@example.com', password: 'password123' })
})

afterAll(async () => {
  await env.close()
})

describe('storage', () => {
  it('creates, lists, gets, and updates buckets (service role)', async () => {
    const created = await env.admin.storage.createBucket('avatars', { public: true })
    expect(created.error).toBeNull()

    await env.admin.storage.createBucket('docs', { public: false })

    const list = await env.admin.storage.listBuckets()
    expect(list.error).toBeNull()
    expect(list.data!.map((b) => b.id).sort()).toEqual(['avatars', 'docs'])

    const got = await env.admin.storage.getBucket('avatars')
    expect(got.data!.public).toBe(true)

    const upd = await env.admin.storage.updateBucket('docs', { public: false })
    expect(upd.error).toBeNull()
  })

  it('rejects bucket creation with anon key', async () => {
    const { error } = await env.supabase.storage.createBucket('nope')
    expect(error).not.toBeNull()
  })

  it('uploads and downloads a file', async () => {
    const content = new Blob(['hello tinbase'], { type: 'text/plain' })
    const up = await env.supabase.storage.from('docs').upload('notes/hello.txt', content)
    expect(up.error).toBeNull()
    expect(up.data!.path).toBe('notes/hello.txt')

    const down = await env.supabase.storage.from('docs').download('notes/hello.txt')
    expect(down.error).toBeNull()
    expect(await down.data!.text()).toBe('hello tinbase')
  })

  it('upsert overwrites, plain upload conflicts', async () => {
    const conflict = await env.supabase.storage
      .from('docs')
      .upload('notes/hello.txt', new Blob(['x'], { type: 'text/plain' }))
    expect(conflict.error).not.toBeNull()

    const upsert = await env.supabase.storage
      .from('docs')
      .upload('notes/hello.txt', new Blob(['updated'], { type: 'text/plain' }), { upsert: true })
    expect(upsert.error).toBeNull()

    const down = await env.supabase.storage.from('docs').download('notes/hello.txt')
    expect(await down.data!.text()).toBe('updated')
  })

  it('lists objects with folder entries', async () => {
    await env.supabase.storage.from('docs').upload('notes/deep/a.txt', new Blob(['a']))
    await env.supabase.storage.from('docs').upload('root.txt', new Blob(['r']))

    const root = await env.supabase.storage.from('docs').list()
    expect(root.error).toBeNull()
    const names = root.data!.map((f) => f.name).sort()
    expect(names).toEqual(['notes', 'root.txt'])

    const notes = await env.supabase.storage.from('docs').list('notes')
    expect(notes.data!.map((f) => f.name).sort()).toEqual(['deep', 'hello.txt'])
  })

  it('serves public objects without auth', async () => {
    await env.supabase.storage.from('avatars').upload('cat.png', new Blob(['pngbytes'], { type: 'image/png' }))
    const { data } = env.supabase.storage.from('avatars').getPublicUrl('cat.png')
    const res = await env.backend.fetch(new Request(data.publicUrl))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('pngbytes')
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('denies public URL for private buckets', async () => {
    const { data } = env.supabase.storage.from('docs').getPublicUrl('root.txt')
    const res = await env.backend.fetch(new Request(data.publicUrl))
    expect(res.status).toBe(400)
  })

  it('signed URLs grant temporary access to private objects', async () => {
    const signed = await env.supabase.storage.from('docs').createSignedUrl('root.txt', 60)
    expect(signed.error).toBeNull()
    const res = await env.backend.fetch(new Request(signed.data!.signedUrl))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('r')

    // tampered token fails
    const bad = signed.data!.signedUrl.replace(/token=.{10}/, 'token=tampered')
    const badRes = await env.backend.fetch(new Request(bad))
    expect(badRes.status).toBe(400)
  })

  it('rejects a download token replayed at the upload endpoint', async () => {
    // a download-scoped signed URL token must not be usable to write objects
    const signed = await env.supabase.storage.from('docs').createSignedUrl('root.txt', 60)
    const token = new URL(signed.data!.signedUrl, 'http://x').searchParams.get('token')!
    const res = await env.backend.fetch(
      new Request(`http://x/storage/v1/object/upload/sign/docs/pwned.txt?token=${token}`, {
        method: 'PUT',
        headers: { apikey: env.backend.anonKey },
        body: 'attacker bytes',
      })
    )
    expect(res.status).toBe(400)
    // the write must not have landed
    const check = await env.admin.storage.from('docs').download('pwned.txt')
    expect(check.error).not.toBeNull()
  })

  it('moves and copies objects', async () => {
    await env.supabase.storage.from('docs').upload('mv/src.txt', new Blob(['move me']))
    const mv = await env.supabase.storage.from('docs').move('mv/src.txt', 'mv/dst.txt')
    expect(mv.error).toBeNull()
    const gone = await env.supabase.storage.from('docs').download('mv/src.txt')
    expect(gone.error).not.toBeNull()
    const there = await env.supabase.storage.from('docs').download('mv/dst.txt')
    expect(await there.data!.text()).toBe('move me')

    const cp = await env.supabase.storage.from('docs').copy('mv/dst.txt', 'mv/copy.txt')
    expect(cp.error).toBeNull()
    const copied = await env.supabase.storage.from('docs').download('mv/copy.txt')
    expect(await copied.data!.text()).toBe('move me')
  })

  it('removes objects', async () => {
    const rm = await env.supabase.storage.from('docs').remove(['mv/dst.txt', 'mv/copy.txt'])
    expect(rm.error).toBeNull()
    expect(rm.data).toHaveLength(2)
    const gone = await env.supabase.storage.from('docs').download('mv/dst.txt')
    expect(gone.error).not.toBeNull()
  })

  it('enforces bucket file size limits', async () => {
    await env.admin.storage.createBucket('tiny', { fileSizeLimit: 10 })
    const { error } = await env.supabase.storage.from('tiny').upload('big.bin', new Blob(['x'.repeat(100)]))
    expect(error).not.toBeNull()
  })

  it('anon cannot read private bucket objects (RLS default policies)', async () => {
    const anonClient = env.supabase
    await anonClient.auth.signOut()
    const { error } = await anonClient.storage.from('docs').download('notes/hello.txt')
    expect(error).not.toBeNull()
    // sign back in for any following tests
    await env.supabase.auth.signInWithPassword({ email: 'files@example.com', password: 'password123' })
  })
})
