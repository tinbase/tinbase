import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultEngine, inLifoBox, nativeSupported, nativeUnavailableReason } from '../src/default-engine.js'

/**
 * The CLI's default engine. A Lifo box (lifo.sh) reports linux/x64 but runs no native code, so
 * the old platform check picked the native engine there and `tinbase start` died downloading
 * Postgres binaries it could never run. A box names itself in `process.versions.lifo`.
 */
const host = (over: Partial<Parameters<typeof defaultEngine>[0]> = {}) => ({
  platform: 'linux',
  arch: 'x64',
  versions: { node: '22.14.0' } as Record<string, string | undefined>,
  isBinary: false,
  ...over,
})
const lifo = { node: '22.14.0', lifo: '0.1.0' }

describe('default engine', () => {
  it('is native on macOS and Linux, x64 and arm64', () => {
    expect(defaultEngine(host())).toBe('native')
    expect(defaultEngine(host({ platform: 'darwin', arch: 'arm64' }))).toBe('native')
  })

  it('is wasm where native binaries do not exist', () => {
    expect(defaultEngine(host({ platform: 'win32' }))).toBe('wasm')
    expect(defaultEngine(host({ arch: 'riscv64' }))).toBe('wasm')
  })

  it('is native in the single binary, which ships without the wasm engine', () => {
    expect(defaultEngine(host({ platform: 'win32', isBinary: true }))).toBe('native')
  })

  it('is wasm in a Lifo box, although it reports linux/x64', () => {
    expect(inLifoBox(lifo)).toBe(true)
    expect(inLifoBox({ node: '22.14.0' })).toBe(false)
    expect(nativeSupported(host({ versions: lifo }))).toBe(false)
    expect(defaultEngine(host({ versions: lifo }))).toBe('wasm')
    expect(defaultEngine(host({ versions: lifo, isBinary: true }))).toBe('wasm')
  })

  it('explains why native cannot run in a Lifo box, and has no objection elsewhere', () => {
    expect(nativeUnavailableReason(host({ versions: lifo }))).toMatch(/Lifo box.*--engine wasm/)
    expect(nativeUnavailableReason(host())).toBeUndefined()
    expect(nativeUnavailableReason(host({ platform: 'win32' }))).toBeUndefined()
  })
})

const CLI = join(process.cwd(), 'dist', 'cli.js')

// The CLI end to end, as a box would run it: a preload gives the process a Lifo box's
// process.versions.lifo before cli.js reads it.
describe.skipIf(!existsSync(CLI))('the CLI in a (simulated) Lifo box', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinbase-lifo-'))
  const preload = join(dir, 'lifo-box.cjs')
  writeFileSync(preload, `Object.defineProperty(process.versions, 'lifo', { value: '0.1.0', enumerable: true })\n`)
  const env = { ...process.env, TINBASE_ENGINE: undefined } as NodeJS.ProcessEnv
  delete env.TINBASE_ENGINE

  it('refuses --engine native with a message that names the alternatives', () => {
    const r = spawnSync('node', ['--require', preload, CLI, 'start', '--dir', dir, '--engine', 'native'], { encoding: 'utf8', env })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/cannot run in a Lifo box/)
    expect(r.stderr).toMatch(/--engine wasm/)
  })

  it('starts on the wasm engine by default, with its database on disk', async () => {
    const child = spawn('node', ['--require', preload, CLI, 'start', '--dir', dir, '--port', String(20000 + Math.floor(Math.random() * 20000))], { env })
    let out = ''
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`tinbase did not start:\n${out}`)), 60_000)
        const onData = (d: Buffer) => {
          out += d.toString()
          if (/Engine: /.test(out)) {
            clearTimeout(timer)
            resolve()
          }
        }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        child.on('exit', (code) => reject(new Error(`tinbase exited ${code}:\n${out}`)))
      })
      expect(out).toMatch(/Engine: PGlite \(.*\.tinbase[\\/]db\)/)
      expect(existsSync(join(dir, '.tinbase', 'db', 'PG_VERSION'))).toBe(true)
      expect(existsSync(join(dir, '.tinbase', 'pgdata'))).toBe(false)
    } finally {
      child.removeAllListeners('exit')
      child.kill('SIGTERM')
    }
  }, 90_000)
})
