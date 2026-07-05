/**
 * Realtime engine speaking the Phoenix-channel protocol that
 * @supabase/realtime-js uses (vsn=1.0.0 JSON serialization): channel
 * join/leave, heartbeat, broadcast, presence, and postgres_changes fed by
 * the trigger-based CDC pipeline in the database layer.
 *
 * Transport-agnostic: sockets are anything with send()/close(), so the same
 * engine works over Node WebSockets today and an in-process pair in the
 * browser.
 */
import type { CdcEvent, Database } from '../db/database.js'

export interface RealtimeSocketLike {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

interface PhoenixMessage {
  topic: string
  event: string
  payload: Record<string, unknown>
  ref: string | null
  join_ref?: string | null
}

interface PostgresBinding {
  id: number
  event: string
  schema: string
  table: string
  filter?: string
}

interface Channel {
  topic: string
  joinRef: string | null
  bindings: PostgresBinding[]
  broadcastSelf: boolean
  broadcastAck: boolean
  presenceKey: string
  presenceEnabled: boolean
}

interface Connection {
  socket: RealtimeSocketLike
  channels: Map<string, Channel>
  /** Phoenix serializer version: "1.0.0" = JSON objects, "2.0.0" = JSON arrays */
  vsn: string
}

type PresenceMetas = { metas: Record<string, unknown>[] }

export class RealtimeEngine {
  private connections = new Set<Connection>()
  private bindingCounter = 1
  private phxRefCounter = 1
  /** topic → key → metas */
  private presence = new Map<string, Map<string, PresenceMetas>>()
  private stopCdc: (() => void) | null = null

  constructor(private db: Database) {}

  async start(): Promise<void> {
    if (this.stopCdc) return
    this.stopCdc = await this.db.onCdcEvent((e) => this.dispatchCdc(e))
  }

  stop(): void {
    this.stopCdc?.()
    this.stopCdc = null
    for (const conn of this.connections) conn.socket.close(1001, 'server shutting down')
    this.connections.clear()
  }

  /** Attach a socket. Returns callbacks the transport must wire up. */
  connect(socket: RealtimeSocketLike, opts: { vsn?: string } = {}): {
    onMessage: (data: string | Uint8Array) => void
    onClose: () => void
  } {
    const conn: Connection = { socket, channels: new Map(), vsn: opts.vsn ?? '1.0.0' }
    this.connections.add(conn)
    return {
      onMessage: (data) => {
        void this.handleMessage(conn, data)
      },
      onClose: () => {
        for (const topic of conn.channels.keys()) this.leaveChannel(conn, topic)
        this.connections.delete(conn)
      },
    }
  }

  private send(conn: Connection, msg: PhoenixMessage): void {
    try {
      const encoded =
        conn.vsn === '2.0.0'
          ? JSON.stringify([msg.join_ref ?? null, msg.ref ?? null, msg.topic, msg.event, msg.payload])
          : JSON.stringify(msg)
      conn.socket.send(encoded)
    } catch {
      // transport already closed
    }
  }

  private reply(conn: Connection, orig: PhoenixMessage, status: 'ok' | 'error', response: unknown): void {
    this.send(conn, {
      topic: orig.topic,
      event: 'phx_reply',
      payload: { status, response },
      ref: orig.ref,
      join_ref: orig.join_ref ?? null,
    })
  }

