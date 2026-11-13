/**
 * The S3-compatible endpoint (/storage/v1/s3), driven by the real AWS SDK v3
 * client, presigner and lib-storage Upload against a server on a real port,
 * with the filesystem storage driver (the streaming path the CLI uses).
 */
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { SignatureV4 } from '@smithy/signature-v4'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, deriveS3Credentials, type TinbaseBackend } from '../src/index.js'
import { FsStorageDriver } from '../src/node/fs-driver.js'
import { serve, type RunningServer } from '../src/node/server.js'
import { chunkSignature, signingKey, type SignedRequest } from '../src/storage/s3/sigv4.js'
import { testEngine } from './helpers.js'

const MB = 1024 * 1024

let backend: TinbaseBackend
let server: RunningServer
let storageDir: string
let endpoint: string
let s3: S3Client

function client(credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }): S3Client {
  return new S3Client({ endpoint, region: 'local', forcePathStyle: true, credentials })
}

function md5(data: Uint8Array | string): string {
  return createHash('md5').update(data).digest('hex')
}

function bytes(n: number, seed = 1): Buffer {
  const b = Buffer.alloc(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    b[i] = x & 0xff
  }
  return b
}

async function body(res: { Body?: unknown }): Promise<Buffer> {
  return Buffer.from(await (res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray())
}

/** The S3 error code and HTTP status a send() rejected with. */
async function s3Error(p: Promise<unknown>): Promise<{ name: string; status: number | undefined }> {
  try {
    await p
  } catch (e) {
    const err = e as { name: string; Code?: string; $metadata?: { httpStatusCode?: number } }
    return { name: err.Code ?? err.name, status: err.$metadata?.httpStatusCode }
  }
  throw new Error('expected the request to fail')
}

beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'tinbase-s3-'))
  backend = await createBackend({
    engine: await testEngine(),
    storageDriver: new FsStorageDriver(storageDir),
    log: () => {},
  })
  server = await serve(backend, { port: 0 })
  endpoint = `${server.url}/storage/v1/s3`
  s3 = client({ accessKeyId: backend.s3!.accessKeyId, secretAccessKey: backend.s3!.secretAccessKey })
})

afterAll(async () => {
  await server?.close()
  await backend?.close()
  rmSync(storageDir, { recursive: true, force: true })
})

describe('credentials', () => {
  it('uses the Supabase CLI local keys with the default JWT secret', () => {
    expect(backend.s3).toEqual({
      accessKeyId: '625729a08b95bf1b7ff351a663f3a23c',
      secretAccessKey: '850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907',
      region: 'local',
    })
  })

  it('derives stable keys from any other JWT secret, and explicit keys win', async () => {
    const a = await deriveS3Credentials('a-much-longer-custom-secret-of-at-least-32-chars')
    const b = await deriveS3Credentials('a-much-longer-custom-secret-of-at-least-32-chars')
    expect(a).toEqual(b)
    expect(a.accessKeyId).toMatch(/^[0-9a-f]{32}$/)
    expect(a.secretAccessKey).toMatch(/^[0-9a-f]{64}$/)
    expect(a.secretAccessKey).not.toBe(backend.s3!.secretAccessKey)
    expect(await deriveS3Credentials('x'.repeat(40), { accessKeyId: 'id', secretAccessKey: 'secret', region: 'eu' })).toEqual({
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      region: 'eu',
    })
  })
})

describe('buckets', () => {
  it('creates, lists, heads, locates and deletes buckets', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'b-one' }))
    const list = await s3.send(new ListBucketsCommand({}))
    expect(list.Buckets?.map((b) => b.Name)).toContain('b-one')
    expect(list.Buckets?.find((b) => b.Name === 'b-one')?.CreationDate).toBeInstanceOf(Date)

    const head = await s3.send(new HeadBucketCommand({ Bucket: 'b-one' }))
    expect(head.$metadata.httpStatusCode).toBe(200)
    const loc = await s3.send(new GetBucketLocationCommand({ Bucket: 'b-one' }))
    expect(loc.LocationConstraint).toBe('local')

    expect(await s3Error(s3.send(new CreateBucketCommand({ Bucket: 'b-one' })))).toEqual({ name: 'BucketAlreadyOwnedByYou', status: 409 })

    await s3.send(new PutObjectCommand({ Bucket: 'b-one', Key: 'x.txt', Body: 'x' }))
    expect(await s3Error(s3.send(new DeleteBucketCommand({ Bucket: 'b-one' })))).toEqual({ name: 'BucketNotEmpty', status: 409 })
    await s3.send(new DeleteObjectCommand({ Bucket: 'b-one', Key: 'x.txt' }))
    await s3.send(new DeleteBucketCommand({ Bucket: 'b-one' }))

    expect((await s3Error(s3.send(new HeadBucketCommand({ Bucket: 'b-one' })))).status).toBe(404)
    expect(await s3Error(s3.send(new DeleteBucketCommand({ Bucket: 'b-one' })))).toEqual({ name: 'NoSuchBucket', status: 404 })
  })

  it('a bucket created over S3 is a Supabase storage bucket', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'b-visible' }))
    const admin = createClient(server.url, backend.serviceRoleKey, { auth: { persistSession: false } })
    const { data } = await admin.storage.getBucket('b-visible')
    expect(data?.id).toBe('b-visible')
    expect(data?.public).toBe(false)
  })
})

