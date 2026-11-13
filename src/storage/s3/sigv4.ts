/**
 * AWS Signature Version 4 verification for the S3 endpoint: the Authorization
 * header form and presigned query-string URLs (X-Amz-*), plus the per-chunk
 * signatures of STREAMING-AWS4-HMAC-SHA256-PAYLOAD bodies.
 *
 * Hashing uses node:crypto, reached through `process.getBuiltinModule` so this
 * module still loads in a browser (where the S3 endpoint answers 501 instead).
 */
import { S3Error } from './errors.js'

/** The subset of node:crypto the S3 endpoint uses. */
export interface NodeCrypto {
  createHash(alg: string): Hasher
  createHmac(alg: string, key: string | Uint8Array): Hasher
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean
}

/** An incremental hash or HMAC (node:crypto Hash/Hmac). */
export interface Hasher {
  update(data: string | Uint8Array): Hasher
  digest(): Uint8Array
  digest(encoding: 'hex' | 'base64'): string
}

let cached: NodeCrypto | null | undefined

/** node:crypto when the runtime has it (Node, Bun, Deno), else null (browser). */
export function nodeCrypto(): NodeCrypto | null {
  if (cached !== undefined) return cached
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    cached = (proc?.getBuiltinModule?.('node:crypto') as NodeCrypto | undefined) ?? null
  } catch {
    cached = null
  }
  return cached
}

/** zlib.crc32 when available (Node 22.2+), for verifying x-amz-checksum-crc32. */
export function nodeCrc32(): ((data: Uint8Array, value?: number) => number) | null {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    const zlib = proc?.getBuiltinModule?.('node:zlib') as { crc32?: (d: Uint8Array, v?: number) => number } | undefined
    return zlib?.crc32 ?? null
  } catch {
    return null
  }
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
export const STREAMING_SIGNED = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD'
export const STREAMING_SIGNED_TRAILER = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER'
export const STREAMING_UNSIGNED_TRAILER = 'STREAMING-UNSIGNED-PAYLOAD-TRAILER'

/** Longest a presigned URL may live (7 days), as on S3. */
const MAX_PRESIGN_EXPIRES = 7 * 24 * 60 * 60
/** Allowed clock difference for header-signed requests, as on S3. */
const MAX_SKEW_MS = 15 * 60 * 1000

/** What a verified request was signed with; the body decoder needs it for chunk signatures. */
export interface SignedRequest {
  accessKeyId: string
  /** x-amz-security-token, when the request uses Supabase's session-token mode */
  sessionToken: string | null
  /** the x-amz-content-sha256 value (or UNSIGNED-PAYLOAD for presigned URLs) */
  payloadHash: string
  presigned: boolean
  /** request signature: the seed for chunk signatures */
  signature: string
  amzDate: string
  /** `<date>/<region>/s3/aws4_request` */
  scope: string
  signingKey: Uint8Array
}

/** Look up the secret for an access key id; null means the key is unknown. */
export type SecretLookup = (accessKeyId: string, sessionToken: string | null) => string | null

/** RFC 3986 encoding as SigV4 wants it (everything but A-Z a-z 0-9 - _ . ~). */
export function uriEscape(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Parse a raw query string without URLSearchParams' '+' → space rule (S3 clients send %20). */
export function parseQuery(search: string): [string, string][] {
  const q = search.startsWith('?') ? search.slice(1) : search
  if (!q) return []
  return q
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const eq = p.indexOf('=')
      return eq === -1 ? [safeDecode(p), ''] : [safeDecode(p.slice(0, eq)), safeDecode(p.slice(eq + 1))]
    })
}

/** Canonical URI: each path segment decoded and re-encoded (S3 does not normalize). */
export function canonicalUri(rawPath: string): string {
  return rawPath
    .split('/')
    .map((seg) => uriEscape(safeDecode(seg)))
    .join('/')
}

