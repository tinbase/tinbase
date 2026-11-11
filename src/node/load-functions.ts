/** Loads edge functions from supabase/functions/<name>/index.{ts,js,mjs} (Node only). */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EdgeFunction } from '../functions/handler.js'
import { installDenoShim, resetCapturedHandler, takeCapturedHandler } from '../functions/deno-shim.js'
import { bundleFunction } from './bundle-function.js'

/**
 * Load edge-function secrets from supabase/functions/.env (KEY=VALUE lines,
 * `#` comments). These are exposed to functions via Deno.env and ctx.env -
 * the local equivalent of `supabase functions serve --env-file`.
 */
export async function loadFunctionEnv(projectDir: string): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(join(projectDir, 'supabase', 'functions', '.env'), 'utf8')
  } catch {
    return {}
  }
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) env[key] = val
  }
  return env
}

/** Per-function options from config.toml [functions.<name>]. */
export interface LoadFunctionOptions {
  /** Skip loading when explicitly disabled. */
  enabled?: boolean
  /** Custom entrypoint path, relative to the project root. */
  entrypoint?: string
}

/**
 * Bundle and import one function, returning its handler (a default export, or
 * the handler a `Deno.serve()` call captured during import). Throws on a build
 * or import failure, or when the module registers no handler.
 */
async function importHandler(path: string, name: string, functionsDir: string): Promise<EdgeFunction> {
  // Bundle with esbuild so TS, relative imports, import maps and
  // npm:/jsr:/URL specifiers resolve. If esbuild isn't installed, import the
  // file directly (Web-API / Deno.serve functions still work).
  let importUrl: string
  try {
    importUrl = pathToFileURL(await bundleFunction(path, name, { functionsDir })).href
  } catch (e) {
    if ((e as Error).message !== 'esbuild-not-available') throw e
    importUrl = pathToFileURL(path).href
  }
  resetCapturedHandler()
  const mod = (await import(importUrl)) as { default?: EdgeFunction }
  // prefer an explicit default export; otherwise use the handler a
  // Deno.serve() call captured during import
  const denoHandler = takeCapturedHandler()
  const handler = typeof mod.default === 'function' ? mod.default : denoHandler ? (req: Request) => denoHandler(req) : undefined
  if (!handler) throw new Error(`function "${name}" has no default export or Deno.serve() handler`)
  return handler as EdgeFunction
}

function describeLoadError(name: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/Unknown file extension|Cannot find module/.test(msg)) {
    return `function "${name}" needs bundling — install esbuild, or run tinbase with tsx/bun`
  }
  return `failed to load function "${name}": ${msg}`
}

// Imports go one at a time: the Deno.serve() capture is a process global, and
// one esbuild build + module graph in flight keeps memory flat.
let importChain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = importChain.then(fn, fn)
  importChain = run.catch(() => undefined)
  return run
}

/**
 * A handler that bundles and imports the function on its first request. The
 * import runs inside the invocation, so top-level `Deno.env.get()` reads see
 * the function's secrets. A failed load is reported as a 500 and retried on
 * the next request (a transient esm.sh fetch error shouldn't stick).
 */
function lazyFunction(path: string, name: string, functionsDir: string): EdgeFunction {
  let loading: Promise<EdgeFunction> | undefined
  return (req, ctx) => {
    loading ??= serialized(() => importHandler(path, name, functionsDir)).catch((e) => {
      loading = undefined
      const msg = describeLoadError(name, e)
      console.warn(`  warning: ${msg}`)
      throw new Error(msg)
    })
    return loading.then((fn) => fn(req, ctx))
  }
}

/** How {@link loadFunctions} loads each discovered function. */
export interface LoadFunctionsBehavior {
  /**
   * Bundle and import each function on its first request instead of at
   * startup. Startup then holds no function code (31 functions eagerly
   * imported can take several hundred MB), and a broken function surfaces as
   * a 500 on its own route rather than a startup warning.
   */
  lazy?: boolean
}

/**
 * Discover and load every edge function under supabase/functions/, keyed by
 * directory name. Dirs starting with `_` or `.` are skipped (shared code), as
 * are functions disabled in config.toml. Each function is bundled with esbuild
 * when available (falling back to a plain import), then its handler is taken
 * from a default export or a captured `Deno.serve()` call. Load failures warn
 * and skip rather than throwing, so one broken function can't block startup.
 * With `lazy`, functions are only discovered here and load on first request.
 */
export async function loadFunctions(
  projectDir: string,
  options: Record<string, LoadFunctionOptions> = {},
  behavior: LoadFunctionsBehavior = {}
): Promise<Map<string, EdgeFunction>> {
  const functions = new Map<string, EdgeFunction>()
  const root = join(projectDir, 'supabase', 'functions')

  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return functions
  }

  // so Supabase-style `Deno.serve(handler)` functions run unchanged
  installDenoShim()

  for (const name of entries) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    if (options[name]?.enabled === false) continue // disabled in config.toml
    const dir = join(root, name)
    if (!(await stat(dir)).isDirectory()) continue
    // A config.toml entrypoint overrides the default index.* discovery.
    const candidates = options[name]?.entrypoint
      ? [join(projectDir, options[name].entrypoint!)]
      : ['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map((f) => join(dir, f))
    for (const path of candidates) {
      try {
        await stat(path)
      } catch {
        continue
      }
      if (behavior.lazy) {
        functions.set(name, lazyFunction(path, name, root))
        break
      }
      try {
        functions.set(name, await serialized(() => importHandler(path, name, root)))
      } catch (e) {
        const msg = describeLoadError(name, e)
        console.warn(`  warning: ${/has no default export/.test(msg) ? `function "${name}" has no default export or Deno.serve() handler, skipped` : msg}`)
      }
      break
    }
  }
  return functions
}
