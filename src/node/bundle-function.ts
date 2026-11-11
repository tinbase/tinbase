/**
 * Bundle an edge function with esbuild so it runs under Node like it would on
 * Supabase's Deno edge runtime. This resolves what a plain `import()` can't:
 *   - TypeScript and multi-file functions (relative imports)
 *   - `npm:` / `jsr:` specifiers  → rewritten to esm.sh and fetched
 *   - `https://` URL imports       → fetched (and their transitive deps);
 *     remote `.ts`/`.tsx` modules (deno.land/x, …) are compiled as TypeScript
 *   - bare specifiers from the function's import map (`<fn>/deno.json`
 *     "imports", else `functions/import_map.json` / `functions/deno.json`)
 *
 * Remote modules are fetched at bundle time (first run) and disk-cached, the
 * same trade Deno makes. esbuild is an optional dependency; when it's missing
 * the loader falls back to a plain import (Web-API/Deno.serve functions still
 * work, just not remote/TS imports).
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Map a Deno-style specifier to a fetchable URL. Pure - unit tested. */
export function rewriteRemoteSpecifier(spec: string): string {
  if (spec.startsWith('npm:')) return `https://esm.sh/${spec.slice(4)}`
  if (spec.startsWith('jsr:')) return `https://esm.sh/jsr/${spec.slice(4)}`
  return spec // already an http(s) URL
}

/**
 * Pick the esbuild loader for a fetched module from its URL path extension.
 * Deno serves TypeScript straight from URLs (deno.land/x, raw GitHub), so a
 * `.ts` module must be compiled, not parsed as JS. Pure - unit tested.
 */
export function loaderForUrl(url: string): 'ts' | 'tsx' | 'jsx' | 'js' {
  let path: string
  try {
    path = new URL(url).pathname.toLowerCase()
  } catch {
    return 'js'
  }
  if (path.endsWith('.d.ts')) return 'ts'
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'ts'
  if (path.endsWith('.tsx')) return 'tsx'
  if (path.endsWith('.jsx')) return 'jsx'
  return 'js'
}

/** A Deno import map: specifier (exact, or prefix ending in "/") → target. */
export interface ImportMap {
  imports: Record<string, string>
  /** Directory relative targets ("./lib/") resolve against. */
  baseDir: string
}

/**
 * Apply an import map to a specifier the way Deno does: an exact key wins,
 * else the longest "prefix/" key. Relative targets resolve against the map's
 * directory (returned as an absolute file path). Returns undefined when the
 * map doesn't cover the specifier. Pure - unit tested.
 */
export function applyImportMap(spec: string, map: ImportMap | undefined): string | undefined {
  if (!map) return undefined
  let target: string | undefined = map.imports[spec]
  if (target === undefined) {
    let best = ''
    for (const key of Object.keys(map.imports)) {
      if (key.endsWith('/') && spec.startsWith(key) && key.length > best.length) best = key
    }
    if (best) target = map.imports[best] + spec.slice(best.length)
  }
  if (target === undefined) return undefined
  if (target.startsWith('./') || target.startsWith('../') || target.startsWith('/')) {
    return resolvePath(map.baseDir, target)
  }
  return target
}

async function readJson(path: string): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Per-function Deno config the bundler honors: import map + JSX settings. */
export interface FunctionDenoConfig {
  importMap?: ImportMap
  jsx?: 'automatic'
  jsxImportSource?: string
}

/**
 * Read the import map (and JSX options) for a function, following Supabase's
 * lookup: `<fn>/deno.json` first (its "imports", or the file its "importMap"
 * points at), then `functions/import_map.json`, then `functions/deno.json`.
 */
