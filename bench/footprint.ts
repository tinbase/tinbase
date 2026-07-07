/**
 * Memory + disk footprint benchmark: tinbase vs PocketBase vs Supabase local.
 *
 * Workload (identical for all three): 1,000 single-row inserts, then 1,000
 * filtered list queries against the same table/collection.
 *
 * Usage:
 *   npx tsx bench/footprint.ts tinbase
 *   POCKETBASE_BIN=/path/to/pocketbase npx tsx bench/footprint.ts pocketbase
 *   npx tsx bench/footprint.ts supabase   (needs Docker + supabase CLI)
 *
 * Results are appended to bench/results.json.
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROWS = 1000
const READS = 1000
const RESULTS_FILE = join(import.meta.dirname, 'results.json')

const BENCH_TABLE_SQL = `
create table bench_items (
  id serial primary key,
  name text not null,
  value int not null,
  data jsonb default '{}'::jsonb
);
`

interface Result {
  target: string
  bootRssMb: number
  workloadRssMb: number
  dataDiskMb: number
  installDiskMb: number
  insertSecs: number
  readSecs: number
  notes: string
  measuredAt: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Physical footprint via vmmap — on macOS `ps rss` over-reports WASM-heavy
 * processes (counts reusable/compressed pages); physical footprint is what
 * the OS actually attributes to the process.
 */
function rssTreeMb(rootPid: number): number {
  try {
    const out = execSync(`vmmap --summary ${rootPid} 2>/dev/null | grep 'Physical footprint:'`).toString()
    const m = out.match(/Physical footprint:\s+([\d.]+)([KMG])/)
    if (m) {
      const v = parseFloat(m[1])
      return Math.round((m[2] === 'G' ? v * 1024 : m[2] === 'K' ? v / 1024 : v) * 10) / 10
    }
  } catch {
    // fall through to ps
  }
  const out = execSync(`ps -o rss= -p ${rootPid}`).toString().trim()
  return Math.round((parseInt(out, 10) / 1024) * 10) / 10
}

function descendants(rootPid: number): number[] {
  const lines = execSync(`ps -axo pid=,ppid=`).toString().trim().split('\n')
  const children = new Map<number, number[]>()
  for (const line of lines) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid)!.push(pid)
  }
  const out: number[] = []
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop()!
    out.push(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  return out
}

function treeFootprintMb(rootPid: number): number {
  let total = 0
  for (const pid of descendants(rootPid)) {
    try {
      total += rssTreeMb(pid)
    } catch {
      // process may have exited between listing and measuring
    }
  }
  return Math.round(total * 10) / 10
}

function duMb(path: string): number {
  const out = execSync(`du -sk "${path}"`).toString().trim()
  return Math.round((parseInt(out, 10) / 1024) * 10) / 10
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch {
      // not up yet
    }
    await sleep(300)
  }
  throw new Error(`timeout waiting for ${url}`)
}

function saveResult(result: Result): void {
  const all: Result[] = existsSync(RESULTS_FILE) ? JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) : []
  const filtered = all.filter((r) => r.target !== result.target)
  filtered.push(result)
  writeFileSync(RESULTS_FILE, JSON.stringify(filtered, null, 2))
  console.log(`\nsaved to bench/results.json:`)
  console.log(JSON.stringify(result, null, 2))
}

// ── supabase-js workload (tinbase + supabase) ──────────────────────────────

async function supabaseJsWorkload(url: string, anonKey: string): Promise<{ insertSecs: number; readSecs: number }> {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })

  let t = Date.now()
  for (let i = 0; i < ROWS; i++) {
    const { error } = await client
      .from('bench_items')
      .insert({ name: `item-${i}`, value: i % 100, data: { idx: i, tags: ['a', 'b'] } })
    if (error) throw new Error(`insert failed at ${i}: ${error.message}`)
  }
  const insertSecs = (Date.now() - t) / 1000

  t = Date.now()
  for (let i = 0; i < READS; i++) {
    const { error, data } = await client.from('bench_items').select('id, name, value').eq('value', i % 100).limit(20)
    if (error) throw new Error(`read failed at ${i}: ${error.message}`)
    if (data!.length === 0) throw new Error('read returned no rows')
  }
  const readSecs = (Date.now() - t) / 1000
  return { insertSecs, readSecs }
}

