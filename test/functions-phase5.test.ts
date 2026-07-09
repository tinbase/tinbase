import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { loadFunctions, loadFunctionEnv, rewriteRemoteSpecifier } from '../src/node/index.js'

const backends: TinbaseBackend[] = []
afterAll(async () => {
  while (backends.length) await backends.pop()!.close()
})

const invoke = (b: TinbaseBackend, name: string) =>
  b.fetch(
    new Request(`http://localhost:54321/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: b.anonKey, authorization: `Bearer ${b.anonKey}`, 'content-type': 'application/json' },
      body: '{}',
    })
  )

describe('edge function bundling', () => {
  it('rewrites npm:/jsr: specifiers to esm.sh URLs', () => {
    expect(rewriteRemoteSpecifier('npm:zod@3.23.8')).toBe('https://esm.sh/zod@3.23.8')
    expect(rewriteRemoteSpecifier('jsr:@std/encoding@1')).toBe('https://esm.sh/jsr/@std/encoding@1')
    expect(rewriteRemoteSpecifier('https://esm.sh/lodash')).toBe('https://esm.sh/lodash')
  })

  it('bundles a TypeScript function with a relative import and runs it', { timeout: 30000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tinbase-fn-'))
    const fnDir = join(dir, 'supabase', 'functions', 'greet')
    await mkdir(fnDir, { recursive: true })
    await writeFile(join(fnDir, 'util.ts'), `export const greeting = (name: string): string => \`hi \${name}\`\n`)
    await writeFile(
      join(fnDir, 'index.ts'),
      `import { greeting } from './util.ts'\nexport default (_req: Request) => new Response(greeting('world'))\n`
    )

    const functions = await loadFunctions(dir)
    expect(functions.has('greet')).toBe(true)

    const backend = await createBackend({ functions })
    backends.push(backend)
    const res = await invoke(backend, 'greet')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hi world')
  })
})

describe('edge function secrets', () => {
  it('parses supabase/functions/.env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tinbase-env-'))
    await mkdir(join(dir, 'supabase', 'functions'), { recursive: true })
    await writeFile(
      join(dir, 'supabase', 'functions', '.env'),
      '# a comment\nMY_SECRET=abc123\nQUOTED="hi there"\nEMPTY=\n'
    )
    const env = await loadFunctionEnv(dir)
    expect(env.MY_SECRET).toBe('abc123')
    expect(env.QUOTED).toBe('hi there')
    expect(env.EMPTY).toBe('')
  })

  it('exposes functionEnv to a handler via ctx.env and Deno.env', async () => {
    const backend = await createBackend({
      functionEnv: { MY_SECRET: 's3cr3t' },
      functions: {
        viactx: (_req, ctx) => new Response(ctx.env.MY_SECRET ?? 'missing'),
        viadeno: () => new Response((globalThis as any).Deno?.env.get('MY_SECRET') ?? 'missing'),
      },
    })
    backends.push(backend)
    expect(await (await invoke(backend, 'viactx')).text()).toBe('s3cr3t')
    expect(await (await invoke(backend, 'viadeno')).text()).toBe('s3cr3t')
  })

  it('does not leak host process.env through Deno.env', async () => {
    process.env.TINBASE_HOST_SECRET = 'do-not-leak'
    const backend = await createBackend({
      functions: {
        leak: () => new Response((globalThis as any).Deno?.env.get('TINBASE_HOST_SECRET') ?? 'not-visible'),
      },
    })
    backends.push(backend)
    try {
      expect(await (await invoke(backend, 'leak')).text()).toBe('not-visible')
    } finally {
      delete process.env.TINBASE_HOST_SECRET
    }
  })
})
