/**
 * In-process HTTP sender for the pg_net emulation — the execution half of the
 * net.* surface (the net.http_get/post/delete SQL functions live in
 * db/emulated.ts). It drains net.http_request_queue, performs each request with
 * fetch, and records the reply in net._http_response, mirroring pg_net's
 * background worker. No C extension, works on the wasm and native engines.
 */
import type { Database } from '../db/database.js'

interface RequestRow {
  id: number
  method: string
  url: string
  headers: Record<string, string> | string | null
  body: string | null
  timeout_milliseconds: number
}

export interface NetDelivery {
  id: number
  method: string
  url: string
  status?: number
  timedOut: boolean
  error?: string
}

export class NetService {
  private timer: ReturnType<typeof setInterval> | null = null
  private draining = false

  constructor(
    private db: Database,
    private fetchImpl: typeof fetch = fetch,
    /** how often to drain the queue (ms) */
    private tickMs = 500,
    private onDeliver?: (d: NetDelivery) => void
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    if (typeof this.timer === 'object' && 'unref' in this.timer) (this.timer as { unref: () => void }).unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Drain any queued requests once (also callable directly in tests). */
  async tick(): Promise<void> {
    if (this.draining) return // never overlap drains — one writer at a time
    this.draining = true
    try {
      let rows: RequestRow[]
      try {
        rows = (
          await this.db.query<RequestRow>(
            `select id, method, url, headers, body, timeout_milliseconds from net.http_request_queue order by id limit 20`
          )
        ).rows
      } catch {
        return // net.* not present (e.g. the pg-mem subset engine)
      }
      for (const row of rows) await this.deliver(row)
    } finally {
      this.draining = false
    }
  }

  private async deliver(row: RequestRow): Promise<void> {
    const headers =
      typeof row.headers === 'string' ? (JSON.parse(row.headers) as Record<string, string>) : row.headers ?? {}
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), row.timeout_milliseconds || 5000)

    let status: number | null = null
    let contentType: string | null = null
    let content: string | null = null
    let respHeaders: Record<string, string> | null = null
    let timedOut = false
    let errorMsg: string | null = null

    try {
      const hasBody = row.method !== 'GET' && row.method !== 'HEAD'
      const res = await this.fetchImpl(row.url, {
        method: row.method,
        headers,
        body: hasBody ? row.body ?? undefined : undefined,
        signal: controller.signal,
      })
      status = res.status
      contentType = res.headers.get('content-type')
      respHeaders = Object.fromEntries(res.headers.entries())
      content = await res.text()
    } catch (e) {
      if (controller.signal.aborted) timedOut = true
      errorMsg = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }

    // record the response and remove the request from the queue (best-effort)
    try {
      await this.db.query(
        `insert into net._http_response (id, status_code, content_type, headers, content, timed_out, error_msg)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7) on conflict (id) do nothing`,
        [row.id, status, contentType, respHeaders ? JSON.stringify(respHeaders) : null, content, timedOut, errorMsg]
      )
      await this.db.query(`delete from net.http_request_queue where id = $1`, [row.id])
    } catch {
      // if recording fails, leave the row so the next tick retries
    }

    this.onDeliver?.({
      id: row.id,
      method: row.method,
      url: row.url,
      status: status ?? undefined,
      timedOut,
      error: errorMsg ?? undefined,
    })
  }
}
