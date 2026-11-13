/**
 * S3-compatible endpoint at /storage/v1/s3, matching Supabase Storage's S3
 * protocol: path-style addressing (`/storage/v1/s3/<bucket>/<key>`), AWS
 * Signature V4 (header and presigned), and the bucket, object and multipart
 * operations the AWS SDKs and CLI use.
 *
 * It sits on the same storage as the Supabase storage API: an object written
 * here is a row in storage.objects plus bytes behind the StorageDriver, so it
 * shows up in supabase-js, Studio and the public URL, and the other way round.
 * Bodies stream through to the driver, never buffered whole.
 *
 * Auth: the configured access key pair acts with service_role rights (RLS
 * bypassed), as on Supabase. Supabase's session-token mode also works: any
 * access key id, the anon key as the secret, and a user's JWT as the session
 * token; the request then runs as that user and RLS applies.
 */
import type { Database } from '../../db/database.js'
import { verifyJwt } from '../../jwt.js'
import type { RequestContext, StorageDriver } from '../../types.js'
import {
  type BucketRow,
  invalidObjectKey,
  isRenderableActiveType,
  likeEscape,
  type ObjectRow,
  parseByteRange,
  type StorageHandler,
} from '../handler.js'
import { copyObject, iterateStream, moveObject, openRead, putFromIterable } from '../stream-io.js'
import { type BodyTotals, payloadStream, readSmallBody } from './body.js'
import type { S3Credentials } from './credentials.js'
import { errorResponse, S3Error } from './errors.js'
import { type NodeCrypto, nodeCrypto, parseQuery, type SignedRequest, uriEscape, verifyRequest } from './sigv4.js'
import { xmlBlocks, xmlDocument, xmlElement, xmlNode, xmlText } from './xml.js'

/** Where the endpoint is mounted. */
export const S3_PATH = '/storage/v1/s3'

/** Driver key prefix for in-flight bytes (uploads being received, multipart parts). Never a bucket. */
const STAGING = '.tinbase-s3-staging'
/** S3's minimum size for every part but the last. */
const MIN_PART_SIZE = 5 * 1024 * 1024
/** Multipart uploads untouched this long are dropped (their state is in memory only). */
const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_KEYS = 1000

/** Bucket/object sub-resources S3 has and tinbase does not implement. */
const UNSUPPORTED_SUBRESOURCES = [
  'acl', 'cors', 'policy', 'policyStatus', 'lifecycle', 'encryption', 'tagging', 'website', 'replication',
  'logging', 'notification', 'object-lock', 'retention', 'legal-hold', 'accelerate', 'requestPayment',
  'ownershipControls', 'publicAccessBlock', 'analytics', 'metrics', 'inventory', 'intelligent-tiering',
  'torrent', 'restore', 'select', 'attributes', 'versions',
]

/** Construction options for {@link S3Handler}. */
export interface S3HandlerConfig {
  credentials: S3Credentials
  /** false answers every request with AccessDenied ([storage.s3_protocol] enabled = false) */
  enabled: boolean
  /** JWT secret, to verify session tokens */
  jwtSecret: string
  /** the anon key: the secret in session-token mode */
  anonKey: string
  log?: (message: string) => void
}

/** System and user metadata carried by an object. */
interface ObjectMeta {
  contentType: string
  cacheControl: string
  contentDisposition?: string
  contentEncoding?: string
  contentLanguage?: string
  expires?: string
  userMetadata?: Record<string, string>
}

interface PartInfo {
  etag: string
  size: number
  lastModified: Date
}

interface MultipartUpload {
  id: string
  bucketId: string
  key: string
  meta: ObjectMeta
  initiated: Date
  touched: number
  parts: Map<number, PartInfo>
  completing: boolean
}

/** Routes /storage/v1/s3/* requests to S3 operations. */
export class S3Handler {
  private uploads = new Map<string, MultipartUpload>()

  constructor(
    private db: Database,
    private driver: StorageDriver,
    private storage: StorageHandler,
    private config: S3HandlerConfig
  ) {}

  /** Entry point: authenticate, dispatch, and render any error as S3 XML. */
  async handle(req: Request, url: URL): Promise<Response> {
    const requestId = crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()
    const head = req.method.toUpperCase() === 'HEAD'
    try {
      if (!this.config.enabled) {
        throw new S3Error('AccessDenied', 'The S3 protocol is disabled on this server ([storage.s3_protocol] enabled = false).')
      }
      const c = nodeCrypto()
      if (!c) throw new S3Error('NotImplemented', 'The S3 protocol needs node:crypto, which this runtime does not have.')
      const signed = verifyRequest(c, req, url, (accessKeyId, sessionToken) => {
        if (sessionToken) return this.config.anonKey
        return accessKeyId === this.config.credentials.accessKeyId ? this.config.credentials.secretAccessKey : null
      })
      const ctx = await this.contextFor(signed)
      const res = await this.route(req, url, c, signed, ctx)
      res.headers.set('x-amz-request-id', requestId)
      return res
    } catch (e) {
      if (e instanceof S3Error) return errorResponse(e, url.pathname, requestId, head)
      const pg = e as { code?: string; message?: string }
      if (pg.code === '42501') {
        return errorResponse(new S3Error('AccessDenied', pg.message ?? 'new row violates row-level security policy'), url.pathname, requestId, head)
      }
      const msg = e instanceof Error ? e.message : String(e)
      this.config.log?.(`[s3] ${req.method} ${url.pathname} failed: ${msg}`)
      return errorResponse(new S3Error('InternalError', msg), url.pathname, requestId, head)
    }
  }

  /** Static keys act as service_role; a session token acts as its JWT's role. */
  private async contextFor(signed: SignedRequest): Promise<RequestContext> {
    if (!signed.sessionToken) return { role: 'service_role', claims: { role: 'service_role' } }
    const claims = await verifyJwt(signed.sessionToken, this.config.jwtSecret)
    if (!claims) throw new S3Error('InvalidToken', 'The provided token is malformed, expired or otherwise invalid.')
    const role = typeof claims.role === 'string' ? claims.role : 'anon'
    if (!['anon', 'authenticated', 'service_role'].includes(role)) {
      throw new S3Error('InvalidToken', `The provided token has an unsupported role: ${role}`)
    }
    return { role, claims }
  }

