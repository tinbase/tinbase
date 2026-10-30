/**
 * storage-api-compatible endpoints (/storage/v1/*) for supabase-js's
 * StorageClient. Object metadata lives in storage.objects (RLS enforced
 * through the request role); bytes live behind a StorageDriver.
 */
import type { Database } from '../db/database.js'
import { signJwt, verifyJwt } from '../jwt.js'
import type { BucketSeed, RequestContext, StorageDriver } from '../types.js'

/** Construction options for {@link StorageHandler}. */
export interface StorageConfig {
  /** secret used to sign and verify signed download/upload URL tokens */
  jwtSecret: string
  /** default per-bucket byte limit applied when a bucket sets none (config.toml storage.file_size_limit) */
  defaultFileSizeLimit?: number
  /**
   * Initial project-wide storage quota in bytes (config.toml storage.quota or
   * TINBASE_STORAGE_QUOTA_BYTES). A quota set through the admin API is
   * persisted and wins over this. Unset or null means unlimited.
   */
  quotaBytes?: number | null
  /** sink for progress/warning lines (e.g. image-transform no-op); no-op when omitted */
  log?: (message: string) => void
}

/** Storage quota state reported by the admin API (`GET /admin/v1/storage`). */
export interface StorageQuotaStatus {
  /** total bytes of every stored object (sum of storage.objects metadata.size) */
  used_bytes: number
  /** project-wide quota in bytes, or null when unlimited */
  quota_bytes: number | null
  /** number of stored objects */
  objects: number
  /** when a write was last refused for exceeding the quota (ISO 8601), or null */
  last_refused_at: string | null
}

/**
 * Slack allowed for multipart framing when pre-checking a request's
 * Content-Length against a limit before reading the body. The exact file size
 * is checked again once the body is parsed, so this only has to be generous
 * enough never to refuse a file that would have fit.
 */
const MULTIPART_SLACK = 16 * 1024

/** Format a byte count for a human-readable message (1024-based, like file_size_limit). */
export function formatBytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  if (i === 0) return `${n} bytes`
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10
  return `${rounded} ${units[i]}`
}

/** Upper bound on signed-URL lifetime (seconds) - 7 days, matching Supabase's practical max. */
const MAX_SIGNED_URL_EXPIRY = 7 * 24 * 60 * 60

/** Clamp a client-supplied `expiresIn` to a positive value within the allowed maximum. */
function clampExpiry(expiresIn: number): number {
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return 3600
  return Math.min(Math.floor(expiresIn), MAX_SIGNED_URL_EXPIRY)
}

/**
 * Reject object keys that could escape their bucket namespace or diverge between
 * the metadata row and the on-disk path. Returns an error string, or null when
 * the key is safe.
 */
function invalidObjectKey(key: string): string | null {
  if (!key) return 'object key is required'
  if (key.length > 1024) return 'object key too long'
  if (key.includes('\0')) return 'object key contains a null byte'
  if (key.startsWith('/') || key.startsWith('\\')) return 'object key must be relative'
  if (key.includes('\\')) return 'object key must not contain backslashes'
  const segments = key.split('/')
  if (segments.some((s) => s === '..' || s === '.')) return 'object key must not contain . or .. segments'
  return null
}

interface ObjectRow {
  id: string
  bucket_id: string
  name: string
  owner: string | null
  metadata: Record<string, unknown> | null
  created_at: Date | string | null
  updated_at: Date | string | null
  last_accessed_at: Date | string | null
}

interface BucketRow {
  id: string
  name: string
  public: boolean
  file_size_limit: number | string | null
  allowed_mime_types: string[] | null
  created_at: Date | string | null
  updated_at: Date | string | null
}

