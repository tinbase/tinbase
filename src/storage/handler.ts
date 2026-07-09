/**
 * storage-api-compatible endpoints (/storage/v1/*) for supabase-js's
 * StorageClient. Object metadata lives in storage.objects (RLS enforced
 * through the request role); bytes live behind a StorageDriver.
 */
import type { Database } from '../db/database.js'
import { signJwt, verifyJwt } from '../jwt.js'
import type { RequestContext, StorageDriver } from '../types.js'

export interface StorageConfig {
  jwtSecret: string
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

export class StorageHandler {
  constructor(
    private db: Database,
    private driver: StorageDriver,
    private config: StorageConfig
  ) {}

  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    const rest = url.pathname.replace(/^\/storage\/v1\/?/, '').replace(/\/+$/, '')
    const method = req.method.toUpperCase()

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
      if (parts[0] !== 'object') return storageError(404, 'not_found', `unknown storage endpoint: ${rest}`)

      if (parts[1] === 'move' && method === 'POST') return await this.moveOrCopy(req, ctx, 'move')
      if (parts[1] === 'copy' && method === 'POST') return await this.moveOrCopy(req, ctx, 'copy')

      if (parts[1] === 'list' && parts.length === 3 && method === 'POST') {
        return await this.listObjects(req, ctx, parts[2])
      }
      if (parts[1] === 'public' && parts.length >= 4 && (method === 'GET' || method === 'HEAD')) {
        return await this.downloadPublic(parts[2], parts.slice(3).join('/'), method === 'HEAD')
      }
      if (parts[1] === 'authenticated' && parts.length >= 4 && (method === 'GET' || method === 'HEAD')) {
        return await this.download(ctx, parts[2], parts.slice(3).join('/'), method === 'HEAD')
      }
      if (parts[1] === 'sign' && parts.length === 3 && method === 'POST') {
        return await this.signUrls(req, ctx, parts[2])
      }
      if (parts[1] === 'sign' && parts.length >= 4 && method === 'POST') {
        return await this.signUrl(req, ctx, parts[2], parts.slice(3).join('/'))
      }
      if (parts[1] === 'sign' && parts.length >= 4 && method === 'GET') {
        return await this.redeemSignedUrl(url, parts[2], parts.slice(3).join('/'))
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
        if (method === 'GET' || method === 'HEAD') return await this.download(ctx, bucket, key, method === 'HEAD')
        if (method === 'DELETE') return await this.removeOne(ctx, bucket, key)
      }
      return storageError(404, 'not_found', `unknown storage endpoint: ${rest}`)
    } catch (e) {
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
    const bucket = await this.loadBucket(bucketId)
    if (!bucket) return storageError(404, 'Bucket not found', 'Bucket not found')

    const upsert = (req.headers.get('x-upsert') ?? 'false').toLowerCase() === 'true' || req.method === 'PUT'
    let contentType = req.headers.get('content-type') ?? 'application/octet-stream'
    let cacheControl = req.headers.get('cache-control') ?? 'no-cache'
    let bytes: Uint8Array

    if (contentType.startsWith('multipart/form-data')) {
      // storage-js wraps Blob/File bodies in FormData with an EMPTY field
      // name, which some runtimes' formData() drops — parse bytes ourselves.
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

    if (bucket.file_size_limit != null && bytes.length > Number(bucket.file_size_limit)) {
      return storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')
    }
    if (bucket.allowed_mime_types && bucket.allowed_mime_types.length > 0) {
      const base = contentType.split(';')[0].trim()
      if (!bucket.allowed_mime_types.some((m) => m === base || (m.endsWith('/*') && base.startsWith(m.slice(0, -1))))) {
        return storageError(415, 'invalid_mime_type', `mime type ${base} is not supported`)
      }
    }

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
    try {
      const res = await this.db.withContext(ctx, (q) =>
        q(
          `insert into storage.objects (bucket_id, name, owner, metadata, version)
           values ($1, $2, $3, $4::jsonb, $5) ${conflictClause} returning id`,
          [bucketId, key, ctx.claims?.sub ?? null, JSON.stringify(metadata), crypto.randomUUID()]
        )
      )
      await this.driver.put(`${bucketId}/${key}`, bytes)
      const id = (res.rows[0] as { id: string }).id
      return json(200, { Key: `${bucketId}/${key}`, Id: id })
    } catch (e) {
      const pg = e as { code?: string }
      if (pg.code === '23505') {
        return storageError(409, 'Duplicate', 'The resource already exists')
      }
      throw e
    }
  }

  private async download(ctx: RequestContext, bucketId: string, key: string, head: boolean): Promise<Response> {
    const res = await this.db.withContext(ctx, (q) =>
      q(`select * from storage.objects where bucket_id = $1 and name = $2`, [bucketId, key])
    )
    const row = res.rows[0] as ObjectRow | undefined
    if (!row) return storageError(404, 'not_found', 'Object not found')
    return this.serveObject(row, bucketId, key, head)
  }

  private async downloadPublic(bucketId: string, key: string, head: boolean): Promise<Response> {
    const bucket = await this.loadBucket(bucketId)
    if (!bucket?.public) return storageError(400, 'not_found', 'Bucket is not public')
    const res = await this.db.query(`select * from storage.objects where bucket_id = $1 and name = $2`, [
      bucketId,
      key,
    ])
    const row = res.rows[0] as ObjectRow | undefined
    if (!row) return storageError(404, 'not_found', 'Object not found')
    return this.serveObject(row, bucketId, key, head)
  }

  private async serveObject(row: ObjectRow, bucketId: string, key: string, head: boolean): Promise<Response> {
    const bytes = await this.driver.get(`${bucketId}/${key}`)
    if (bytes === null) return storageError(404, 'not_found', 'Object not found')
    const meta = row.metadata ?? {}
    return new Response(head ? null : (bytes as BodyInit), {
      status: 200,
      headers: {
        'content-type': String(meta.mimetype ?? 'application/octet-stream'),
        'content-length': String(bytes.length),
        'cache-control': String(meta.cacheControl ?? 'no-cache'),
        etag: String(meta.eTag ?? '""'),
        'last-modified': new Date(String(meta.lastModified ?? Date.now())).toUTCString(),
      },
    })
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
    const dstBucket = body.destinationBucket ?? body.bucketId
    const bytes = await this.driver.get(`${body.bucketId}/${body.sourceKey}`)
    if (bytes === null) return storageError(404, 'not_found', 'Object not found')

    if (mode === 'move') {
      const res = await this.db.withContext(ctx, (q) =>
        q(
          `update storage.objects set bucket_id = $3, name = $4, updated_at = now()
           where bucket_id = $1 and name = $2 returning id`,
          [body.bucketId, body.sourceKey, dstBucket, body.destinationKey]
        )
      )
      if (res.rows.length === 0) return storageError(404, 'not_found', 'Object not found')
      await this.driver.put(`${dstBucket}/${body.destinationKey}`, bytes)
      await this.driver.delete(`${body.bucketId}/${body.sourceKey}`)
      return json(200, { message: 'Successfully moved' })
    }

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
    await this.driver.put(`${dstBucket}/${body.destinationKey}`, bytes)
    return json(200, { Id: (res.rows[0] as { id: string }).id, Key: `${dstBucket}/${body.destinationKey}` })
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

  private async redeemSignedUrl(url: URL, bucketId: string, key: string): Promise<Response> {
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
    return this.serveObject(row, bucketId, key, false)
  }

  private async signUploadUrl(ctx: RequestContext, bucketId: string, key: string): Promise<Response> {
    const bucket = await this.loadBucket(bucketId)
    if (!bucket) return storageError(404, 'Bucket not found', 'Bucket not found')
    const owner = typeof ctx.claims?.sub === 'string' ? ctx.claims.sub : undefined
    const token = await this.makeSignToken('upload', bucketId, key, 7200, owner)
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
    const uploadCtx: RequestContext = owner
      ? { role: 'authenticated', claims: { role: 'authenticated', sub: owner } }
      : { role: 'anon', claims: { role: 'anon' } }
    return this.upload(req, uploadCtx, bucketId, key)
  }

  private makeSignToken(
    type: 'download' | 'upload',
    bucketId: string,
    key: string,
    expiresIn: number,
    owner?: string
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    return signJwt({ type, url: `${bucketId}/${key}`, iat: now, exp: now + expiresIn, owner }, this.config.jwtSecret)
  }
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

function parseSizeLimit(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i)
  if (!m) return null
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
