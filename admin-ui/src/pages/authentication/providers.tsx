import { ExternalLink, Globe, Inbox, KeyRound, Mail, Smartphone, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type AuthSettings } from '../../api'
import { Badge, Button, Input, Spinner, Switch, toast } from '../../components/ui'
import { apiUrl } from '../../lib/snippet'

interface Config {
  providers: string[]
  inbox: boolean
  sms?: { custom: boolean; apiUrl: string }
  settings: AuthSettings | null
}

/**
 * Sign In / Providers: live toggles for signups, anonymous users, email
 * confirmation and password length, plus per-OAuth-provider switches.
 * Every change saves instantly through the admin API and takes effect
 * on the next auth request — no restart.
 */
export function ProvidersSection() {
  const [config, setConfig] = useState<Config | null>(null)

  useEffect(() => {
    api.authConfig().then(setConfig, () => setConfig({ providers: [], inbox: false, settings: null }))
  }, [])

  if (config === null) return <Spinner />
  const settings = config.settings

  /** Optimistically apply a patch, then persist; roll back on failure. */
  async function patch(p: Partial<AuthSettings>) {
    if (!settings) return
    const prev = { ...settings, disabledProviders: [...settings.disabledProviders] }
    setConfig((c) => (c && c.settings ? { ...c, settings: { ...c.settings, ...p } } : c))
    try {
      const saved = await api.updateAuthSettings(p)
      setConfig((c) => (c ? { ...c, settings: saved } : c))
    } catch (e) {
      setConfig((c) => (c ? { ...c, settings: prev } : c))
      toast.error((e as Error).message)
    }
  }

  /** One Twilio field. Only the field named travels, so the others (the secret above all) are kept. */
  async function patchTwilio(field: 'accountSid' | 'authToken' | 'messageServiceSid', value: string) {
    if (!settings) return
    try {
      const saved = await api.updateAuthSettings({ smsTwilio: { [field]: value } as AuthSettings['smsTwilio'] })
      setConfig((c) => (c ? { ...c, settings: saved } : c))
      toast.success('Saved')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const phoneOn = settings?.phoneEnabled ?? false
  const twilioConfigured = !!settings?.smsTwilio?.accountSid && !!settings?.smsTwilioAuthTokenSet
  const smsApiHost = (() => {
    try {
      return new URL(config.sms?.apiUrl ?? 'https://api.twilio.com').host
    } catch {
      return config.sms?.apiUrl ?? 'api.twilio.com'
    }
  })()

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <h1 className="text-lg font-semibold text-foreground">Sign In / Providers</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground/80">
          Changes apply instantly to the running instance and persist across restarts.
        </p>

        {/* ── user signups ── */}
        <h2 className="mb-2 mt-7 text-sm font-medium text-foreground">User signups</h2>
        <div className="divide-y divide-border rounded-md border border-border bg-card">
          <SettingRow
            title="Allow new users to sign up"
            description="If disabled, new email/password and OTP signups are rejected; existing users can still sign in."
          >
            <Switch checked={settings ? !settings.disableSignup : true} onChange={(on) => void patch({ disableSignup: !on })} disabled={!settings} />
          </SettingRow>
          <SettingRow
            title="Allow anonymous sign-ins"
            description="Enable signInAnonymously() — temporary users without credentials."
          >
            <Switch checked={settings?.anonymousUsers ?? true} onChange={(on) => void patch({ anonymousUsers: on })} disabled={!settings} />
          </SettingRow>
          <SettingRow
            title="Confirm email"
            description="Require users to verify their email address (via the emailed link or code) before they can sign in."
          >
            <Switch checked={settings ? !settings.autoconfirm : false} onChange={(on) => void patch({ autoconfirm: !on })} disabled={!settings} />
          </SettingRow>
          <SettingRow title="Minimum password length" description="Passwords shorter than this are rejected on signup and password change (4–72).">
            <MinLengthInput value={settings?.minPasswordLength ?? 6} disabled={!settings} onSave={(n) => void patch({ minPasswordLength: n })} />
          </SettingRow>
        </div>

        {/* ── auth methods ── */}
        <h2 className="mb-2 mt-8 text-sm font-medium text-foreground">Auth methods</h2>
        <div className="divide-y divide-border rounded-md border border-border bg-card">
          <ProviderRow icon={Mail} name="Email" description="Email/password, OTP codes, magic links, and password recovery.">
            <Badge variant="brand">Enabled</Badge>
          </ProviderRow>
          <ProviderRow icon={Smartphone} name="Phone" description="signInWithOtp({ phone }), signUp({ phone, password }) and phone changes, confirmed by a texted code.">
            <Switch checked={phoneOn} onChange={(on) => void patch({ phoneEnabled: on })} disabled={!settings} />
          </ProviderRow>
          <ProviderRow icon={KeyRound} name="PKCE flows" description="OAuth and magic links support the PKCE flow out of the box.">
            <Badge variant="brand">Enabled</Badge>
          </ProviderRow>
          <ProviderRow icon={UserRound} name="Anonymous" description="Temporary users without credentials — controlled by the toggle above.">
            {settings?.anonymousUsers === false ? <Badge variant="neutral">Disabled</Badge> : <Badge variant="brand">Enabled</Badge>}
          </ProviderRow>
        </div>

        {/* ── phone ── */}
        {phoneOn && (
          <>
            <h2 className="mb-2 mt-8 text-sm font-medium text-foreground">Phone</h2>
            <div className="divide-y divide-border rounded-md border border-border bg-card">
              <SettingRow
                title="Confirm phone"
                description="Require users to verify their number with the texted code before a phone signup can sign in."
              >
                <Switch checked={settings ? !settings.smsAutoconfirm : false} onChange={(on) => void patch({ smsAutoconfirm: !on })} disabled={!settings} />
              </SettingRow>
              <SettingRow title="Code length" description="Digits in texted codes (6–10).">
                <NumberInput value={settings?.smsOtpLength ?? 6} min={6} max={10} disabled={!settings} onSave={(n) => void patch({ smsOtpLength: n })} />
              </SettingRow>
              <SettingRow title="Code expiry (seconds)" description="How long a texted code stays valid.">
                <NumberInput value={settings?.smsOtpExpirySeconds ?? 60} min={1} max={86400} disabled={!settings} onSave={(n) => void patch({ smsOtpExpirySeconds: n })} />
              </SettingRow>
              <SettingRow title="Minimum interval (seconds)" description="Shortest gap between texts to the same number. 0 turns the limit off.">
                <NumberInput value={settings?.maxSmsFrequencySeconds ?? 60} min={0} max={3600} disabled={!settings} onSave={(n) => void patch({ maxSmsFrequencySeconds: n })} />
              </SettingRow>
            </div>

            <h2 className="mb-2 mt-8 text-sm font-medium text-foreground">Test phone numbers</h2>
            <div className="rounded-md border border-border bg-card">
              <div className="border-b border-border p-4">
                <p className="text-[13px] text-foreground">Numbers that are never texted</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/80">
                  A listed number always accepts its fixed code — for app-store reviewers and QA on the live app. Expiry, the five-try lock and the
                  minimum interval still apply. The same as <code className="text-muted-foreground">[auth.sms.test_otp]</code> in config.toml.
                </p>
              </div>
              <TestOtpEditor value={settings?.smsTestOtp ?? {}} disabled={!settings} onSave={(m) => void patch({ smsTestOtp: m })} />
            </div>

            <h2 className="mb-2 mt-8 text-sm font-medium text-foreground">SMS provider</h2>
            {config.sms?.custom ? (
              <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
                <Smartphone size={16} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-foreground">Custom sender</p>
                  <p className="text-[11px] text-muted-foreground/80">An SMS sender was provided to createBackend; texts are delivered through it.</p>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-border bg-card">
                <div className="flex items-center gap-3 border-b border-border p-4">
                  <Smartphone size={16} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13px] text-foreground">
                      Twilio
                      {twilioConfigured ? <Badge variant="brand">configured</Badge> : <Badge variant="neutral">dev inbox</Badge>}
                    </p>
                    <p className="text-[11px] text-muted-foreground/80">
                      {twilioConfigured
                        ? `Codes are sent through ${smsApiHost}.`
                        : 'No credentials — texted codes are captured in the local inbox instead of being sent.'}{' '}
                      The same fields as <code className="text-muted-foreground">[auth.sms.twilio]</code> in config.toml; a value here overrides it.
                    </p>
                  </div>
                </div>
                <div className="divide-y divide-border">
                  <SettingRow title="Account SID" description="ACxxxxxxxx from the Twilio console.">
                    <TextInput value={settings?.smsTwilio?.accountSid ?? ''} placeholder="AC…" disabled={!settings} onSave={(v) => void patchTwilio('accountSid', v)} />
                  </SettingRow>
                  <SettingRow title="Auth token" description={settings?.smsTwilioAuthTokenSet ? 'Set. Never shown again; paste a new one to replace it.' : 'The account auth token (secret).'}>
                    <TextInput value="" placeholder={settings?.smsTwilioAuthTokenSet ? '••••••••' : 'auth token'} secret disabled={!settings} onSave={(v) => void patchTwilio('authToken', v)} />
                  </SettingRow>
                  <SettingRow title="Messaging Service SID" description="MGxxxxxxxx; the Messaging Service texts are sent through.">
                    <TextInput value={settings?.smsTwilio?.messageServiceSid ?? ''} placeholder="MG…" disabled={!settings} onSave={(v) => void patchTwilio('messageServiceSid', v)} />
                  </SettingRow>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── oauth providers ── */}
        <h2 className="mb-2 mt-8 text-sm font-medium text-foreground">OAuth providers</h2>
        {config.providers.length > 0 ? (
          <div className="divide-y divide-border rounded-md border border-border bg-card">
            {config.providers.map((p) => {
              const enabled = !settings?.disabledProviders.includes(p)
              return (
                <ProviderRow key={p} icon={Globe} name={p} description="signInWithOAuth() with identity linking." oauth>
                  <Switch
                    checked={enabled}
                    disabled={!settings}
                    onChange={(on) => {
                      if (!settings) return
                      const next = on ? settings.disabledProviders.filter((x) => x !== p) : [...settings.disabledProviders, p]
                      void patch({ disabledProviders: next })
                    }}
                  />
                </ProviderRow>
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground/80">
            No OAuth providers configured. Add Google/GitHub (or a generic provider) to{' '}
            <code className="text-muted-foreground">supabase/config.toml</code> and restart — they appear here with a toggle.
          </div>
        )}

        {/* ── email delivery ── */}
        <h2 className="mb-2 mt-8 text-sm font-medium text-foreground">Email delivery</h2>
        <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
          <Inbox size={16} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-foreground">
              {config.inbox ? 'Local dev inbox' : 'Custom mailer'} {config.inbox && <Badge variant="brand">active</Badge>}
            </p>
            <p className="text-[11px] text-muted-foreground/80">
              {config.inbox
                ? 'No mailer configured — OTP codes, magic links and confirmations are captured locally instead of being sent.'
                : 'A mailer was provided to createBackend; emails are delivered through it.'}
            </p>
          </div>
          {config.inbox && (
            <a
              href={`${apiUrl()}/inbox`}
              target="_blank"
              rel="noreferrer"
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-input px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:border-muted-foreground hover:text-foreground"
            >
              Open inbox <ExternalLink size={11} />
            </a>
          )}
        </div>

        {settings === null && (
          <p className="mt-6 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            This server predates runtime auth settings — restart tinbase after updating to enable the toggles.
          </p>
        )}
      </div>
    </div>
  )
}

/* ── pieces ── */

/** The [auth.sms.test_otp] map: one row per number, an add form at the bottom. Each change saves the whole map. */
function TestOtpEditor({ value, disabled, onSave }: { value: Record<string, string>; disabled?: boolean; onSave: (m: Record<string, string>) => void }) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const entries = Object.entries(value)
  const canAdd = !disabled && /^\+?[1-9][\d\s().-]{1,20}$/.test(phone.trim()) && /^\d{4,10}$/.test(code.trim())

  function add() {
    if (!canAdd) return
    onSave({ ...value, [phone.trim()]: code.trim() })
    setPhone('')
    setCode('')
  }

  function remove(p: string) {
    const next = { ...value }
    delete next[p]
    onSave(next)
  }

  return (
    <div className="divide-y divide-border">
      {entries.map(([p, c]) => (
        <div key={p} className="flex items-center gap-4 p-4">
          <code className="min-w-0 flex-1 text-[13px] text-foreground">+{p}</code>
          <code className="text-[13px] text-muted-foreground">{c}</code>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={disabled}
            onClick={() => remove(p)}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 p-4">
        <Input mono className="w-48" placeholder="+15005550006" autoComplete="off" value={phone} disabled={disabled} onChange={(e) => setPhone(e.target.value)} />
        <Input
          mono
          className="w-28"
          placeholder="123456"
          autoComplete="off"
          value={code}
          disabled={disabled}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button variant="outline" disabled={!canAdd} onClick={add}>
          Add
        </Button>
        {entries.length === 0 && <span className="text-[11px] text-muted-foreground/80">None yet. Codes are 4–10 digits.</span>}
      </div>
    </div>
  )
}

function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">{title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/80">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function ProviderRow({
  icon: Icon,
  name,
  description,
  oauth,
  children,
}: {
  icon: typeof Mail
  name: string
  description: string
  oauth?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3 p-4">
      <Icon size={16} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13px] capitalize text-foreground">
          {name}
          {oauth && <Badge variant="blue">oauth</Badge>}
        </p>
        <p className="text-[11px] text-muted-foreground/80">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Small numeric input that saves on blur or Enter and snaps back on invalid values. */
function MinLengthInput({ value, disabled, onSave }: { value: number; disabled?: boolean; onSave: (n: number) => void }) {
  return <NumberInput value={value} min={4} max={72} disabled={disabled} onSave={onSave} />
}

function NumberInput({ value, min, max, disabled, onSave }: { value: number; min: number; max: number; disabled?: boolean; onSave: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])

  function commit() {
    const n = parseInt(text, 10)
    if (!Number.isFinite(n) || n < min || n > max) {
      setText(String(value))
      return
    }
    if (n !== value) onSave(n)
  }

  return (
    <Input
      mono
      className="w-16 text-center"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

/**
 * Text field that saves on blur or Enter when the value changed. A `secret`
 * field is write-only: it starts empty whatever is stored, and is emptied
 * again once saved, so the stored value is never on screen.
 */
function TextInput({
  value,
  placeholder,
  secret,
  disabled,
  onSave,
}: {
  value: string
  placeholder?: string
  secret?: boolean
  disabled?: boolean
  onSave: (v: string) => void
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])

  function commit() {
    const v = text.trim()
    if (v === value || (secret && v === '')) return
    onSave(v)
    if (secret) setText('')
  }

  return (
    <Input
      mono
      type={secret ? 'password' : 'text'}
      autoComplete="off"
      className="w-64"
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}
