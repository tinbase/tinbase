/**
 * Parity harness — the objective scoreboard for tinbase's Supabase compatibility.
 *
 *   npx tsx parity/harness.ts               run scenarios against tinbase, self-scored
 *   npx tsx parity/harness.ts --engine native
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npx tsx parity/harness.ts --compare   also run against a real supabase and diff
 *
 * "Self-scored" = each scenario's expect() gives a pass/fail without needing a
 * real Supabase. "--compare" additionally diffs normalized results against a
 * running `supabase start`, which is the true 1:1 measure.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { SCENARIOS, type Scenario } from './scenarios.js'

const SCHEMA = readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8')
const args = process.argv.slice(2)
const engine = args.includes('--engine') ? args[args.indexOf('--engine') + 1] : 'wasm'
const compare = args.includes('--compare')

/** Replace volatile values so two runs / two backends are comparable. */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return '<uuid>'
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)) return '<timestamp>'
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return '<jwt>'
    return value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as object).sort()) {
      // error objects: keep only the stable, meaningful fields
      out[k] = normalize((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

async function runAll(anon: SupabaseClient, service: SupabaseClient, tag: string) {
  const results: Record<string, { normalized: unknown; pass: boolean | null }> = {}
  for (const s of SCENARIOS) {
    try {
      const raw = await s.run({ anon, service, tag })
      const normalized = normalize(raw)
      results[s.name] = { normalized, pass: s.expect ? s.expect(raw) : null }
    } catch (e) {
      results[s.name] = { normalized: { threw: (e as Error).message }, pass: false }
    }
  }
  return results
}

function clientsFor(url: string, anonKey: string, serviceKey: string, fetchImpl?: typeof fetch) {
  const opts = {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  }
  return {
    anon: createClient(url, anonKey, opts),
    service: createClient(url, serviceKey, opts),
  }
}

async function main() {
  // ── tinbase side ──
  let backend: TinbaseBackend
  let dbEngine
  if (engine === 'native') {
    const { createNativeEngine } = await import('../src/node/native/engine.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    dbEngine = await createNativeEngine({ dataDir: join(mkdtempSync(join(tmpdir(), 'parity-')), 'pg') })
  }
  backend = await createBackend({ engine: dbEngine, migrations: [{ name: '20240101000000_parity', sql: SCHEMA }] })
  // Reuse the tag so normalized results are comparable.
  const tag = Math.random().toString(36).slice(2, 8)
  const tb = clientsFor('http://localhost:54321', backend.anonKey, backend.serviceRoleKey, (i, init) =>
    backend.fetch(new Request(i, init))
  )
  const tbResults = await runAll(tb.anon, tb.service, tag)
  await backend.close()

  const passed = Object.values(tbResults).filter((r) => r.pass === true).length
  const failed = Object.values(tbResults).filter((r) => r.pass === false).length
  const byModule: Record<string, { pass: number; total: number }> = {}
  for (const s of SCENARIOS) {
    byModule[s.module] ??= { pass: 0, total: 0 }
    byModule[s.module].total++
    if (tbResults[s.name].pass === true) byModule[s.module].pass++
  }

  console.log(`\n  tinbase parity — self-scored (engine: ${engine})\n`)
  for (const s of SCENARIOS) {
    const r = tbResults[s.name]
    const mark = r.pass === true ? '✓' : r.pass === false ? '✗' : '·'
    console.log(`  ${mark} [${s.module}] ${s.name}`)
  }
  console.log(`\n  by module:`)
  for (const [m, v] of Object.entries(byModule)) console.log(`    ${m}: ${v.pass}/${v.total}`)
  console.log(`\n  SELF-SCORE: ${passed}/${SCENARIOS.length} pass, ${failed} fail\n`)

  // ── optional: diff against a real supabase start ──
  if (compare) {
    const url = process.env.SUPABASE_URL
    const anonKey = process.env.SUPABASE_ANON_KEY
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !anonKey || !serviceKey) {
      console.log('  --compare needs SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY')
      process.exit(failed > 0 ? 1 : 0)
    }
    console.log(`  comparing normalized results against real supabase at ${url}\n`)
    const sb = clientsFor(url, anonKey, serviceKey)
    const sbResults = await runAll(sb.anon, sb.service, tag)
    // conformance is measured over scenarios that SHOULD match real supabase;
    // documented tinbase-only deviations are reported but not counted against it
    const comparable = SCENARIOS.filter((s) => !s.tinbaseOnly)
    let match = 0
    for (const s of SCENARIOS) {
      if (s.tinbaseOnly) {
        console.log(`  ~ [${s.module}] ${s.name} (tinbase-only, not compared)`)
        continue
      }
      const a = JSON.stringify(tbResults[s.name].normalized)
      const b = JSON.stringify(sbResults[s.name].normalized)
      const same = a === b
      if (same) match++
      console.log(`  ${same ? '=' : '≠'} [${s.module}] ${s.name}`)
      if (!same) {
        console.log(`      tinbase : ${a.slice(0, 200)}`)
        console.log(`      supabase: ${b.slice(0, 200)}`)
      }
    }
    console.log(`\n  CONFORMANCE: ${match}/${comparable.length} identical to real supabase\n`)
    process.exit(match === comparable.length ? 0 : 1)
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
