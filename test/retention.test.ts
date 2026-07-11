import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, RetentionService, type TinbaseBackend } from '../src/index.js'

// Each test cold-boots a fresh backend; PGlite startup is slow under the
// full suite's parallel load, so allow generous time (matches migration-compat).
const T = 30_000

let backend: TinbaseBackend | null = null
afterEach(async () => {
  if (backend) await backend.close()
  backend = null
})

describe('retention sweep', () => {
  it('purges expired one-time tokens and mfa challenges', async () => {
    // disable the backend's own auto-sweep so only the explicit service below runs
    backend = await createBackend({ retention: { auditLogDays: 0, refreshTokenDays: 0 } })
    const user = await backend.db.query<{ id: string }>(
      `insert into auth.users (aud, role, email) values ('authenticated','authenticated','ret@example.com') returning id`
    )
    const uid = user.rows[0].id

    // an already-expired OTP and a still-valid one
    await backend.db.query(
      `insert into auth.one_time_tokens (user_id, email, token_type, token, expires_at)
       values ($1,'ret@example.com','otp','111111', now() - interval '1 minute'),
              ($1,'ret@example.com','otp','222222', now() + interval '10 minutes')`,
      [uid]
    )

    const svc = new RetentionService(backend.db)
    await svc.sweep()

    const left = await backend.db.query<{ token: string }>(
      `select token from auth.one_time_tokens where email = 'ret@example.com'`
    )
    expect(left.rows.map((r) => r.token)).toEqual(['222222'])
  }, T)

  it('deletes audit entries older than the retention window', async () => {
    // disable the backend's own auto-sweep so only the explicit service below runs
    backend = await createBackend({ retention: { auditLogDays: 0, refreshTokenDays: 0 } })
    await backend.db.query(
      `insert into auth.audit_log_entries (payload, created_at)
       values ('{"action":"old"}'::jsonb, now() - interval '200 days'),
              ('{"action":"recent"}'::jsonb, now())`
    )

    const svc = new RetentionService(backend.db, { auditLogDays: 90 })
    await svc.sweep()

    const rows = await backend.db.query<{ payload: { action: string } }>(
      `select payload from auth.audit_log_entries`
    )
    const actions = rows.rows.map((r) => r.payload.action)
    expect(actions).toContain('recent')
    expect(actions).not.toContain('old')
  }, T)

  it('keeps everything when a window is 0', async () => {
    // disable the backend's own auto-sweep so only the explicit service below runs
    backend = await createBackend({ retention: { auditLogDays: 0, refreshTokenDays: 0 } })
    await backend.db.query(
      `insert into auth.audit_log_entries (payload, created_at) values ('{"action":"ancient"}'::jsonb, now() - interval '999 days')`
    )
    const svc = new RetentionService(backend.db, { auditLogDays: 0 })
    await svc.sweep()
    const rows = await backend.db.query(`select 1 from auth.audit_log_entries where payload->>'action' = 'ancient'`)
    expect(rows.rows.length).toBe(1)
  }, T)
})
