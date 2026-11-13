/**
 * Request-body decoding for the S3 endpoint. Turns whatever the client sent
 * (a plain body under a SHA-256 or UNSIGNED-PAYLOAD hash, or an aws-chunked
 * body in any of the STREAMING-* modes) into the object's bytes as a stream,
 * verifying signatures and checksums on the way. Nothing is buffered beyond
 * the network chunk in hand, so a 100 MB part goes to disk as it arrives.
 *
 * Every check that can only run at the end (payload hash, chunk and trailer
 * signatures, checksums, declared length) throws from the generator, so the
 * consumer's write fails and its temporary file is discarded.
 */
import { S3Error } from './errors.js'
import {
  chunkSignature,
  type Hasher,
  type NodeCrypto,
  nodeCrc32,
  type SignedRequest,
  signaturesMatch,
  STREAMING_SIGNED,
  STREAMING_SIGNED_TRAILER,
  STREAMING_UNSIGNED_TRAILER,
  trailerSignature,
  UNSIGNED_PAYLOAD,
} from './sigv4.js'
import { iterateStream } from '../stream-io.js'

/** Totals known once the body has been read to the end. */
export interface BodyTotals {
  size: number
  /** MD5 of the decoded bytes: the S3 ETag of a single-part object or part */
  md5: Uint8Array
  md5Hex: string
}

/** Options for {@link payloadStream}. */
export interface PayloadOptions {
  /** refuse with EntityTooLarge past this many decoded bytes */
  maxBytes?: number
}

const CHECKSUM_ALGORITHMS = ['crc32', 'crc32c', 'crc64nvme', 'sha1', 'sha256'] as const

/** An incremental verifier for one x-amz-checksum-* value (null when we cannot compute it). */
function checksumHasher(c: NodeCrypto, alg: string): { update(d: Uint8Array): void; digest(): string } | null {
  if (alg === 'sha1' || alg === 'sha256') {
    const h = c.createHash(alg)
    return { update: (d) => void h.update(d), digest: () => h.digest('base64') }
  }
  if (alg === 'crc32') {
    const crc32 = nodeCrc32()
    if (!crc32) return null
    let v = 0
    return {
      update: (d) => {
        v = crc32(d, v)
      },
      digest: () => {
        const b = new Uint8Array(4)
        new DataView(b.buffer).setUint32(0, v >>> 0)
        let s = ''
        for (const x of b) s += String.fromCharCode(x)
        return btoa(s)
      },
    }
  }
  return null // crc32c / crc64nvme: accepted, not verified
}

/**
 * Stream the decoded payload of `req`. Call `totals()` after the generator
 * has finished to get the size and MD5.
 */
export function payloadStream(
  req: Request,
  c: NodeCrypto,
  signed: SignedRequest,
  opts: PayloadOptions = {}
): { chunks: AsyncGenerator<Uint8Array>; totals: () => BodyTotals } {
  const md5 = c.createHash('md5')
  let size = 0
  let finished: BodyTotals | null = null
  const mode = signed.payloadHash
  const trailers = new Map<string, string>()

  // A checksum the client declared, in a header or (for aws-chunked) a trailer.
  const trailerName = req.headers.get('x-amz-trailer')?.trim().toLowerCase() ?? null
  let checksumAlg: string | null = null
  let checksumHeader: string | null = null
  for (const alg of CHECKSUM_ALGORITHMS) {
    const v = req.headers.get(`x-amz-checksum-${alg}`)
    if (v) {
      checksumAlg = alg
      checksumHeader = v
    }
  }
  if (!checksumAlg && trailerName?.startsWith('x-amz-checksum-')) checksumAlg = trailerName.slice('x-amz-checksum-'.length)
  const checksum = checksumAlg ? checksumHasher(c, checksumAlg) : null

  async function* run(): AsyncGenerator<Uint8Array> {
    const source = req.body ? iterateStream(req.body) : (async function* () {})()
    const decoded = mode.startsWith('STREAMING-')
      ? decodeAwsChunked(source, c, signed, trailers)
      : verifyPlain(source, c, mode)
    for await (const chunk of decoded) {
      size += chunk.length
      if (opts.maxBytes !== undefined && size > opts.maxBytes) {
        throw new S3Error('EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size')
      }
      md5.update(chunk)
      checksum?.update(chunk)
      yield chunk
    }

    const declared = req.headers.get('x-amz-decoded-content-length')
    if (mode.startsWith('STREAMING-') && declared !== null && Number(declared) !== size) {
      throw new S3Error('IncompleteBody', 'You did not provide the number of bytes specified by the x-amz-decoded-content-length header')
    }
    const digest = md5.digest()
    const md5Hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
    const contentMd5 = req.headers.get('content-md5')
    if (contentMd5) {
      let s = ''
      for (const x of digest) s += String.fromCharCode(x)
      if (btoa(s) !== contentMd5.trim()) {
        throw new S3Error('BadDigest', 'The Content-MD5 you specified did not match what we received.')
      }
    }
    const expected = checksumHeader ?? (checksumAlg ? trailers.get(`x-amz-checksum-${checksumAlg}`) : undefined)
    if (checksum && expected && checksum.digest() !== expected.trim()) {
      throw new S3Error('BadDigest', `The ${checksumAlg!.toUpperCase()} you specified did not match the calculated checksum.`)
    }
    finished = { size, md5: digest, md5Hex }
  }

  return {
    chunks: run(),
    totals: () => {
      if (!finished) throw new Error('payload not fully read')
      return finished
    },
  }
}

