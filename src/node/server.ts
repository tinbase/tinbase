/** Node HTTP wrapper: serves the backend's fetch handler and upgrades /realtime/v1 WebSockets. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { TinbaseBackend } from '../index.js'
import { acceptWebSocket } from './ws.js'

/** Resolve whether a port is free to bind on `host`. */
function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createNetServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => tester.close(() => resolve(true)))
    tester.listen(port, host)
  })
}

/**
 * First free port at or after `startPort` (scanning up to `maxTries`), or null
 * if none. Used so `tinbase start` skips a port that's already in use (e.g. a
 * tinbase instance already running) instead of crashing with EADDRINUSE.
 */
export async function findAvailablePort(startPort: number, host = '127.0.0.1', maxTries = 20): Promise<number | null> {
  for (let p = startPort; p < startPort + maxTries; p++) {
    if (await portIsFree(p, host)) return p
  }
  return null
}

/** Options for {@link serve}. */
export interface ServeOptions {
  /** Port to bind. Defaults to 54321. */
  port?: number
  /** Host to bind. Defaults to 127.0.0.1 (loopback only). */
  host?: string
}

/** A bound HTTP server plus its resolved address and a graceful shutdown hook. */
export interface RunningServer {
  server: Server
  /** The actually-bound port (may differ from the requested one when 0 is passed). */
  port: number
  url: string
  close: () => Promise<void>
}

/**
 * Bind an HTTP server that dispatches requests to `backend.fetch` and upgrades
 * `/realtime/v1` WebSocket handshakes into realtime sessions.
 *
 * @throws if the port is already in use (EADDRINUSE) or binding otherwise fails.
 */
export async function serve(backend: TinbaseBackend, opts: ServeOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1'

  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req, host)
      const response = await backend.fetch(request)
      await writeResponse(response, res)
    } catch (e) {
      if (res.headersSent) {
        res.destroy()
        return
      }
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
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`port ${opts.port ?? 54321} is already in use — pass --port <n> to choose another`)
          : err
      )
    })
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
  // Expose the connecting client's address to the fetch handler (rate limiting)
  // without trusting a client-supplied x-forwarded-for header.
  const remote = req.socket.remoteAddress
  if (remote) headers.set('x-tinbase-remote-addr', remote)
  // The body is handed over as a stream, not read up front, so a large upload
  // (an S3 PutObject or UploadPart) can go straight to disk instead of being
  // held in memory whole. Handlers that want it all still call arrayBuffer()/json().
  const hasBody =
    method !== 'GET' &&
    method !== 'HEAD' &&
    (req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0)
  if (!hasBody) return new Request(url, { method, headers })
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
    duplex: 'half',
  } as RequestInit)
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }
  // Stream the body with backpressure, so a large download is never buffered
  // whole. Headers are already sent: a failure here (usually the client going
  // away) can only end the connection.
  try {
    await pipeline(Readable.fromWeb(response.body as never), res)
  } catch {
    res.destroy()
  }
}