describe('objects', () => {
  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'media', ACL: 'public-read' }))
  })

  it('PutObject stores the body, system headers and x-amz-meta-*, with an MD5 ETag', async () => {
    const put = await s3.send(
      new PutObjectCommand({
        Bucket: 'media',
        Key: 'docs/hello world+1.txt',
        Body: 'hello s3',
        ContentType: 'text/plain; charset=utf-8',
        CacheControl: 'public, max-age=60',
        ContentDisposition: 'inline; filename="hello.txt"',
        Metadata: { author: 'ada', 'x-thing': 'y' },
      })
    )
    expect(put.ETag).toBe(`"${md5('hello s3')}"`)

    const head = await s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'docs/hello world+1.txt' }))
    expect(head.ContentType).toBe('text/plain; charset=utf-8')
    expect(head.CacheControl).toBe('public, max-age=60')
    expect(head.ContentDisposition).toBe('inline; filename="hello.txt"')
    expect(head.ContentLength).toBe(8)
    expect(head.ETag).toBe(put.ETag)
    expect(head.Metadata).toEqual({ author: 'ada', 'x-thing': 'y' })
    expect(head.LastModified).toBeInstanceOf(Date)

    const get = await s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'docs/hello world+1.txt' }))
    expect((await body(get)).toString()).toBe('hello s3')
  })

  it('PutObject accepts a streamed body (aws-chunked with a CRC32 trailer)', async () => {
    const parts = [bytes(100_000, 7), bytes(70_000, 8)]
    const all = Buffer.concat(parts)
    const put = await s3.send(
      new PutObjectCommand({ Bucket: 'media', Key: 'stream.bin', Body: Readable.from(parts), ContentLength: all.length })
    )
    expect(put.ETag).toBe(`"${md5(all)}"`)
    const get = await s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'stream.bin' }))
    expect((await body(get)).equals(all)).toBe(true)
  })

  it('GetObject honours Range, conditionals and response-* overrides', async () => {
    const data = Buffer.from('0123456789abcdef')
    const { ETag } = await s3.send(new PutObjectCommand({ Bucket: 'media', Key: 'range.txt', Body: data }))

    const ranged = await s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'range.txt', Range: 'bytes=2-5' }))
    expect(ranged.$metadata.httpStatusCode).toBe(206)
    expect(ranged.ContentRange).toBe('bytes 2-5/16')
    expect((await body(ranged)).toString()).toBe('2345')
    const suffix = await s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'range.txt', Range: 'bytes=-3' }))
    expect((await body(suffix)).toString()).toBe('def')
    expect(await s3Error(s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'range.txt', Range: 'bytes=99-' })))).toEqual({
      name: 'InvalidRange',
      status: 416,
    })

    expect((await s3Error(s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'range.txt', IfNoneMatch: ETag })))).status).toBe(304)
    expect(
      (await s3Error(s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'range.txt', IfModifiedSince: new Date(Date.now() + 60_000) })))).status
    ).toBe(304)
    const modified = await s3.send(
      new GetObjectCommand({ Bucket: 'media', Key: 'range.txt', IfModifiedSince: new Date(Date.now() - 3_600_000) })
    )
    expect(modified.$metadata.httpStatusCode).toBe(200)
    await modified.Body?.transformToString()
    expect(await s3Error(s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'range.txt', IfMatch: '"nope"' })))).toEqual({
      name: 'PreconditionFailed',
      status: 412,
    })

    const overridden = await s3.send(
      new GetObjectCommand({
        Bucket: 'media',
        Key: 'range.txt',
        ResponseContentType: 'application/x-custom',
        ResponseContentDisposition: 'attachment; filename="r.txt"',
        ResponseCacheControl: 'no-store',
      })
    )
    expect(overridden.ContentType).toBe('application/x-custom')
    expect(overridden.ContentDisposition).toBe('attachment; filename="r.txt"')
    expect(overridden.CacheControl).toBe('no-store')
    await overridden.Body?.transformToString()
  })

  it('missing keys and buckets give NoSuchKey / NoSuchBucket', async () => {
    expect(await s3Error(s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'nope' })))).toEqual({ name: 'NoSuchKey', status: 404 })
    expect((await s3Error(s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'nope' })))).status).toBe(404)
    expect(await s3Error(s3.send(new GetObjectCommand({ Bucket: 'no-bucket', Key: 'x' })))).toEqual({ name: 'NoSuchBucket', status: 404 })
    expect(await s3Error(s3.send(new PutObjectCommand({ Bucket: 'no-bucket', Key: 'x', Body: 'x' })))).toEqual({
      name: 'NoSuchBucket',
      status: 404,
    })
  })

  it('DeleteObject and DeleteObjects remove objects (missing keys count as deleted)', async () => {
    for (const k of ['del/a', 'del/b', 'del/c']) await s3.send(new PutObjectCommand({ Bucket: 'media', Key: k, Body: k }))
    const one = await s3.send(new DeleteObjectCommand({ Bucket: 'media', Key: 'del/a' }))
    expect(one.$metadata.httpStatusCode).toBe(204)
    await s3.send(new DeleteObjectCommand({ Bucket: 'media', Key: 'del/never-existed' }))

    const many = await s3.send(
      new DeleteObjectsCommand({ Bucket: 'media', Delete: { Objects: [{ Key: 'del/b' }, { Key: 'del/c' }, { Key: 'del/zzz' }] } })
    )
    expect(many.Deleted?.map((d) => d.Key).sort()).toEqual(['del/b', 'del/c', 'del/zzz'])
    expect(many.Errors ?? []).toEqual([])
    const left = await s3.send(new ListObjectsV2Command({ Bucket: 'media', Prefix: 'del/' }))
    expect(left.KeyCount).toBe(0)
  })

  it('ListObjectsV2 handles prefix, delimiter, max-keys, continuation and start-after', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'listing' }))
    const keys = ['a.txt', 'b/1.txt', 'b/2.txt', 'b/c/3.txt', 'd.txt', 'e/4.txt', 'f.txt']
    for (const k of keys) await s3.send(new PutObjectCommand({ Bucket: 'listing', Key: k, Body: k }))

    const all = await s3.send(new ListObjectsV2Command({ Bucket: 'listing' }))
    expect(all.Contents?.map((o) => o.Key)).toEqual(keys)
    expect(all.KeyCount).toBe(7)
    expect(all.IsTruncated).toBe(false)
    expect(all.Contents?.[0].Size).toBe(5)
    expect(all.Contents?.[0].ETag).toBe(`"${md5('a.txt')}"`)

    const top = await s3.send(new ListObjectsV2Command({ Bucket: 'listing', Delimiter: '/' }))
    expect(top.Contents?.map((o) => o.Key)).toEqual(['a.txt', 'd.txt', 'f.txt'])
    expect(top.CommonPrefixes?.map((p) => p.Prefix)).toEqual(['b/', 'e/'])

    const inB = await s3.send(new ListObjectsV2Command({ Bucket: 'listing', Prefix: 'b/', Delimiter: '/' }))
    expect(inB.Contents?.map((o) => o.Key)).toEqual(['b/1.txt', 'b/2.txt'])
    expect(inB.CommonPrefixes?.map((p) => p.Prefix)).toEqual(['b/c/'])

    // page through with the delimiter: keys and common prefixes share max-keys
    const seen: string[] = []
    let token: string | undefined
    let pages = 0
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: 'listing', Delimiter: '/', MaxKeys: 2, ContinuationToken: token }))
      seen.push(...(page.Contents ?? []).map((o) => o.Key!), ...(page.CommonPrefixes ?? []).map((p) => p.Prefix!))
      token = page.IsTruncated ? page.NextContinuationToken : undefined
      pages++
    } while (token)
    expect(pages).toBe(3)
    expect(seen.sort()).toEqual(['a.txt', 'b/', 'd.txt', 'e/', 'f.txt'])

    const after = await s3.send(new ListObjectsV2Command({ Bucket: 'listing', StartAfter: 'b/2.txt' }))
    expect(after.Contents?.map((o) => o.Key)).toEqual(['b/c/3.txt', 'd.txt', 'e/4.txt', 'f.txt'])

    const encoded = await s3.send(new ListObjectsV2Command({ Bucket: 'media', Prefix: 'docs/', EncodingType: 'url' }))
    expect(encoded.Contents?.map((o) => decodeURIComponent(o.Key!.replace(/\+/g, ' ')))).toEqual(['docs/hello world+1.txt'])

    const v1 = await s3.send(new ListObjectsCommand({ Bucket: 'listing', MaxKeys: 3 }))
    expect(v1.Contents?.map((o) => o.Key)).toEqual(['a.txt', 'b/1.txt', 'b/2.txt'])
    expect(v1.IsTruncated).toBe(true)
    const v1next = await s3.send(new ListObjectsCommand({ Bucket: 'listing', Marker: v1.NextMarker }))
    expect(v1next.Contents?.map((o) => o.Key)).toEqual(['b/c/3.txt', 'd.txt', 'e/4.txt', 'f.txt'])
  })

  it('CopyObject copies bytes and metadata, or replaces the metadata', async () => {
    await s3.send(
      new PutObjectCommand({ Bucket: 'media', Key: 'orig.txt', Body: 'copy me', ContentType: 'text/plain', Metadata: { k: 'v' } })
    )
    const copy = await s3.send(new CopyObjectCommand({ Bucket: 'media', Key: 'copies/one.txt', CopySource: 'media/orig.txt' }))
    expect(copy.CopyObjectResult?.ETag).toBe(`"${md5('copy me')}"`)
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'copies/one.txt' }))
    expect(head.ContentType).toBe('text/plain')
    expect(head.Metadata).toEqual({ k: 'v' })
    expect((await body(await s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'copies/one.txt' })))).toString()).toBe('copy me')

    await s3.send(new CreateBucketCommand({ Bucket: 'other' }))
    await s3.send(
      new CopyObjectCommand({
        Bucket: 'other',
        Key: 'two.txt',
        CopySource: encodeURIComponent('media/orig.txt'),
        MetadataDirective: 'REPLACE',
        ContentType: 'application/json',
        Metadata: { fresh: '1' },
      })
    )
    const replaced = await s3.send(new HeadObjectCommand({ Bucket: 'other', Key: 'two.txt' }))
    expect(replaced.ContentType).toBe('application/json')
    expect(replaced.Metadata).toEqual({ fresh: '1' })

    // copying onto itself changes metadata in place, and needs REPLACE
    expect((await s3Error(s3.send(new CopyObjectCommand({ Bucket: 'media', Key: 'orig.txt', CopySource: 'media/orig.txt' })))).name).toBe(
      'InvalidRequest'
    )
    await s3.send(
      new CopyObjectCommand({ Bucket: 'media', Key: 'orig.txt', CopySource: 'media/orig.txt', MetadataDirective: 'REPLACE', ContentType: 'text/markdown' })
    )
    const self = await s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'orig.txt' }))
    expect(self.ContentType).toBe('text/markdown')
    expect(self.ETag).toBe(`"${md5('copy me')}"`)

    expect(await s3Error(s3.send(new CopyObjectCommand({ Bucket: 'media', Key: 'x', CopySource: 'media/missing' })))).toEqual({
      name: 'NoSuchKey',
      status: 404,
    })
    expect(
      (await s3Error(s3.send(new CopyObjectCommand({ Bucket: 'media', Key: 'x', CopySource: 'media/orig.txt', CopySourceIfMatch: '"nope"' }))))
        .status
    ).toBe(412)
  })
})

