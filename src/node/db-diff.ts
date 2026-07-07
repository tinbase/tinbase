/**
 * `tinbase db diff` core: diff the live project database (which may contain
 * changes made outside migrations) against a fresh "shadow" database that has
 * only the migrations applied. The emitted DDL is the delta you'd save as a
 * new migration.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend, type TinbaseBackend } from '../index.js'
import { snapshotSchema, diffSchemas } from '../db/schema-diff.js'
import type { MigrationFile } from '../types.js'

export interface DbDiffOptions {
  /** the live project's data dir (wasm) or undefined when a native engine is passed */
  liveDataDir?: string
  liveEngine?: import('../db/engine.js').DbEngine
  migrations: MigrationFile[]
  seedSql?: string
  schema?: string
  /** factory for the shadow engine (native mode); omit for wasm/in-memory shadow */
  makeShadowEngine?: () => Promise<import('../db/engine.js').DbEngine>
}

export async function computeDbDiff(opts: DbDiffOptions): Promise<string[]> {
  const schema = opts.schema ?? 'public'

  // shadow = migrations only, fresh
  const shadow: TinbaseBackend = await createBackend({
    engine: opts.makeShadowEngine ? await opts.makeShadowEngine() : undefined,
    migrations: opts.migrations,
    // no seed: seed is data, not schema
  })
  // live = current project db (createBackend only applies *pending* migrations, so
  // this reflects the actual current schema including out-of-migration changes)
  const live: TinbaseBackend = await createBackend({
    engine: opts.liveEngine,
    dataDir: opts.liveEngine ? undefined : opts.liveDataDir,
    migrations: opts.migrations,
  })

  try {
    const shadowSnap = await snapshotSchema(shadow.db, schema)
    const liveSnap = await snapshotSchema(live.db, schema)
    return diffSchemas(shadowSnap, liveSnap, schema)
  } finally {
    await shadow.close()
    await live.close()
  }
}

export function shadowNativeDataDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'tinbase-shadow-')), 'pg')
}
