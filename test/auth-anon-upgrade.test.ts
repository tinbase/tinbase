import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

/**
 * Anonymous → permanent upgrade: an anonymous user adds an email + password
 * via updateUser and becomes a normal account — same uid (so their data is
 * retained), is_anonymous flips off, an email identity is recorded, and they
 * can subsequently sign in with the new credentials.
 */
let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

describe('anonymous → permanent upgrade', () => {
  it('keeps the same uid and can sign in after adding email + password', async () => {
    const anon = await env.supabase.auth.signInAnonymously()
    expect(anon.error).toBeNull()
    const uid = anon.data.user!.id
    expect(anon.data.user!.is_anonymous).toBe(true)

    const email = `anon-${Date.now()}@example.com`
    const upgraded = await env.supabase.auth.updateUser({ email, password: 'password123' })
    expect(upgraded.error).toBeNull()
    expect(upgraded.data.user!.id).toBe(uid)
    expect(upgraded.data.user!.is_anonymous).toBe(false)
    expect(upgraded.data.user!.email).toBe(email)

    // the upgraded account can now sign in with its new credentials, same uid
    await env.supabase.auth.signOut()
    const signIn = await env.supabase.auth.signInWithPassword({ email, password: 'password123' })
    expect(signIn.error).toBeNull()
    expect(signIn.data.user!.id).toBe(uid)
    expect(signIn.data.user!.is_anonymous).toBe(false)
  })

  it('rejects upgrading to an email already registered', async () => {
    const taken = `taken-${Date.now()}@example.com`
    const first = await env.supabase.auth.signUp({ email: taken, password: 'password123' })
    expect(first.error).toBeNull()
    await env.supabase.auth.signOut()

    const anon = await env.supabase.auth.signInAnonymously()
    expect(anon.error).toBeNull()
    const { error } = await env.supabase.auth.updateUser({ email: taken })
    expect(error).not.toBeNull()
    // and it stays anonymous
    const me = await env.supabase.auth.getUser()
    expect(me.data.user!.is_anonymous).toBe(true)
  })
})
