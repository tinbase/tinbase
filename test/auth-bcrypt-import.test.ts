import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

// Users restored from a hosted-Supabase dump carry GoTrue's bcrypt hashes in
// auth.users.encrypted_password. They must be able to sign in with their
// existing password, and get moved onto tinbase's PBKDF2 hash when they do.

let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

async function userWithBcrypt(email: string, password: string, prefix = '$2a$') {
  const { data, error } = await env.admin.auth.admin.createUser({ email, password: 'placeholder-pass', email_confirm: true })
  expect(error).toBeNull()
  const r = await env.backend.db.query<{ h: string }>(`select extensions.crypt($1, extensions.gen_salt('bf', 10)) as h`, [
    password,
  ])
  const hash = prefix + r.rows[0].h.slice(4)
  await env.backend.db.query(`update auth.users set encrypted_password = $1 where id = $2`, [hash, data.user!.id])
  return { id: data.user!.id, hash }
}

async function storedHash(id: string): Promise<string> {
  const r = await env.backend.db.query<{ h: string }>(`select encrypted_password as h from auth.users where id = $1`, [id])
  return r.rows[0].h
}

describe('sign-in with a bcrypt hash from Supabase', () => {
  it('accepts the right password and upgrades the hash to PBKDF2', async () => {
    const { id, hash } = await userWithBcrypt('bcrypt-a@example.com', 'correct horse')
    expect(hash.startsWith('$2a$10$')).toBe(true)

    const ok = await env.supabase.auth.signInWithPassword({ email: 'bcrypt-a@example.com', password: 'correct horse' })
    expect(ok.error).toBeNull()
    expect(ok.data.session?.access_token).toBeTruthy()
    await env.supabase.auth.signOut()

    expect((await storedHash(id)).startsWith('pbkdf2$')).toBe(true)

    // and the upgraded hash keeps working
    const again = await env.supabase.auth.signInWithPassword({ email: 'bcrypt-a@example.com', password: 'correct horse' })
    expect(again.error).toBeNull()
    await env.supabase.auth.signOut()
  })

  it('rejects a wrong password and leaves the hash alone', async () => {
    const { id, hash } = await userWithBcrypt('bcrypt-wrong@example.com', 'right one')
    const bad = await env.supabase.auth.signInWithPassword({ email: 'bcrypt-wrong@example.com', password: 'wrong one' })
    expect(bad.error?.code).toBe('invalid_credentials')
    expect(await storedHash(id)).toBe(hash)
  })

  it('accepts the $2b$ and $2y$ spellings', async () => {
    for (const prefix of ['$2b$', '$2y$']) {
      const email = `bcrypt-${prefix.slice(2, 3)}@example.com`
      await userWithBcrypt(email, 'same secret', prefix)
      const ok = await env.supabase.auth.signInWithPassword({ email, password: 'same secret' })
      expect(ok.error).toBeNull()
      await env.supabase.auth.signOut()
    }
  })
})
