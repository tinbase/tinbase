import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOAuthProviders } from '../src/node/load-oauth.js'

function project(configToml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tb-oauth-'))
  if (configToml !== undefined) {
    mkdirSync(join(dir, 'supabase'), { recursive: true })
    writeFileSync(join(dir, 'supabase', 'config.toml'), configToml)
  }
  return dir
}

describe('loadOAuthProviders', () => {
  it('reads config.toml [auth.external.*] and resolves env()', () => {
    const dir = project(`
[auth]
site_url = "http://localhost:3000"

[auth.external.google]
enabled = true
client_id = "google-id"
secret = "env(MY_GOOGLE_SECRET)"

[auth.external.github]
enabled = false
client_id = "gh-id"
secret = "gh-secret"
`)
    const providers = loadOAuthProviders(dir, { MY_GOOGLE_SECRET: 'resolved-secret' } as any)
    expect(providers.google).toBeDefined()
    expect(providers.google.clientId).toBe('google-id')
    expect(providers.google.clientSecret).toBe('resolved-secret')
    // github is enabled = false → skipped
    expect(providers.github).toBeUndefined()
  })

  it('falls back to GOTRUE_EXTERNAL_ env vars', () => {
    const dir = project()
    const providers = loadOAuthProviders(dir, {
      GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: 'x',
      GOTRUE_EXTERNAL_GITHUB_SECRET: 'y',
      GOTRUE_EXTERNAL_GITHUB_ENABLED: 'true',
    } as any)
    expect(providers.github).toEqual(
      expect.objectContaining({ clientId: 'x', clientSecret: 'y' })
    )
  })

  it('config.toml wins over env for the same provider', () => {
    const dir = project(`
[auth.external.google]
enabled = true
client_id = "from-toml"
secret = "toml-secret"
`)
    const providers = loadOAuthProviders(dir, {
      GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: 'from-env',
      GOTRUE_EXTERNAL_GOOGLE_SECRET: 'env-secret',
    } as any)
    expect(providers.google.clientId).toBe('from-toml')
  })

  it('TINBASE_OAUTH_ alias still works', () => {
    const dir = project()
    const providers = loadOAuthProviders(dir, {
      TINBASE_OAUTH_GOOGLE_CLIENT_ID: 'a',
      TINBASE_OAUTH_GOOGLE_CLIENT_SECRET: 'b',
    } as any)
    expect(providers.google?.clientId).toBe('a')
  })
})