describe('multipart uploads', () => {
  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'big' }))
  })

  it('creates, uploads >5 MB parts, lists parts and completes with an md5-of-md5s ETag', async () => {
    const p1 = bytes(5 * MB + 17, 11)
    const p2 = bytes(MB + 3, 12)
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: 'big', Key: 'video/clip.mp4', ContentType: 'video/mp4', Metadata: { kind: 'clip' } })
    )
    expect(UploadId).toBeTruthy()

    const r1 = await s3.send(new UploadPartCommand({ Bucket: 'big', Key: 'video/clip.mp4', UploadId, PartNumber: 1, Body: p1 }))
    const r2 = await s3.send(new UploadPartCommand({ Bucket: 'big', Key: 'video/clip.mp4', UploadId, PartNumber: 2, Body: p2 }))
    expect(r1.ETag).toBe(`"${md5(p1)}"`)

    const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: 'big' }))
    expect(uploads.Uploads?.map((u) => u.UploadId)).toContain(UploadId)

    const parts = await s3.send(new ListPartsCommand({ Bucket: 'big', Key: 'video/clip.mp4', UploadId }))
    expect(parts.Parts?.map((p) => [p.PartNumber, p.Size, p.ETag])).toEqual([
      [1, p1.length, r1.ETag],
      [2, p2.length, r2.ETag],
    ])

    // not visible until completed
    expect((await s3Error(s3.send(new HeadObjectCommand({ Bucket: 'big', Key: 'video/clip.mp4' })))).status).toBe(404)

    const done = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'big',
        Key: 'video/clip.mp4',
        UploadId,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: r1.ETag }, { PartNumber: 2, ETag: r2.ETag }] },
      })
    )
    const expected = createHash('md5').update(Buffer.concat([Buffer.from(md5(p1), 'hex'), Buffer.from(md5(p2), 'hex')])).digest('hex')
    expect(done.ETag).toBe(`"${expected}-2"`)
    expect(done.Location).toContain('/storage/v1/s3/big/video/clip.mp4')

    const get = await s3.send(new GetObjectCommand({ Bucket: 'big', Key: 'video/clip.mp4' }))
    expect(get.ContentType).toBe('video/mp4')
    expect(get.Metadata).toEqual({ kind: 'clip' })
    expect(get.ContentLength).toBe(p1.length + p2.length)
    expect((await body(get)).equals(Buffer.concat([p1, p2]))).toBe(true)

    // the upload is gone once completed
    expect((await s3Error(s3.send(new ListPartsCommand({ Bucket: 'big', Key: 'video/clip.mp4', UploadId })))).name).toBe('NoSuchUpload')
  })

  it('refuses parts under 5 MB (except the last), bad ETags and unordered parts', async () => {
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: 'big', Key: 'small.bin' }))
    const r1 = await s3.send(new UploadPartCommand({ Bucket: 'big', Key: 'small.bin', UploadId, PartNumber: 1, Body: bytes(1000) }))
    const r2 = await s3.send(new UploadPartCommand({ Bucket: 'big', Key: 'small.bin', UploadId, PartNumber: 2, Body: bytes(1000, 2) }))
    const complete = (Parts: { PartNumber: number; ETag?: string }[]) =>
      s3Error(s3.send(new CompleteMultipartUploadCommand({ Bucket: 'big', Key: 'small.bin', UploadId, MultipartUpload: { Parts } })))
    expect((await complete([{ PartNumber: 1, ETag: r1.ETag }, { PartNumber: 2, ETag: r2.ETag }])).name).toBe('EntityTooSmall')
    expect((await complete([{ PartNumber: 1, ETag: '"bad"' }])).name).toBe('InvalidPart')
    expect((await complete([{ PartNumber: 2, ETag: r2.ETag }, { PartNumber: 1, ETag: r1.ETag }])).name).toBe('InvalidPartOrder')

    // a single small part is a valid (last) part
    const ok = await s3.send(
      new CompleteMultipartUploadCommand({ Bucket: 'big', Key: 'small.bin', UploadId, MultipartUpload: { Parts: [{ PartNumber: 2, ETag: r2.ETag }] } })
    )
    expect(ok.ETag).toMatch(/-1"$/)
    expect((await body(await s3.send(new GetObjectCommand({ Bucket: 'big', Key: 'small.bin' })))).equals(bytes(1000, 2))).toBe(true)
  })

  it('AbortMultipartUpload drops the upload and its parts', async () => {
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: 'big', Key: 'aborted.bin' }))
    await s3.send(new UploadPartCommand({ Bucket: 'big', Key: 'aborted.bin', UploadId, PartNumber: 1, Body: bytes(10) }))
    const res = await s3.send(new AbortMultipartUploadCommand({ Bucket: 'big', Key: 'aborted.bin', UploadId }))
    expect(res.$metadata.httpStatusCode).toBe(204)
    expect(
      (await s3Error(s3.send(new UploadPartCommand({ Bucket: 'big', Key: 'aborted.bin', UploadId, PartNumber: 2, Body: bytes(10) })))).name
    ).toBe('NoSuchUpload')
    expect((await s3Error(s3.send(new AbortMultipartUploadCommand({ Bucket: 'big', Key: 'aborted.bin', UploadId: 'nope' })))).status).toBe(404)
  })

  it('UploadPartCopy copies a byte range of an existing object into a part', async () => {
    const src = bytes(6 * MB, 21)
    await s3.send(new PutObjectCommand({ Bucket: 'big', Key: 'src.bin', Body: src }))
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: 'big', Key: 'assembled.bin' }))
    const c1 = await s3.send(
      new UploadPartCopyCommand({ Bucket: 'big', Key: 'assembled.bin', UploadId, PartNumber: 1, CopySource: 'big/src.bin', CopySourceRange: `bytes=0-${5 * MB - 1}` })
    )
    const c2 = await s3.send(
      new UploadPartCopyCommand({ Bucket: 'big', Key: 'assembled.bin', UploadId, PartNumber: 2, CopySource: 'big/src.bin', CopySourceRange: `bytes=${5 * MB}-${6 * MB - 1}` })
    )
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'big',
        Key: 'assembled.bin',
        UploadId,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: c1.CopyPartResult?.ETag }, { PartNumber: 2, ETag: c2.CopyPartResult?.ETag }] },
      })
    )
    expect((await body(await s3.send(new GetObjectCommand({ Bucket: 'big', Key: 'assembled.bin' })))).equals(src)).toBe(true)
  })

  it('lib-storage Upload (what apps use for big files) round-trips a 12 MB stream', async () => {
    const data = bytes(12 * MB + 5, 31)
    const upload = new Upload({
      client: s3,
      params: { Bucket: 'big', Key: 'lib/big.bin', Body: Readable.from([data.subarray(0, 4 * MB), data.subarray(4 * MB)]), ContentType: 'application/zip' },
      partSize: 5 * MB,
      queueSize: 2,
    })
    const res = await upload.done()
    expect(res.ETag).toMatch(/-3"$/)
    const get = await s3.send(new GetObjectCommand({ Bucket: 'big', Key: 'lib/big.bin' }))
    expect(get.ContentType).toBe('application/zip')
    expect((await body(get)).equals(data)).toBe(true)

    // a small Body goes through a single PutObject
    const small = await new Upload({ client: s3, params: { Bucket: 'big', Key: 'lib/small.txt', Body: 'tiny' } }).done()
    expect(small.ETag).toBe(`"${md5('tiny')}"`)
  })
})

