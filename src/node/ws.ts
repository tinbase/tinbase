/**
 * Minimal RFC 6455 WebSocket server on top of node:http upgrade events —
 * enough for Phoenix-protocol JSON text frames, so no `ws` dependency.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { RealtimeSocketLike } from '../realtime/engine.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface WsConnection extends RealtimeSocketLike {
  onMessage: ((data: string | Uint8Array) => void) | null
  onClose: (() => void) | null
}

export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | null {
  const key = req.headers['sec-websocket-key']
  if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return null
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
  )

  let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
  let fragments: Buffer[] = []
  let fragmentOpcode = 0
  let closed = false

  const conn: WsConnection = {
    onMessage: null,
    onClose: null,
    send(data: string | Uint8Array) {
      if (closed) return
      if (typeof data === 'string') {
        socket.write(encodeFrame(0x1, Buffer.from(data, 'utf8')))
      } else {
        socket.write(encodeFrame(0x2, Buffer.from(data)))
      }
    },
    close(code = 1000, reason = '') {
      if (closed) return
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2)
      socket.write(encodeFrame(0x8, payload))
      finish()
    },
  }

  function finish() {
    if (closed) return
    closed = true
    socket.end()
    conn.onClose?.()
  }

  function deliver(opcode: number, payload: Buffer): void {
    if (opcode === 0x1) conn.onMessage?.(payload.toString('utf8'))
    else if (opcode === 0x2) conn.onMessage?.(new Uint8Array(payload))
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    processFrames()
  })
  socket.on('close', finish)
  socket.on('error', finish)

  function processFrames(): void {
    while (true) {
      const frame = decodeFrame(buffer)
      if (!frame) return
      buffer = buffer.subarray(frame.frameLength)

      switch (frame.opcode) {
        case 0x0: // continuation
          fragments.push(frame.payload)
          if (frame.fin) {
            const full = Buffer.concat(fragments)
            fragments = []
            deliver(fragmentOpcode, full)
          }
          break
        case 0x1: // text
        case 0x2: // binary
          if (frame.fin) {
            deliver(frame.opcode, frame.payload)
          } else {
            fragments = [frame.payload]
            fragmentOpcode = frame.opcode
          }
          break
        case 0x8: // close
          if (!closed) {
            socket.write(encodeFrame(0x8, frame.payload.subarray(0, 2)))
          }
          finish()
          return
        case 0x9: // ping
          socket.write(encodeFrame(0xa, frame.payload))
          break
        case 0xa: // pong
          break
      }
    }
  }

  return conn
}

interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
  frameLength: number
}

function decodeFrame(buf: Buffer): Frame | null {
  if (buf.length < 2) return null
  const fin = (buf[0] & 0x80) !== 0
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let payloadLength = buf[1] & 0x7f
  let offset = 2

  if (payloadLength === 126) {
    if (buf.length < offset + 2) return null
    payloadLength = buf.readUInt16BE(offset)
    offset += 2
  } else if (payloadLength === 127) {
    if (buf.length < offset + 8) return null
    const big = buf.readBigUInt64BE(offset)
    if (big > BigInt(64 * 1024 * 1024)) throw new Error('frame too large')
    payloadLength = Number(big)
    offset += 8
  }

  let maskKey: Buffer | null = null
  if (masked) {
    if (buf.length < offset + 4) return null
    maskKey = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + payloadLength) return null

  let payload = Buffer.from(buf.subarray(offset, offset + payloadLength))
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
  }
  return { fin, opcode, payload, frameLength: offset + payloadLength }
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}
