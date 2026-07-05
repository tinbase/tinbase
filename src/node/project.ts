/** Loads migrations + seed following Supabase CLI conventions (supabase/ dir). */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MigrationFile } from '../types.js'

export interface SupabaseProject {
  migrations: MigrationFile[]
  seedSql?: string
}

export async function loadSupabaseProject(projectDir: string): Promise<SupabaseProject> {
  const migrationsDir = join(projectDir, 'supabase', 'migrations')
  const migrations: MigrationFile[] = []

  let entries: string[] = []
  try {
    entries = await readdir(migrationsDir)
  } catch {
    // no migrations directory — that's fine
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.sql')) continue
    const sql = await readFile(join(migrationsDir, entry), 'utf8')
    migrations.push({ name: entry.replace(/\.sql$/, ''), sql })
  }

  let seedSql: string | undefined
  try {
    seedSql = await readFile(join(projectDir, 'supabase', 'seed.sql'), 'utf8')
  } catch {
    // no seed file
  }

  return { migrations, seedSql }
}
