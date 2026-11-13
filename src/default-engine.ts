/**
 * Which database engine the CLI uses when neither `--engine` nor `TINBASE_ENGINE` picks one.
 * Kept apart from cli.ts (which runs on import) so the choice can be tested.
 */
export type EngineName = 'wasm' | 'native' | 'pgmem'

export interface EngineHost {
  platform: string
  arch: string
  /** `process.versions`: a JavaScript runtime that isn't a real OS names itself here. */
  versions: Record<string, string | undefined>
  /** the single-file binary, which ships without the WASM engine */
  isBinary: boolean
}

/**
 * A Lifo box (https://lifo.sh): a Linux-like OS written in JavaScript, in a browser tab, Node or a
 * Lifo Cloud isolate. It reports `linux`/`x64`, but nothing native runs in it, so the embedded
 * Postgres binaries can't be downloaded or exec'd there. PGlite (wasm) runs, on the box's files.
 */
export function inLifoBox(versions: Record<string, string | undefined>): boolean {
  return typeof versions.lifo === 'string'
}

/**
 * Native (embedded Postgres) where it can run: macOS/Linux on x64/arm64, and always in the single
 * binary. Elsewhere (Windows, a Lifo box) the WASM (PGlite) engine.
 */
export function nativeSupported(host: EngineHost): boolean {
  if (inLifoBox(host.versions)) return false
  return (host.platform === 'darwin' || host.platform === 'linux') && (host.arch === 'arm64' || host.arch === 'x64')
}

export function defaultEngine(host: EngineHost): EngineName {
  if (inLifoBox(host.versions)) return 'wasm'
  return host.isBinary || nativeSupported(host) ? 'native' : 'wasm'
}

/** Why `--engine native` can't work on this host, or undefined when it can. */
export function nativeUnavailableReason(host: EngineHost): string | undefined {
  if (inLifoBox(host.versions)) {
    return 'the native engine cannot run in a Lifo box (nothing native runs there) - use --engine wasm (Postgres on disk) or --engine pgmem (in-memory, lighter)'
  }
  return undefined
}
