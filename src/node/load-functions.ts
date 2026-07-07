/** Loads edge functions from supabase/functions/<name>/index.{ts,js,mjs} (Node only). */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EdgeFunction } from '../functions/handler.js'
import { installDenoShim, resetCapturedHandler, takeCapturedHandler } from '../functions/deno-shim.js'

export async function loadFunctions(projectDir: string): Promise<Map<string, EdgeFunction>> {
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
    const dir = join(root, name)
    if (!(await stat(dir)).isDirectory()) continue
    for (const file of ['index.ts', 'index.js', 'index.mjs']) {
      const path = join(dir, file)
      try {
        await stat(path)
      } catch {
        continue
      }
      try {
        resetCapturedHandler()
        const mod = (await import(pathToFileURL(path).href)) as { default?: EdgeFunction }
        // prefer an explicit default export; otherwise use the handler a
        // Deno.serve() call captured during import
        const denoHandler = takeCapturedHandler()
        const handler = typeof mod.default === 'function' ? mod.default : denoHandler ? (req: Request) => denoHandler(req) : undefined
        if (handler) {
          functions.set(name, handler as EdgeFunction)
        } else {
          console.warn(`  warning: function "${name}" has no default export or Deno.serve() handler, skipped`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (file === 'index.ts' && /Unknown file extension|Cannot find module/.test(msg)) {
          console.warn(`  warning: function "${name}" is TypeScript — run tinbase with tsx or bun, or compile it to .js`)
        } else {
          console.warn(`  warning: failed to load function "${name}": ${msg}`)
        }
      }
      break
    }
  }
  return functions
}
