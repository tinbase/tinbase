import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

describe('auth', () => {
  it('signs up with email/password and returns a session', async () => {
    const { data, error } = await env.supabase.auth.signUp({
      email: 'test@example.com',
      password: 'password123',
      options: { data: { display_name: 'Tester' } },
    })
    expect(error).toBeNull()
    expect(data.session?.access_token).toBeTruthy()
    expect(data.user?.email).toBe('test@example.com')
    expect(data.user?.user_metadata).toEqual({ display_name: 'Tester' })
    await env.supabase.auth.signOut()
  })

  it('rejects duplicate signup', async () => {
    const { error } = await env.supabase.auth.signUp({ email: 'test@example.com', password: 'password123' })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('user_already_exists')
  })

  it('signs in with correct password, rejects wrong one', async () => {
    const ok = await env.supabase.auth.signInWithPassword({ email: 'test@example.com', password: 'password123' })
    expect(ok.error).toBeNull()
    expect(ok.data.session?.refresh_token).toBeTruthy()
    await env.supabase.auth.signOut()

    const bad = await env.supabase.auth.signInWithPassword({ email: 'test@example.com', password: 'wrong' })
    expect(bad.error).not.toBeNull()
    expect(bad.error!.code).toBe('invalid_credentials')
  })

  it('getUser returns the authenticated user', async () => {
    await env.supabase.auth.signInWithPassword({ email: 'test@example.com', password: 'password123' })
    const { data, error } = await env.supabase.auth.getUser()
    expect(error).toBeNull()
    expect(data.user?.email).toBe('test@example.com')
    await env.supabase.auth.signOut()
  })

  it('updates user metadata and password', async () => {
    await env.supabase.auth.signInWithPassword({ email: 'test@example.com', password: 'password123' })
    const upd = await env.supabase.auth.updateUser({ data: { plan: 'pro' }, password: 'newpassword456' })
    expect(upd.error).toBeNull()
    expect(upd.data.user?.user_metadata).toMatchObject({ display_name: 'Tester', plan: 'pro' })
    await env.supabase.auth.signOut()

    const relogin = await env.supabase.auth.signInWithPassword({
      email: 'test@example.com',
      password: 'newpassword456',
    })
    expect(relogin.error).toBeNull()
    await env.supabase.auth.signOut()
  })

  it('refreshes a session with the refresh token', async () => {
    const login = await env.supabase.auth.signInWithPassword({
      email: 'test@example.com',
      password: 'newpassword456',
    })
    const refreshToken = login.data.session!.refresh_token
    const { data, error } = await env.supabase.auth.refreshSession({ refresh_token: refreshToken })
    expect(error).toBeNull()
    expect(data.session?.access_token).toBeTruthy()
    expect(data.session?.refresh_token).not.toBe(refreshToken)

    // old refresh token is revoked
    const reuse = await env.supabase.auth.refreshSession({ refresh_token: refreshToken })
    expect(reuse.error).not.toBeNull()
    await env.supabase.auth.signOut()
  })

  it('signs in anonymously', async () => {
    const { data, error } = await env.supabase.auth.signInAnonymously()
    expect(error).toBeNull()
    expect(data.user?.is_anonymous).toBe(true)
    await env.supabase.auth.signOut()
  })

  it('admin can list, create, and delete users', async () => {
    const list = await env.admin.auth.admin.listUsers()
    expect(list.error).toBeNull()
    expect(list.data.users.length).toBeGreaterThanOrEqual(1)

    const created = await env.admin.auth.admin.createUser({
      email: 'admin-made@example.com',
      password: 'password123',
      email_confirm: true,
    })
    expect(created.error).toBeNull()

    const del = await env.admin.auth.admin.deleteUser(created.data.user!.id)
    expect(del.error).toBeNull()
  })

  it('admin endpoints reject anon key', async () => {
    const { error } = await env.supabase.auth.admin.listUsers()
    expect(error).not.toBeNull()
  })

  it('exports a user\'s data (GDPR access) without leaking credentials', async () => {
    const created = await env.admin.auth.admin.createUser({
      email: 'export-me@example.com',
      password: 'password123',
      email_confirm: true,
      user_metadata: { plan: 'pro' },
    })
    const id = created.data.user!.id

    const res = await env.backend.fetch(
      new Request(`http://localhost:54321/auth/v1/admin/users/${id}/export`, {
        headers: { apikey: env.backend.serviceRoleKey, authorization: `Bearer ${env.backend.serviceRoleKey}` },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.email).toBe('export-me@example.com')
    expect(body.user.user_metadata).toEqual({ plan: 'pro' })
    expect(Array.isArray(body.identities)).toBe(true)
    expect(Array.isArray(body.sessions)).toBe(true)
    expect(Array.isArray(body.mfa_factors)).toBe(true)
    // the password hash must never appear anywhere in the export
    expect(JSON.stringify(body)).not.toContain('encrypted_password')
  })

  it('erases a user and cascades their auth rows (GDPR erasure)', async () => {
    const created = await env.admin.auth.admin.createUser({
      email: 'erase-me@example.com',
      password: 'password123',
      email_confirm: true,
    })
    const id = created.data.user!.id

    const res = await env.backend.fetch(
      new Request(`http://localhost:54321/auth/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: { apikey: env.backend.serviceRoleKey, authorization: `Bearer ${env.backend.serviceRoleKey}` },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.erased).toBe(true)

    // the user is gone
    const gone = await env.admin.auth.admin.getUserById(id)
    expect(gone.data.user).toBeNull()

    // erasing a non-existent user returns 404
    const missing = await env.backend.fetch(
      new Request(`http://localhost:54321/auth/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: { apikey: env.backend.serviceRoleKey, authorization: `Bearer ${env.backend.serviceRoleKey}` },
      })
    )
    expect(missing.status).toBe(404)
  })

  it('export rejects the anon key', async () => {
    const res = await env.backend.fetch(
      new Request(`http://localhost:54321/auth/v1/admin/users/00000000-0000-0000-0000-000000000000/export`, {
        headers: { apikey: env.backend.anonKey, authorization: `Bearer ${env.backend.anonKey}` },
      })
    )
    expect(res.status).toBe(403)
  })
})

describe('auth OTP brute-force protection', () => {
  const key = env => env.backend.anonKey
  const authFetch = (env: TestEnv, path: string, body: unknown) =>
    env.backend.fetch(
      new Request(`http://localhost:54321/auth/v1/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: env.backend.anonKey },
        body: JSON.stringify(body),
      })
    )

  it('locks out an OTP after too many wrong guesses', async () => {
    env.backend.inbox!.clear()
    const email = `otp-brute-${Date.now()}@example.com`
    await authFetch(env, 'otp', { email })
    const realCode = env.backend.inbox!.list()[0].code!

    // 5 wrong guesses trip the lockout
    for (let i = 0; i < 5; i++) {
      const r = await authFetch(env, 'verify', { type: 'email', email, token: '000000' })
      expect(r.status).toBe(403)
    }
    // even the correct code is now rejected — the token was burned
    const good = await authFetch(env, 'verify', { type: 'email', email, token: realCode })
    expect(good.status).toBe(403)
  })

  it('does not let a login OTP redeem as a recovery session', async () => {
    env.backend.inbox!.clear()
    const email = `otp-type-${Date.now()}@example.com`
    await authFetch(env, 'otp', { email })
    const code = env.backend.inbox!.list()[0].code!

    // the same 6-digit code must not be accepted as a recovery token
    const asRecovery = await authFetch(env, 'verify', { type: 'recovery', email, token: code })
    expect(asRecovery.status).toBe(403)
  })
})
