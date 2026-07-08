/**
 * In-memory ring buffer of recent server log lines, surfaced in the Studio
 * "Logs" pane (and available as backend.logs). Captures request lines and the
 * internal log() output (migrations, mail, webhooks, cron). Dev convenience —
 * bounded, never persisted.
 */
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string
  level: LogLevel
  msg: string
}

export class LogBuffer {
  private entries: LogEntry[] = []
  constructor(private cap = 500) {}

  push(msg: string, level: LogLevel = 'info'): void {
    this.entries.push({ ts: new Date().toISOString(), level, msg })
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap)
  }

  /** Most recent first. */
  list(limit = 200): LogEntry[] {
    return this.entries.slice(-limit).reverse()
  }

  clear(): void {
    this.entries = []
  }
}
