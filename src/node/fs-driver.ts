import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import type { StorageDriver } from '../types.js'

/** Node-only driver — object bytes live under a root directory. */
export class FsStorageDriver implements StorageDriver {
  constructor(private root: string) {}

  private resolve(key: string): string {
    const path = normalize(join(this.root, key))
    if (!path.startsWith(normalize(this.root) + sep)) {
      throw new Error(`invalid storage key: ${key}`)
    }
    return path
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.resolve(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.resolve(key)))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true })
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const k of keys) await this.delete(k)
  }
}