describe('presigned URLs', () => {
  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'presign' }))
  })

  it('a presigned PUT uploads and a presigned GET downloads, with plain fetch', async () => {
    const putUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: 'presign', Key: 'up/file.txt', ContentType: 'text/plain' }), {
      expiresIn: 300,
    })
    expect(putUrl).toContain('X-Amz-Signature=')
    const put = await fetch(putUrl, { method: 'PUT', body: 'via presigned put', headers: { 'content-type': 'text/plain' } })
    expect(put.status).toBe(200)
    expect(put.headers.get('etag')).toBe(`"${md5('via presigned put')}"`)

    const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: 'presign', Key: 'up/file.txt' }), { expiresIn: 300 })
    const get = await fetch(getUrl)
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('text/plain')
    expect(await get.text()).toBe('via presigned put')

    const tampered = getUrl.replace('up/file.txt', 'up/other.txt')
    const bad = await fetch(tampered)
    expect(bad.status).toBe(403)
    expect(await bad.text()).toContain('<Code>SignatureDoesNotMatch</Code>')
  })

  it('an expired presigned URL is refused', async () => {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: 'presign', Key: 'up/file.txt' }), {
      expiresIn: 1,
      signingDate: new Date(Date.now() - 60_000),
    })
    const res = await fetch(url)
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).toContain('<Code>AccessDenied</Code>')
    expect(text).toContain('Request has expired')
  })
})

