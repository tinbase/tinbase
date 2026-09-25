/**
 * Runtime-mutable auth settings - the knobs Studio's "Sign In / Providers"
 * page toggles. One shared object is created at boot, read by the auth
 * handler on every request, mutated in place by the admin API, and persisted
 * to the auth.config kv table so restarts keep the operator's choices.
 */
import type { Database } from '../db/database.js'

/**
 * Runtime-mutable auth configuration. One shared instance is read by the auth
 * handler on every request and edited in place by the admin API, so changes
 * apply immediately; it is persisted to auth.config to survive restarts.
 */
export interface AuthSettings {
  /** When true, new email/password signups are rejected (existing users can still sign in). */
  disableSignup: boolean
  /** Allow signInAnonymously() to mint temporary users. */
  anonymousUsers: boolean
  /** Confirm email addresses automatically on signup. When false, users must verify via the emailed link before signing in. */
  autoconfirm: boolean
  /** Minimum accepted password length (signup, updateUser, admin create). */
  minPasswordLength: number
  /** Configured OAuth providers the operator has switched off at runtime. */
  disabledProviders: string[]
  /** Digits in emailed OTP codes (config.toml auth.email.otp_length; 6-10). */
  otpLength: number
  /** OTP / magic-link lifetime in seconds (auth.email.otp_expiry). */
  otpExpirySeconds: number
  /**
   * Minimum seconds between auth emails to the same address
   * (config.toml `[auth.email] max_frequency`, GoTrue's SMTP_MAX_FREQUENCY).
   *
   * The per-client rate limit does not cover this: it is keyed by caller, so
   * rotating addresses defeats it, and it says nothing about how often one
   * person's inbox can be made to receive mail. This is keyed by recipient, so
   * it caps what any one mailbox can be subjected to no matter who asks.
   */
  maxEmailFrequencySeconds: number
  /**
   * Confirm an email change from both addresses, not just the new one
   * (config.toml `[auth.email] secure_email_change_enabled`, GoTrue's
   * MAILER_SECURE_EMAIL_CHANGE_ENABLED).
   *
   * On by default, as it is in Supabase. With it off, whoever holds a live
   * session can move the account to an address of their choosing and the old
   * one never hears about it; with it on, the change needs a click from the
   * address that is losing the account as well as the one gaining it.
   */
  secureEmailChange: boolean
  /** Max MFA factors a user may enroll (auth.mfa.max_enrolled_factors). */
  maxEnrolledFactors: number
  /** Allow TOTP enrollment (auth.mfa.totp.enroll_enabled). */
  totpEnrollEnabled: boolean
  /** Allow TOTP verification/challenge (auth.mfa.totp.verify_enabled). */
  totpVerifyEnabled: boolean
}

/** Built-in defaults, matching `supabase start`'s permissive local posture (autoconfirm on, anonymous users on). */
export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  disableSignup: false,
  anonymousUsers: true,
  autoconfirm: true,
  minPasswordLength: 6,
  disabledProviders: [],
  otpLength: 6,
  otpExpirySeconds: 3600,
  maxEmailFrequencySeconds: 60,
  secureEmailChange: true,
  maxEnrolledFactors: 10,
  totpEnrollEnabled: true,
  totpVerifyEnabled: true,
}

/** Clamp/typecheck a stored or patched settings object into a valid one. */
function sanitize(raw: Record<string, unknown>): AuthSettings {
  const s = { ...DEFAULT_AUTH_SETTINGS }
  if (typeof raw.disableSignup === 'boolean') s.disableSignup = raw.disableSignup
  if (typeof raw.anonymousUsers === 'boolean') s.anonymousUsers = raw.anonymousUsers
  if (typeof raw.autoconfirm === 'boolean') s.autoconfirm = raw.autoconfirm
  if (typeof raw.minPasswordLength === 'number' && Number.isFinite(raw.minPasswordLength)) {
    s.minPasswordLength = Math.max(4, Math.min(72, Math.floor(raw.minPasswordLength)))
  }
  if (Array.isArray(raw.disabledProviders)) {
    s.disabledProviders = raw.disabledProviders.filter((p): p is string => typeof p === 'string').slice(0, 50)
  }
  if (typeof raw.otpLength === 'number' && Number.isFinite(raw.otpLength)) {
    s.otpLength = Math.max(6, Math.min(10, Math.floor(raw.otpLength)))
  }
  if (typeof raw.otpExpirySeconds === 'number' && Number.isFinite(raw.otpExpirySeconds) && raw.otpExpirySeconds > 0) {
    s.otpExpirySeconds = Math.floor(raw.otpExpirySeconds)
  }
  // >= 0, not > 0: zero is how the limit is turned off, and a value that is
  // merely falsy must not be mistaken for one that was never set.
  if (
    typeof raw.maxEmailFrequencySeconds === 'number' &&
    Number.isFinite(raw.maxEmailFrequencySeconds) &&
    raw.maxEmailFrequencySeconds >= 0
  ) {
    // Capped: a mistyped window that locks a mailbox out of password reset for
    // a day is worse than one that is slightly too short.
    s.maxEmailFrequencySeconds = Math.min(3600, Math.floor(raw.maxEmailFrequencySeconds))
  }
  if (typeof raw.secureEmailChange === 'boolean') s.secureEmailChange = raw.secureEmailChange
  if (typeof raw.maxEnrolledFactors === 'number' && Number.isFinite(raw.maxEnrolledFactors) && raw.maxEnrolledFactors > 0) {
    s.maxEnrolledFactors = Math.floor(raw.maxEnrolledFactors)
  }
  if (typeof raw.totpEnrollEnabled === 'boolean') s.totpEnrollEnabled = raw.totpEnrollEnabled
  if (typeof raw.totpVerifyEnabled === 'boolean') s.totpVerifyEnabled = raw.totpVerifyEnabled
  return s
}