  private async handleMessage(conn: Connection, data: string | Uint8Array): Promise<void> {
    if (typeof data !== 'string') {
      this.handleBinary(conn, data)
      return
    }
    let msg: PhoenixMessage
    try {
      const parsed = JSON.parse(data) as unknown
      if (Array.isArray(parsed)) {
        // Phoenix v2 serializer: [join_ref, ref, topic, event, payload]
        const [join_ref, ref, topic, event, payload] = parsed as [
          string | null,
          string | null,
          string,
          string,
          Record<string, unknown>,
        ]
        msg = { join_ref, ref, topic, event, payload }
      } else {
        msg = parsed as PhoenixMessage
      }
    } catch {
      return
    }
    if (msg.topic === 'phoenix' && msg.event === 'heartbeat') {
      this.reply(conn, msg, 'ok', {})
      return
    }

    switch (msg.event) {
      case 'phx_join':
        await this.handleJoin(conn, msg)
        break
      case 'phx_leave':
        this.leaveChannel(conn, msg.topic)
        this.reply(conn, msg, 'ok', {})
        break
      case 'broadcast':
        this.handleBroadcast(conn, msg)
        break
      case 'presence':
        this.handlePresence(conn, msg)
        break
      case 'access_token':
        // token refresh — nothing to re-validate in this single-tenant setup
        break
      default:
        break
    }
  }

  private async handleJoin(conn: Connection, msg: PhoenixMessage): Promise<void> {
    const config = (msg.payload?.config ?? {}) as {
      broadcast?: { self?: boolean; ack?: boolean }
      presence?: { key?: string; enabled?: boolean }
      postgres_changes?: { event?: string; schema?: string; table?: string; filter?: string }[]
    }

    const bindings: PostgresBinding[] = []
    for (const spec of config.postgres_changes ?? []) {
      const binding: PostgresBinding = {
        id: this.bindingCounter++,
        event: (spec.event ?? '*').toUpperCase(),
        schema: spec.schema ?? 'public',
        table: spec.table ?? '*',
        filter: spec.filter,
      }
      bindings.push(binding)
      if (binding.table !== '*') {
        try {
          await this.db.ensureCdcTrigger(binding.schema, binding.table)
        } catch {
          this.reply(conn, msg, 'error', {
            reason: `unable to subscribe to changes on ${binding.schema}.${binding.table}`,
          })
          return
        }
      } else {
        // wildcard table: attach triggers to every table currently in the schema
        const info = await this.db.getSchemaInfo(binding.schema)
        for (const table of info.tables.keys()) {
          await this.db.ensureCdcTrigger(binding.schema, table).catch(() => {})
        }
      }
    }

    const channel: Channel = {
      topic: msg.topic,
      joinRef: msg.join_ref ?? msg.ref ?? null,
      bindings,
      broadcastSelf: config.broadcast?.self ?? false,
      broadcastAck: config.broadcast?.ack ?? false,
      presenceKey: config.presence?.key || crypto.randomUUID(),
      presenceEnabled: config.presence?.enabled ?? true,
    }
    conn.channels.set(msg.topic, channel)

    this.reply(conn, msg, 'ok', {
      postgres_changes: bindings.map((b) => ({
        id: b.id,
        event: b.event,
        schema: b.schema,
        table: b.table,
        ...(b.filter ? { filter: b.filter } : {}),
      })),
    })

    // initial presence snapshot
    const state = this.presence.get(msg.topic)
    this.send(conn, {
      topic: msg.topic,
      event: 'presence_state',
      payload: state ? Object.fromEntries(state) : {},
      ref: null,
    })

    // postgres_changes readiness signal (realtime-js listens for this)
    if (bindings.length > 0) {
      this.send(conn, {
        topic: msg.topic,
        event: 'system',
        payload: {
          status: 'ok',
          extension: 'postgres_changes',
          message: 'Subscribed to PostgreSQL',
          channel: msg.topic.replace(/^realtime:/, ''),
        },
        ref: null,
      })
    }
  }

  private leaveChannel(conn: Connection, topic: string): void {
    const channel = conn.channels.get(topic)
    if (!channel) return
    conn.channels.delete(topic)
    // presence leave
    const state = this.presence.get(topic)
    if (state?.has(channel.presenceKey)) {
      const metas = state.get(channel.presenceKey)!
      state.delete(channel.presenceKey)
      if (state.size === 0) this.presence.delete(topic)
      this.broadcastToTopic(topic, {
        topic,
        event: 'presence_diff',
        payload: { joins: {}, leaves: { [channel.presenceKey]: metas } },
        ref: null,
      })
    }
  }

