/**
 * Logical export and import of a native-engine project: a portable archive of
 * the database and its stored files.
 *
 * The archive is a tar.gz holding `globals.sql` (roles, from `pg_dumpall
 * --globals-only`, without passwords), `dump.sql` (`pg_dump` of the database),
 * `storage/` (the uploaded objects) and `manifest.json`. A seed-only database
 * dumps to a few KB where a copy of its data directory is tens of MB, and a dump
 * still loads after a Postgres major upgrade, where a data directory does not.
 *
 * Export works against a running server - `pg_dump` reads one consistent
 * snapshot, so nothing has to stop - or starts Postgres briefly when none is
 * running. Import needs the data directory empty and no server on it: it creates
 * the cluster, loads roles and data, and stops; the next `tinbase start` opens it
 * like any existing database.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { checkPristine, type PristineState } from '../../db/pristine.js'
import type { DbEngine } from '../../db/engine.js'
import { attachNativeEngine, createNativeEngine, ensurePostgres, readRunningPostmaster } from './engine.js'

const run = promisify(execFile)

export const DUMP_FORMAT = 'tinbase-dump'
export const DUMP_VERSION = 1
/** Where `tinbase start` looks for an archive to restore before it opens the database (relative to --dir). */
export const RESTORE_FILE = join('.tinbase', 'restore.tar.gz')

export interface DumpManifest {
  format: typeof DUMP_FORMAT
  version: number
  createdAt: string
  /** server_version of the database that was dumped */
  postgres: string
  /**
   * sha256 of the roles, the dump and every stored file (path and bytes). Equal
   * hashes mean equal contents, so a host can skip keeping an archive identical
   * to the last one; the archive bytes themselves differ by `createdAt`.
   */
  contentHash: string
  pristine: PristineState
}

export interface ExportOptions {
  dataDir: string
  storageDir: string
  /** archive to write (.tar.gz) */
  outFile: string
  log?: (m: string) => void
}

export interface ImportOptions {
  dataDir: string
  storageDir: string
  /** archive written by {@link exportProject} */
  file: string
  /** replace an existing (stopped) data directory and storage */
  force?: boolean
  log?: (m: string) => void
}

/** A live postmaster for `dataDir`: the running server's, or one started for this call. */
async function postmasterFor(
  dataDir: string,
  log?: (m: string) => void
): Promise<{ engine: DbEngine; socketDir: string; port: number }> {
  const attached = await attachNativeEngine(dataDir)
  const engine = attached ?? (await createNativeEngine({ dataDir, log }))
  await engine.query('select 1') // connects lazily; the pid file says ready only once it serves
  const pm = readRunningPostmaster(dataDir)
  if (!pm) {
    await engine.close()
    throw new Error(`no ready postgres on ${dataDir}`)
  }
  return { engine, socketDir: pm.socketDir, port: pm.port }
}

async function pgTool(name: string): Promise<string> {
  return join(await ensurePostgres(), 'bin', name)
}

async function pgArgs(socketDir: string, port: number): Promise<string[]> {
  return ['-h', socketDir, '-p', String(port), '-U', 'postgres', '--no-password']
}

async function dirHasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}

/** Every regular file under `dir`, as paths relative to it, sorted. */
async function filesUnder(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await filesUnder(dir, p)))
    else if (e.isFile()) out.push(p)
  }
  return out.sort()
}

/** See {@link DumpManifest.contentHash}: roles, dump and stored files of a staged export. */
async function contentHash(stage: string): Promise<string> {
  const h = createHash('sha256')
  for (const name of ['globals.sql', 'dump.sql']) {
    // pg_dump brackets its output in \restrict / \unrestrict with a fresh random
    // key every run (it stops a crafted dump from running psql meta-commands on
    // restore), so those lines differ between dumps of the same database.
    const sql = (await readFile(join(stage, name), 'utf8')).replace(/^\\(un)?restrict .*$/gm, '')
    h.update(`${name}\0`).update(sql)
  }
  for (const p of await filesUnder(join(stage, 'storage'))) {
    h.update(`storage/${p}\0`).update(await readFile(join(stage, 'storage', p)))
  }
  return h.digest('hex')
}