function storageError(status: number, error: string, message: string): Response {
  return json(status, { statusCode: String(status), error, message })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

/** Content types a browser will render and that can execute script in-origin. */
function isRenderableActiveType(contentType: string): boolean {
  const t = contentType.split(';')[0].trim().toLowerCase()
  return (
    t === 'text/html' ||
    t === 'application/xhtml+xml' ||
    t === 'image/svg+xml' ||
    t === 'application/xml' ||
    t === 'text/xml'
  )
}

/** In-flight resumable (TUS) upload, held in memory until the last chunk. */
interface TusUpload {
  bucketId: string
  key: string
  contentType: string
  cacheControl: string
  upsert: boolean
  length: number
  offset: number
  data: Uint8Array
  ctx: RequestContext
}

const TUS_VERSION = '1.0.0'

/** Routes /storage/v1/* requests to bucket and object operations. */
export class StorageHandler {
  private tusUploads = new Map<string, TusUpload>()
  private warnedTransform = false
  private quotaBytes: number | null
  private lastRefusedAt: string | null = null
  /** Tail of the chain that serializes quota-checked writes (check + persist). */
  private quotaChain: Promise<unknown> = Promise.resolve()

  constructor(
    private db: Database,
    private driver: StorageDriver,
    private config: StorageConfig
  ) {
    this.quotaBytes = config.quotaBytes ?? null
  }

  // ── quota ───────────────────────────────────────────────────────────────

  /**
   * Load the persisted quota settings (storage.config). A quota set through the
   * admin API wins over the configured initial value, including an explicit
   * null (unlimited). Call once at boot, before serving.
   */
  async loadQuota(): Promise<void> {
    try {
      const res = await this.db.query(`select key, value from storage.config where key in ('quota', 'quota_refused')`)
      for (const row of res.rows as { key: string; value: Record<string, unknown> }[]) {
        if (row.key === 'quota') {
          const q = row.value?.quota_bytes
          this.quotaBytes = typeof q === 'number' && Number.isFinite(q) && q >= 0 ? q : null
        } else if (row.key === 'quota_refused') {
          const at = row.value?.at
          this.lastRefusedAt = typeof at === 'string' ? at : null
        }
      }
    } catch {
      // older data directory without storage.config: keep the configured value
    }
  }

  /** Current usage and quota, for the admin API. */
  async quotaStatus(): Promise<StorageQuotaStatus> {
    const res = await this.db.query(
      `select coalesce(sum(((metadata->>'size'))::bigint), 0)::text as used, count(*)::int as objects
       from storage.objects`
    )
    const row = res.rows[0] as { used: string | number; objects: number | string }
    return {
      used_bytes: Number(row.used),
      quota_bytes: this.quotaBytes,
      objects: Number(row.objects),
      last_refused_at: this.lastRefusedAt,
    }
  }

  /** Set (or clear, with null) the project-wide quota. Applies immediately and persists across restarts. */
  async setQuota(bytes: number | null): Promise<void> {
    await this.saveConfig('quota', { quota_bytes: bytes })
    this.quotaBytes = bytes
  }

  private async saveConfig(key: string, value: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `insert into storage.config (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    )
  }

  private async usedBytes(): Promise<number> {
    const res = await this.db.query(
      `select coalesce(sum(((metadata->>'size'))::bigint), 0)::text as used from storage.objects`
    )
    return Number((res.rows[0] as { used: string | number }).used)
  }

  /**
   * Refuse a write that would take the project over its storage quota.
   * `adding` is the size of the object being written; `replaces` names an
   * existing object it overwrites (upsert), whose size is freed. A write that
   * doesn't grow usage is always allowed, so an over-quota project can still
   * shrink or replace files.
   *
   * @returns a 413 response to send, or null when the write fits
   */
  private async checkQuota(adding: number, replaces?: { bucketId: string; key: string }): Promise<Response | null> {
    const quota = this.quotaBytes
    if (quota === null) return null
    let replaced = 0
    if (replaces) {
      const res = await this.db.query(
        `select ((metadata->>'size'))::bigint as size from storage.objects where bucket_id = $1 and name = $2`,
        [replaces.bucketId, replaces.key]
      )
      const row = res.rows[0] as { size: string | number | null } | undefined
      replaced = row?.size != null ? Number(row.size) : 0
    }
    if (adding <= replaced) return null
    const used = await this.usedBytes()
    if (used - replaced + adding <= quota) return null
    return this.refuseQuota(used, quota)
  }

  private async refuseQuota(used: number, quota: number): Promise<Response> {
    this.lastRefusedAt = new Date().toISOString()
    await this.saveConfig('quota_refused', { at: this.lastRefusedAt }).catch(() => {})
    this.config.log?.(`[storage] write refused: storage quota reached (${formatBytes(used)} of ${formatBytes(quota)})`)
    return storageError(
      413,
      'storage_quota_exceeded',
      `This app has reached its storage limit (${formatBytes(used)} of ${formatBytes(quota)}). ` +
        'The project owner can free up space or upgrade their plan.'
    )
  }

  /**
   * Run a quota-checked write so that two concurrent writes can't both pass the
   * check and together exceed the quota. Writes are only serialized while a
   * quota is set; without one they run as before.
   */
  private serializeQuota<T>(fn: () => Promise<T>): Promise<T> {
    if (this.quotaBytes === null) return fn()
    const run = this.quotaChain.then(fn, fn)
    this.quotaChain = run.catch(() => {})
    return run
  }

  /** Effective per-object size limit for a bucket (its own, else the project default). */
  private sizeLimitFor(bucket: BucketRow): number | undefined {
    return bucket.file_size_limit != null ? Number(bucket.file_size_limit) : this.config.defaultFileSizeLimit
  }

  /** Create the given buckets if they don't already exist (config.toml storage.buckets.*). */
  async ensureBuckets(buckets: BucketSeed[]): Promise<void> {
    for (const b of buckets) {
      await this.db.query(
        `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
         values ($1, $1, $2, $3, $4) on conflict (id) do nothing`,
        [b.id, b.public, b.fileSizeLimit ?? this.config.defaultFileSizeLimit ?? null, b.allowedMimeTypes]
      )
    }
  }

  /** Entry point: match the path to a bucket/object endpoint and map thrown errors to storage-api responses. */
  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    const rest = url.pathname.replace(/^\/storage\/v1\/?/, '').replace(/\/+$/, '')
    const method = req.method.toUpperCase()
    const range = req.headers.get('range')

    try {
      // ── buckets ──
      if (rest === 'bucket' && method === 'POST') return await this.createBucket(req, ctx)
      if (rest === 'bucket' && method === 'GET') return await this.listBuckets()
      const bucketMatch = rest.match(/^bucket\/([^/]+)$/)
      if (bucketMatch && method === 'GET') return await this.getBucket(dec(bucketMatch[1]))
      if (bucketMatch && method === 'PUT') return await this.updateBucket(req, ctx, dec(bucketMatch[1]))
      if (bucketMatch && method === 'DELETE') return await this.deleteBucket(ctx, dec(bucketMatch[1]))
      const emptyMatch = rest.match(/^bucket\/([^/]+)\/empty$/)
      if (emptyMatch && method === 'POST') return await this.emptyBucket(ctx, dec(emptyMatch[1]))

      // ── objects ──
      const parts = rest.split('/').map(dec)

      // ── resumable (TUS) uploads: /upload/resumable[/:id] ──
      if (parts[0] === 'upload' && parts[1] === 'resumable') {
        return await this.handleTus(req, ctx, url, parts.slice(2).join('/'), method)
      }

      // ── image transforms: /render/image/{authenticated,public,sign}/:bucket/:path ──
      // Not supported yet — serve the ORIGINAL object as a no-op (with a warning)
      // rather than 404, so apps requesting a transform still get their image.
      if (parts[0] === 'render' && parts[1] === 'image' && parts.length >= 5) {
        this.warnTransformUnsupported()
        const kind = parts[2]
        const bucket = parts[3]
        const key = parts.slice(4).join('/')
        if (kind === 'public' && (method === 'GET' || method === 'HEAD')) {
          return await this.downloadPublic(bucket, key, method === 'HEAD', range)
        }
        if (kind === 'authenticated' && (method === 'GET' || method === 'HEAD')) {
          return await this.download(ctx, bucket, key, method === 'HEAD', range)
        }
        if (kind === 'sign' && method === 'GET') {
          return await this.redeemSignedUrl(url, bucket, key, range)
        }
        return storageError(404, 'not_found', `unknown render endpoint: ${rest}`)
      }

      if (parts[0] !== 'object') return storageError(404, 'not_found', `unknown storage endpoint: ${rest}`)

      if (parts[1] === 'move' && method === 'POST') return await this.moveOrCopy(req, ctx, 'move')
      if (parts[1] === 'copy' && method === 'POST') return await this.moveOrCopy(req, ctx, 'copy')

      if (parts[1] === 'list' && parts.length === 3 && method === 'POST') {
        return await this.listObjects(req, ctx, parts[2])
      }
      if (parts[1] === 'public' && parts.length >= 4 && (method === 'GET' || method === 'HEAD')) {
        return await this.downloadPublic(parts[2], parts.slice(3).join('/'), method === 'HEAD', range)
      }
      if (parts[1] === 'authenticated' && parts.length >= 4 && (method === 'GET' || method === 'HEAD')) {
        return await this.download(ctx, parts[2], parts.slice(3).join('/'), method === 'HEAD', range)
      }
      if (parts[1] === 'sign' && parts.length === 3 && method === 'POST') {
        return await this.signUrls(req, ctx, parts[2])
      }
      if (parts[1] === 'sign' && parts.length >= 4 && method === 'POST') {
        return await this.signUrl(req, ctx, parts[2], parts.slice(3).join('/'))
      }
      if (parts[1] === 'sign' && parts.length >= 4 && method === 'GET') {
        return await this.redeemSignedUrl(url, parts[2], parts.slice(3).join('/'), range)
      }
      if (parts[1] === 'upload' && parts[2] === 'sign' && parts.length >= 5) {
        const bucket = parts[3]
        const key = parts.slice(4).join('/')
        if (method === 'POST') return await this.signUploadUrl(ctx, bucket, key)
        if (method === 'PUT') return await this.redeemSignedUpload(req, url, bucket, key)
      }
      if (parts[1] === 'info' && parts.length >= 4 && method === 'GET') {
        return await this.objectInfo(ctx, parts[2], parts.slice(3).join('/'))
      }

      // plain /object/:bucket[/:path...]
      const bucket = parts[1]
      const key = parts.slice(2).join('/')
      if (key === '' && method === 'DELETE') return await this.removeObjects(req, ctx, bucket)
      if (key !== '') {
        if (method === 'POST' || method === 'PUT') return await this.upload(req, ctx, bucket, key)
        if (method === 'GET' || method === 'HEAD') return await this.download(ctx, bucket, key, method === 'HEAD', range)
        if (method === 'DELETE') return await this.removeOne(ctx, bucket, key)
      }
      return storageError(404, 'not_found', `unknown storage endpoint: ${rest}`)
    } catch (e) {
      if (e instanceof StorageValidationError) {
        return storageError(400, 'InvalidRequest', e.message)
      }
      const pg = e as { code?: string; message?: string }
      if (pg.code === '42501') {
        return storageError(403, 'Unauthorized', pg.message ?? 'new row violates row-level security policy')
      }
      const msg = e instanceof Error ? e.message : String(e)
      return storageError(500, 'internal', msg)
    }
  }

  // ── buckets ─────────────────────────────────────────────────────────────

  private requireService(ctx: RequestContext): Response | null {
    if (ctx.role !== 'service_role') {
      return storageError(403, 'Unauthorized', 'Bucket management requires the service_role key')
    }
    return null
  }

  private async createBucket(req: Request, ctx: RequestContext): Promise<Response> {
    const denied = this.requireService(ctx)
    if (denied) return denied
    const body = (await req.json().catch(() => ({}))) as {
      id?: string
      name?: string
      public?: boolean
      file_size_limit?: number | string | null
      allowed_mime_types?: string[] | null
    }
    const id = body.id ?? body.name
    if (!id) return storageError(400, 'invalid_request', 'bucket id is required')
    const existing = await this.db.query(`select id from storage.buckets where id = $1`, [id])
    if (existing.rows.length > 0) {
      return storageError(409, 'Duplicate', 'The resource already exists')
    }
    await this.db.query(
      `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
       values ($1, $2, $3, $4, $5)`,
      [id, body.name ?? id, body.public ?? false, parseSizeLimit(body.file_size_limit), body.allowed_mime_types ?? null]
    )
    return json(200, { name: id })
  }

  private async listBuckets(): Promise<Response> {
    const res = await this.db.query(`select * from storage.buckets order by created_at`)
    return json(200, (res.rows as BucketRow[]).map(bucketJson))
  }

  private async getBucket(id: string): Promise<Response> {
    const res = await this.db.query(`select * from storage.buckets where id = $1`, [id])
    if (res.rows.length === 0) return storageError(404, 'Bucket not found', 'Bucket not found')
    return json(200, bucketJson(res.rows[0] as BucketRow))
  }

  private async updateBucket(req: Request, ctx: RequestContext, id: string): Promise<Response> {
    const denied = this.requireService(ctx)
    if (denied) return denied
    const body = (await req.json().catch(() => ({}))) as {
      public?: boolean
      file_size_limit?: number | string | null
      allowed_mime_types?: string[] | null
    }
    const res = await this.db.query(
      `update storage.buckets
       set public = coalesce($2, public),
           file_size_limit = $3,
           allowed_mime_types = $4,
           updated_at = now()
       where id = $1 returning id`,
      [id, body.public ?? null, parseSizeLimit(body.file_size_limit), body.allowed_mime_types ?? null]
    )
    if (res.rows.length === 0) return storageError(404, 'Bucket not found', 'Bucket not found')
    return json(200, { message: 'Successfully updated' })
  }

  private async deleteBucket(ctx: RequestContext, id: string): Promise<Response> {
    const denied = this.requireService(ctx)
    if (denied) return denied
    const objects = await this.db.query(`select count(*)::int as count from storage.objects where bucket_id = $1`, [id])
    if ((objects.rows[0] as { count: number }).count > 0) {
      return storageError(409, 'Conflict', 'The bucket you tried to delete is not empty')
    }
    const res = await this.db.query(`delete from storage.buckets where id = $1 returning id`, [id])
    if (res.rows.length === 0) return storageError(404, 'Bucket not found', 'Bucket not found')
    return json(200, { message: 'Successfully deleted' })
  }

  private async emptyBucket(ctx: RequestContext, id: string): Promise<Response> {
    const denied = this.requireService(ctx)
    if (denied) return denied
    const res = await this.db.query(`delete from storage.objects where bucket_id = $1 returning name`, [id])
    await this.driver.deleteMany((res.rows as { name: string }[]).map((r) => `${id}/${r.name}`))
    return json(200, { message: 'Successfully emptied' })
  }

  // ── objects ─────────────────────────────────────────────────────────────

  private async loadBucket(id: string): Promise<BucketRow | null> {
    const res = await this.db.query(`select * from storage.buckets where id = $1`, [id])
    return (res.rows[0] as BucketRow) ?? null
  }

  private async upload(req: Request, ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    const keyErr = invalidObjectKey(key)
    if (keyErr) return storageError(400, 'invalid_key', keyErr)
    const bucket = await this.loadBucket(bucketId)
    if (!bucket) return storageError(404, 'Bucket not found', 'Bucket not found')

    const upsert = (req.headers.get('x-upsert') ?? 'false').toLowerCase() === 'true' || req.method === 'PUT'
    let contentType = req.headers.get('content-type') ?? 'application/octet-stream'
    let cacheControl = req.headers.get('cache-control') ?? 'no-cache'
    let bytes: Uint8Array
    const sizeLimit = this.sizeLimitFor(bucket)
    const replaces = upsert ? { bucketId, key } : undefined

    // Refuse an oversized body from its declared length, before buffering it.
    const declared = Number(req.headers.get('content-length') ?? NaN)
    if (Number.isFinite(declared) && declared > 0) {
      const payload = contentType.startsWith('multipart/form-data') ? Math.max(0, declared - MULTIPART_SLACK) : declared
      if (sizeLimit != null && payload > sizeLimit) {
        return storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')
      }
      const refused = await this.checkQuota(payload, replaces)
      if (refused) return refused
    }

    if (contentType.startsWith('multipart/form-data')) {
      // storage-js wraps Blob/File bodies in FormData with an EMPTY field
      // name, which some runtimes' formData() drops - parse bytes ourselves.
      const boundary = contentType.match(/boundary="?([^";]+)"?/)?.[1]
      if (!boundary) return storageError(400, 'invalid_request', 'multipart body without boundary')
      const parts = parseMultipart(new Uint8Array(await req.arrayBuffer()), boundary)
      const filePart = parts.find((p) => p.filename !== undefined || p.contentType !== undefined)
      if (!filePart) return storageError(400, 'invalid_request', 'no file found in multipart body')
      const cc = parts.find((p) => p.name === 'cacheControl')
      if (cc) cacheControl = new TextDecoder().decode(cc.data)
      bytes = filePart.data
      contentType = filePart.contentType ?? 'application/octet-stream'
    } else {
      bytes = new Uint8Array(await req.arrayBuffer())
    }

    // Per-bucket limit, falling back to the project-wide default (config.toml
    // storage.file_size_limit) when the bucket sets none.
    if (sizeLimit != null && bytes.length > sizeLimit) {
      return storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')
    }
    if (bucket.allowed_mime_types && bucket.allowed_mime_types.length > 0) {
      const base = contentType.split(';')[0].trim()
      if (!bucket.allowed_mime_types.some((m) => m === base || (m.endsWith('/*') && base.startsWith(m.slice(0, -1))))) {
        return storageError(415, 'invalid_mime_type', `mime type ${base} is not supported`)
      }
    }

    try {
      const body = bytes
      return await this.serializeQuota(async () => {
        const refused = await this.checkQuota(body.length, replaces)
        if (refused) return refused
        const id = await this.persistObject(ctx, bucketId, key, body, contentType, cacheControl, upsert)
        return json(200, { Key: `${bucketId}/${key}`, Id: id })
      })
    } catch (e) {
      const pg = e as { code?: string }
      if (pg.code === '23505') {
        return storageError(409, 'Duplicate', 'The resource already exists')
      }
      throw e
    }
  }

  /** Warn once that image transforms are unsupported (the original is served). */
  private warnTransformUnsupported(): void {
    if (this.warnedTransform) return
    this.warnedTransform = true
    this.config.log?.(
      '[storage] image transformations are not supported yet — serving the original object unchanged ' +
        '(this warning is shown once per process).'
    )
  }

  /** Insert (or upsert) the object row and write its bytes to the driver. */
  private async persistObject(
    ctx: RequestContext,
    bucketId: string,
    key: string,
    bytes: Uint8Array,
    contentType: string,
    cacheControl: string,
    upsert: boolean
  ): Promise<string> {
    const metadata = {
      eTag: `"${crypto.randomUUID()}"`,
      size: bytes.length,
      mimetype: contentType,
      cacheControl,
      lastModified: new Date().toISOString(),
      contentLength: bytes.length,
      httpStatusCode: 200,
    }
    const conflictClause = upsert
      ? `on conflict (bucket_id, name) do update
           set metadata = excluded.metadata, owner = excluded.owner, updated_at = now(), version = excluded.version`
      : ''
    const res = await this.db.withContext(ctx, (q) =>
      q(
        `insert into storage.objects (bucket_id, name, owner, metadata, version)
         values ($1, $2, $3, $4::jsonb, $5) ${conflictClause} returning id`,
        [bucketId, key, ctx.claims?.sub ?? null, JSON.stringify(metadata), crypto.randomUUID()]
      )
    )
    // Row committed first so RLS authorizes the write; if the byte write then
    // fails, roll the row back so we never leave a metadata row whose download
    // would 404 ("Object not found").
    const insertedId = (res.rows[0] as { id: string }).id
    try {
      await this.driver.put(`${bucketId}/${key}`, bytes)
    } catch (e) {
      await this.db.query(`delete from storage.objects where id = $1`, [insertedId]).catch(() => {})
      throw e
    }
    return insertedId
  }

  // ── resumable (TUS) uploads ───────────────────────────────────────────────
  // A minimal TUS 1.0.0 server (creation, creation-with-upload, core PATCH,
  // termination) for supabase-js's resumable uploads. Upload state is held in
  // memory, so it resumes across network interruptions within a server session.

  private async handleTus(
    req: Request,
    ctx: RequestContext,
    url: URL,
    id: string,
    method: string
  ): Promise<Response> {
    const tus = (extra: Record<string, string> = {}): Record<string, string> => ({
      'tus-resumable': TUS_VERSION,
      ...extra,
    })

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: tus({ 'tus-version': TUS_VERSION, 'tus-extension': 'creation,creation-with-upload,termination' }),
      })
    }

    // POST /upload/resumable — create a new upload
    if (id === '' && method === 'POST') {
      const length = parseInt(req.headers.get('upload-length') ?? '', 10)
      if (!Number.isFinite(length) || length < 0) {
        return storageError(400, 'invalid_request', 'a non-negative Upload-Length header is required')
      }
      const meta = parseTusMetadata(req.headers.get('upload-metadata'))
      const bucketId = meta.bucketName
      const key = meta.objectName
      if (!bucketId || !key) {
        return storageError(400, 'invalid_request', 'bucketName and objectName upload metadata are required')
      }
      const bucket = await this.loadBucket(bucketId)
      if (!bucket) return storageError(404, 'Bucket not found', 'Bucket not found')
      const sizeLimit = this.sizeLimitFor(bucket)
      if (sizeLimit != null && length > sizeLimit) {
        return storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')
      }
      const tusUpsert = (req.headers.get('x-upsert') ?? 'false').toLowerCase() === 'true'
      // Refuse before allocating the upload buffer; re-checked when it completes.
      const refused = await this.checkQuota(length, tusUpsert ? { bucketId, key } : undefined)
      if (refused) return refused
      const uploadId = crypto.randomUUID()
      const upload: TusUpload = {
        bucketId,
        key,
        contentType: meta.contentType ?? 'application/octet-stream',
        cacheControl: meta.cacheControl ?? 'no-cache',
        upsert: tusUpsert,
        length,
        offset: 0,
        data: new Uint8Array(length),
        ctx,
      }
      this.tusUploads.set(uploadId, upload)

      // creation-with-upload: an initial chunk may ride along on the POST
      if ((req.headers.get('content-type') ?? '').includes('application/offset+octet-stream')) {
        const chunk = new Uint8Array(await req.arrayBuffer())
        if (chunk.length > 0) {
          const err = await this.appendTus(uploadId, upload, 0, chunk)
          if (err) return err
        }
      }
      return new Response(null, {
        status: 201,
        headers: tus({
          location: `${url.origin}/storage/v1/upload/resumable/${uploadId}`,
          'upload-offset': String(upload.offset),
        }),
      })
    }

    const upload = id ? this.tusUploads.get(id) : undefined

    if (method === 'HEAD') {
      if (!upload) return new Response(null, { status: 404, headers: tus() })
      return new Response(null, {
        status: 200,
        headers: tus({
          'upload-offset': String(upload.offset),
          'upload-length': String(upload.length),
          'cache-control': 'no-store',
        }),
      })
    }

    if (method === 'PATCH') {
      if (!upload) return new Response(null, { status: 404, headers: tus() })
      if (!(req.headers.get('content-type') ?? '').includes('application/offset+octet-stream')) {
        return new Response(null, { status: 415, headers: tus() })
      }
      const offset = parseInt(req.headers.get('upload-offset') ?? '', 10)
      if (offset !== upload.offset) {
        return new Response(null, { status: 409, headers: tus() }) // offset mismatch
      }
      const chunk = new Uint8Array(await req.arrayBuffer())
      const err = await this.appendTus(id, upload, offset, chunk)
      if (err) return err
      return new Response(null, { status: 204, headers: tus({ 'upload-offset': String(upload.offset) }) })
    }

    if (method === 'DELETE') {
      this.tusUploads.delete(id)
      return new Response(null, { status: 204, headers: tus() })
    }

    return storageError(404, 'not_found', 'unknown resumable upload endpoint')
  }

  /** Append a chunk at `offset`; finalize the object once fully received. */
  private async appendTus(
    id: string,
    upload: TusUpload,
    offset: number,
    chunk: Uint8Array
  ): Promise<Response | undefined> {
    if (offset + chunk.length > upload.length) {
      this.tusUploads.delete(id)
      return storageError(400, 'invalid_request', 'chunk exceeds the declared Upload-Length')
    }
    upload.data.set(chunk, offset)
    upload.offset = offset + chunk.length
    if (upload.offset < upload.length) return undefined

    try {
      const refused = await this.serializeQuota(async () => {
        // other writes may have landed since the upload was created
        const r = await this.checkQuota(
          upload.length,
          upload.upsert ? { bucketId: upload.bucketId, key: upload.key } : undefined
        )
        if (r) return r
        await this.persistObject(
          upload.ctx,
          upload.bucketId,
          upload.key,
          upload.data,
          upload.contentType,
          upload.cacheControl,
          upload.upsert
        )
        return null
      })
      if (refused) {
        this.tusUploads.delete(id)
        return refused
      }
    } catch (e) {
      this.tusUploads.delete(id)
      const pg = e as { code?: string }
      if (pg.code === '23505') return storageError(409, 'Duplicate', 'The resource already exists')
      throw e
    }
    this.tusUploads.delete(id)
    return undefined
  }

  private async download(
    ctx: RequestContext,
    bucketId: string,
    key: string,
    head: boolean,
    range: string | null
  ): Promise<Response> {
    const res = await this.db.withContext(ctx, (q) =>
      q(`select * from storage.objects where bucket_id = $1 and name = $2`, [bucketId, key])
    )
    const row = res.rows[0] as ObjectRow | undefined
    if (!row) return storageError(404, 'not_found', 'Object not found')
    return this.serveObject(row, bucketId, key, head, range)
  }

  private async downloadPublic(bucketId: string, key: string, head: boolean, range: string | null): Promise<Response> {
    const bucket = await this.loadBucket(bucketId)
    if (!bucket?.public) return storageError(400, 'not_found', 'Bucket is not public')
    const res = await this.db.query(`select * from storage.objects where bucket_id = $1 and name = $2`, [
      bucketId,
      key,
    ])
    const row = res.rows[0] as ObjectRow | undefined
    if (!row) return storageError(404, 'not_found', 'Object not found')
    return this.serveObject(row, bucketId, key, head, range)
  }

  /**
   * Answer a download. Honours a single `Range: bytes=…` (206 with only those
   * bytes, or 416 when it starts past the end), which Safari requires before it
   * will play <audio>/<video>; anything else gets the whole object (200).
   */
  private async serveObject(
    row: ObjectRow,
    bucketId: string,
    key: string,
    head: boolean,
    range: string | null
  ): Promise<Response> {
    const path = `${bucketId}/${key}`
    // Learn the size without reading the bytes when the driver can, so a HEAD
    // or a ranged read of a large object does not load all of it.
    let bytes: Uint8Array | null = null
    let size: number | null
    if (this.driver.size && (head || range !== null)) {
      size = await this.driver.size(path)
    } else {
      bytes = await this.driver.get(path)
      size = bytes?.length ?? null
    }
    if (size === null) return storageError(404, 'not_found', 'Object not found')
    const meta = row.metadata ?? {}
    const contentType = String(meta.mimetype ?? 'application/octet-stream')
    const headers: Record<string, string> = {
      'content-type': contentType,
      'content-length': String(size),
      'accept-ranges': 'bytes',
      'cache-control': String(meta.cacheControl ?? 'no-cache'),
      etag: String(meta.eTag ?? '""'),
      'last-modified': new Date(String(meta.lastModified ?? Date.now())).toUTCString(),
      // never let the browser sniff a different (executable) type
      'x-content-type-options': 'nosniff',
    }
    // The content-type is attacker-controlled at upload time; force active
    // content to download instead of rendering same-origin (stored-XSS guard).
    if (isRenderableActiveType(contentType)) headers['content-disposition'] = 'attachment'

    const span = range === null ? null : parseByteRange(range, size)
    if (span === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-length': '0', 'content-range': `bytes */${size}` },
      })
    }
    if (span) {
      const [start, end] = span
      headers['content-length'] = String(end - start + 1)
      headers['content-range'] = `bytes ${start}-${end}/${size}`
      let body: Uint8Array | null = null
      if (!head) {
        body = bytes
          ? bytes.subarray(start, end + 1)
          : this.driver.getRange
            ? await this.driver.getRange(path, start, end)
            : ((await this.driver.get(path))?.subarray(start, end + 1) ?? null)
        if (body === null) return storageError(404, 'not_found', 'Object not found')
      }
      return new Response(body as BodyInit | null, { status: 206, headers })
    }
    if (!head && bytes === null) {
      bytes = await this.driver.get(path)
      if (bytes === null) return storageError(404, 'not_found', 'Object not found')
      headers['content-length'] = String(bytes.length)
    }
    return new Response(head ? null : (bytes as BodyInit), { status: 200, headers })
  }

  private async removeObjects(req: Request, ctx: RequestContext, bucketId: string): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { prefixes?: string[] }
    const prefixes = body.prefixes ?? []
    if (prefixes.length === 0) return json(200, [])
    const res = await this.db.withContext(ctx, (q) =>
      q(`delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning *`, [
        bucketId,
        `{${prefixes.map((p) => `"${p.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`,
      ])
    )
    const rows = res.rows as ObjectRow[]
    await this.driver.deleteMany(rows.map((r) => `${bucketId}/${r.name}`))
    return json(200, rows.map((r) => objectJson(r)))
  }

  private async removeOne(ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    const res = await this.db.withContext(ctx, (q) =>
      q(`delete from storage.objects where bucket_id = $1 and name = $2 returning *`, [bucketId, key])
    )
    if (res.rows.length === 0) return storageError(404, 'not_found', 'Object not found')
    await this.driver.delete(`${bucketId}/${key}`)
    return json(200, { message: 'Successfully deleted' })
  }

  private async moveOrCopy(req: Request, ctx: RequestContext, mode: 'move' | 'copy'): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      bucketId?: string
      sourceKey?: string
      destinationKey?: string
      destinationBucket?: string
    }
    if (!body.bucketId || !body.sourceKey || !body.destinationKey) {
      return storageError(400, 'invalid_request', 'bucketId, sourceKey and destinationKey are required')
    }
    const srcErr = invalidObjectKey(body.sourceKey)
    if (srcErr) return storageError(400, 'invalid_key', srcErr)
    const dstErr = invalidObjectKey(body.destinationKey)
    if (dstErr) return storageError(400, 'invalid_key', dstErr)
    const dstBucket = body.destinationBucket ?? body.bucketId
    const bytes = await this.driver.get(`${body.bucketId}/${body.sourceKey}`)
    if (bytes === null) return storageError(404, 'not_found', 'Object not found')

    if (mode === 'move') {
      // Write the destination bytes first so the row never points at a missing
      // key; if the RLS-checked update fails, remove the bytes we just wrote.
      await this.driver.put(`${dstBucket}/${body.destinationKey}`, bytes)
      let res
      try {
        res = await this.db.withContext(ctx, (q) =>
          q(
            `update storage.objects set bucket_id = $3, name = $4, updated_at = now()
             where bucket_id = $1 and name = $2 returning id`,
            [body.bucketId, body.sourceKey, dstBucket, body.destinationKey]
          )
        )
      } catch (e) {
        await this.driver.delete(`${dstBucket}/${body.destinationKey}`).catch(() => {})
        throw e
      }
      if (res.rows.length === 0) {
        await this.driver.delete(`${dstBucket}/${body.destinationKey}`).catch(() => {})
        return storageError(404, 'not_found', 'Object not found')
      }
      await this.driver.delete(`${body.bucketId}/${body.sourceKey}`).catch(() => {})
      return json(200, { message: 'Successfully moved' })
    }

    // A copy stores a second object, so it is subject to the destination
    // bucket's size limit and to the project quota like any upload.
    const destination = await this.loadBucket(dstBucket)
    if (!destination) return storageError(404, 'Bucket not found', 'Bucket not found')
    const sizeLimit = this.sizeLimitFor(destination)
    if (sizeLimit != null && bytes.length > sizeLimit) {
      return storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')
    }

    return this.serializeQuota(async () => {
      const refused = await this.checkQuota(bytes.length)
      if (refused) return refused
      const res = await this.db.withContext(ctx, (q) =>
        q(
          `insert into storage.objects (bucket_id, name, owner, metadata, version)
           select $3, $4, $5, metadata, gen_random_uuid()::text
           from storage.objects where bucket_id = $1 and name = $2
           returning id`,
          [body.bucketId, body.sourceKey, dstBucket, body.destinationKey, ctx.claims?.sub ?? null]
        )
      )
      if (res.rows.length === 0) return storageError(404, 'not_found', 'Object not found')
      const copyId = (res.rows[0] as { id: string }).id
      try {
        await this.driver.put(`${dstBucket}/${body.destinationKey}`, bytes)
      } catch (e) {
        await this.db.query(`delete from storage.objects where id = $1`, [copyId]).catch(() => {})
        throw e
      }
      return json(200, { Id: copyId, Key: `${dstBucket}/${body.destinationKey}` })
    })
  }

  private async listObjects(req: Request, ctx: RequestContext, bucketId: string): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      prefix?: string
      limit?: number
      offset?: number
      search?: string
      sortBy?: { column?: string; order?: string }
    }
    let prefix = body.prefix ?? ''
    if (prefix !== '' && !prefix.endsWith('/')) prefix += '/'

    const res = await this.db.withContext(ctx, (q) =>
      q(`select * from storage.objects where bucket_id = $1 and name like $2 order by name`, [
        bucketId,
        `${likeEscape(prefix)}%`,
      ])
    )

    const files: Record<string, ObjectRow> = {}
    const folders = new Set<string>()
    for (const row of res.rows as ObjectRow[]) {
      const relative = row.name.slice(prefix.length)
      const slash = relative.indexOf('/')
      if (slash === -1) files[relative] = row
      else folders.add(relative.slice(0, slash))
    }

    let entries: { name: string; row: ObjectRow | null }[] = [
      ...[...folders].map((name) => ({ name, row: null })),
      ...Object.entries(files).map(([name, row]) => ({ name, row })),
    ]
    if (body.search) entries = entries.filter((e) => e.name.includes(body.search!))

    const column = body.sortBy?.column ?? 'name'
    const asc = (body.sortBy?.order ?? 'asc') === 'asc'
    entries.sort((a, b) => {
      const av = column === 'name' ? a.name : String((a.row as unknown as Record<string, unknown>)?.[column] ?? '')
      const bv = column === 'name' ? b.name : String((b.row as unknown as Record<string, unknown>)?.[column] ?? '')
      return asc ? av.localeCompare(bv) : bv.localeCompare(av)
    })

    const offset = body.offset ?? 0
    const limit = body.limit ?? 100
    const page = entries.slice(offset, offset + limit)
    return json(
      200,
      page.map((e) =>
        e.row
          ? { ...objectJson(e.row), name: e.name }
          : { name: e.name, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null }
      )
    )
  }

  private async objectInfo(ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    const res = await this.db.withContext(ctx, (q) =>
      q(`select * from storage.objects where bucket_id = $1 and name = $2`, [bucketId, key])
    )
    const row = res.rows[0] as ObjectRow | undefined
    if (!row) return storageError(404, 'not_found', 'Object not found')
    const meta = row.metadata ?? {}
    return json(200, {
      id: row.id,
      name: row.name,
      bucket_id: row.bucket_id,
      size: meta.size ?? null,
      content_type: meta.mimetype ?? null,
      cache_control: meta.cacheControl ?? null,
      etag: meta.eTag ?? null,
      metadata: meta,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      last_modified: meta.lastModified ?? null,
      version: null,
    })
  }

  // ── signed URLs ─────────────────────────────────────────────────────────

  private async signUrl(req: Request, ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { expiresIn?: number }
    // visibility check under the caller's role
    const res = await this.db.withContext(ctx, (q) =>
      q(`select id from storage.objects where bucket_id = $1 and name = $2`, [bucketId, key])
    )
    if (res.rows.length === 0) return storageError(404, 'not_found', 'Object not found')
    const token = await this.makeSignToken('download', bucketId, key, body.expiresIn ?? 3600)
    return json(200, { signedURL: `/object/sign/${bucketId}/${encPath(key)}?token=${token}` })
  }

  private async signUrls(req: Request, ctx: RequestContext, bucketId: string): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { expiresIn?: number; paths?: string[] }
    const out: unknown[] = []
    for (const path of body.paths ?? []) {
      const res = await this.db.withContext(ctx, (q) =>
        q(`select id from storage.objects where bucket_id = $1 and name = $2`, [bucketId, path])
      )
      if (res.rows.length === 0) {
        out.push({ path, error: 'Object not found', signedURL: null })
      } else {
        const token = await this.makeSignToken('download', bucketId, path, body.expiresIn ?? 3600)
        out.push({ path, error: null, signedURL: `/object/sign/${bucketId}/${encPath(path)}?token=${token}` })
      }
    }
    return json(200, out)
  }

  private async redeemSignedUrl(url: URL, bucketId: string, key: string, range: string | null): Promise<Response> {
    const token = url.searchParams.get('token') ?? ''
    const claims = await verifyJwt(token, this.config.jwtSecret)
    if (!claims || claims.url !== `${bucketId}/${key}` || claims.type !== 'download') {
      return storageError(400, 'InvalidJWT', 'The provided token is invalid or expired')
    }
    const res = await this.db.query(`select * from storage.objects where bucket_id = $1 and name = $2`, [
      bucketId,
      key,
    ])
    const row = res.rows[0] as ObjectRow | undefined
    if (!row) return storageError(404, 'not_found', 'Object not found')
    return this.serveObject(row, bucketId, key, false, range)
  }

  private async signUploadUrl(ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    const keyErr = invalidObjectKey(key)
    if (keyErr) return storageError(400, 'invalid_key', keyErr)
    const bucket = await this.loadBucket(bucketId)
    if (!bucket) return storageError(404, 'Bucket not found', 'Bucket not found')
    const owner = typeof ctx.claims?.sub === 'string' ? ctx.claims.sub : undefined
    // A URL minted with the service_role key uploads with that key's rights, as on hosted
    // Supabase: server code mints it and hands the URL to a client or script that has no key.
    const token = await this.makeSignToken('upload', bucketId, key, 7200, owner, ctx.role === 'service_role')
    return json(200, {
      url: `/object/upload/sign/${bucketId}/${encPath(key)}?token=${token}`,
      token,
    })
  }

  private async redeemSignedUpload(req: Request, url: URL, bucketId: string, key: string): Promise<Response> {
    const token = url.searchParams.get('token') ?? ''
    const claims = await verifyJwt(token, this.config.jwtSecret)
    if (!claims || claims.url !== `${bucketId}/${key}` || claims.type !== 'upload') {
      return storageError(400, 'InvalidJWT', 'The provided token is invalid or expired')
    }
    // redeem as the token's owner (authenticated user) so RLS still governs the
    // write, rather than the RLS-bypassing service role.
    const owner = typeof claims.owner === 'string' ? claims.owner : undefined
    const uploadCtx: RequestContext =
      claims.service === true
        ? { role: 'service_role', claims: { role: 'service_role' } }
        : owner
          ? { role: 'authenticated', claims: { role: 'authenticated', sub: owner } }
          : { role: 'anon', claims: { role: 'anon' } }
    return this.upload(req, uploadCtx, bucketId, key)
  }

  private makeSignToken(
    type: 'download' | 'upload',
    bucketId: string,
    key: string,
    expiresIn: number,
    owner?: string,
    service = false
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    return signJwt(
      { type, url: `${bucketId}/${key}`, iat: now, exp: now + clampExpiry(expiresIn), owner, ...(service ? { service: true } : {}) },
      this.config.jwtSecret
    )
  }
}