export async function readFunctionDenoConfig(fnDir: string, functionsDir?: string): Promise<FunctionDenoConfig> {
  const cfg: FunctionDenoConfig = {}
  const fnDeno = (await readJson(join(fnDir, 'deno.json'))) ?? (await readJson(join(fnDir, 'deno.jsonc')))
  const co = fnDeno?.compilerOptions
  if (co && (co.jsx === 'react-jsx' || co.jsx === 'react-jsxdev')) {
    cfg.jsx = 'automatic'
    if (typeof co.jsxImportSource === 'string') cfg.jsxImportSource = co.jsxImportSource
  }
  const fromConfig = async (json: any, dir: string): Promise<ImportMap | undefined> => {
    if (json?.imports && typeof json.imports === 'object') return { imports: json.imports, baseDir: dir }
    if (typeof json?.importMap === 'string') {
      const file = resolvePath(dir, json.importMap)
      const m = await readJson(file)
      if (m?.imports && typeof m.imports === 'object') return { imports: m.imports, baseDir: dirname(file) }
    }
    return undefined
  }
  cfg.importMap =
    (await fromConfig(fnDeno, fnDir)) ??
    (await fromConfig(await readJson(join(fnDir, 'import_map.json')), fnDir)) ??
    (functionsDir
      ? (await fromConfig(await readJson(join(functionsDir, 'import_map.json')), functionsDir)) ??
        (await fromConfig(await readJson(join(functionsDir, 'deno.json')), functionsDir))
      : undefined)
  return cfg
}

const REMOTE = /^(npm:|jsr:|https?:\/\/)/

const HTTP_CACHE = join(tmpdir(), 'tinbase-fn-http')

async function fetchModule(url: string): Promise<string> {
  const key = createHash('sha256').update(url).digest('hex')
  const cached = join(HTTP_CACHE, key)
  if (existsSync(cached)) return readFile(cached, 'utf8')
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`)
  const body = await res.text()
  await mkdir(HTTP_CACHE, { recursive: true })
  await writeFile(cached, body)
  return body
}

/** esbuild plugin: resolve npm:/jsr:/https imports by fetching from esm.sh. */
function remotePlugin(importMap?: ImportMap) {
  // a mapped target is either remote (npm:/jsr:/URL) or a local file path
  const toResult = (target: string) =>
    REMOTE.test(target)
      ? { path: rewriteRemoteSpecifier(target), namespace: 'http-url' }
      : target.startsWith('file:')
        ? { path: fileURLToPath(target) }
        : { path: target }
  return {
    name: 'tinbase-remote',
    setup(build: any) {
      // import map first, for local and remote importers alike (as Deno does)
      if (importMap && Object.keys(importMap.imports).length) {
        build.onResolve({ filter: /.*/ }, (args: { path: string }) => {
          const target = applyImportMap(args.path, importMap)
          return target === undefined ? undefined : toResult(target)
        })
        build.onResolve({ filter: /.*/, namespace: 'http-url' }, (args: { path: string }) => {
          const target = applyImportMap(args.path, importMap)
          return target === undefined ? undefined : toResult(target)
        })
      }
      build.onResolve({ filter: REMOTE }, (args: { path: string }) => ({
        path: rewriteRemoteSpecifier(args.path),
        namespace: 'http-url',
      }))
      // imports *inside* a fetched module resolve relative to its URL
      build.onResolve({ filter: /.*/, namespace: 'http-url' }, (args: { path: string; importer: string }) => ({
        path: new URL(args.path, args.importer).href,
        namespace: 'http-url',
      }))
      build.onLoad({ filter: /.*/, namespace: 'http-url' }, async (args: { path: string }) => ({
        contents: await fetchModule(args.path),
        loader: loaderForUrl(args.path),
      }))
    },
  }
}

/**
 * Bundle `entryPath` to a single ESM file and return its path (written under
 * the OS temp dir). Throws if esbuild is not installed.
 */
export async function bundleFunction(
  entryPath: string,
  name: string,
  opts: { functionsDir?: string } = {}
): Promise<string> {
  let esbuild: typeof import('esbuild')
  try {
    esbuild = await import('esbuild')
  } catch {
    throw new Error('esbuild-not-available')
  }
  const deno = await readFunctionDenoConfig(dirname(entryPath), opts.functionsDir)
  const outDir = join(tmpdir(), 'tinbase-fn-bundle')
  await mkdir(outDir, { recursive: true })
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'silent',
    ...(deno.jsx ? { jsx: deno.jsx } : {}),
    ...(deno.jsxImportSource ? { jsxImportSource: deno.jsxImportSource } : {}),
    plugins: [remotePlugin(deno.importMap)],
  })
  const code = result.outputFiles[0].text
  const out = join(outDir, `${name}-${createHash('sha256').update(entryPath).digest('hex').slice(0, 8)}.mjs`)
  await writeFile(out, code)
  return out
}