// ── target: tinbase ────────────────────────────────────────────────────────

async function benchTinbase(engine: 'wasm' | 'pgmem' = 'wasm'): Promise<void> {
  const dir = join(import.meta.dirname, engine === 'pgmem' ? '.tmp-pgmem' : '.tmp-tinbase')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'supabase', 'migrations', '20240101000000_bench.sql'), BENCH_TABLE_SQL)

  const port = engine === 'pgmem' ? 54444 : 54441
  const args = ['dist/cli.js', 'start', '--dir', dir, '--port', String(port)]
  if (engine === 'pgmem') args.push('--engine', 'pgmem')
  const proc = spawn('node', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let banner = ''
  proc.stdout.on('data', (d) => (banner += d.toString()))

  try {
    await waitForHttp(`http://127.0.0.1:${port}/health`)
    await sleep(2000)
    const bootRssMb = rssTreeMb(proc.pid!)

    const anonKey = banner.match(/anon key: (\S+)/)?.[1]
    if (!anonKey) throw new Error('anon key not found in banner')

    const { insertSecs, readSecs } = await supabaseJsWorkload(`http://127.0.0.1:${port}`, anonKey)
    await sleep(1000)
    const workloadRssMb = rssTreeMb(proc.pid!)
    const dataDiskMb = engine === 'pgmem' ? 0 : duMb(join(dir, '.tinbase'))
    const installDiskMb =
      engine === 'pgmem' ? duMb('node_modules/pg-mem') + duMb('dist') : duMb('node_modules/@electric-sql/pglite') + duMb('dist')

    saveResult({
      target: engine === 'pgmem' ? 'tinbase-pgmem' : 'tinbase',
      bootRssMb,
      workloadRssMb,
      dataDiskMb,
      installDiskMb,
      insertSecs,
      readSecs,
      notes:
        engine === 'pgmem'
          ? 'single node process; pg-mem in-memory subset (no RLS/realtime); install = dist + pg-mem'
          : `single node process; install = dist + @electric-sql/pglite (excludes Node runtime itself)`,
      measuredAt: new Date().toISOString(),
    })
  } finally {
    proc.kill('SIGTERM')
    await sleep(500)
    proc.kill('SIGKILL')
  }
}

// ── target: tinbase-native ─────────────────────────────────────────────────