/** Read a small request body whole (an XML document), verifying its payload hash. */
export async function readSmallBody(req: Request, c: NodeCrypto, signed: SignedRequest, limit = 16 * 1024 * 1024): Promise<string> {
  const { chunks } = payloadStream(req, c, signed, { maxBytes: limit })
  const parts: Uint8Array[] = []
  for await (const ch of chunks) parts.push(ch)
  let total = 0
  for (const p of parts) total += p.length
  const all = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    all.set(p, off)
    off += p.length
  }
  return new TextDecoder().decode(all)
}

/** A plain body: pass it through, checking the declared SHA-256 at the end. */
async function* verifyPlain(source: AsyncIterable<Uint8Array>, c: NodeCrypto, mode: string): AsyncGenerator<Uint8Array> {
  const hash: Hasher | null = mode === UNSIGNED_PAYLOAD ? null : c.createHash('sha256')
  for await (const chunk of source) {
    hash?.update(chunk)
    yield chunk
  }
  if (hash && hash.digest('hex') !== mode) {
    throw new S3Error('XAmzContentSHA256Mismatch', "The provided 'x-amz-content-sha256' header does not match what was computed.")
  }
}

const CRLF0 = 0x0d
const CRLF1 = 0x0a
const MAX_LINE = 8 * 1024

/**
 * Decode an aws-chunked body: `<hex size>[;chunk-signature=<sig>]\r\n<data>\r\n`
 * repeated, a zero-size final chunk, then optional trailing headers. In the
 * signed modes every chunk's signature chains from the previous one, seeded
 * by the request signature.
 */
async function* decodeAwsChunked(
  source: AsyncIterable<Uint8Array>,
  c: NodeCrypto,
  signed: SignedRequest,
  trailers: Map<string, string>
): AsyncGenerator<Uint8Array> {
  const mode = signed.payloadHash
  const signedChunks = mode === STREAMING_SIGNED || mode === STREAMING_SIGNED_TRAILER
  const hasTrailer = mode === STREAMING_SIGNED_TRAILER || mode === STREAMING_UNSIGNED_TRAILER
  const it = source[Symbol.asyncIterator]()
  let buf: Uint8Array = new Uint8Array(0)
  let previous = signed.signature
  const dec = new TextDecoder()

  const fill = async (): Promise<boolean> => {
    const r = await it.next()
    if (r.done) return false
    if (buf.length === 0) buf = r.value
    else {
      const next = new Uint8Array(buf.length + r.value.length)
      next.set(buf)
      next.set(r.value, buf.length)
      buf = next
    }
    return true
  }
  /** Next CRLF-terminated line, or null at a clean end of the body. */
  const readLine = async (): Promise<string | null> => {
    let from = 0
    for (;;) {
      for (let i = from; i + 1 < buf.length; i++) {
        if (buf[i] === CRLF0 && buf[i + 1] === CRLF1) {
          const line = dec.decode(buf.subarray(0, i))
          buf = buf.subarray(i + 2)
          return line
        }
      }
      from = Math.max(0, buf.length - 1)
      if (buf.length > MAX_LINE) throw new S3Error('InvalidRequest', 'Malformed aws-chunked body: chunk header too long')
      if (!(await fill())) {
        if (buf.length === 0) return null
        const line = dec.decode(buf)
        buf = new Uint8Array(0)
        return line
      }
    }
  }
  const incomplete = () => new S3Error('IncompleteBody', 'The request body ended before the final aws-chunked chunk')

  for (;;) {
    const header = await readLine()
    if (header === null) throw incomplete()
    const [sizeHex, ...extensions] = header.split(';')
    if (!/^[0-9a-fA-F]+$/.test(sizeHex.trim())) {
      throw new S3Error('InvalidRequest', `Malformed aws-chunked body: bad chunk size "${sizeHex.slice(0, 32)}"`)
    }
    const size = parseInt(sizeHex.trim(), 16)
    const sig = extensions.map((e) => e.trim()).find((e) => e.startsWith('chunk-signature='))?.slice('chunk-signature='.length)
    if (signedChunks && !sig) throw new S3Error('SignatureDoesNotMatch', 'A chunk of the streaming upload has no chunk-signature')
    const hash = signedChunks ? c.createHash('sha256') : null
    let remaining = size
    while (remaining > 0) {
      if (buf.length === 0 && !(await fill())) throw incomplete()
      const take = Math.min(remaining, buf.length)
      const piece = buf.subarray(0, take)
      buf = buf.subarray(take)
      remaining -= take
      hash?.update(piece)
      yield piece
    }
    if (signedChunks) {
      const expected = chunkSignature(c, signed, previous, hash!.digest('hex'))
      if (!signaturesMatch(c, expected, sig!.toLowerCase())) {
        throw new S3Error('SignatureDoesNotMatch', 'The chunk signature we calculated does not match the signature you provided.')
      }
      previous = expected
    }
    if (size === 0) break
    const end = await readLine()
    if (end !== '') throw new S3Error('InvalidRequest', 'Malformed aws-chunked body: chunk data is not followed by CRLF')
  }

  // Trailing headers (checksums, the trailer signature), up to a blank line.
  let trailerText = ''
  let trailerSig: string | null = null
  for (;;) {
    const line = await readLine()
    if (line === null || line === '') break
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (name === 'x-amz-trailer-signature') trailerSig = value
    else {
      trailers.set(name, value)
      trailerText += `${name}:${value}\n`
    }
  }
  if (mode === STREAMING_SIGNED_TRAILER && hasTrailer && trailerText !== '') {
    const expected = trailerSignature(c, signed, previous, trailerText)
    if (!trailerSig || !signaturesMatch(c, expected, trailerSig.toLowerCase())) {
      throw new S3Error('SignatureDoesNotMatch', 'The trailer signature we calculated does not match the signature you provided.')
    }
  }
}
