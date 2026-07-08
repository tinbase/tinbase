import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { findAvailablePort } from '../src/node/server.js'

/**
 * `tinbase start` skips a port that's already in use (e.g. a tinbase already
 * running) instead of crashing with EADDRINUSE. findAvailablePort is the core.
 */
const blockers: import('node:net').Server[] = []
function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    blockers.push(s)
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => resolve())
  })
}
afterEach(async () => {
  await Promise.all(blockers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

describe('findAvailablePort', () => {
  it('returns the requested port when it is free', async () => {
    const p = await findAvailablePort(54830, '127.0.0.1')
    expect(p).toBe(54830)
  })

  it('skips a port already in use and returns a higher free one', async () => {
    const start = 54840
    await occupy(start)
    const p = await findAvailablePort(start, '127.0.0.1', 20)
    expect(p).not.toBeNull()
    expect(p).toBeGreaterThan(start)
  })

  it('skips a run of busy ports', async () => {
    const start = 54850
    await occupy(start)
    await occupy(start + 1)
    await occupy(start + 2)
    const p = await findAvailablePort(start, '127.0.0.1', 20)
    expect(p).toBeGreaterThanOrEqual(start + 3)
  })

  it('returns null when the whole range is exhausted', async () => {
    const start = 54860
    for (let i = 0; i < 3; i++) await occupy(start + i)
    const p = await findAvailablePort(start, '127.0.0.1', 3) // only scans start..start+2, all busy
    expect(p).toBeNull()
  })
})