/**
 * Resolve a `Range` header against an object of `size` bytes to an inclusive
 * [start, end], as RFC 9110 §14 reads it: `bytes=a-b`, `bytes=a-` or the suffix
 * `bytes=-n`. Returns null when the header should be ignored (another unit,
 * malformed, or several ranges, which are answered with the whole object) and
 * 'unsatisfiable' when it is well formed but selects no byte.
 */
export function parseByteRange(header: string, size: number): [number, number] | 'unsatisfiable' | null {
  const m = header.trim().match(/^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i)
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return [Math.max(0, size - suffix), size - 1]
  }
  const start = Number(m[1])
  if (m[2] !== '' && Number(m[2]) < start) return null
  if (start >= size) return 'unsatisfiable'
  return [start, m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)]
}

function bucketJson(b: BucketRow): Record<string, unknown> {
  return {
    id: b.id,
    name: b.name,
    owner: '',
    public: b.public,
    file_size_limit: b.file_size_limit === null ? null : Number(b.file_size_limit),
    allowed_mime_types: b.allowed_mime_types,
    created_at: iso(b.created_at),
    updated_at: iso(b.updated_at),
  }
}

function objectJson(r: ObjectRow): Record<string, unknown> {
  return {
    name: r.name,
    bucket_id: r.bucket_id,
    owner: r.owner ?? '',
    id: r.id,
    updated_at: iso(r.updated_at),
    created_at: iso(r.created_at),
    last_accessed_at: iso(r.last_accessed_at),
    metadata: r.metadata ?? {},
  }
}

