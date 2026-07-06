/** Loads edge functions from supabase/functions/<name>/index.{ts,js,mjs} (Node only). */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EdgeFunction } from '../functions/handler.js'

export async function loadFunctions(projectDir: string): Promise<Map<string, EdgeFunction>> {
  const functions = new Map<string, EdgeFunction>()
  const root = join(projectDir, 'supabase', 'functions')

  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return functions
  }

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
        const mod = (await import(pathToFileURL(path).href)) as { default?: EdgeFunction }
        if (typeof mod.default === 'function') {
          functions.set(name, mod.default)
        } else {
          console.warn(`  warning: function "${name}" has no default export, skipped`)
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