  /**
   * Phoenix binary serializer, kind 3 (userBroadcastPush):
   * [3, joinRefLen, refLen, topicLen, eventLen, metaLen, encoding,
   *  joinRef, ref, topic, event, meta, payloadBytes]
   * encoding: 0 = raw binary payload, 1 = JSON payload
   */
  private handleBinary(conn: Connection, bytes: Uint8Array): void {
    if (bytes.length < 7 || bytes[0] !== 3) return
    const [, joinRefLen, refLen, topicLen, eventLen, metaLen, encoding] = bytes
    let offset = 7
    const decoder = new TextDecoder()
    const read = (len: number) => {
      const out = decoder.decode(bytes.subarray(offset, offset + len))
      offset += len
      return out
    }
    const joinRef = read(joinRefLen)
    const ref = read(refLen)
    const topic = read(topicLen)
    const userEvent = read(eventLen)
    read(metaLen) // metadata — not relayed
    const payloadBytes = bytes.subarray(offset)

    const payload: Record<string, unknown> = {
      type: 'broadcast',
      event: userEvent,
      payload: encoding === 1 ? safeJsonParse(decoder.decode(payloadBytes)) : payloadBytes,
    }
    this.handleBroadcast(conn, {
      topic,
      event: 'broadcast',
      payload,
      ref: ref || null,
      join_ref: joinRef || null,
    })
  }

  private handleBroadcast(conn: Connection, msg: PhoenixMessage): void {
    const sender = conn.channels.get(msg.topic)
    if (!sender) return
    const userPayload = (msg.payload as { payload?: unknown }).payload
    const binaryFrame =
      userPayload instanceof Uint8Array
        ? encodeUserBroadcast(msg.topic, String((msg.payload as { event?: unknown }).event ?? ''), userPayload)
        : null
    for (const other of this.connections) {
      const channel = other.channels.get(msg.topic)
      if (!channel) continue
      if (other === conn && !sender.broadcastSelf) continue
      if (binaryFrame) {
        try {
          other.socket.send(binaryFrame)
        } catch {
          // transport already closed
        }
      } else {
        this.send(other, { topic: msg.topic, event: 'broadcast', payload: msg.payload, ref: null })
      }
    }
    if (sender.broadcastAck && msg.ref) this.reply(conn, msg, 'ok', {})
  }

  private handlePresence(conn: Connection, msg: PhoenixMessage): void {
    const channel = conn.channels.get(msg.topic)
    if (!channel) return
    const event = String((msg.payload?.event ?? '')).toLowerCase()

    if (event === 'track') {
      const meta = {
        ...((msg.payload?.payload as Record<string, unknown>) ?? {}),
        phx_ref: `F${this.phxRefCounter++}`,
      }
      let state = this.presence.get(msg.topic)
      if (!state) {
        state = new Map()
        this.presence.set(msg.topic, state)
      }
      const previous = state.get(channel.presenceKey)
      state.set(channel.presenceKey, { metas: [meta] })
      this.broadcastToTopic(msg.topic, {
        topic: msg.topic,
        event: 'presence_diff',
        payload: {
          joins: { [channel.presenceKey]: { metas: [meta] } },
          leaves: previous ? { [channel.presenceKey]: previous } : {},
        },
        ref: null,
      })
      if (msg.ref) this.reply(conn, msg, 'ok', {})
      return
    }

    if (event === 'untrack') {
      const state = this.presence.get(msg.topic)
      const metas = state?.get(channel.presenceKey)
      if (state && metas) {
        state.delete(channel.presenceKey)
        if (state.size === 0) this.presence.delete(msg.topic)
        this.broadcastToTopic(msg.topic, {
          topic: msg.topic,
          event: 'presence_diff',
          payload: { joins: {}, leaves: { [channel.presenceKey]: metas } },
          ref: null,
        })
      }
      if (msg.ref) this.reply(conn, msg, 'ok', {})
    }
  }