function canonicalQuery(params: [string, string][]): string {
  return params
    .map(([k, v]) => [uriEscape(k), uriEscape(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function hex(c: NodeCrypto, data: string | Uint8Array): string {
  return c.createHash('sha256').update(data).digest('hex')
}

function hmac(c: NodeCrypto, key: string | Uint8Array, data: string): Uint8Array {
  return c.createHmac('sha256', key).update(data).digest()
}

/** The SigV4 signing key for a secret and credential scope. */
export function signingKey(c: NodeCrypto, secret: string, date: string, region: string, service: string): Uint8Array {
  const kDate = hmac(c, `AWS4${secret}`, date)
  const kRegion = hmac(c, kDate, region)
  const kService = hmac(c, kRegion, service)
  return hmac(c, kService, 'aws4_request')
}

/** Constant-time comparison of two hex signatures. */
export function signaturesMatch(c: NodeCrypto, a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const enc = new TextEncoder()
  return c.timingSafeEqual(enc.encode(a), enc.encode(b))
}

/** Parse `YYYYMMDDTHHMMSSZ` to epoch ms, or NaN. */
function parseAmzDate(s: string): number {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

/**
 * Verify a request's SigV4 signature (header or presigned form).
 *
 * @throws S3Error AccessDenied / InvalidAccessKeyId / SignatureDoesNotMatch /
 *   AuthorizationHeaderMalformed / RequestTimeTooSkewed when it does not check out.
 */
export function verifyRequest(
  c: NodeCrypto,
  req: Request,
  url: URL,
  lookup: SecretLookup,
  now = Date.now()
): SignedRequest {
  const query = parseQuery(url.search)
  const q = (name: string) => query.find(([k]) => k === name)?.[1]
  const presigned = q('X-Amz-Algorithm') !== undefined || q('X-Amz-Signature') !== undefined

  let algorithm: string
  let credential: string
  let signedHeaders: string
  let signature: string
  let amzDate: string
  let sessionToken: string | null
  let payloadHash: string

  if (presigned) {
    algorithm = q('X-Amz-Algorithm') ?? ''
    credential = q('X-Amz-Credential') ?? ''
    signedHeaders = q('X-Amz-SignedHeaders') ?? ''
    signature = q('X-Amz-Signature') ?? ''
    amzDate = q('X-Amz-Date') ?? ''
    sessionToken = q('X-Amz-Security-Token') ?? null
    payloadHash = q('X-Amz-Content-Sha256') ?? UNSIGNED_PAYLOAD
    if (!credential || !signedHeaders || !signature || !amzDate) {
      throw new S3Error('AuthorizationQueryParametersError', 'Query-string authentication requires X-Amz-Credential, X-Amz-Date, X-Amz-SignedHeaders and X-Amz-Signature')
    }
  } else {
    const auth = req.headers.get('authorization')
    if (!auth) throw new S3Error('AccessDenied', 'Access Denied: the request is not signed')
    const sp = auth.indexOf(' ')
    algorithm = sp === -1 ? auth : auth.slice(0, sp)
    if (algorithm === 'AWS') {
      throw new S3Error('InvalidRequest', 'The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.')
    }
    const fields: Record<string, string> = {}
    for (const part of auth.slice(sp + 1).split(',')) {
      const eq = part.indexOf('=')
      if (eq !== -1) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
    }
    credential = fields.Credential ?? ''
    signedHeaders = fields.SignedHeaders ?? ''
    signature = fields.Signature ?? ''
    amzDate = req.headers.get('x-amz-date') ?? ''
    sessionToken = req.headers.get('x-amz-security-token')
    if (!credential || !signedHeaders || !signature) {
      throw new S3Error('AuthorizationHeaderMalformed', 'The authorization header is malformed; Credential, SignedHeaders and Signature are required.')
    }
    if (!amzDate) {
      // SigV4 also allows the Date header, in the same basic format
      throw new S3Error('AccessDenied', 'AWS authentication requires a valid X-Amz-Date header')
    }
    const declared = req.headers.get('x-amz-content-sha256')
    if (declared) {
      payloadHash = declared
    } else {
      const hasBody = req.headers.has('transfer-encoding') || Number(req.headers.get('content-length') ?? 0) > 0
      if (hasBody) throw new S3Error('InvalidRequest', 'Missing required header for this request: x-amz-content-sha256')
      payloadHash = EMPTY_SHA256
    }
  }

  if (algorithm !== 'AWS4-HMAC-SHA256') {
    throw new S3Error('InvalidRequest', `Unsupported signature algorithm ${algorithm}; use AWS4-HMAC-SHA256.`)
  }
  if (!/^[0-9a-f]{64}$/.test(payloadHash) && ![UNSIGNED_PAYLOAD, STREAMING_SIGNED, STREAMING_SIGNED_TRAILER, STREAMING_UNSIGNED_TRAILER].includes(payloadHash)) {
    throw new S3Error('InvalidArgument', `x-amz-content-sha256 must be a SHA-256 hex digest, UNSIGNED-PAYLOAD or a supported STREAMING-* value, not ${payloadHash}`)
  }

  const credParts = credential.split('/')
  if (credParts.length < 5 || credParts[credParts.length - 1] !== 'aws4_request') {
    throw new S3Error(presigned ? 'AuthorizationQueryParametersError' : 'AuthorizationHeaderMalformed', `Malformed credential: ${credential}`)
  }
  const n = credParts.length
  const accessKeyId = credParts.slice(0, n - 4).join('/')
  const date = credParts[n - 4]
  const region = credParts[n - 3]
  const service = credParts[n - 2]
  if (service !== 's3') {
    throw new S3Error('AuthorizationHeaderMalformed', `The credential scope must name the s3 service, not ${service}`)
  }
  if (!amzDate.startsWith(date)) {
    throw new S3Error('AuthorizationHeaderMalformed', `The credential date ${date} does not match X-Amz-Date ${amzDate}`)
  }
  const at = parseAmzDate(amzDate)
  if (Number.isNaN(at)) throw new S3Error('AccessDenied', `Invalid X-Amz-Date: ${amzDate}`)

  const secret = lookup(accessKeyId, sessionToken)
  if (secret === null) {
    throw new S3Error('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.')
  }

  if (presigned) {
    const expires = Number(q('X-Amz-Expires') ?? '')
    if (!Number.isInteger(expires) || expires < 0) {
      throw new S3Error('AuthorizationQueryParametersError', 'X-Amz-Expires must be a non-negative integer')
    }
    if (expires > MAX_PRESIGN_EXPIRES) {
      throw new S3Error('AuthorizationQueryParametersError', 'X-Amz-Expires must be less than a week (in seconds); that is, the given X-Amz-Expires must be less than 604800 seconds')
    }
    if (now > at + expires * 1000) throw new S3Error('AccessDenied', 'Request has expired')
    if (at - now > MAX_SKEW_MS) throw new S3Error('AccessDenied', 'Request is not valid yet')
  } else if (Math.abs(now - at) > MAX_SKEW_MS) {
    throw new S3Error('RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.')
  }

  const headerNames = signedHeaders.toLowerCase().split(';').filter(Boolean)
  if (!headerNames.includes('host')) {
    throw new S3Error('AccessDenied', 'The host header must be signed')
  }
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${(req.headers.get(name) ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  const params = presigned ? query.filter(([k]) => k !== 'X-Amz-Signature') : query
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(params),
    canonicalHeaders,
    headerNames.join(';'),
    payloadHash,
  ].join('\n')
  const scope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(c, canonicalRequest)].join('\n')
  const key = signingKey(c, secret, date, region, service)
  const expected = c.createHmac('sha256', key).update(stringToSign).digest('hex')
  if (!signaturesMatch(c, expected, signature.toLowerCase())) {
    throw new S3Error('SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided. Check your key and signing method.')
  }

  return { accessKeyId, sessionToken, payloadHash, presigned, signature: expected, amzDate, scope, signingKey: key }
}

/** Expected signature of one aws-chunked chunk (STREAMING-AWS4-HMAC-SHA256-PAYLOAD). */
export function chunkSignature(c: NodeCrypto, signed: SignedRequest, previous: string, chunkSha256Hex: string): string {
  const stringToSign = ['AWS4-HMAC-SHA256-PAYLOAD', signed.amzDate, signed.scope, previous, EMPTY_SHA256, chunkSha256Hex].join('\n')
  return c.createHmac('sha256', signed.signingKey).update(stringToSign).digest('hex')
}

/** Expected signature of the trailing headers (STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER). */
export function trailerSignature(c: NodeCrypto, signed: SignedRequest, previous: string, trailerText: string): string {
  const stringToSign = ['AWS4-HMAC-SHA256-TRAILER', signed.amzDate, signed.scope, previous, hex(c, trailerText)].join('\n')
  return c.createHmac('sha256', signed.signingKey).update(stringToSign).digest('hex')
}
