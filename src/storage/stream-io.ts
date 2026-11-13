/**
 * Streaming reads and writes over any {@link StorageDriver}. Drivers that
 * implement the optional streaming methods (the Node filesystem driver) never
 * hold a whole object in memory; the rest (the in-memory driver) fall back to
 * their buffered `get`/`put`.
 */
import type { StorageDriver } from '../types.js'

/** Write `body` to `key`, streaming when the driver can. */
export async function putFromIterable(
  driver: StorageDriver,
  key: string,
  body: AsyncIterable<Uint8Array>
): Promise<void> {
  if (driver.putStream) return driver.putStream(key, body)
  const chunks: Uint8Array[] = []
  for await (const c of body) chunks.push(c)
  await driver.put(key, concatBytes(chunks))
}

/** Open bytes `start`..`end` (inclusive; whole object when omitted) as a stream, or null if missing. */
export async function openRead(
  driver: StorageDriver,
  key: string,
  start?: number,
  end?: number
): Promise<ReadableStream<Uint8Array> | null> {
  if (driver.getStream) return driver.getStream(key, start, end)
  let bytes: Uint8Array | null
  if (start !== undefined && end !== undefined && driver.getRange) {
    bytes = await driver.getRange(key, start, end)
  } else {
    bytes = await driver.get(key)
    if (bytes && start !== undefined) bytes = bytes.subarray(start, end === undefined ? undefined : end + 1)
  }
  if (bytes === null) return null
  const data = bytes
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (data.length > 0) controller.enqueue(data)
      controller.close()
    },
  })
}

/** Iterate a ReadableStream's chunks (works where ReadableStream is not async-iterable). */
export async function* iterateStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value && value.length > 0) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/** Rename an object within the driver. */
export async function moveObject(driver: StorageDriver, from: string, to: string): Promise<void> {
  if (driver.move) return driver.move(from, to)
  const bytes = await driver.get(from)
  if (bytes === null) throw new Error(`storage object missing: ${from}`)
  await driver.put(to, bytes)
  await driver.delete(from)
}

/** Copy an object within the driver. */
export async function copyObject(driver: StorageDriver, from: string, to: string): Promise<void> {
  if (driver.copy) return driver.copy(from, to)
  const bytes = await driver.get(from)
  if (bytes === null) throw new Error(`storage object missing: ${from}`)
  await driver.put(to, bytes)
}

/** Concatenate byte chunks into one array. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
