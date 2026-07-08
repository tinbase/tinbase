/**
 * In-process scheduler that runs the jobs recorded in cron.job — the execution
 * half of our pg_cron emulation (the cron.schedule()/unschedule() SQL functions
 * live in db/emulated.ts). Supports standard 5-field cron expressions and
 * pg_cron's "N seconds" form. Cron fields are matched in UTC, to match hosted
 * pg_cron (which runs in UTC). Runs due job commands as superuser and logs each
 * run to cron.job_run_details.
 */
import type { Database } from '../db/database.js'

interface JobRow {
  jobid: number
  schedule: string
  command: string
  jobname: string | null
  active: boolean
}

export class CronService {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRun = new Map<number, number>() // jobid → epoch ms of last run
  private lastMinute = new Map<number, number>() // jobid → minute bucket last run

  constructor(
    private db: Database,
    /** how often to check for due jobs (ms). Small so "N seconds" jobs are timely. */
    private tickMs = 1000,
    private now: () => Date = () => new Date()
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

  /** Run any due jobs once (also callable directly in tests). */
  async tick(): Promise<void> {
    let jobs: JobRow[]
    try {
      jobs = (await this.db.query<JobRow>(`select jobid, schedule, command, jobname, active from cron.job where active`)).rows
    } catch {
      return // cron.job not present yet
    }
    const now = this.now()
    for (const job of jobs) {
      if (this.isDue(job, now)) await this.run(job, now)
    }
  }

  private isDue(job: JobRow, now: Date): boolean {
    const secs = job.schedule.match(/^(\d+)\s*seconds?$/i)
    if (secs) {
      const interval = parseInt(secs[1], 10) * 1000
      const last = this.lastRun.get(job.jobid) ?? 0
      return now.getTime() - last >= interval
    }
    if (!cronMatches(job.schedule, now)) return false
    // minute-granularity: run at most once per matching minute
    const bucket = Math.floor(now.getTime() / 60000)
    return this.lastMinute.get(job.jobid) !== bucket
  }

  private async run(job: JobRow, now: Date): Promise<void> {
    this.lastRun.set(job.jobid, now.getTime())
    this.lastMinute.set(job.jobid, Math.floor(now.getTime() / 60000))
    const start = new Date()
    try {
      await this.db.query(job.command)
      await this.log(job, 'succeeded', null, start)
    } catch (e) {
      await this.log(job, 'failed', e instanceof Error ? e.message : String(e), start)
    }
  }

  private async log(job: JobRow, status: string, message: string | null, start: Date): Promise<void> {
    try {
      await this.db.query(
        `insert into cron.job_run_details (jobid, command, status, return_message, start_time, end_time)
         values ($1, $2, $3, $4, $5, now())`,
        [job.jobid, job.command, status, message, start.toISOString()]
      )
    } catch {
      // logging is best-effort
    }
  }
}

/**
 * Match a Date against a standard 5-field cron expression (min hour dom month
 * dow). Fields are evaluated in UTC, matching hosted pg_cron.
 */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const parts = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()]
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ]
  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(fields[i], parts[i], ranges[i][0], ranges[i][1])) return false
  }
  return true
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    if (matchPart(part, value, min, max)) return true
  }
  return false
}

function matchPart(part: string, value: number, min: number, max: number): boolean {
  // step: */K or range/K
  let step = 1
  let rangeStr = part
  const slash = part.indexOf('/')
  if (slash !== -1) {
    step = parseInt(part.slice(slash + 1), 10) || 1
    rangeStr = part.slice(0, slash)
  }
  let lo = min
  let hi = max
  if (rangeStr !== '*') {
    if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-').map(Number)
      lo = a
      hi = b
    } else {
      const n = Number(rangeStr)
      if (Number.isNaN(n)) return false
      if (slash === -1) return n === value
      lo = n
      hi = max
    }
  }
  if (value < lo || value > hi) return false
  return (value - lo) % step === 0
}