  private async route(req: Request, url: URL, c: NodeCrypto, signed: SignedRequest, ctx: RequestContext): Promise<Response> {
    const method = req.method.toUpperCase()
    const segments = url.pathname.slice(S3_PATH.length).split('/').slice(1)
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s)
      } catch {
        throw new S3Error('InvalidURI', `Couldn't parse the specified URI: ${s}`)
      }
    }
    const bucket = segments[0] ? decode(segments[0]) : ''
    const key = segments.slice(1).map(decode).join('/')
    const query = new Map(parseQuery(url.search))
    const has = (name: string) => query.has(name)

    if (!bucket) {
      if (method === 'GET') return this.listBuckets()
      throw new S3Error('MethodNotAllowed', 'The specified method is not allowed against this resource.')
    }

    const unsupported = UNSUPPORTED_SUBRESOURCES.find(has)
    if (unsupported) throw new S3Error('NotImplemented', `The ${unsupported} sub-resource is not supported by tinbase.`)

    if (!key) {
      switch (method) {
        case 'HEAD':
          return this.headBucket(bucket)
        case 'PUT':
          if (has('versioning')) throw new S3Error('NotImplemented', 'S3 versioning is not supported.')
          return this.createBucket(req, c, signed, ctx, bucket)
        case 'DELETE':
          return this.deleteBucket(ctx, bucket)
        case 'GET':
          if (has('location')) return this.bucketLocation(bucket)
          if (has('versioning')) return this.bucketVersioning(bucket)
          if (has('uploads')) return this.listMultipartUploads(query, bucket)
          return this.listObjects(query, ctx, bucket, query.get('list-type') === '2')
        case 'POST':
          if (has('delete')) return this.deleteObjects(req, c, signed, ctx, bucket)
          break
      }
      throw new S3Error('MethodNotAllowed', 'The specified method is not allowed against this resource.')
    }

    switch (method) {
      case 'PUT':
        if (has('uploadId') || has('partNumber')) {
          if (req.headers.has('x-amz-copy-source')) return this.uploadPartCopy(req, query, ctx, bucket, key)
          return this.uploadPart(req, c, signed, query, bucket, key)
        }
        if (req.headers.has('x-amz-copy-source')) return this.copy(req, ctx, bucket, key)
        return this.putObject(req, c, signed, ctx, bucket, key)
      case 'GET':
      case 'HEAD':
        if (has('uploadId') && method === 'GET') return this.listParts(query, bucket, key)
        return this.getObject(req, query, ctx, bucket, key, method === 'HEAD')
      case 'DELETE':
        if (has('uploadId')) return this.abortMultipartUpload(query, bucket, key)
        return this.deleteObject(ctx, bucket, key)
      case 'POST':
        if (has('uploads')) return this.createMultipartUpload(req, bucket, key)
        if (has('uploadId')) return this.completeMultipartUpload(req, url, c, signed, query, ctx, bucket, key)
        break
    }
    throw new S3Error('MethodNotAllowed', 'The specified method is not allowed against this resource.')
  }

  // ── buckets ─────────────────────────────────────────────────────────────

  private async requireBucket(id: string): Promise<BucketRow> {
    const bucket = await this.storage.bucketRow(id)
    if (!bucket) throw new S3Error('NoSuchBucket', 'The specified bucket does not exist', { BucketName: id })
    return bucket
  }

  private requireService(ctx: RequestContext): void {
    if (ctx.role !== 'service_role') {
      throw new S3Error('AccessDenied', 'Bucket management needs the S3 access keys (service role), not a session token.')
    }
  }

  private async listBuckets(): Promise<Response> {
    const res = await this.db.query(`select id, created_at from storage.buckets order by id`)
    const buckets = (res.rows as { id: string; created_at: Date | string | null }[])
      .map((b) => xmlNode('Bucket', xmlElement('Name', b.id) + xmlElement('CreationDate', isoDate(b.created_at))))
      .join('')
    return xml(
      200,
      xmlDocument(
        'ListAllMyBucketsResult',
        xmlNode('Owner', xmlElement('ID', 'tinbase') + xmlElement('DisplayName', 'tinbase')) + xmlNode('Buckets', buckets)
      )
    )
  }

  private async headBucket(id: string): Promise<Response> {
    await this.requireBucket(id)
    return new Response(null, { status: 200, headers: { 'x-amz-bucket-region': this.config.credentials.region } })
  }

  private async createBucket(req: Request, c: NodeCrypto, signed: SignedRequest, ctx: RequestContext, id: string): Promise<Response> {
    this.requireService(ctx)
    if (id.length > 100 || id.startsWith('.') || /[\\\0]/.test(id)) {
      throw new S3Error('InvalidBucketName', 'The specified bucket is not valid.', { BucketName: id })
    }
    await readSmallBody(req, c, signed) // optional CreateBucketConfiguration; the region is fixed
    if (await this.storage.bucketRow(id)) {
      throw new S3Error('BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.', { BucketName: id })
    }
    const acl = (req.headers.get('x-amz-acl') ?? '').toLowerCase()
    const isPublic = acl === 'public-read' || acl === 'public-read-write'
    try {
      await this.db.query(`insert into storage.buckets (id, name, public) values ($1, $1, $2)`, [id, isPublic])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new S3Error('BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.', { BucketName: id })
      }
      throw e
    }
    return new Response(null, { status: 200, headers: { location: `/${id}` } })
  }

  private async deleteBucket(ctx: RequestContext, id: string): Promise<Response> {
    this.requireService(ctx)
    await this.requireBucket(id)
    const objects = await this.db.query(`select count(*)::int as count from storage.objects where bucket_id = $1`, [id])
    if (Number((objects.rows[0] as { count: number | string }).count) > 0) {
      throw new S3Error('BucketNotEmpty', 'The bucket you tried to delete is not empty', { BucketName: id })
    }
    await this.db.query(`delete from storage.buckets where id = $1`, [id])
    for (const upload of [...this.uploads.values()]) {
      if (upload.bucketId === id) await this.dropUpload(upload)
    }
    return new Response(null, { status: 204 })
  }

  private async bucketLocation(id: string): Promise<Response> {
    await this.requireBucket(id)
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${this.config.credentials.region}</LocationConstraint>`)
  }

  private async bucketVersioning(id: string): Promise<Response> {
    await this.requireBucket(id)
    return xml(200, xmlDocument('VersioningConfiguration', ''))
  }

  // ── listing ─────────────────────────────────────────────────────────────

  /** ListObjectsV2 (`list-type=2`) and the original ListObjects. */
  private async listObjects(query: Map<string, string>, ctx: RequestContext, bucketId: string, v2: boolean): Promise<Response> {
    await this.requireBucket(bucketId)
    const prefix = query.get('prefix') ?? ''
    const delimiter = query.get('delimiter') ?? ''
    const encodingType = query.get('encoding-type')
    if (encodingType !== undefined && encodingType !== 'url') {
      throw new S3Error('InvalidArgument', 'Invalid Encoding Method specified in Request')
    }
    const maxKeysRaw = query.get('max-keys')
    const maxKeys = maxKeysRaw === undefined ? MAX_KEYS : Number(maxKeysRaw)
    if (!Number.isInteger(maxKeys) || maxKeys < 0) throw new S3Error('InvalidArgument', 'max-keys must be a non-negative integer')
    const limit = Math.min(maxKeys, MAX_KEYS)

    const token = query.get('continuation-token')
    let after: string
    if (v2 && token !== undefined) {
      try {
        after = new TextDecoder().decode(Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)))
      } catch {
        throw new S3Error('InvalidArgument', 'The continuation token provided is incorrect')
      }
    } else {
      after = (v2 ? query.get('start-after') : query.get('marker')) ?? ''
    }
    // Resuming after a common prefix skips everything under it.
    const skipUnder = delimiter && after.startsWith(prefix) && after.endsWith(delimiter) ? after : null

    const res = await this.db.withContext(ctx, (q) =>
      prefix
        ? q(`select name, owner, metadata, updated_at from storage.objects where bucket_id = $1 and name like $2`, [bucketId, `${likeEscape(prefix)}%`])
        : q(`select name, owner, metadata, updated_at from storage.objects where bucket_id = $1`, [bucketId])
    )
    // Byte order, as S3 lists (not the database collation).
    const rows = (res.rows as ObjectRow[]).filter((r) => r.name.startsWith(prefix)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const contents: ObjectRow[] = []
    const prefixes: string[] = []
    let last: string | null = null
    let truncated = false
    for (const row of rows) {
      if (row.name <= after) continue
      if (skipUnder && row.name.startsWith(skipUnder)) continue
      let common: string | null = null
      if (delimiter) {
        const i = row.name.indexOf(delimiter, prefix.length)
        if (i !== -1) common = row.name.slice(0, i + delimiter.length)
      }
      if (common !== null && common === prefixes[prefixes.length - 1]) continue
      if (contents.length + prefixes.length >= limit) {
        truncated = limit > 0
        break
      }
      if (common !== null) {
        prefixes.push(common)
        last = common
      } else {
        contents.push(row)
        last = row.name
      }
    }

    const enc = (s: string) => (encodingType === 'url' ? s.split('/').map(encodeURIComponent).join('/') : s)
    const owner = (r: ObjectRow) => xmlNode('Owner', xmlElement('ID', r.owner ?? '') + xmlElement('DisplayName', ''))
    const showOwner = !v2 || query.get('fetch-owner') === 'true'
    const items =
      contents
        .map((r) => {
          const meta = r.metadata ?? {}
          return xmlNode(
            'Contents',
            xmlElement('Key', enc(r.name)) +
              xmlElement('LastModified', isoDate(String(meta.lastModified ?? '') || r.updated_at)) +
              xmlElement('ETag', String(meta.eTag ?? '""')) +
              xmlElement('Size', Number(meta.size ?? 0)) +
              (showOwner ? owner(r) : '') +
              xmlElement('StorageClass', 'STANDARD')
          )
        })
        .join('') + prefixes.map((p) => xmlNode('CommonPrefixes', xmlElement('Prefix', enc(p)))).join('')

    let head = xmlElement('Name', bucketId) + xmlElement('Prefix', enc(prefix))
    if (v2) {
      head +=
        (delimiter ? xmlElement('Delimiter', enc(delimiter)) : '') +
        xmlElement('MaxKeys', maxKeys) +
        xmlElement('KeyCount', contents.length + prefixes.length) +
        xmlElement('IsTruncated', truncated) +
        (token !== undefined ? xmlElement('ContinuationToken', token) : '') +
        (truncated && last !== null ? xmlElement('NextContinuationToken', btoaUtf8(last)) : '') +
        (query.has('start-after') ? xmlElement('StartAfter', enc(query.get('start-after')!)) : '')
    } else {
      head +=
        xmlElement('Marker', enc(query.get('marker') ?? '')) +
        (delimiter ? xmlElement('Delimiter', enc(delimiter)) : '') +
        xmlElement('MaxKeys', maxKeys) +
        xmlElement('IsTruncated', truncated) +
        (truncated && last !== null ? xmlElement('NextMarker', enc(last)) : '')
    }
    if (encodingType) head += xmlElement('EncodingType', encodingType)
    return xml(200, xmlDocument('ListBucketResult', head + items))
  }

  // ── objects ─────────────────────────────────────────────────────────────

  private validateKey(key: string): void {
    const err = invalidObjectKey(key)
    if (err) throw new S3Error('InvalidArgument', `Invalid object key: ${err}`, { Key: key })
    if (key.endsWith('/')) {
      throw new S3Error('InvalidArgument', 'Object keys ending in "/" (folder markers) are not supported by tinbase.', { Key: key })
    }
  }

  private checkMime(bucket: BucketRow, contentType: string): void {
    if (!bucket.allowed_mime_types || bucket.allowed_mime_types.length === 0) return
    const base = contentType.split(';')[0].trim()
    if (!bucket.allowed_mime_types.some((m) => m === base || (m.endsWith('/*') && base.startsWith(m.slice(0, -1))))) {
      throw new S3Error('InvalidMimeType', `mime type ${base} is not supported by bucket ${bucket.id}`)
    }
  }

  private stagingKey(): string {
    return `${STAGING}/put/${crypto.randomUUID()}`
  }

  /** Stream the request body into a staging key. */
  private async receive(req: Request, c: NodeCrypto, signed: SignedRequest, staging: string, maxBytes?: number): Promise<BodyTotals> {
    const { chunks, totals } = payloadStream(req, c, signed, { maxBytes })
    try {
      await putFromIterable(this.driver, staging, chunks)
    } catch (e) {
      await this.driver.delete(staging).catch(() => {})
      throw e
    }
    return totals()
  }

  /**
   * Make staged bytes the object `bucketId/key`: quota check, the RLS-checked
   * storage.objects upsert, then the rename into place, all serialized with
   * other quota-checked writes. The staged bytes are removed on any failure.
   */
  private async commit(
    ctx: RequestContext,
    bucketId: string,
    key: string,
    staging: string,
    meta: ObjectMeta,
    size: number,
    etag: string
  ): Promise<string> {
    const lastModified = new Date().toISOString()
    const metadata: Record<string, unknown> = {
      eTag: `"${etag}"`,
      size,
      mimetype: meta.contentType,
      cacheControl: meta.cacheControl,
      lastModified,
      contentLength: size,
      httpStatusCode: 200,
    }
    if (meta.contentDisposition) metadata.contentDisposition = meta.contentDisposition
    if (meta.contentEncoding) metadata.contentEncoding = meta.contentEncoding
    if (meta.contentLanguage) metadata.contentLanguage = meta.contentLanguage
    if (meta.expires) metadata.expires = meta.expires
    if (meta.userMetadata && Object.keys(meta.userMetadata).length > 0) metadata.userMetadata = meta.userMetadata
    try {
      await this.storage.serializeWrite(async () => {
        const refusal = await this.storage.quotaRefusal(size, { bucketId, key })
        if (refusal) throw new S3Error('QuotaExceeded', refusal)
        const res = await this.db.withContext(ctx, (q) =>
          q(
            `insert into storage.objects (bucket_id, name, owner, metadata, version)
             values ($1, $2, $3, $4::jsonb, $5)
             on conflict (bucket_id, name) do update
               set metadata = excluded.metadata, owner = excluded.owner, updated_at = now(), version = excluded.version
             returning id`,
            [bucketId, key, ctx.claims?.sub ?? null, JSON.stringify(metadata), crypto.randomUUID()]
          )
        )
        const id = (res.rows[0] as { id: string } | undefined)?.id
        if (!id) throw new S3Error('AccessDenied', 'Access Denied')
        try {
          await moveObject(this.driver, staging, `${bucketId}/${key}`)
        } catch (e) {
          await this.db.query(`delete from storage.objects where id = $1`, [id]).catch(() => {})
          throw e
        }
      })
    } catch (e) {
      await this.driver.delete(staging).catch(() => {})
      throw e
    }
    return lastModified
  }

  private async putObject(req: Request, c: NodeCrypto, signed: SignedRequest, ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    this.validateKey(key)
    const bucket = await this.requireBucket(bucketId)
    const meta = metaFromHeaders(req.headers)
    this.checkMime(bucket, meta.contentType)
    const limit = this.storage.objectSizeLimit(bucket)
    const declared = declaredLength(req, signed)
    if (declared !== undefined) {
      if (limit !== undefined && declared > limit) {
        throw new S3Error('EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size', { MaxSizeAllowed: String(limit) })
      }
      const refusal = await this.storage.quotaRefusal(declared, { bucketId, key })
      if (refusal) throw new S3Error('QuotaExceeded', refusal)
    }
    const staging = this.stagingKey()
    const totals = await this.receive(req, c, signed, staging, limit)
    await this.commit(ctx, bucketId, key, staging, meta, totals.size, totals.md5Hex)
    return new Response(null, { status: 200, headers: { etag: `"${totals.md5Hex}"` } })
  }

  private async loadObject(ctx: RequestContext, bucketId: string, key: string): Promise<ObjectRow> {
    await this.requireBucket(bucketId)
    const res = await this.db.withContext(ctx, (q) =>
      q(`select * from storage.objects where bucket_id = $1 and name = $2`, [bucketId, key])
    )
    const row = res.rows[0] as ObjectRow | undefined
    if (!row) throw new S3Error('NoSuchKey', 'The specified key does not exist.', { Key: key })
    return row
  }

  private async getObject(req: Request, query: Map<string, string>, ctx: RequestContext, bucketId: string, key: string, head: boolean): Promise<Response> {
    const row = await this.loadObject(ctx, bucketId, key)
    const meta = row.metadata ?? {}
    const path = `${bucketId}/${key}`
    const etag = String(meta.eTag ?? '""')
    const lastModified = new Date(String(meta.lastModified ?? '') || iso(row.updated_at))

    const cond = evaluateConditions(req.headers, '', etag, lastModified)
    if (cond === 412) throw new S3Error('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold')
    if (cond === 304) {
      return new Response(null, { status: 304, headers: { etag, 'last-modified': lastModified.toUTCString() } })
    }

    const size = this.driver.size ? await this.driver.size(path) : Number(meta.size ?? NaN)
    if (size === null || Number.isNaN(size)) throw new S3Error('NoSuchKey', 'The specified key does not exist.', { Key: key })

    const headers: Record<string, string> = {
      'content-type': String(meta.mimetype ?? 'application/octet-stream'),
      'content-length': String(size),
      'accept-ranges': 'bytes',
      etag,
      'last-modified': lastModified.toUTCString(),
      'x-content-type-options': 'nosniff',
    }
    if (meta.cacheControl) headers['cache-control'] = String(meta.cacheControl)
    if (meta.contentDisposition) headers['content-disposition'] = String(meta.contentDisposition)
    if (meta.contentEncoding) headers['content-encoding'] = String(meta.contentEncoding)
    if (meta.contentLanguage) headers['content-language'] = String(meta.contentLanguage)
    if (meta.expires) headers.expires = String(meta.expires)
    const userMeta = (meta.userMetadata ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(userMeta)) headers[`x-amz-meta-${k}`] = String(v)
    // response-* query parameters override the stored headers (signed requests only, which these all are)
    for (const name of ['content-type', 'content-language', 'expires', 'cache-control', 'content-disposition', 'content-encoding']) {
      const v = query.get(`response-${name}`)
      if (v !== undefined) headers[name] = v
    }
    // Same stored-XSS guard as the storage API: never render active content inline on this origin.
    if (isRenderableActiveType(headers['content-type'])) headers['content-disposition'] = 'attachment'

    const partNumber = query.get('partNumber')
    if (partNumber !== undefined && partNumber !== '1') {
      throw new S3Error('InvalidArgument', 'Only partNumber=1 (the whole object) is supported by tinbase.')
    }

    const range = req.headers.get('range')
    const span = range === null ? null : parseByteRange(range, size)
    if (span === 'unsatisfiable') {
      throw new S3Error('InvalidRange', 'The requested range is not satisfiable', { ActualObjectSize: String(size) })
    }
    if (span) {
      const [start, end] = span
      headers['content-length'] = String(end - start + 1)
      headers['content-range'] = `bytes ${start}-${end}/${size}`
      const body = head ? null : await openRead(this.driver, path, start, end)
      if (!head && body === null) throw new S3Error('NoSuchKey', 'The specified key does not exist.', { Key: key })
      return new Response(body, { status: 206, headers })
    }
    const body = head || size === 0 ? null : await openRead(this.driver, path)
    if (!head && size > 0 && body === null) throw new S3Error('NoSuchKey', 'The specified key does not exist.', { Key: key })
    return new Response(body, { status: 200, headers })
  }

  private async deleteObject(ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    await this.requireBucket(bucketId)
    const res = await this.db.withContext(ctx, (q) =>
      q(`delete from storage.objects where bucket_id = $1 and name = $2 returning name`, [bucketId, key])
    )
    if (res.rows.length > 0) await this.driver.delete(`${bucketId}/${key}`)
    return new Response(null, { status: 204 })
  }

  private async deleteObjects(req: Request, c: NodeCrypto, signed: SignedRequest, ctx: RequestContext, bucketId: string): Promise<Response> {
    await this.requireBucket(bucketId)
    const body = await readSmallBody(req, c, signed)
    if (!/<(?:[\w-]+:)?Delete[\s>]/.test(body)) {
      throw new S3Error('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema')
    }
    const quiet = xmlText(body, 'Quiet')?.trim().toLowerCase() === 'true'
    const keys = xmlBlocks(body, 'Object').map((o) => xmlText(o, 'Key') ?? '')
    if (keys.length === 0 || keys.length > MAX_KEYS) {
      throw new S3Error('MalformedXML', `A Delete request names between 1 and ${MAX_KEYS} objects`)
    }
    const res = await this.db.withContext(ctx, (q) =>
      q(`delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name`, [
        bucketId,
        `{${keys.map((k) => `"${k.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`,
      ])
    )
    const deleted = (res.rows as { name: string }[]).map((r) => r.name)
    await this.driver.deleteMany(deleted.map((k) => `${bucketId}/${k}`))
    // S3 reports a key that did not exist as deleted too.
    const out = quiet ? '' : keys.map((k) => xmlNode('Deleted', xmlElement('Key', k))).join('')
    return xml(200, xmlDocument('DeleteResult', out))
  }

  /** CopyObject: `x-amz-copy-source` onto `bucketId/key`, with COPY or REPLACE metadata. */
  private async copy(req: Request, ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    this.validateKey(key)
    const source = parseCopySource(req.headers.get('x-amz-copy-source')!)
    const srcRow = await this.loadObject(ctx, source.bucket, source.key)
    const srcMeta = srcRow.metadata ?? {}
    const etag = String(srcMeta.eTag ?? '""').replace(/"/g, '')
    const srcModified = new Date(String(srcMeta.lastModified ?? '') || iso(srcRow.updated_at))
    if (evaluateConditions(req.headers, 'x-amz-copy-source-', `"${etag}"`, srcModified) !== null) {
      throw new S3Error('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold')
    }
    const bucket = await this.requireBucket(bucketId)
    const directive = (req.headers.get('x-amz-metadata-directive') ?? 'COPY').toUpperCase()
    if (directive !== 'COPY' && directive !== 'REPLACE') {
      throw new S3Error('InvalidArgument', 'Unknown metadata directive.')
    }
    const meta: ObjectMeta = directive === 'REPLACE' ? metaFromHeaders(req.headers) : metaFromStored(srcMeta)
    this.checkMime(bucket, meta.contentType)
    const same = source.bucket === bucketId && source.key === key

    if (same) {
      if (directive !== 'REPLACE') {
        throw new S3Error(
          'InvalidRequest',
          "This copy request is illegal because it is trying to copy an object to itself without changing the object's metadata, storage class, website redirect location or encryption attributes."
        )
      }
      // Metadata-only update in place: same bytes, same ETag.
      const lastModified = new Date().toISOString()
      const updated = {
        ...srcMeta,
        mimetype: meta.contentType,
        cacheControl: meta.cacheControl,
        contentDisposition: meta.contentDisposition,
        contentEncoding: meta.contentEncoding,
        contentLanguage: meta.contentLanguage,
        expires: meta.expires,
        userMetadata: meta.userMetadata,
        lastModified,
      }
      const res = await this.db.withContext(ctx, (q) =>
        q(`update storage.objects set metadata = $3::jsonb, updated_at = now() where bucket_id = $1 and name = $2 returning id`, [
          bucketId,
          key,
          JSON.stringify(updated),
        ])
      )
      if (res.rows.length === 0) throw new S3Error('AccessDenied', 'Access Denied')
      return xml(200, xmlDocument('CopyObjectResult', xmlElement('LastModified', lastModified) + xmlElement('ETag', `"${etag}"`)))
    }

    const size = Number(srcMeta.size ?? 0)
    const limit = this.storage.objectSizeLimit(bucket)
    if (limit !== undefined && size > limit) {
      throw new S3Error('EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size', { MaxSizeAllowed: String(limit) })
    }
    const staging = this.stagingKey()
    try {
      await copyObject(this.driver, `${source.bucket}/${source.key}`, staging)
    } catch (e) {
      await this.driver.delete(staging).catch(() => {})
      if ((e as { code?: string }).code === 'ENOENT' || /missing/.test(String((e as Error).message))) {
        throw new S3Error('NoSuchKey', 'The specified key does not exist.', { Key: source.key })
      }
      throw e
    }
    const lastModified = await this.commit(ctx, bucketId, key, staging, meta, size, etag)
    return xml(200, xmlDocument('CopyObjectResult', xmlElement('LastModified', lastModified) + xmlElement('ETag', `"${etag}"`)))
  }

  // ── multipart uploads ───────────────────────────────────────────────────
  // Upload state is kept in memory (like the TUS endpoint); parts are staged
  // through the driver, so they are on disk with the filesystem driver.

  private partKey(uploadId: string, partNumber: number): string {
    return `${STAGING}/mpu/${uploadId}/${partNumber}`
  }

  private getUpload(query: Map<string, string>, bucketId: string, key: string): MultipartUpload {
    const id = query.get('uploadId') ?? ''
    const upload = this.uploads.get(id)
    if (!upload || upload.bucketId !== bucketId || upload.key !== key) {
      throw new S3Error('NoSuchUpload', 'The specified multipart upload does not exist. The upload ID might be invalid, or the multipart upload might have been aborted or completed.', { UploadId: id })
    }
    upload.touched = Date.now()
    return upload
  }

  private async dropUpload(upload: MultipartUpload): Promise<void> {
    this.uploads.delete(upload.id)
    await this.driver.deleteMany([...upload.parts.keys()].map((n) => this.partKey(upload.id, n))).catch(() => {})
  }

  private async sweepUploads(): Promise<void> {
    const cutoff = Date.now() - UPLOAD_TTL_MS
    for (const upload of [...this.uploads.values()]) {
      if (upload.touched < cutoff && !upload.completing) await this.dropUpload(upload)
    }
  }

  /** Start an upload. Write permission (RLS, quota) is checked when it completes, as the object is created then. */
  private async createMultipartUpload(req: Request, bucketId: string, key: string): Promise<Response> {
    this.validateKey(key)
    const bucket = await this.requireBucket(bucketId)
    const meta = metaFromHeaders(req.headers)
    this.checkMime(bucket, meta.contentType)
    await this.sweepUploads()
    const id = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
    this.uploads.set(id, {
      id,
      bucketId,
      key,
      meta,
      initiated: new Date(),
      touched: Date.now(),
      parts: new Map(),
      completing: false,
    })
    return xml(
      200,
      xmlDocument('InitiateMultipartUploadResult', xmlElement('Bucket', bucketId) + xmlElement('Key', key) + xmlElement('UploadId', id))
    )
  }

  private partNumber(query: Map<string, string>): number {
    const n = Number(query.get('partNumber'))
    if (!Number.isInteger(n) || n < 1 || n > 10000) {
      throw new S3Error('InvalidArgument', 'Part number must be an integer between 1 and 10000, inclusive')
    }
    return n
  }

  private async uploadPart(req: Request, c: NodeCrypto, signed: SignedRequest, query: Map<string, string>, bucketId: string, key: string): Promise<Response> {
    const upload = this.getUpload(query, bucketId, key)
    const n = this.partNumber(query)
    const bucket = await this.requireBucket(bucketId)
    const limit = this.storage.objectSizeLimit(bucket)
    const declared = declaredLength(req, signed)
    if (limit !== undefined && declared !== undefined && declared > limit) {
      throw new S3Error('EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size', { MaxSizeAllowed: String(limit) })
    }
    const partKey = this.partKey(upload.id, n)
    const totals = await this.receive(req, c, signed, partKey, limit)
    if (!this.uploads.has(upload.id)) {
      await this.driver.delete(partKey).catch(() => {})
      throw new S3Error('NoSuchUpload', 'The multipart upload was aborted or completed while this part was uploading.')
    }
    upload.parts.set(n, { etag: totals.md5Hex, size: totals.size, lastModified: new Date() })
    return new Response(null, { status: 200, headers: { etag: `"${totals.md5Hex}"` } })
  }

  private async uploadPartCopy(req: Request, query: Map<string, string>, ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    const upload = this.getUpload(query, bucketId, key)
    const n = this.partNumber(query)
    const c = nodeCrypto()!
    const source = parseCopySource(req.headers.get('x-amz-copy-source')!)
    const srcRow = await this.loadObject(ctx, source.bucket, source.key)
    const srcPath = `${source.bucket}/${source.key}`
    const size = this.driver.size ? await this.driver.size(srcPath) : Number(srcRow.metadata?.size ?? NaN)
    if (size === null || Number.isNaN(size)) throw new S3Error('NoSuchKey', 'The specified key does not exist.', { Key: source.key })
    let start = 0
    let end = size - 1
    const rangeHeader = req.headers.get('x-amz-copy-source-range')
    if (rangeHeader) {
      const m = rangeHeader.match(/^bytes=(\d+)-(\d+)$/)
      if (!m || Number(m[2]) < Number(m[1]) || Number(m[2]) >= size) {
        throw new S3Error('InvalidArgument', 'The x-amz-copy-source-range value must be of the form bytes=first-last within the source object')
      }
      start = Number(m[1])
      end = Number(m[2])
    }
    const stream = size === 0 ? null : await openRead(this.driver, srcPath, start, end)
    const md5 = c.createHash('md5')
    let copied = 0
    async function* source_(): AsyncGenerator<Uint8Array> {
      if (!stream) return
      for await (const chunk of iterateStream(stream)) {
        md5.update(chunk)
        copied += chunk.length
        yield chunk
      }
    }
    const partKey = this.partKey(upload.id, n)
    await putFromIterable(this.driver, partKey, source_())
    const etag = md5.digest('hex')
    const lastModified = new Date()
    upload.parts.set(n, { etag, size: copied, lastModified })
    return xml(200, xmlDocument('CopyPartResult', xmlElement('LastModified', lastModified.toISOString()) + xmlElement('ETag', `"${etag}"`)))
  }

  private async completeMultipartUpload(
    req: Request,
    url: URL,
    c: NodeCrypto,
    signed: SignedRequest,
    query: Map<string, string>,
    ctx: RequestContext,
    bucketId: string,
    key: string
  ): Promise<Response> {
    const upload = this.getUpload(query, bucketId, key)
    const body = await readSmallBody(req, c, signed)
    const requested = xmlBlocks(body, 'Part').map((p) => ({
      n: Number(xmlText(p, 'PartNumber')),
      etag: (xmlText(p, 'ETag') ?? '').trim().replace(/"/g, ''),
    }))
    if (requested.length === 0) {
      throw new S3Error('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema')
    }
    for (let i = 1; i < requested.length; i++) {
      if (requested[i].n <= requested[i - 1].n) {
        throw new S3Error('InvalidPartOrder', 'The list of parts was not in ascending order. Parts must be ordered by part number.')
      }
    }
    for (let i = 0; i < requested.length; i++) {
      const part = upload.parts.get(requested[i].n)
      if (!part || part.etag !== requested[i].etag) {
        throw new S3Error('InvalidPart', 'One or more of the specified parts could not be found. The part might not have been uploaded, or the specified entity tag might not have matched the part\'s entity tag.', {
          PartNumber: String(requested[i].n),
        })
      }
      if (i < requested.length - 1 && part.size < MIN_PART_SIZE) {
        throw new S3Error('EntityTooSmall', 'Your proposed upload is smaller than the minimum allowed size', {
          PartNumber: String(requested[i].n),
          ProposedSize: String(part.size),
          MinSizeAllowed: String(MIN_PART_SIZE),
        })
      }
    }
    if (upload.completing) throw new S3Error('OperationAborted', 'A conflicting operation is in progress on this multipart upload. Please try again.')
    const bucket = await this.requireBucket(bucketId)
    const parts = requested.map((r) => ({ n: r.n, ...upload.parts.get(r.n)! }))
    const total = parts.reduce((s, p) => s + p.size, 0)
    const limit = this.storage.objectSizeLimit(bucket)
    if (limit !== undefined && total > limit) {
      throw new S3Error('EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size', { MaxSizeAllowed: String(limit) })
    }

    upload.completing = true
    try {
      const driver = this.driver
      const partKey = (n: number) => this.partKey(upload.id, n)
      async function* concatenated(): AsyncGenerator<Uint8Array> {
        for (const p of parts) {
          if (p.size === 0) continue
          const stream = await openRead(driver, partKey(p.n))
          if (!stream) throw new S3Error('InvalidPart', `Part ${p.n} is missing from storage.`)
          yield* iterateStream(stream)
        }
      }
      const staging = this.stagingKey()
      try {
        await putFromIterable(this.driver, staging, concatenated())
      } catch (e) {
        await this.driver.delete(staging).catch(() => {})
        throw e
      }
      const md5 = c.createHash('md5')
      for (const p of parts) md5.update(hexBytes(p.etag))
      const etag = `${md5.digest('hex')}-${parts.length}`
      await this.commit(ctx, bucketId, key, staging, upload.meta, total, etag)
      await this.dropUpload(upload)
      const location = `${url.origin}${S3_PATH}/${uriEscape(bucketId)}/${key.split('/').map(uriEscape).join('/')}`
      return xml(
        200,
        xmlDocument(
          'CompleteMultipartUploadResult',
          xmlElement('Location', location) + xmlElement('Bucket', bucketId) + xmlElement('Key', key) + xmlElement('ETag', `"${etag}"`)
        )
      )
    } finally {
      upload.completing = false
    }
  }

  private async abortMultipartUpload(query: Map<string, string>, bucketId: string, key: string): Promise<Response> {
    const upload = this.getUpload(query, bucketId, key)
    await this.dropUpload(upload)
    return new Response(null, { status: 204 })
  }

  private async listParts(query: Map<string, string>, bucketId: string, key: string): Promise<Response> {
    const upload = this.getUpload(query, bucketId, key)
    const maxParts = Math.min(Number(query.get('max-parts') ?? 1000) || 1000, 1000)
    const marker = Number(query.get('part-number-marker') ?? 0) || 0
    const all = [...upload.parts.entries()].filter(([n]) => n > marker).sort((a, b) => a[0] - b[0])
    const page = all.slice(0, maxParts)
    const truncated = all.length > page.length
    const parts = page
      .map(([n, p]) =>
        xmlNode(
          'Part',
          xmlElement('PartNumber', n) + xmlElement('LastModified', p.lastModified.toISOString()) + xmlElement('ETag', `"${p.etag}"`) + xmlElement('Size', p.size)
        )
      )
      .join('')
    return xml(
      200,
      xmlDocument(
        'ListPartsResult',
        xmlElement('Bucket', bucketId) +
          xmlElement('Key', key) +
          xmlElement('UploadId', upload.id) +
          xmlNode('Initiator', xmlElement('ID', 'tinbase') + xmlElement('DisplayName', 'tinbase')) +
          xmlNode('Owner', xmlElement('ID', 'tinbase') + xmlElement('DisplayName', 'tinbase')) +
          xmlElement('StorageClass', 'STANDARD') +
          xmlElement('PartNumberMarker', marker) +
          xmlElement('NextPartNumberMarker', page.length ? page[page.length - 1][0] : marker) +
          xmlElement('MaxParts', maxParts) +
          xmlElement('IsTruncated', truncated) +
          parts
      )
    )
  }

  private async listMultipartUploads(query: Map<string, string>, bucketId: string): Promise<Response> {
    await this.requireBucket(bucketId)
    const prefix = query.get('prefix') ?? ''
    const uploads = [...this.uploads.values()]
      .filter((u) => u.bucketId === bucketId && u.key.startsWith(prefix))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.initiated.getTime() - b.initiated.getTime()))
    const items = uploads
      .map((u) =>
        xmlNode(
          'Upload',
          xmlElement('Key', u.key) +
            xmlElement('UploadId', u.id) +
            xmlNode('Initiator', xmlElement('ID', 'tinbase') + xmlElement('DisplayName', 'tinbase')) +
            xmlNode('Owner', xmlElement('ID', 'tinbase') + xmlElement('DisplayName', 'tinbase')) +
            xmlElement('StorageClass', 'STANDARD') +
            xmlElement('Initiated', u.initiated.toISOString())
        )
      )
      .join('')
    return xml(
      200,
      xmlDocument(
        'ListMultipartUploadsResult',
        xmlElement('Bucket', bucketId) +
          xmlElement('KeyMarker', '') +
          xmlElement('UploadIdMarker', '') +
          xmlElement('Prefix', prefix) +
          xmlElement('MaxUploads', 1000) +
          xmlElement('IsTruncated', false) +
          items
      )
    )
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function xml(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml' } })
}

function iso(v: Date | string | null): string {
  if (v === null || v === undefined) return new Date(0).toISOString()
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

/** ISO 8601 with milliseconds, as S3 writes timestamps in XML. */
function isoDate(v: Date | string | null): string {
  const d = new Date(iso(v))
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
}

function btoaUtf8(s: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin)
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Decoded body length the client declared, if any. */
function declaredLength(req: Request, signed: SignedRequest): number | undefined {
  const raw = signed.payloadHash.startsWith('STREAMING-')
    ? req.headers.get('x-amz-decoded-content-length')
    : req.headers.get('content-length')
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** System metadata and x-amz-meta-* from a PutObject / CreateMultipartUpload / CopyObject(REPLACE). */
function metaFromHeaders(h: Headers): ObjectMeta {
  const encoding = (h.get('content-encoding') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== 'aws-chunked')
    .join(', ')
  const userMetadata: Record<string, string> = {}
  h.forEach((value, name) => {
    if (name.startsWith('x-amz-meta-')) userMetadata[name.slice('x-amz-meta-'.length)] = value
  })
  return {
    contentType: h.get('content-type') || 'application/octet-stream',
    cacheControl: h.get('cache-control') || 'no-cache',
    contentDisposition: h.get('content-disposition') || undefined,
    contentEncoding: encoding || undefined,
    contentLanguage: h.get('content-language') || undefined,
    expires: h.get('expires') || undefined,
    userMetadata,
  }
}

/** ObjectMeta from a storage.objects metadata column (CopyObject with COPY). */
function metaFromStored(m: Record<string, unknown>): ObjectMeta {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return {
    contentType: str(m.mimetype) ?? 'application/octet-stream',
    cacheControl: str(m.cacheControl) ?? 'no-cache',
    contentDisposition: str(m.contentDisposition),
    contentEncoding: str(m.contentEncoding),
    contentLanguage: str(m.contentLanguage),
    expires: str(m.expires),
    userMetadata: (m.userMetadata as Record<string, string> | undefined) ?? {},
  }
}

/** `x-amz-copy-source`: `[/]bucket/key[?versionId=…]`, URL-encoded. */
function parseCopySource(raw: string): { bucket: string; key: string } {
  let v = raw.split('?')[0]
  try {
    v = decodeURIComponent(v)
  } catch {
    throw new S3Error('InvalidArgument', 'Invalid copy source encoding')
  }
  if (v.startsWith('/')) v = v.slice(1)
  const slash = v.indexOf('/')
  if (slash <= 0 || slash === v.length - 1) {
    throw new S3Error('InvalidArgument', 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey')
  }
  return { bucket: v.slice(0, slash), key: v.slice(slash + 1) }
}

function etagListMatches(list: string, etag: string): boolean {
  const bare = etag.replace(/"/g, '')
  return list.split(',').some((t) => {
    const s = t.trim().replace(/^W\//, '').replace(/"/g, '')
    return s === '*' || s === bare
  })
}

/**
 * RFC 7232 conditionals as S3 applies them: If-Match / If-Unmodified-Since
 * fail with 412, If-None-Match / If-Modified-Since answer 304 (for CopyObject's
 * x-amz-copy-source-* variants, every failure is a 412). Null means proceed.
 */
function evaluateConditions(h: Headers, prefix: string, etag: string, lastModified: Date): 304 | 412 | null {
  const get = (n: string) => h.get(`${prefix}${n}`)
  const seconds = Math.floor(lastModified.getTime() / 1000)
  const date = (v: string | null) => {
    if (!v) return null
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : Math.floor(t / 1000)
  }
  const ifMatch = get('if-match')
  const ifUnmodified = date(get('if-unmodified-since'))
  if (ifMatch !== null) {
    if (!etagListMatches(ifMatch, etag)) return 412
  } else if (ifUnmodified !== null && seconds > ifUnmodified) {
    return 412
  }
  const notModified = prefix ? 412 : 304
  const ifNoneMatch = get('if-none-match')
  const ifModified = date(get('if-modified-since'))
  if (ifNoneMatch !== null) {
    if (etagListMatches(ifNoneMatch, etag)) return notModified
  } else if (ifModified !== null && seconds <= ifModified) {
    return notModified
  }
  return null
}