describe('authentication', () => {
  it('refuses a wrong secret, an unknown key and an unsigned request', async () => {
    const wrongSecret = client({ accessKeyId: backend.s3!.accessKeyId, secretAccessKey: 'not-the-secret' })
    expect(await s3Error(wrongSecret.send(new ListBucketsCommand({})))).toEqual({ name: 'SignatureDoesNotMatch', status: 403 })
    const unknown = client({ accessKeyId: 'AKIDUNKNOWN', secretAccessKey: backend.s3!.secretAccessKey })
    expect(await s3Error(unknown.send(new ListBucketsCommand({})))).toEqual({ name: 'InvalidAccessKeyId', status: 403 })

    const res = await fetch(`${endpoint}/`)
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toBe('application/xml')
    expect(await res.text()).toContain('<Code>AccessDenied</Code>')
  })

  it('refuses a body that does not match its signed x-amz-content-sha256', async () => {
    const signer = new SignatureV4({ credentials: { accessKeyId: backend.s3!.accessKeyId, secretAccessKey: backend.s3!.secretAccessKey }, region: 'local', service: 's3', sha256: NodeSha256 })
    const url = new URL(`${endpoint}/media/tamper.txt`)
    const signed = await signer.sign({
      method: 'PUT',
      protocol: 'http:',
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      headers: { host: url.host, 'x-amz-content-sha256': createHash('sha256').update('original').digest('hex'), 'content-type': 'text/plain' },
      body: 'original',
    })
    const res = await fetch(url, { method: 'PUT', headers: signed.headers, body: 'tampered' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('<Code>XAmzContentSHA256Mismatch</Code>')
    expect((await s3Error(s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'tamper.txt' })))).status).toBe(404)
  })
})

