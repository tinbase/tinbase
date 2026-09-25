/**
 * In-memory sliding-window rate limiter for auth endpoints. GoTrue throttles
 * login/signup/OTP/recovery to blunt brute-force and mail-flooding; tinbase
 * mirrors that with per-key windows and returns the same 429 /
 * `over_request_rate_limit` shape. State is per-process (no external store),
 * which is sufficient for a single-process local backend.
 */

/** A single sliding-window limit: at most `limit` hits per `windowMs`. */
export interface RateLimitRule {
  /** max requests permitted within the window */
  limit: number
  /** window length in milliseconds */
  windowMs: number
}

/** Default per-endpoint rules, keyed by the logical action being throttled. */
export const DEFAULT_AUTH_RATE_LIMITS: Record<string, RateLimitRule> = {
  // Password login / token grants: brute-force surface.
  token: { limit: 30, windowMs: 5 * 60 * 1000 },
  signup: { limit: 30, windowMs: 60 * 60 * 1000 },
  // Endpoints that send email (OTP, magic link, recovery): mail-flood surface.
  otp: { limit: 10, windowMs: 60 * 60 * 1000 },
  recover: { limit: 10, windowMs: 60 * 60 * 1000 },
  // Redeeming a code is the same brute-force surface as a password grant: a
  // short OTP is only a few hundred thousand guesses, and the per-address
  // lockout cannot see an attacker who spreads guesses across addresses.
  verify: { limit: 30, windowMs: 5 * 60 * 1000 },
}

/** Per-key sliding-window counter with one background sweep to drop stale buckets. */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  private timer: ReturnType<typeof setInterval> | null = null

  private rules: Record<string, RateLimitRule>

  /** `overrides` (e.g. from config.toml auth.rate_limit.*) replace the matching defaults. */
  constructor(overrides: Record<string, RateLimitRule> = {}) {
    this.rules = { ...DEFAULT_AUTH_RATE_LIMITS, ...overrides }
    // Periodically drop empty buckets so long-lived processes don't grow the
    // map without bound. Unref'd so it never keeps the process alive.
    this.timer = setInterval(() => this.sweep(), 10 * 60 * 1000)
    this.timer.unref?.()
  }

  /**
   * Record an attempt for `action` by `key` (typically IP + identifier).
   * Returns `null` when allowed, or the seconds until the window frees up when
   * the limit is exceeded.
   */
  /**
   * `override` supplies the rule inline, for a limit whose window is a runtime
   * setting rather than a fixed policy (e.g. the per-recipient email
   * frequency, which a project can change without restarting).
   */
  check(action: string, key: string, now: number = Date.now(), override?: RateLimitRule): number | null {
    const rule = override ?? this.rules[action]
    if (!rule) return null
    const bucketKey = `${action}:${key}`
    const cutoff = now - rule.windowMs
    const recent = (this.hits.get(bucketKey) ?? []).filter((t) => t > cutoff)
    if (recent.length >= rule.limit) {
      const retryMs = recent[0] + rule.windowMs - now
      return Math.max(1, Math.ceil(retryMs / 1000))
    }
    recent.push(now)
    this.hits.set(bucketKey, recent)
    return null
  }

  private sweep(now: number = Date.now()): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t > 60 * 60 * 1000)) this.hits.delete(key)
    }
  }

  /** Stop the background sweep timer. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
