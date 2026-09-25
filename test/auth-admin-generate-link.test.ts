import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

/**
 * `auth.admin.generateLink` - the GoTrue admin endpoint that mints a link/OTP
 * and returns it instead of emailing it, so a test harness can redeem it
 * directly. The point of the flow (#77) is programmatic session minting:
 * generateLink -> verifyOtp({ token_hash }) yields a session with no password
 * and no email round-trip.
 */
let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

describe('auth.admin.generateLink', () => {
  it('mints a magiclink whose token_hash verifies into a session', async () => {
    const { data, error } = await env.admin.auth.admin.generateLink({
      type: 'magiclink',
      email: 'gl-magic@example.test',
    })
    expect(error).toBeNull()

    // supabase-js splits the flat response into { user, properties }; if the
    // server nested it instead, properties would be undefined here.
    expect(data.properties?.hashed_token).toBeTruthy()
    expect(data.properties?.email_otp).toBeTruthy()
    expect(data.properties?.verification_type).toBe('magiclink')
    expect(data.properties?.action_link).toContain('/auth/v1/verify?token=')
    expect(data.user?.email).toBe('gl-magic@example.test')

    // the actual use case: redeem the hash for a session, no password involved
    const verified = await env.supabase.auth.verifyOtp({
      token_hash: data.properties!.hashed_token,
      type: 'magiclink',
    })
    expect(verified.error).toBeNull()
    expect(verified.data.session?.access_token).toBeTruthy()
    expect(verified.data.user?.email).toBe('gl-magic@example.test')
    await env.supabase.auth.signOut()
  })

  it('does not send an email (the caller delivers the link)', async () => {
    const before = env.backend.inbox?.list().length ?? 0
    const { error } = await env.admin.auth.admin.generateLink({
      type: 'magiclink',
      email: 'gl-silent@example.test',
    })
    expect(error).toBeNull()
    expect(env.backend.inbox?.list().length ?? 0).toBe(before)
  })

  it('returns the six-digit email_otp, which also verifies', async () => {
    const { data } = await env.admin.auth.admin.generateLink({
      type: 'magiclink',
      email: 'gl-otp@example.test',
    })
    const verified = await env.supabase.auth.verifyOtp({
      email: 'gl-otp@example.test',
      token: data.properties!.email_otp,
      type: 'email',
    })
    expect(verified.error).toBeNull()
    expect(verified.data.session?.access_token).toBeTruthy()
    await env.supabase.auth.signOut()
  })

  it('signup type creates the user and applies password + metadata', async () => {
    const { data, error } = await env.admin.auth.admin.generateLink({
      type: 'signup',
      email: 'gl-signup@example.test',
      password: 'hunter2hunter2',
      options: { data: { display_name: 'Linked' } },
    })
    expect(error).toBeNull()
    expect(data.user?.user_metadata).toMatchObject({ display_name: 'Linked' })
    expect(data.properties?.verification_type).toBe('signup')

    // the password it set is usable
    const pw = await env.supabase.auth.signInWithPassword({
      email: 'gl-signup@example.test',
      password: 'hunter2hunter2',
    })
    expect(pw.error).toBeNull()
    await env.supabase.auth.signOut()
  })

  it('recovery type requires an existing user', async () => {
    const missing = await env.admin.auth.admin.generateLink({
      type: 'recovery',
      email: 'gl-nobody@example.test',
    })
    expect(missing.error).not.toBeNull()

    await env.admin.auth.admin.createUser({
      email: 'gl-recover@example.test',
      password: 'password123',
      email_confirm: true,
    })
    const { data, error } = await env.admin.auth.admin.generateLink({
      type: 'recovery',
      email: 'gl-recover@example.test',
    })
    expect(error).toBeNull()
    expect(data.properties?.verification_type).toBe('recovery')

    const verified = await env.supabase.auth.verifyOtp({
      token_hash: data.properties!.hashed_token,
      type: 'recovery',
    })
    expect(verified.error).toBeNull()
    expect(verified.data.session?.access_token).toBeTruthy()
    await env.supabase.auth.signOut()
  })

  it('a recovery token cannot be redeemed as a login', async () => {
    await env.admin.auth.admin.createUser({
      email: 'gl-scope@example.test',
      password: 'password123',
      email_confirm: true,
    })
    const { data } = await env.admin.auth.admin.generateLink({
      type: 'recovery',
      email: 'gl-scope@example.test',
    })
    // magiclink must not accept a recovery token - otherwise a guessed login OTP
    // could mint a recovery session
    const wrong = await env.supabase.auth.verifyOtp({
      token_hash: data.properties!.hashed_token,
      type: 'magiclink',
    })
    expect(wrong.error).not.toBeNull()
  })

  it('the action_link redeems via GET /verify', async () => {
    const { data } = await env.admin.auth.admin.generateLink({
      type: 'magiclink',
      email: 'gl-link@example.test',
    })
    const res = await env.backend.fetch(new Request(data.properties!.action_link, { redirect: 'manual' }))
    expect(res.status).toBe(303)
    // session lands in the fragment, as with an emailed link
    expect(res.headers.get('location')).toContain('access_token=')
  })

  it('requires the service_role key', async () => {
    const res = await env.backend.fetch(
      new Request('http://localhost:54321/auth/v1/admin/generate_link', {
        method: 'POST',
        headers: { apikey: env.backend.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'magiclink', email: 'gl-anon@example.test' }),
      })
    )
    expect(res.status).toBe(403)
  })

  const generate = (body: unknown) =>
    env.backend.fetch(
      new Request('http://localhost:54321/auth/v1/admin/generate_link', {
        method: 'POST',
        headers: {
          apikey: env.backend.serviceRoleKey,
          Authorization: `Bearer ${env.backend.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    )

  it('rejects a type it has no flow for, instead of minting a plain login link', async () => {
    const res = await generate({ type: 'phone_change', email: 'gl-change@example.test' })
    expect(res.status).toBe(400)
    expect((await res.json()).msg).toContain('unsupported generate_link type')
  })

  it('asks for new_email on an email change rather than guessing one', async () => {
    // The two email-change types mint against a pending address, so the
    // address alone is not enough to describe the link being asked for.
    const res = await generate({ type: 'email_change_new', email: 'gl-change@example.test' })
    expect(res.status).toBe(400)
    expect((await res.json()).msg).toContain('new_email')
  })
})
