/**
 * Database engine abstraction. Two implementations:
 *  - PGlite (WASM Postgres) — portable, runs in the browser; heavier RAM.
 *  - Native embedded Postgres (Node only) — PocketBase-class footprint.
 * The rest of tinbase only talks to this interface.
 */

export interface EngineResults<T = any> {
  rows: T[]
  affectedRows?: number
}

export interface EngineTx {
  query<T = any>(sql: string, params?: unknown[]): Promise<EngineResults<T>>
  exec(sql: string): Promise<void>
}

export interface DbEngine {
  /** true for subset engines (pg-mem) that can't run the full plpgsql/RLS bootstrap */
  minimalBootstrap?: boolean
  query<T = any>(sql: string, params?: unknown[]): Promise<EngineResults<T>>
  /** Run multiple SQL statements (no params). */
  exec(sql: string): Promise<void>
  /** Serialized transaction — implementations must guarantee mutual exclusion. */
  transaction<T>(fn: (tx: EngineTx) => Promise<T>): Promise<T>
  /** Subscribe to pg_notify on a channel. Returns unsubscribe. */
  listen(channel: string, cb: (payload: string) => void): Promise<() => void>
  close(): Promise<void>
}

/** Simple async mutex for engines that serialize over one connection. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve()

  async lock(): Promise<() => void> {
    let release!: () => void
    const next = new Promise<void>((r) => (release = r))
    const prev = this.tail
    this.tail = this.tail.then(() => next)
    await prev
    return release
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.lock()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
