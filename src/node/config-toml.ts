/**
 * A minimal TOML reader for supabase/config.toml - just enough of the format to
 * read a real Supabase project's settings, without a TOML dependency. It handles
 * the subset config.toml actually uses:
 *
 *   - `[section]` and dotted `[section.sub.name]` table headers
 *   - `key = value` scalars (string, bool, integer)
 *   - string arrays, on one line or spread across several:
 *     `key = ["a", "b"]`, or the same entries one per line
 *   - `#` line and inline comments
 *   - `env(VAR)` substitution against process.env (or a provided env)
 *
 * It does NOT handle inline tables (`{ a = 1 }`) or dotted keys inside a table
 * body - neither of which config.toml uses for the settings we read. Each
 * loader (auth, api, storage, functions, oauth) reads from the one parsed tree
 * instead of re-scanning the file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A parsed table: its scalar/array values plus nested child tables. */
export interface ConfigTable {
  /** scalar and array values declared directly under this table, by key */
  values: Map<string, string | string[]>
  /** nested child tables, by their (single, undotted) segment name */
  children: Map<string, ConfigTable>
}

function emptyTable(): ConfigTable {
  return { values: new Map(), children: new Map() }
}

/** Parse config.toml at `projectDir/supabase/config.toml`; empty root if absent/unreadable. */
export function loadConfigToml(projectDir: string, env: NodeJS.ProcessEnv = process.env): ConfigTable {
  let text: string
  try {
    text = readFileSync(join(projectDir, 'supabase', 'config.toml'), 'utf8')
  } catch {
    return emptyTable()
  }
  return parseConfigToml(text, env)
}

/** Parse TOML `text` into a table tree, resolving `env(VAR)` references. */
export function parseConfigToml(text: string, env: NodeJS.ProcessEnv = process.env): ConfigTable {
  const root = emptyTable()
  let current = root
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim()
    if (!line) continue
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) {
      current = descend(root, header[1].split('.').map((s) => s.trim()))
      continue
    }
    // A bare key, or a quoted one for what TOML cannot spell bare, such as a
    // phone number with its `+` in [auth.sms.test_otp].
    const kv = line.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*(.+)$/)
    if (!kv) continue
    const key = kv[1] ?? kv[2] ?? kv[3]
    let raw = kv[4].trim()
    // An array may be spread over several lines, which is how Supabase itself
    // writes a long one. Join them before parsing so the value below sees a
    // single `["a", "b"]` however the file was formatted. Read only as far as
    // the brackets balance: a file that never closes one is malformed, and
    // swallowing the rest of it would lose every setting that follows.
    if (raw.startsWith('[') && bracketDepth(raw) > 0) {
      const parts = [raw]
      let j = i
      while (++j < lines.length) {
        const next = stripComment(lines[j]).trim()
        if (/^\[([^\]]+)\]$/.test(next)) break // a table header: the array was never closed
        parts.push(next)
        if (bracketDepth(parts.join(' ')) === 0) {
          raw = parts.join(' ')
          i = j
          break
        }
      }
    }
    const value = parseValue(raw, env)
    if (value !== undefined) current.values.set(key, value)
  }
  return root
}

/** Net `[` minus `]` outside quoted strings, so brackets inside a value don't count. */
function bracketDepth(s: string): number {
  let depth = 0
  let quote: string | null = null
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '[') {
      depth++
    } else if (c === ']') {
      depth--
    }
  }
  return depth
}

/** Walk/create the table at the given dotted path. */
function descend(root: ConfigTable, path: string[]): ConfigTable {
  let t = root
  for (const key of path) {
    let next = t.children.get(key)
    if (!next) {
      next = emptyTable()
      t.children.set(key, next)
    }
    t = next
  }
  return t
}

/** Remove a `#` comment that isn't inside a quoted string. */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

/** Parse a scalar or array value (already joined to one line), resolving env() and stripping quotes. */
function parseValue(raw: string, env: NodeJS.ProcessEnv): string | string[] | undefined {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (inner === '') return []
    return inner
      .split(',')
      .map((s) => resolveScalar(s.trim(), env))
      .filter((s): s is string => s !== undefined && s !== '')
  }
  return resolveScalar(raw, env)
}

/** Strip quotes and expand an `env(VAR)` reference to its value. */
function resolveScalar(raw: string, env: NodeJS.ProcessEnv): string | undefined {
  const v = raw.trim().replace(/^["']|["']$/g, '')
  const m = v.match(/^env\(\s*"?([A-Za-z0-9_]+)"?\s*\)$/)
  if (m) return env[m[1]]
  return v
}

// ── typed accessors ───────────────────────────────────────────────────────

/** Child table at a dotted path, or undefined if any segment is missing. */
export function tableAt(root: ConfigTable, path: string): ConfigTable | undefined {
  let t: ConfigTable | undefined = root
  for (const key of path.split('.')) {
    t = t?.children.get(key)
    if (!t) return undefined
  }
  return t
}

/** String value at `key`, or undefined if absent, empty, or an array. */
export function getString(table: ConfigTable | undefined, key: string): string | undefined {
  const v = table?.values.get(key)
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Boolean value at `key`, or undefined if absent or not exactly true/false. */
export function getBool(table: ConfigTable | undefined, key: string): boolean | undefined {
  const v = table?.values.get(key)
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

/** Integer value at `key` (base 10), or undefined if absent or unparseable. */
export function getInt(table: ConfigTable | undefined, key: string): number | undefined {
  const v = table?.values.get(key)
  if (typeof v !== 'string') return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

/** String-array value at `key`, or undefined if absent or a scalar. */
export function getStringArray(table: ConfigTable | undefined, key: string): string[] | undefined {
  const v = table?.values.get(key)
  return Array.isArray(v) ? v : undefined
}

/**
 * Parse a Go duration to seconds: a single unit ("1m", "24h", "10s") or the
 * compound form Supabase itself writes ("1m0s", "24h0m0s").
 *
 * The compound form matters - it is what lands in the file when Supabase
 * generates it - and reading only the first unit turns "1m0s" into 1 second
 * and "24h0m0s" into 24, quietly shortening a window by orders of magnitude.
 *
 * Returns undefined if absent or malformed.
 */
export function getDurationSeconds(table: ConfigTable | undefined, key: string): number | undefined {
  const v = table?.values.get(key)
  if (typeof v !== 'string') return undefined
  const text = v.trim()
  if (/^(\d+\s*[hms]\s*)+$/i.test(text)) {
    let total = 0
    for (const [, digits, unit] of text.matchAll(/(\d+)\s*([hms])/gi)) {
      const n = parseInt(digits, 10)
      total += unit.toLowerCase() === 'h' ? n * 3600 : unit.toLowerCase() === 'm' ? n * 60 : n
    }
    return total
  }
  const n = parseInt(text, 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Parse a Supabase byte-size string ("50MiB", "5MB", "500KB") to bytes.
 * Returns undefined if absent or malformed.
 */
export function getByteSize(table: ConfigTable | undefined, key: string): number | undefined {
  const v = table?.values.get(key)
  if (typeof v !== 'string') return undefined
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i)
  if (!m) return undefined
  const n = parseFloat(m[1])
  const unit = (m[2] ?? 'b').toLowerCase()
  const mult: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 * 1000,
    mib: 1024 * 1024,
    gb: 1000 * 1000 * 1000,
    gib: 1024 * 1024 * 1024,
  }
  return Math.round(n * (mult[unit] ?? 1))
}
