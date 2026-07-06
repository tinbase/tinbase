/**
 * Edge Functions (/functions/v1/*) — supabase.functions.invoke() support.
 *
 * A "function" is any fetch handler: (Request) => Response | Promise<Response>.
 * The core takes a name → handler map (portable, works in the browser); the
 * Node CLI populates it from supabase/functions/<name>/index.{ts,js,mjs}
 * modules that `export default` a fetch handler.
 */
import type { RequestContext } from '../types.js'

export type EdgeFunction = (req: Request, ctx: FunctionContext) => Response | Promise<Response>

export interface FunctionContext {
  /** Verified request context (role + JWT claims) resolved by the router. */
  auth: RequestContext
  /** Keys/urls so the function can create its own supabase-js client. */
  env: {
    SUPABASE_URL: string
    SUPABASE_ANON_KEY: string
    SUPABASE_SERVICE_ROLE_KEY: string
  }
}

export class FunctionsHandler {
  constructor(
    private functions: Map<string, EdgeFunction>,
    private env: FunctionContext['env']
  ) {}

  register(name: string, fn: EdgeFunction): void {
    this.functions.set(name, fn)
  }

  list(): string[] {
    return [...this.functions.keys()]
  }

  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    const name = url.pathname.replace(/^\/functions\/v1\/?/, '').split('/')[0]
    if (!name) {
      return json(404, { error: 'function name required: /functions/v1/<name>' })
    }
    const fn = this.functions.get(name)
    if (!fn) {
      return json(404, { error: `function "${name}" not found` })
    }
    try {
      const res = await fn(req, { auth: ctx, env: this.env })
      if (!(res instanceof Response)) {
        return json(500, { error: `function "${name}" did not return a Response` })
      }
      return res
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return json(500, { error: message })
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
