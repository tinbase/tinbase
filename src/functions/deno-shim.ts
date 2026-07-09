/**
 * Minimal `Deno` global shim so Supabase-style edge functions run unchanged
 * under Node/Bun. Supabase functions are written for Deno:
 *
 *   Deno.serve((req) => new Response(...))
 *   const url = Deno.env.get('SUPABASE_URL')
 *
 * Instead of starting a server, our `Deno.serve` captures the handler so the
 * FunctionsHandler can invoke it per request; `Deno.env` reads only the
 * injected SUPABASE_* vars and declared function secrets (never the host
 * process.env).
 *
 * Not resolved: `npm:` / `jsr:` / URL import specifiers and the Deno std lib —
 * a function using those needs a bundling step. Functions that stick to Web
 * APIs (fetch/Request/Response) + Deno.serve/Deno.env work as-is.
 */
type DenoHandler = (req: Request) => Response | Promise<Response>

const captured: { handler?: DenoHandler } = {}
const denoEnv: Record<string, string> = {}

/** Merge variables the shim's Deno.env should expose (SUPABASE_* keys, secrets). */
export function setDenoEnv(env: Record<string, string>): void {
  Object.assign(denoEnv, env)
}

/** Install globalThis.Deno if we're not already running under a Deno-like runtime. */
export function installDenoShim(): void {
  const g = globalThis as Record<string, unknown> & { Deno?: unknown; __tinbaseDeno?: boolean }
  if (g.__tinbaseDeno) return
  // a real Deno runtime already provides Deno.serve — don't clobber it
  if (g.Deno && typeof (g.Deno as { serve?: unknown }).serve === 'function') return
  g.__tinbaseDeno = true
  g.Deno = {
    serve(arg1: unknown, arg2?: unknown) {
      captured.handler = (typeof arg1 === 'function' ? arg1 : arg2) as DenoHandler
      // Deno.serve returns a server; some functions `await server.finished`.
      return { finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {}, addr: { hostname: '0.0.0.0', port: 0, transport: 'tcp' } }
    },
    // Scope Deno.env to the injected SUPABASE_* vars + declared function
    // secrets only. It deliberately does NOT fall through to the host
    // process.env, so a function can't read arbitrary server-side env (cloud
    // credentials, DB URLs, etc.).
    env: {
      get: (k: string) => denoEnv[k],
      set: (k: string, v: string) => {
        denoEnv[k] = v
      },
      has: (k: string) => denoEnv[k] !== undefined,
      delete: (k: string) => {
        delete denoEnv[k]
      },
      toObject: () => ({ ...denoEnv }),
    },
    // enough of the surface that idiomatic functions don't crash on reference
    cwd: () => process.cwd(),
    // a function must not be able to terminate the whole server; throw instead
    // of calling process.exit.
    exit: (code?: number) => {
      throw new Error(`Deno.exit(${code ?? 0}) called in an edge function (ignored)`)
    },
  }
}

/** Return and clear the handler captured by the most recent Deno.serve() call. */
export function takeCapturedHandler(): DenoHandler | undefined {
  const h = captured.handler
  captured.handler = undefined
  return h
}

export function resetCapturedHandler(): void {
  captured.handler = undefined
}