/** sha256 / HMAC-sha256 for @smithy/signature-v4. */
class NodeSha256 {
  private h
  constructor(secret?: string | Uint8Array) {
    this.h = secret ? createHmac('sha256', secret) : createHash('sha256')
  }
  update(data: string | Uint8Array) {
    this.h.update(data)
  }
  async digest() {
    return new Uint8Array(this.h.digest())
  }
  reset() {}
}

describe('STREAMING-AWS4-HMAC-SHA256-PAYLOAD (signed aws-chunked bodies)', () => {
  it('matches the chunk signatures in the AWS documentation example', () => {
    const c = { createHash, createHmac } as never
    const key = signingKey(
      { createHmac } as never,
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      '20130524',
      'us-east-1',
      's3'
    )
    const signed = {
      amzDate: '20130524T000000Z',
      scope: '20130524/us-east-1/s3/aws4_request',
      signingKey: key,
    } as SignedRequest
    const seed = '4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9'
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
    const s1 = chunkSignature(c, signed, seed, sha(Buffer.alloc(65536, 'a')))
    expect(s1).toBe('ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648')
    const s2 = chunkSignature(c, signed, s1, sha(Buffer.alloc(1024, 'a')))
    expect(s2).toBe('0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497')
    const s3sig = chunkSignature(c, signed, s2, sha(Buffer.alloc(0)))
    expect(s3sig).toBe('b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9')
  })

  async function streamingPut(key: string, chunks: Buffer[], tamper = false): Promise<Response> {
    const { accessKeyId, secretAccessKey } = backend.s3!
    const signer = new SignatureV4({ credentials: { accessKeyId, secretAccessKey }, region: 'local', service: 's3', sha256: NodeSha256 })
    const url = new URL(`${endpoint}/media/${key}`)
    const total = chunks.reduce((s, c) => s + c.length, 0)
    const date = new Date()
    const signed = await signer.sign(
      {
        method: 'PUT',
        protocol: 'http:',
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        headers: {
          host: url.host,
          'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
          'content-encoding': 'aws-chunked',
          'x-amz-decoded-content-length': String(total),
          'content-type': 'application/octet-stream',
        },
      },
      { signingDate: date }
    )
    const seed = /Signature=([0-9a-f]+)/.exec(signed.headers.authorization)![1]
    const amzDate = signed.headers['x-amz-date']
    const day = amzDate.slice(0, 8)
    const kSigning = createHmac(
      'sha256',
      createHmac('sha256', createHmac('sha256', createHmac('sha256', `AWS4${secretAccessKey}`).update(day).digest()).update('local').digest())
        .update('s3')
        .digest()
    )
      .update('aws4_request')
      .digest()
    const empty = createHash('sha256').update('').digest('hex')
    let prev = seed
    const encoded: Buffer[] = []
    for (const chunk of [...chunks, Buffer.alloc(0)]) {
      const toSign = ['AWS4-HMAC-SHA256-PAYLOAD', amzDate, `${day}/local/s3/aws4_request`, prev, empty, createHash('sha256').update(chunk).digest('hex')].join('\n')
      const sig = createHmac('sha256', kSigning).update(toSign).digest('hex')
      prev = sig
      encoded.push(Buffer.from(`${chunk.length.toString(16)};chunk-signature=${sig}\r\n`), tamper && chunk.length ? Buffer.from(chunk).fill(0, 0, 1) : chunk, Buffer.from('\r\n'))
    }
    return fetch(url, { method: 'PUT', headers: signed.headers, body: Buffer.concat(encoded) })
  }

  it('decodes and verifies a signed chunked upload', async () => {
    const chunks = [bytes(65536, 41), bytes(65536, 42), bytes(1000, 43)]
    const res = await streamingPut('signed-chunks.bin', chunks)
    expect(res.status).toBe(200)
    const all = Buffer.concat(chunks)
    expect(res.headers.get('etag')).toBe(`"${md5(all)}"`)
    expect((await body(await s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'signed-chunks.bin' })))).equals(all)).toBe(true)
  })

  it('refuses an unsigned-trailer body whose CRC32 trailer does not match', async () => {
    const { accessKeyId, secretAccessKey } = backend.s3!
    const signer = new SignatureV4({ credentials: { accessKeyId, secretAccessKey }, region: 'local', service: 's3', sha256: NodeSha256 })
    const url = new URL(`${endpoint}/media/bad-crc.bin`)
    const signed = await signer.sign({
      method: 'PUT',
      protocol: 'http:',
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      headers: {
        host: url.host,
        'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
        'content-encoding': 'aws-chunked',
        'x-amz-decoded-content-length': '5',
        'x-amz-trailer': 'x-amz-checksum-crc32',
      },
    })
    const res = await fetch(url, { method: 'PUT', headers: signed.headers, body: '5\r\nhello\r\n0\r\nx-amz-checksum-crc32:AAAAAA==\r\n\r\n' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('<Code>BadDigest</Code>')
    const ok = await fetch(url, { method: 'PUT', headers: signed.headers, body: '5\r\nhello\r\n0\r\nx-amz-checksum-crc32:NhCmhg==\r\n\r\n' })
    expect(ok.status).toBe(200)
  })

  it('refuses a chunk whose signature does not match its data', async () => {
    const res = await streamingPut('tampered-chunks.bin', [bytes(1000, 51), bytes(10, 52)], true)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('<Code>SignatureDoesNotMatch</Code>')
    expect((await s3Error(s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'tampered-chunks.bin' })))).status).toBe(404)
  })
})