async function benchTinbaseNative(binary?: string): Promise<void> {
  const dir = join(import.meta.dirname, binary ? '.tmp-tinbase-binary' : '.tmp-tinbase-native')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'supabase', 'migrations', '20240101000000_bench.sql'), BENCH_TABLE_SQL)

  const port = binary ? 54443 : 54442
  const proc = binary
    ? spawn(binary, ['start', '--dir', dir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('node', ['dist/cli.js', 'start', '--dir', dir, '--engine', 'native', '--port', String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
  let banner = ''
  proc.stdout.on('data', (d) => (banner += d.toString()))

  try {
    await waitForHttp(`http://127.0.0.1:${port}/health`, 120_000)
    await sleep(2000)
    const bootRssMb = treeFootprintMb(proc.pid!)

    const anonKey = banner.match(/anon key: (\S+)/)?.[1]
    if (!anonKey) throw new Error('anon key not found in banner')

    const { insertSecs, readSecs } = await supabaseJsWorkload(`http://127.0.0.1:${port}`, anonKey)
    await sleep(1000)
    const workloadRssMb = treeFootprintMb(proc.pid!)
    const dataDiskMb = duMb(join(dir, '.tinbase'))
    const { homedir } = await import('node:os')
    const cache = execSync(`ls -d ${homedir()}/.cache/tinbase/postgresql-* | head -1`).toString().trim()
    const installDiskMb = binary ? duMb(binary) + duMb(cache) : duMb(cache) + duMb('dist')

    saveResult({
      target: binary ? 'tinbase-binary' : 'tinbase-native',
      bootRssMb,
      workloadRssMb,
      dataDiskMb,
      installDiskMb,
      insertSecs,
      readSecs,
      notes: binary
        ? 'single compiled executable (bun) + embedded postgres tree; install = binary + postgres binaries, NO runtime prerequisite'
        : 'node server + embedded native postgres process tree; install = postgres binaries + dist (excludes Node runtime)',
      measuredAt: new Date().toISOString(),
    })
  } finally {
    proc.kill('SIGTERM')
    await sleep(1500)
    proc.kill('SIGKILL')
  }
}

// ── target: pocketbase ─────────────────────────────────────────────────────

async function benchPocketbase(): Promise<void> {
  const bin = process.env.POCKETBASE_BIN
  if (!bin) throw new Error('set POCKETBASE_BIN=/path/to/pocketbase')
  const dir = join(import.meta.dirname, '.tmp-pocketbase')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const email = 'admin@bench.local'
  const password = 'password1234'
  execSync(`"${bin}" superuser upsert ${email} ${password} --dir "${dir}"`, { stdio: 'ignore' })

  const port = 8095
  const base = `http://127.0.0.1:${port}`
  const proc = spawn(bin, ['serve', '--dir', dir, '--http', `127.0.0.1:${port}`], { stdio: 'ignore' })

  try {
    await waitForHttp(`${base}/api/health`)
    await sleep(2000)
    const bootRssMb = rssTreeMb(proc.pid!)

    // authenticate as superuser
    const authRes = await fetch(`${base}/api/collections/_superusers/auth-with-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: email, password }),
    })
    if (!authRes.ok) throw new Error(`pb auth failed: ${await authRes.text()}`)
    const token = ((await authRes.json()) as { token: string }).token
    const headers = { 'content-type': 'application/json', authorization: token }

    // create the bench collection (open rules so parity with anon REST access)
    const colRes = await fetch(`${base}/api/collections`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'bench_items',
        type: 'base',
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'value', type: 'number', required: false },
          { name: 'data', type: 'json', required: false },
        ],
        listRule: '',
        viewRule: '',
        createRule: '',
      }),
    })
    if (!colRes.ok) throw new Error(`pb create collection failed: ${await colRes.text()}`)

    let t = Date.now()
    for (let i = 0; i < ROWS; i++) {
      const res = await fetch(`${base}/api/collections/bench_items/records`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `item-${i}`, value: i % 100, data: { idx: i, tags: ['a', 'b'] } }),
      })
      if (!res.ok) throw new Error(`pb insert failed at ${i}: ${await res.text()}`)
    }
    const insertSecs = (Date.now() - t) / 1000

    t = Date.now()
    for (let i = 0; i < READS; i++) {
      const res = await fetch(
        `${base}/api/collections/bench_items/records?perPage=20&filter=${encodeURIComponent(`value=${i % 100}`)}`,
        { headers }
      )
      if (!res.ok) throw new Error(`pb read failed at ${i}: ${await res.text()}`)
      const body = (await res.json()) as { items: unknown[] }
      if (body.items.length === 0) throw new Error('pb read returned no rows')
    }
    const readSecs = (Date.now() - t) / 1000

    await sleep(1000)
    const workloadRssMb = rssTreeMb(proc.pid!)
    const dataDiskMb = duMb(dir)
    const installDiskMb = duMb(bin)

    saveResult({
      target: 'pocketbase',
      bootRssMb,
      workloadRssMb,
      dataDiskMb,
      installDiskMb,
      insertSecs,
      readSecs,
      notes: 'single Go binary (SQLite), v0.39.5; different API/SDK — measured via its REST API',
      measuredAt: new Date().toISOString(),
    })
  } finally {
    proc.kill('SIGTERM')
    await sleep(500)
    proc.kill('SIGKILL')
  }
}

// ── target: supabase (local docker stack) ──────────────────────────────────

async function benchSupabase(): Promise<void> {
  const dir = join(import.meta.dirname, '.tmp-supabase')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  execSync('supabase init --force', { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'supabase', 'migrations', '20240101000000_bench.sql'), BENCH_TABLE_SQL)
  // shift all ports so we don't collide with any Supabase project already running
  const cfg = join(dir, 'supabase', 'config.toml')
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/port = 543(\d\d)/g, 'port = 545$1'))

  console.log('starting supabase local stack (this takes a minute or two)…')
  execSync('supabase start', { cwd: dir, stdio: 'inherit', timeout: 600_000 })

  const dockerMemMb = (): number => {
    const out = execSync(`docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'`).toString().trim()
    let total = 0
    for (const line of out.split('\n')) {
      const [name, mem] = line.split('\t')
      if (!name?.startsWith('supabase_') || !name.endsWith('_tmp-supabase')) continue
      const m = mem.match(/^([\d.]+)(KiB|MiB|GiB)/)
      if (!m) continue
      const v = parseFloat(m[1])
      total += m[2] === 'GiB' ? v * 1024 : m[2] === 'KiB' ? v / 1024 : v
    }
    return Math.round(total * 10) / 10
  }

  const imagesDiskMb = (): number => {
    const names = execSync(`docker ps --format '{{.Names}}\t{{.Image}}'`)
      .toString()
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('supabase_') && l.split('\t')[0].endsWith('_tmp-supabase'))
      .map((l) => l.split('\t')[1])
    const unique = [...new Set(names)]
    let total = 0
    for (const image of unique) {
      const bytes = execSync(`docker image inspect ${image} --format '{{.Size}}'`).toString().trim()
      total += parseInt(bytes, 10) / 1048576
    }
    return Math.round(total)
  }

  try {
    await sleep(5000)
    const bootRssMb = dockerMemMb()

    const status = JSON.parse(execSync('supabase status -o json', { cwd: dir }).toString()) as Record<string, string>
    const anonKey = status.ANON_KEY
    const apiUrl = status.API_URL ?? 'http://127.0.0.1:54321'

    const { insertSecs, readSecs } = await supabaseJsWorkload(apiUrl, anonKey)
    await sleep(2000)
    const workloadRssMb = dockerMemMb()

    // data disk: postgres data dir inside the db container
    let dataDiskMb = 0
    try {
      const dbContainer = 'supabase_db_tmp-supabase'
      const du = execSync(`docker exec ${dbContainer} du -sk /var/lib/postgresql/data`).toString().trim()
      dataDiskMb = Math.round((parseInt(du, 10) / 1024) * 10) / 10
    } catch {
      // best effort
    }

    saveResult({
      target: 'supabase',
      bootRssMb,
      workloadRssMb,
      dataDiskMb,
      installDiskMb: imagesDiskMb(),
      insertSecs,
      readSecs,
      notes: `sum of docker stats for all supabase_* containers (default local stack); install = sum of docker image sizes (excludes Docker Desktop itself)`,
      measuredAt: new Date().toISOString(),
    })
  } finally {
    console.log('stopping supabase stack…')
    execSync('supabase stop --no-backup', { cwd: dir, stdio: 'ignore', timeout: 300_000 })
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const target = process.argv[2]
if (target === 'tinbase') await benchTinbase()
else if (target === 'tinbase-pgmem') await benchTinbase('pgmem')
else if (target === 'tinbase-native') await benchTinbaseNative()
else if (target === 'tinbase-binary') await benchTinbaseNative(join(import.meta.dirname, '..', 'dist-bin', 'tinbase'))
else if (target === 'pocketbase') await benchPocketbase()
else if (target === 'supabase') await benchSupabase()
else {
  console.error('usage: npx tsx bench/footprint.ts <tinbase|pocketbase|supabase>')
  process.exit(1)
}
process.exit(0)
