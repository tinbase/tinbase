import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

describe('health endpoint', () => {
  let env: TestEnv

  beforeAll(async () => {
    env = await createTestEnv()
  })

  afterAll(async () => {
    await env.close()
  })

  it('reports healthy 200 when database is reachable', async () => {
    const res = await env.backend.fetch(new Request('http://localhost:54321/health'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string; status: string }
    expect(body).toEqual({ name: 'tinbase', status: 'healthy' })
  })

  it('reports healthy 200 for root path /', async () => {
    const res = await env.backend.fetch(new Request('http://localhost:54321/'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string; status: string }
    expect(body).toEqual({ name: 'tinbase', status: 'healthy' })
  })

  for (const endpoint of ['/health', '/']) {
    it(`reports unhealthy 503 for ${endpoint} when database is unreachable without leaking error details`, async () => {
      // Simulate database unreachable by corrupting the db query method
      const originalQuery = env.backend.db.query
      env.backend.db.query = async () => {
        throw new Error('FATAL: connection to postgres://postgres:secret@db.internal:5432 failed')
      }

      try {
        const res = await env.backend.fetch(new Request(`http://localhost:54321${endpoint}`))
        expect(res.status).toBe(503)
        const body = (await res.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'tinbase', status: 'unhealthy' })
        expect(JSON.stringify(body)).not.toContain('postgres')
        expect(JSON.stringify(body)).not.toContain('secret')
        expect(JSON.stringify(body)).not.toContain('FATAL')
      } finally {
        env.backend.db.query = originalQuery
      }
    })
  }
})


