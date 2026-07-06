/** PGlite (WASM) engine — imported dynamically so native mode never loads the WASM bundle. */
import type { DbEngine, EngineResults, EngineTx } from './engine.js'

export async function createPgliteEngine(dataDir?: string): Promise<DbEngine> {
  let PGlite, extensions
  try {
    ;({ PGlite } = await import('@electric-sql/pglite'))
    // Supabase enables these by default; load the bundled contrib so migrations
    // that call uuid_generate_v4(), crypt(), citext, etc. work out of the box.
    const [uuid_ossp, pgcrypto, citext, pg_trgm, ltree, hstore, fuzzystrmatch] = await Promise.all([
      import('@electric-sql/pglite/contrib/uuid_ossp').then((m) => m.uuid_ossp),
      import('@electric-sql/pglite/contrib/pgcrypto').then((m) => m.pgcrypto),
      import('@electric-sql/pglite/contrib/citext').then((m) => m.citext),
      import('@electric-sql/pglite/contrib/pg_trgm').then((m) => m.pg_trgm),
      import('@electric-sql/pglite/contrib/ltree').then((m) => m.ltree),
      import('@electric-sql/pglite/contrib/hstore').then((m) => m.hstore),
      import('@electric-sql/pglite/contrib/fuzzystrmatch').then((m) => m.fuzzystrmatch),
    ])
    extensions = { uuid_ossp, pgcrypto, citext, pg_trgm, ltree, hstore, fuzzystrmatch }
  } catch (e) {
    if (e instanceof Error && /wasm/.test(e.message)) throw e
    throw new Error(
      'the PGlite (wasm) engine is not available in this build — run with --engine native'
    )
  }
  const pg = new PGlite({ dataDir, extensions })
  await pg.waitReady

  return {
    async query<T>(sql: string, params?: unknown[]): Promise<EngineResults<T>> {
      const res = await pg.query<T>(sql, params)
      return { rows: res.rows, affectedRows: res.affectedRows }
    },
    async exec(sql: string): Promise<void> {
      await pg.exec(sql)
    },
    transaction<T>(fn: (tx: EngineTx) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        return fn({
          async query<R>(sql: string, params?: unknown[]): Promise<EngineResults<R>> {
            const res = await tx.query<R>(sql, params)
            return { rows: res.rows, affectedRows: res.affectedRows }
          },
          async exec(sql: string): Promise<void> {
            await tx.exec(sql)
          },
        })
      }) as Promise<T>
    },
    async listen(channel: string, cb: (payload: string) => void): Promise<() => void> {
      return pg.listen(channel, cb)
    },
    close: () => pg.close(),
  }
}
