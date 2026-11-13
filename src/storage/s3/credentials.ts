/**
 * S3 access keys. With the default (public, local-dev) JWT secret tinbase uses
 * the Supabase CLI's own local S3 keys, so tooling written against
 * `supabase start` works unchanged. With any other JWT secret the keys are
 * derived from it, the same way the anon/service_role keys are: stable across
 * restarts, known to whoever holds the secret, and never the public defaults
 * on a deployed server.
 */
import { DEFAULT_JWT_SECRET } from '../../types.js'

/** The Supabase CLI's local S3 access key id (`supabase status`). */
export const SUPABASE_LOCAL_S3_ACCESS_KEY_ID = '625729a08b95bf1b7ff351a663f3a23c'
/** The Supabase CLI's local S3 secret access key. */
export const SUPABASE_LOCAL_S3_SECRET_ACCESS_KEY = '850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907'
/** The Supabase CLI's local S3 region. */
export const DEFAULT_S3_REGION = 'local'

/** Credentials for the S3 endpoint. */
export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
  region: string
}

async function hmacHex(secret: string, label: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(label)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The S3 credentials for a JWT secret, with any explicit values taking
 * precedence (config / TINBASE_S3_* env vars).
 */
export async function deriveS3Credentials(
  jwtSecret: string = DEFAULT_JWT_SECRET,
  overrides: Partial<S3Credentials> = {}
): Promise<S3Credentials> {
  const region = overrides.region || DEFAULT_S3_REGION
  if (overrides.accessKeyId && overrides.secretAccessKey) {
    return { accessKeyId: overrides.accessKeyId, secretAccessKey: overrides.secretAccessKey, region }
  }
  if (jwtSecret === DEFAULT_JWT_SECRET) {
    return {
      accessKeyId: overrides.accessKeyId || SUPABASE_LOCAL_S3_ACCESS_KEY_ID,
      secretAccessKey: overrides.secretAccessKey || SUPABASE_LOCAL_S3_SECRET_ACCESS_KEY,
      region,
    }
  }
  return {
    accessKeyId: overrides.accessKeyId || (await hmacHex(jwtSecret, 'tinbase:s3:access-key-id')).slice(0, 32),
    secretAccessKey: overrides.secretAccessKey || (await hmacHex(jwtSecret, 'tinbase:s3:secret-access-key')),
    region,
  }
}