describe('one storage, two APIs', () => {
  it('an object put over S3 is in storage.objects and served at its public URL', async () => {
    await s3.send(new PutObjectCommand({ Bucket: 'media', Key: 'img/logo.png', Body: bytes(2048, 61), ContentType: 'image/png', CacheControl: 'max-age=3600' }))
    const row = await backend.db.query(`select metadata from storage.objects where bucket_id = 'media' and name = 'img/logo.png'`)
    expect(row.rows[0].metadata).toMatchObject({ size: 2048, mimetype: 'image/png', eTag: `"${md5(bytes(2048, 61))}"` })

    const pub = await fetch(`${server.url}/storage/v1/object/public/media/img/logo.png`)
    expect(pub.status).toBe(200)
    expect(pub.headers.get('content-type')).toBe('image/png')
    expect(pub.headers.get('cache-control')).toBe('max-age=3600')
    expect(Buffer.from(await pub.arrayBuffer()).equals(bytes(2048, 61))).toBe(true)

    const ranged = await fetch(`${server.url}/storage/v1/object/public/media/img/logo.png`, { headers: { range: 'bytes=0-9' } })
    expect(ranged.status).toBe(206)
    expect(Buffer.from(await ranged.arrayBuffer()).equals(bytes(2048, 61).subarray(0, 10))).toBe(true)

    const admin = createClient(server.url, backend.serviceRoleKey, { auth: { persistSession: false } })
    const { data } = await admin.storage.from('media').download('img/logo.png')
    expect(Buffer.from(await data!.arrayBuffer()).equals(bytes(2048, 61))).toBe(true)
  })

  it('a file uploaded with supabase-js is listed and served over S3', async () => {
    const admin = createClient(server.url, backend.serviceRoleKey, { auth: { persistSession: false } })
    const { error } = await admin.storage.from('media').upload('from-js/note.txt', new Blob(['from supabase-js'], { type: 'text/plain' }))
    expect(error).toBeNull()
    const list = await s3.send(new ListObjectsV2Command({ Bucket: 'media', Prefix: 'from-js/' }))
    expect(list.Contents?.map((o) => [o.Key, o.Size])).toEqual([['from-js/note.txt', 16]])
    expect(list.Contents?.[0].ETag).toBe(`"${md5('from supabase-js')}"`)
    const get = await s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'from-js/note.txt' }))
    expect(get.ContentType).toBe('text/plain')
    expect((await body(get)).toString()).toBe('from supabase-js')

    // and a delete over S3 removes it for supabase-js too
    await s3.send(new DeleteObjectCommand({ Bucket: 'media', Key: 'from-js/note.txt' }))
    const { data } = await admin.storage.from('media').list('from-js')
    expect(data).toEqual([])
  })
})

describe('limits', () => {
  it('honours the bucket size limit and mime allowlist', async () => {
    const admin = createClient(server.url, backend.serviceRoleKey, { auth: { persistSession: false } })
    await admin.storage.createBucket('limited', { fileSizeLimit: 1000, allowedMimeTypes: ['image/*'] })
    expect((await s3Error(s3.send(new PutObjectCommand({ Bucket: 'limited', Key: 'a.png', Body: bytes(2000), ContentType: 'image/png' })))).name).toBe(
      'EntityTooLarge'
    )
    expect((await s3Error(s3.send(new PutObjectCommand({ Bucket: 'limited', Key: 'a.txt', Body: 'x', ContentType: 'text/plain' })))).name).toBe(
      'InvalidMimeType'
    )
    await s3.send(new PutObjectCommand({ Bucket: 'limited', Key: 'a.png', Body: bytes(500), ContentType: 'image/png' }))
  })
})

