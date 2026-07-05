/** Node HTTP wrapper: serves the backend's fetch handler and upgrades /realtime/v1 WebSockets. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { TinbaseBackend } from '../index.js'
import { acceptWebSocket } from './ws.js'

export interface ServeOptions {
  port?: number
  host?: string
}

export interface RunningServer {
  server: Server
  port: number
  url: string
  close: () => Promise<void>
}

export async function serve(backend: TinbaseBackend, opts: ServeOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1'

  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req, host)
      const response = await backend.fetch(request)
      await writeResponse(response, res)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: e instanceof Error ? e.message : String(e) }))
    }
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
    if (!url.pathname.startsWith('/realtime/v1')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const ws = acceptWebSocket(req, socket, head as Buffer)
    if (!ws) return
    const session = backend.realtime.connect(ws, { vsn: url.searchParams.get('vsn') ?? '1.0.0' })
    ws.onMessage = session.onMessage
    ws.onClose = session.onClose
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 54321, host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 54321)

  return {
    server,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

async function toRequest(req: IncomingMessage, fallbackHost: string): Promise<Request> {
  const url = `http://${req.headers.host ?? fallbackHost}${req.url ?? '/'}`
  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else headers.set(key, value)
  }
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    body = Buffer.concat(chunks)
  }
  return new Request(url, { method, headers, body: body as BodyInit | undefined })
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  res.writeHead(response.status, headers)
  if (response.body) {
    const buf = Buffer.from(await response.arrayBuffer())
    res.end(buf)
  } else {
    res.end()
  }
}
