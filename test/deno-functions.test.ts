import { createClient } from '@supabase/supabase-js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { loadFunctions } from '../src/node/load-functions.js'

/** Write a supabase/functions/<name>/index.mjs and return the project dir. */
function projectWithFunctions(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tb-deno-'))
  for (const [name, src] of Object.entries(files)) {
    mkdirSync(join(dir, 'supabase', 'functions', name), { recursive: true })
    writeFileSync(join(dir, 'supabase', 'functions', name, 'index.mjs'), src)
  }
  return dir
}

let backend: TinbaseBackend
let supabase: ReturnType<typeof createClient>

beforeAll(async () => {
  const dir = projectWithFunctions({
    // idiomatic Supabase edge function: Deno.serve + Deno.env, Web APIs only
    hello: `Deno.serve(async (req) => {
      const { name = 'world' } = await req.json().catch(() => ({}))
      return new Response(
        JSON.stringify({ message: \`Hello \${name}!\`, url: Deno.env.get('SUPABASE_URL') }),
        { headers: { 'content-type': 'application/json' } }
      )
    })`,
    // export-default style should still work
    legacy: `export default (req) => new Response('legacy-ok')`,
  })
  const functions = await loadFunctions(dir)
  backend = await createBackend({ functions })
  supabase = createClient('http://127.0.0.1:54321', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
  })
})

afterAll(async () => {
  await backend.close()
})

describe('Deno-style edge functions', () => {
  it('runs a Deno.serve() function unchanged and exposes Deno.env', async () => {
    const { data, error } = await supabase.functions.invoke('hello', { body: { name: 'tinbase' } })
    expect(error).toBeNull()
    expect(data.message).toBe('Hello tinbase!')
    // Deno.env.get('SUPABASE_URL') resolved to the injected value (backend siteUrl)
    expect(data.url).toBe('http://localhost:54321')
  })

  it('still supports export-default handlers', async () => {
    const { data, error } = await supabase.functions.invoke('legacy')
    expect(error).toBeNull()
    expect(data).toBe('legacy-ok')
  })
})