describe('session-token mode (Supabase: anon key as secret, user JWT as session token)', () => {
  it('acts as the user, under RLS', async () => {
    const anon = createClient(server.url, backend.anonKey, { auth: { persistSession: false } })
    const { data, error } = await anon.auth.signUp({ email: 's3user@example.com', password: 'password-123456' })
    expect(error).toBeNull()
    const token = data.session!.access_token
    const userId = data.user!.id
    const user = client({ accessKeyId: 'stub', secretAccessKey: backend.anonKey, sessionToken: token })

    await s3.send(new CreateBucketCommand({ Bucket: 'user-files' }))
    await user.send(new PutObjectCommand({ Bucket: 'user-files', Key: `${userId}/a.txt`, Body: 'mine' }))
    const row = await backend.db.query(`select owner from storage.objects where bucket_id = 'user-files' and name = $1`, [`${userId}/a.txt`])
    expect(row.rows[0].owner).toBe(userId)
    expect((await body(await user.send(new GetObjectCommand({ Bucket: 'user-files', Key: `${userId}/a.txt` })))).toString()).toBe('mine')

    // bucket management needs the real keys
    expect((await s3Error(user.send(new CreateBucketCommand({ Bucket: 'nope' })))).name).toBe('AccessDenied')

    // a bad session token is refused
    const forged = client({ accessKeyId: 'stub', secretAccessKey: backend.anonKey, sessionToken: `${token}x` })
    expect((await s3Error(forged.send(new ListBucketsCommand({})))).name).toBe('InvalidToken')

    // lock the bucket down to each user's own folder: RLS now refuses other keys
    await backend.db.exec(`
      drop policy if exists tinbase_authenticated_all on storage.objects;
      create policy own_folder on storage.objects for all to authenticated
        using ((storage.foldername(name))[1] = auth.uid()::text)
        with check ((storage.foldername(name))[1] = auth.uid()::text);
    `)
    expect((await s3Error(user.send(new PutObjectCommand({ Bucket: 'user-files', Key: 'someone-else/b.txt', Body: 'no' })))).name).toBe('AccessDenied')
    await user.send(new PutObjectCommand({ Bucket: 'user-files', Key: `${userId}/c.txt`, Body: 'still mine' }))
    await s3.send(new PutObjectCommand({ Bucket: 'user-files', Key: 'someone-else/d.txt', Body: 'service' }))
    const listed = await user.send(new ListObjectsV2Command({ Bucket: 'user-files' }))
    expect(listed.Contents?.map((o) => o.Key)).toEqual([`${userId}/a.txt`, `${userId}/c.txt`])
  })
})

describe('other configurations', () => {
  it('works on the in-memory driver (no streaming driver methods)', async () => {
    const mem = await createBackend({ engine: await testEngine(), log: () => {} })
    const srv = await serve(mem, { port: 0 })
    try {
      const c = new S3Client({
        endpoint: `${srv.url}/storage/v1/s3`,
        region: 'local',
        forcePathStyle: true,
        credentials: { accessKeyId: mem.s3!.accessKeyId, secretAccessKey: mem.s3!.secretAccessKey },
      })
      await c.send(new CreateBucketCommand({ Bucket: 'm' }))
      await c.send(new PutObjectCommand({ Bucket: 'm', Key: 'k.txt', Body: Readable.from([Buffer.from('in '), Buffer.from('memory')]), ContentLength: 9 }))
      expect((await body(await c.send(new GetObjectCommand({ Bucket: 'm', Key: 'k.txt', Range: 'bytes=3-' })))).toString()).toBe('memory')
      await c.send(new CopyObjectCommand({ Bucket: 'm', Key: 'k2.txt', CopySource: 'm/k.txt' }))
      expect((await body(await c.send(new GetObjectCommand({ Bucket: 'm', Key: 'k2.txt' })))).toString()).toBe('in memory')
    } finally {
      await srv.close()
      await mem.close()
    }
  })

  it('s3: false turns the endpoint off', async () => {
    const off = await createBackend({ engine: await testEngine(), s3: false, log: () => {} })
    try {
      expect(off.s3).toBeNull()
      const res = await off.fetch(new Request('http://localhost:54321/storage/v1/s3/'))
      expect(res.status).toBe(403)
      expect(await res.text()).toContain('disabled')
    } finally {
      await off.close()
    }
  })

  it('refuses the public default S3 secret on a network-exposed host', async () => {
    await expect(
      createBackend({
        engine: await testEngine(),
        host: '0.0.0.0',
        jwtSecret: 'a-strong-secret-that-is-long-enough-for-the-guard',
        vaultKey: 'independent-vault-key-value',
        s3: { accessKeyId: 'x', secretAccessKey: '850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907' },
        log: () => {},
      })
    ).rejects.toThrow(/S3 secret access key/)
  })
})
