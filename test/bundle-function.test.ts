import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { applyImportMap, loadFunctions, loaderForUrl } from '../src/node/index.js'

// A local stand-in for deno.land/x / esm.sh: serves TypeScript and JS modules.
// Each run gets a fresh port, so the bundler's URL-keyed disk cache never
// serves a stale copy.
const MODULES: Record<string, string> = {
  // remote TypeScript with type-only import syntax, like deno.land/x/djwt
  '/x/jwtish/mod.ts': `import { type Algo, algoName } from './algo.ts'\nexport function sign(a: Algo): string { return 'signed:' + algoName(a) }\n`,
  '/x/jwtish/algo.ts': `export type Algo = 'HS256' | 'HS512'\nexport const algoName = (a: Algo): string => a.toLowerCase()\n`,
  '/zodish.js': `export const z = { tag: 'zodish' }\n`,
  '/pkg/util.js': `export const util = 'pkg-util'\n`,
}
let server: Server
let base: string
let hits = 0
beforeAll(async () => {
  server = createServer((req, res) => {
    hits++
    const body = MODULES[new URL(req.url!, 'http://x').pathname]
    if (body === undefined) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/javascript' }).end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

const backends: TinbaseBackend[] = []
afterAll(async () => {
  while (backends.length) await backends.pop()!.close()
  await new Promise((r) => server.close(r))
})

/** Scaffold a project with the given `functions/<rel>` = source entries. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tb-bundle-'))
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, 'supabase', 'functions', rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, src)
  }
  return dir
}

async function call(fns: Awaited<ReturnType<typeof loadFunctions>>, name: string, env: Record<string, string> = {}) {
  const backend = await createBackend({ functions: fns, functionEnv: env })
  backends.push(backend)
  return backend.fetch(
    new Request(`http://localhost:54321/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: backend.anonKey, authorization: `Bearer ${backend.anonKey}` },
      body: '{}',
    })
  )
}

describe('loaderForUrl', () => {
  it('picks the loader from the URL path extension', () => {
    expect(loaderForUrl('https://deno.land/x/djwt@v3.0.2/mod.ts')).toBe('ts')
    expect(loaderForUrl('https://example.com/a.mts?x=1')).toBe('ts')
    expect(loaderForUrl('https://example.com/a.tsx')).toBe('tsx')
    expect(loaderForUrl('https://example.com/a.jsx')).toBe('jsx')
    expect(loaderForUrl('https://esm.sh/zod@3.25.76')).toBe('js')
    expect(loaderForUrl('https://esm.sh/zod@3.25.76/es2022/zod.mjs')).toBe('js')
  })
})

describe('applyImportMap', () => {
  const map = {
    imports: { zod: 'npm:zod@3.25.76', 'std/': 'https://deno.land/std@0.224.0/', local: './lib/local.ts' },
    baseDir: '/proj/supabase/functions/fn',
  }
  it('maps exact keys, longest prefix keys, and relative targets', () => {
    expect(applyImportMap('zod', map)).toBe('npm:zod@3.25.76')
    expect(applyImportMap('std/assert/mod.ts', map)).toBe('https://deno.land/std@0.224.0/assert/mod.ts')
    expect(applyImportMap('local', map)).toBe('/proj/supabase/functions/fn/lib/local.ts')
    expect(applyImportMap('zod/v4', map)).toBeUndefined()
    expect(applyImportMap('./x.ts', map)).toBeUndefined()
    expect(applyImportMap('zod', undefined)).toBeUndefined()
  })
})

describe('edge function bundling: remote TypeScript and import maps', () => {
  it('compiles a remote .ts module (type-only import syntax) instead of parsing it as JS', { timeout: 30000 }, async () => {
    const dir = project({
      'login/index.ts': `import { sign } from '${base}/x/jwtish/mod.ts'\nDeno.serve(() => new Response(sign('HS256')))\n`,
    })
    const fns = await loadFunctions(dir)
    expect(fns.has('login')).toBe(true)
    const res = await call(fns, 'login')
    expect(await res.text()).toBe('signed:hs256')
  })

  it("resolves bare specifiers from the function's deno.json, including in _shared code", { timeout: 30000 }, async () => {
    const dir = project({
      '_shared/field-request.ts': `import { z } from 'zod'\nimport { util } from 'pkg/util.js'\nexport const tag = (): string => z.tag + '+' + util\n`,
      'bookings/deno.json': JSON.stringify({ imports: { zod: `${base}/zodish.js`, 'pkg/': `${base}/pkg/` } }),
      'bookings/index.ts': `import { tag } from '../_shared/field-request.ts'\nexport default () => new Response(tag())\n`,
    })
    const fns = await loadFunctions(dir)
    expect(fns.has('bookings')).toBe(true)
    expect(await (await call(fns, 'bookings')).text()).toBe('zodish+pkg-util')
  })

  it('falls back to functions/import_map.json when the function has no import map', { timeout: 30000 }, async () => {
    const dir = project({
      'import_map.json': JSON.stringify({ imports: { zod: `${base}/zodish.js`, helper: './_shared/helper.ts' } }),
      '_shared/helper.ts': `export const help = (): string => 'helped'\n`,
      'fn/deno.json': '{}',
      'fn/index.ts': `import { z } from 'zod'\nimport { help } from 'helper'\nexport default () => new Response(z.tag + ':' + help())\n`,
    })
    const fns = await loadFunctions(dir)
    expect(await (await call(fns, 'fn')).text()).toBe('zodish:helped')
  })
})

describe('lazy function loading', () => {
  it('bundles nothing at startup and loads each function on its first request', { timeout: 30000 }, async () => {
    const dir = project({
      'lazy/index.ts': `import { sign } from '${base}/x/jwtish/mod.ts?lazy'\n` +
        // top-level env read: runs inside the invocation, so it sees the secret
        `const key = Deno.env.get('MY_KEY')\nif (!key) throw new Error('Missing key')\n` +
        `Deno.serve(() => new Response(sign('HS512') + ':' + key))\n`,
      'broken/index.ts': `import { nope } from 'not-mapped-anywhere'\nexport default () => new Response(nope)\n`,
    })
    const before = hits
    const fns = await loadFunctions(dir, {}, { lazy: true })
    expect([...fns.keys()].sort()).toEqual(['broken', 'lazy'])
    expect(hits).toBe(before) // nothing fetched or bundled yet

    const res = await call(fns, 'lazy', { MY_KEY: 'k1' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('signed:hs512:k1')

    const bad = await call(fns, 'broken')
    expect(bad.status).toBe(500)
    expect((await bad.json()).error).toMatch(/failed to load function "broken"/)
  })
})
