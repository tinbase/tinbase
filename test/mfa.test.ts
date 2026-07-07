import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'
import { totpNow } from '../src/auth/totp.js'

/**
 * MFA / TOTP end to end through the real supabase-js `auth.mfa.*` API:
 * enroll → challenge → verify (elevates to aal2) → listFactors → unenroll,
 * plus wrong-code rejection. Runs on both engines via createTestEnv.
 */
let env: TestEnv
const email = `mfa-${Date.now()}@example.com`
const password = 'password123'
let factorId = ''
let secret = ''

beforeAll(async () => {
  env = await createTestEnv()
  const { error } = await env.supabase.auth.signUp({ email, password })
  expect(error).toBeNull()
})

afterAll(async () => {
  await env.close()
})

describe('MFA (TOTP)', () => {
  it('enrolls a TOTP factor and returns a secret, uri, and QR', async () => {
    const { data, error } = await env.supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'my phone' })
    expect(error).toBeNull()
    expect(data!.type).toBe('totp')
    expect(data!.totp.secret).toMatch(/^[A-Z2-7]+$/)
    expect(data!.totp.uri).toContain('otpauth://totp/')
    expect(data!.totp.qr_code).toContain('data:image/svg+xml')
    factorId = data!.id
    secret = data!.totp.secret
  })

  it('reports aal1 before verification', async () => {
    const { data, error } = await env.supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    expect(error).toBeNull()
    expect(data!.currentLevel).toBe('aal1')
  })

  it('rejects a wrong TOTP code', async () => {
    const { data: ch } = await env.supabase.auth.mfa.challenge({ factorId })
    const real = await totpNow(secret)
    const wrong = real === '000000' ? '111111' : '000000'
    const { error } = await env.supabase.auth.mfa.verify({ factorId, challengeId: ch!.id, code: wrong })
    expect(error).not.toBeNull()
  })

  it('verifies a correct TOTP code and elevates the session to aal2', async () => {
    const { data: ch, error: chErr } = await env.supabase.auth.mfa.challenge({ factorId })
    expect(chErr).toBeNull()
    const code = await totpNow(secret)
    const { data, error } = await env.supabase.auth.mfa.verify({ factorId, challengeId: ch!.id, code })
    expect(error).toBeNull()
    expect(data!.access_token).toBeTruthy()

    const aal = await env.supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    expect(aal.data!.currentLevel).toBe('aal2')
  })

  it('lists the factor as a verified totp factor', async () => {
    const { data, error } = await env.supabase.auth.mfa.listFactors()
    expect(error).toBeNull()
    expect(data!.totp.length).toBe(1)
    expect(data!.totp[0].id).toBe(factorId)
    expect(data!.totp[0].status).toBe('verified')
  })

  it('unenrolls the factor', async () => {
    const { error } = await env.supabase.auth.mfa.unenroll({ factorId })
    expect(error).toBeNull()
    const { data } = await env.supabase.auth.mfa.listFactors()
    expect(data!.all.length).toBe(0)
  })
})