class StorageValidationError extends Error {}

function parseSizeLimit(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return v
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i)
  // a provided-but-unparseable limit must be rejected, not silently treated as
  // unlimited (which would disable the cap on a typo like "10 megabytes")
  if (!m) throw new StorageValidationError(`invalid file_size_limit: ${v}`)
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase()]!
  return Math.floor(parseFloat(m[1]) * mult)
}

interface MultipartPart {
  name: string
  filename?: string
  contentType?: string
  data: Uint8Array
}

/** Minimal byte-safe multipart/form-data parser (works identically on Node, Bun, browsers). */
export function parseMultipart(bytes: Uint8Array, boundary: string): MultipartPart[] {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const delim = enc.encode(`--${boundary}`)
  const parts: MultipartPart[] = []

  const indexOf = (needle: Uint8Array, from: number): number => {
    outer: for (let i = from; i <= bytes.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) continue outer
      }
      return i
    }
    return -1
  }

  let pos = indexOf(delim, 0)
  while (pos !== -1) {
    const headerStart = pos + delim.length + 2 // skip \r\n (or "--" at the end)
    if (bytes[pos + delim.length] === 0x2d && bytes[pos + delim.length + 1] === 0x2d) break
    const headerEnd = indexOf(enc.encode('\r\n\r\n'), headerStart)
    if (headerEnd === -1) break
    const headerText = dec.decode(bytes.subarray(headerStart, headerEnd))
    const next = indexOf(delim, headerEnd + 4)
    if (next === -1) break
    const data = bytes.subarray(headerEnd + 4, next - 2) // strip trailing \r\n

    const disposition = headerText.match(/content-disposition:[^\r\n]*/i)?.[0] ?? ''
    parts.push({
      name: disposition.match(/[^a-z]name="([^"]*)"/i)?.[1] ?? '',
      filename: disposition.match(/filename="([^"]*)"/i)?.[1],
      contentType: headerText.match(/content-type:\s*([^\r\n;]+)/i)?.[1]?.trim(),
      data: new Uint8Array(data),
    })
    pos = next
  }
  return parts
}

function likeEscape(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function encPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

function dec(s: string): string {
  return decodeURIComponent(s)
}

/** Parse a TUS `Upload-Metadata` header (`key <base64>,flag,...`) to a map. */
function parseTusMetadata(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(',')) {
    const trimmed = pair.trim()
    if (trimmed === '') continue
    const sp = trimmed.indexOf(' ')
    const k = sp === -1 ? trimmed : trimmed.slice(0, sp)
    const v = sp === -1 ? '' : trimmed.slice(sp + 1)
    out[k] = v === '' ? '' : new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)))
  }
  return out
}