/** Export the database and stored files to `outFile`. */
export async function exportProject(opts: ExportOptions): Promise<{ bytes: number; manifest: DumpManifest }> {
  const stage = await mkdtemp(join(tmpdir(), 'tb-export-'))
  const { engine, socketDir, port } = await postmasterFor(opts.dataDir, opts.log)
  try {
    const conn = await pgArgs(socketDir, port)
    await run(await pgTool('pg_dumpall'), [...conn, '--globals-only', '--no-role-passwords', '-f', join(stage, 'globals.sql')])
    await run(await pgTool('pg_dump'), [...conn, '-d', 'postgres', '-f', join(stage, 'dump.sql')], {
      maxBuffer: 16 * 1024 * 1024,
    })
    await mkdir(join(stage, 'storage'), { recursive: true })
    if (existsSync(opts.storageDir)) await cp(opts.storageDir, join(stage, 'storage'), { recursive: true })
    const version = await engine.query<{ v: string }>(`select current_setting('server_version') as v`)
    const pristine = await checkPristine(engine).catch(
      (e): PristineState => ({ pristine: false, state: 'unknown', reason: (e as Error)?.message ?? String(e) })
    )
    const manifest: DumpManifest = {
      format: DUMP_FORMAT,
      version: DUMP_VERSION,
      createdAt: new Date().toISOString(),
      postgres: version.rows[0]?.v ?? '',
      contentHash: await contentHash(stage),
      pristine,
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

    await run('tar', ['-czf', opts.outFile, '-C', stage, '.'])
    return { bytes: (await stat(opts.outFile)).size, manifest }
  } finally {
    await engine.close()
    await rm(stage, { recursive: true, force: true })
  }
}

/** Read an archive's manifest without importing it. */
export async function readManifest(file: string): Promise<DumpManifest> {
  const { stdout } = await run('tar', ['-xzOf', file, './manifest.json'])
  return parseManifest(stdout)
}

function parseManifest(text: string): DumpManifest {
  const m = JSON.parse(text) as DumpManifest
  if (m?.format !== DUMP_FORMAT) throw new Error('not a tinbase export archive')
  if (m.version !== DUMP_VERSION) throw new Error(`unsupported tinbase export version ${m.version}`)
  return m
}

/**
 * Roles as `pg_dumpall` wrote them, minus the bootstrap superuser: a new cluster
 * already has it, and creating it again fails the load.
 */
export function rolesSql(globals: string): string {
  return globals
    .split('\n')
    .filter((line) => line.trim() !== 'CREATE ROLE postgres;')
    .join('\n')
}

/**
 * Create a database from an archive written by {@link exportProject}.
 *
 * The archive loads into a new cluster beside the data directory, which takes
 * the data directory's place only once everything loaded. A bad archive or a
 * failed load leaves the existing database and storage exactly as they were.
 */
export async function importProject(opts: ImportOptions): Promise<DumpManifest> {
  if (readRunningPostmaster(opts.dataDir)) {
    throw new Error(`a server is running on ${opts.dataDir}; stop it before importing`)
  }
  const replacing = await dirHasEntries(opts.dataDir)
  if (replacing && !opts.force) throw new Error(`${opts.dataDir} already holds a database; pass force to replace it`)

  const stage = await mkdtemp(join(tmpdir(), 'tb-import-'))
  const newData = `${opts.dataDir}.importing`
  const newStorage = `${opts.storageDir}.importing`
  try {
    await run('tar', ['-xzf', opts.file, '-C', stage])
    const manifest = parseManifest(await readFile(join(stage, 'manifest.json'), 'utf8'))
    await writeFile(join(stage, 'roles.sql'), rolesSql(await readFile(join(stage, 'globals.sql'), 'utf8')))

    await rm(newData, { recursive: true, force: true })
    const engine = await createNativeEngine({ dataDir: newData, log: opts.log })
    try {
      await engine.query('select 1')
      const pm = readRunningPostmaster(newData)
      if (!pm) throw new Error(`postgres did not come up on ${newData}`)
      const psql = await pgTool('psql')
      const conn = [...(await pgArgs(pm.socketDir, pm.port)), '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1']
      await run(psql, [...conn, '-f', join(stage, 'roles.sql')])
      await run(psql, [...conn, '--single-transaction', '-f', join(stage, 'dump.sql')], {
        maxBuffer: 16 * 1024 * 1024,
      })
    } finally {
      await engine.close()
    }

    await rm(newStorage, { recursive: true, force: true })
    await cp(join(stage, 'storage'), newStorage, { recursive: true })

    // Everything loaded: swap the new database and storage in.
    await rm(opts.dataDir, { recursive: true, force: true })
    await rename(newData, opts.dataDir)
    await rm(opts.storageDir, { recursive: true, force: true })
    await rename(newStorage, opts.storageDir)
    return manifest
  } finally {
    await rm(stage, { recursive: true, force: true })
    await rm(newData, { recursive: true, force: true })
    await rm(newStorage, { recursive: true, force: true })
  }
}