/**
 * Resolve the effective auth settings by layering, low precedence first:
 *   1. built-in defaults
 *   2. `defaults` - the committed baseline (config.toml [auth]); portable, in VCS
 *   3. the persisted auth.config row - per-instance live overrides from the studio
 *
 * config.toml stays the source of truth a project commits; the studio's live
 * toggles are overrides on top, so both models coexist.
 */
export async function loadAuthSettings(db: Database, defaults: Partial<AuthSettings> = {}): Promise<AuthSettings> {
  const base = sanitize({ ...DEFAULT_AUTH_SETTINGS, ...defaults })
  try {
    const res = await db.query(`select value from auth.config where key = 'settings'`)
    const stored = (res.rows[0] as { value: Record<string, unknown> } | undefined)?.value
    return stored ? sanitize({ ...base, ...stored }) : base
  } catch {
    return base
  }
}

/** Persist the settings object to auth.config. */
export async function saveAuthSettings(db: Database, settings: AuthSettings): Promise<void> {
  await db.query(
    `insert into auth.config (key, value, updated_at) values ('settings', $1::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(settings)]
  )
}

/**
 * Apply a partial patch onto the shared settings object IN PLACE (so every
 * holder of the reference - the auth handler - sees the change immediately).
 *
 * @returns An error message for an invalid patch, or `null` on success.
 */
export function applyAuthSettingsPatch(target: AuthSettings, patch: Record<string, unknown>): string | null {
  // Every AuthSettings key is patchable; unknown keys are rejected so a typo
  // fails loudly instead of being silently dropped by sanitize().
  const BOOL_KEYS = ['disableSignup', 'anonymousUsers', 'autoconfirm', 'totpEnrollEnabled', 'totpVerifyEnabled']
  const NUMBER_KEYS = ['minPasswordLength', 'otpLength', 'otpExpirySeconds', 'maxEnrolledFactors']
  const KEYS = [...BOOL_KEYS, ...NUMBER_KEYS, 'disabledProviders']
  for (const k of Object.keys(patch)) {
    if (!KEYS.includes(k)) return `unknown setting: ${k}`
  }
  for (const k of BOOL_KEYS) {
    if (k in patch && typeof patch[k] !== 'boolean') return `${k} must be a boolean`
  }
  // Bounds mirror sanitize() so validation and clamping never disagree.
  const numBounds: Record<string, { min: number; max: number }> = {
    minPasswordLength: { min: 4, max: 72 },
    otpLength: { min: 6, max: 10 },
    otpExpirySeconds: { min: 1, max: Number.MAX_SAFE_INTEGER },
    maxEnrolledFactors: { min: 1, max: Number.MAX_SAFE_INTEGER },
  }
  for (const k of NUMBER_KEYS) {
    if (!(k in patch)) continue
    const n = patch[k]
    const { min, max } = numBounds[k]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
      return max === Number.MAX_SAFE_INTEGER
        ? `${k} must be a number >= ${min}`
        : `${k} must be a number between ${min} and ${max}`
    }
  }
  if ('disabledProviders' in patch) {
    const arr = patch.disabledProviders
    if (!Array.isArray(arr) || arr.some((p) => typeof p !== 'string')) {
      return 'disabledProviders must be an array of provider names'
    }
  }
  Object.assign(target, sanitize({ ...target, ...patch }))
  return null
}
