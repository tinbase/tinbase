/**
 * Filesystem-backed storage driver (Node only). Persists object bytes as files
 * under a single root directory, with path-traversal protection on every key.
 */
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { StorageDriver } from '../types.js'

/**
 * Node-only {@link StorageDriver} that keeps object bytes as files under a
 * single root directory. Keys map to relative paths beneath the root.
 */
export class FsStorageDriver implements StorageDriver {
  constructor(private root: string) {}

  /**
   * Resolve a storage key to an absolute path inside the root.
   *
   * SECURITY: rejects keys that escape the root (e.g. `../`); the normalized
   * path must stay under `root` + separator or the key is refused.
   *
   * @throws if the key would resolve outside the root directory.
   */
  private resolve(key: string): string {
    const path = normalize(join(this.root, key))
    if (!path.startsWith(normalize(this.root) + sep)) {
      throw new Error(`invalid storage key: ${key}`)
    }
    return path
  }

  /** Write object bytes, creating parent directories as needed. */
  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.resolve(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }

  /** Read object bytes, or null if the key does not exist. */
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.resolve(key)))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  /** Size of an object in bytes, or null if the key does not exist. */
  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.resolve(key))).size
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  /** Read bytes `start`..`end` (inclusive) without loading the whole file. */
  async getRange(key: string, start: number, end: number): Promise<Uint8Array | null> {
    let fh
    try {
      fh = await open(this.resolve(key), 'r')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
    try {
      const buf = new Uint8Array(end - start + 1)
      let read = 0
      while (read < buf.length) {
        const { bytesRead } = await fh.read(buf, read, buf.length - read, start + read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      return read === buf.length ? buf : buf.subarray(0, read)
    } finally {
      await fh.close()
    }
  }

  /**
   * Stream an object to disk: the bytes go to a temporary file beside the
   * target, renamed into place only once the stream ends, so a failed or
   * aborted upload never replaces (or half-writes) the object.
   */
  async putStream(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const path = this.resolve(key)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tinbase-tmp-${crypto.randomUUID()}`
    try {
      await pipeline(Readable.from(body), createWriteStream(tmp))
      await rename(tmp, path)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }

  /** Stream bytes `start`..`end` (inclusive, whole file when omitted), or null if the key does not exist. */
  async getStream(key: string, start?: number, end?: number): Promise<ReadableStream<Uint8Array> | null> {
    let fh
    try {
      fh = await open(this.resolve(key), 'r')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
    const stream = fh.createReadStream({ start, end, autoClose: true })
    return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
  }

  /** Rename an object (same filesystem, so atomic), replacing any existing one. */
  async move(from: string, to: string): Promise<void> {
    const dst = this.resolve(to)
    await mkdir(dirname(dst), { recursive: true })
    await rename(this.resolve(from), dst)
  }

  /** Copy an object without reading it into memory, replacing any existing one. */
  async copy(from: string, to: string): Promise<void> {
    const dst = this.resolve(to)
    await mkdir(dirname(dst), { recursive: true })
    await copyFile(this.resolve(from), dst)
  }

  /** Delete an object; a missing key is not an error. */
  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true })
  }

  /** Delete several objects in sequence. */
  async deleteMany(keys: string[]): Promise<void> {
    for (const k of keys) await this.delete(k)
  }
}
