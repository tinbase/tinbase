import { describe, expect, it } from 'vitest'
import { decodeFrame } from '../src/node/ws.js'

/** Build a single WebSocket text frame, masked or not. */
function frame(text: string, masked: boolean): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const head = Buffer.from([0x81, (masked ? 0x80 : 0x00) | payload.length])
  if (!masked) return Buffer.concat([head, payload])
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04])
  const masked_payload = Buffer.from(payload)
  for (let i = 0; i < masked_payload.length; i++) masked_payload[i] ^= mask[i % 4]
  return Buffer.concat([head, mask, masked_payload])
}

describe('ws frame decoding', () => {
  it('decodes a masked client frame and reports masked=true', () => {
    const f = decodeFrame(frame('hi', true))
    expect(f).not.toBeNull()
    expect(f!.masked).toBe(true)
    expect(f!.payload.toString('utf8')).toBe('hi')
  })

  it('flags an unmasked client frame (server must reject per RFC 6455)', () => {
    const f = decodeFrame(frame('hi', false))
    expect(f).not.toBeNull()
    expect(f!.masked).toBe(false)
  })
})