  private broadcastToTopic(topic: string, msg: PhoenixMessage): void {
    for (const conn of this.connections) {
      if (conn.channels.has(topic)) this.send(conn, msg)
    }
  }

  // ── postgres_changes fan-out ──────────────────────────────────────────

  private async dispatchCdc(event: CdcEvent): Promise<void> {
    // column metadata lets realtime-js run its type conversion
    let columns: { name: string; type: string }[] = []
    try {
      const info = await this.db.getSchemaInfo(event.schema)
      columns = (info.tables.get(event.table)?.columns ?? []).map((c) => ({
        name: c.name,
        type: c.udtName,
      }))
    } catch {
      // schema went away — still deliver the event without columns
    }

    for (const conn of this.connections) {
      for (const channel of conn.channels.values()) {
        const ids = channel.bindings
          .filter((b) => this.bindingMatches(b, event))
          .map((b) => b.id)
        if (ids.length === 0) continue
        this.send(conn, {
          topic: channel.topic,
          event: 'postgres_changes',
          payload: {
            ids,
            data: {
              schema: event.schema,
              table: event.table,
              commit_timestamp: event.commit_timestamp,
              eventType: event.type,
              type: event.type,
              columns,
              record: event.record ?? {},
              old_record: event.old_record ?? {},
              errors: event.errors ?? null,
            },
          },
          ref: null,
        })
      }
    }
  }

  private bindingMatches(b: PostgresBinding, e: CdcEvent): boolean {
    if (b.schema !== '*' && b.schema !== e.schema) return false
    if (b.table !== '*' && b.table !== e.table) return false
    if (b.event !== '*' && b.event !== e.type) return false
    if (b.filter) {
      const row = e.type === 'DELETE' ? e.old_record : e.record
      if (!row || !matchFilter(b.filter, row)) return false
    }
    return true
  }
}

/** Evaluate a realtime filter string ("col=eq.value") against a row. */
export function matchFilter(filter: string, row: Record<string, unknown>): boolean {
  const m = filter.match(/^([^=]+)=(eq|neq|lt|lte|gt|gte|in)\.(.*)$/s)
  if (!m) return false
  const [, column, op, rawValue] = m
  const actual = row[column.trim()]

  if (op === 'in') {
    const list = rawValue.replace(/^\(/, '').replace(/\)$/, '').split(',').map((s) => s.trim())
    return list.some((v) => looseEquals(actual, v))
  }
  if (op === 'eq') return looseEquals(actual, rawValue)
  if (op === 'neq') return !looseEquals(actual, rawValue)

  const a = Number(actual)
  const b = Number(rawValue)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  switch (op) {
    case 'lt':
      return a < b
    case 'lte':
      return a <= b
    case 'gt':
      return a > b
    case 'gte':
      return a >= b
  }
  return false
}

function looseEquals(actual: unknown, expected: string): boolean {
  if (actual === null || actual === undefined) return expected === 'null'
  return String(actual) === expected
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Phoenix binary serializer, kind 4 (userBroadcast):
 * [4, topicLen, eventLen, metaLen, encoding, topic, event, meta, payloadBytes]
 */
function encodeUserBroadcast(topic: string, event: string, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder()
  const topicBytes = enc.encode(topic)
  const eventBytes = enc.encode(event)
  const out = new Uint8Array(5 + topicBytes.length + eventBytes.length + payload.length)
  out[0] = 4
  out[1] = topicBytes.length
  out[2] = eventBytes.length
  out[3] = 0
  out[4] = 0
  out.set(topicBytes, 5)
  out.set(eventBytes, 5 + topicBytes.length)
  out.set(payload, 5 + topicBytes.length + eventBytes.length)
  return out
}
