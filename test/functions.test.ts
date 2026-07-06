import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend, type EdgeFunction } from '../src/index.js'

let backend: TinbaseBackend
let supabase: ReturnType<typeof createClient>

const hello: EdgeFunction = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { name?: string }
  return new Response(JSON.stringify({ message: `Hello ${body.name ?? 'world'}!` }), {
    headers: { 'content-type': 'application/json' },
  })
}

const whoami: EdgeFunction = async (_req, ctx) => {
  return new Response(JSON.stringify({ role: ctx.auth.role, hasEnv: !!ctx.env.SUPABASE_URL }), {
    headers: { 'content-type': 'application/json' },
  })
}

const boom: EdgeFunction = async () => {
  throw new Error('kaboom')
}

beforeAll(async () => {
  backend = await createBackend({ functions: { hello, whoami, boom } })
  supabase = createClient('http://localhost:54321', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
  })
})

afterAll(async () => {
  await backend.close()
})

describe('edge functions', () => {
  it('invokes a function with a body', async () => {
    const { data, error } = await supabase.functions.invoke('hello', { body: { name: 'tinbase' } })
    expect(error).toBeNull()
    expect(data).toEqual({ message: 'Hello tinbase!' })
  })

  it('provides auth context and env to the function', async () => {
    const { data, error } = await supabase.functions.invoke('whoami')
    expect(error).toBeNull()
    expect((data as { role: string }).role).toBe('anon')
    expect((data as { hasEnv: boolean }).hasEnv).toBe(true)
  })

  it('unknown function returns an error', async () => {
    const { error } = await supabase.functions.invoke('nope')
    expect(error).not.toBeNull()
  })

  it('function exceptions surface as errors', async () => {
    const { error } = await supabase.functions.invoke('boom')
    expect(error).not.toBeNull()
  })

  it('functions can be registered at runtime', async () => {
    backend.functions.register('late', async () => new Response('late-ok'))
    const { data, error } = await supabase.functions.invoke('late')
    expect(error).toBeNull()
    expect(data).toBe('late-ok')
  })
})
