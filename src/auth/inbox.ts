/**
 * Local email inbox — the tinbase equivalent of Supabase local's Inbucket /
 * Mailpit. When no custom mailer is configured, outgoing auth emails (magic
 * links, OTP codes, password recovery, email-change confirmations) are captured
 * in memory and viewable at /inbox, so you can test those flows locally without
 * a real SMTP server.
 *
 * Dev-only by nature: it exposes email contents (including sign-in links) with
 * no auth, exactly like Inbucket. Not for production — provide your own
 * `mailer` there and no inbox is mounted.
 */
import type { MailMessage, Mailer } from '../types.js'

export interface InboxEntry extends MailMessage {
  id: string
  created_at: string
  /** first URL found in the body (the magic/confirm/recovery link), if any */
  link: string | null
  /** first 6-digit code found in the body (the OTP), if any */
  code: string | null
}

const CAP = 200

export class InboxMailer implements Mailer {
  private messages: InboxEntry[] = []

  /** `passthrough` still receives every message (e.g. to also log to console). */
  constructor(private passthrough?: (msg: MailMessage) => void) {}

  async send(msg: MailMessage): Promise<void> {
    this.messages.unshift({
      ...msg,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      link: msg.text.match(/https?:\/\/\S+/)?.[0] ?? null,
      code: msg.text.match(/\b\d{6}\b/)?.[0] ?? null,
    })
    if (this.messages.length > CAP) this.messages.length = CAP
    this.passthrough?.(msg)
  }

  list(): InboxEntry[] {
    return this.messages
  }
  clear(): void {
    this.messages = []
  }

  /** Serve GET /inbox (HTML), GET /inbox/api/messages (JSON), DELETE (clear). */
  serve(req: Request, url: URL): Response {
    const path = url.pathname
    const method = req.method.toUpperCase()
    if (path === '/inbox' || path === '/inbox/') {
      return new Response(INBOX_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (path === '/inbox/api/messages') {
      if (method === 'DELETE') {
        this.clear()
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify({ messages: this.messages }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
}

const INBOX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tinbase · Inbox</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0a0a; color: #fafafa; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #27272a; position: sticky; top: 0; background: #0a0a0aee; backdrop-filter: blur(6px); }
  h1 { font-size: 16px; margin: 0; font-weight: 700; }
  h1 .dot { color: #10b981; }
  .muted { color: #71717a; font-size: 12px; }
  button { font: inherit; cursor: pointer; border-radius: 8px; border: 1px solid #27272a; background: #18181b; color: #e4e4e7; padding: 6px 12px; }
  button:hover { background: #27272a; }
  main { max-width: 820px; margin: 0 auto; padding: 20px; }
  .empty { text-align: center; color: #71717a; padding: 80px 20px; }
  .msg { border: 1px solid #27272a; border-radius: 12px; padding: 16px; margin-bottom: 12px; background: #131316; }
  .msg .top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .subject { font-weight: 600; }
  .to { color: #a1a1aa; font-size: 13px; }
  .time { color: #52525b; font-size: 12px; white-space: nowrap; }
  .body { margin-top: 10px; white-space: pre-wrap; color: #c3c2b7; font-size: 13px; word-break: break-word; }
  .actions { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .code { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: 3px; color: #10b981; background: #10b98115; border: 1px solid #10b98130; padding: 4px 10px; border-radius: 8px; }
  a.link { color: #34d399; text-decoration: none; border: 1px solid #10b98130; background: #10b98110; padding: 6px 12px; border-radius: 8px; }
  a.link:hover { background: #10b98120; }
</style>
</head>
<body>
<header>
  <div>
    <h1>tinbase <span class="dot">·</span> Inbox</h1>
    <div class="muted">Captured auth emails — local dev only</div>
  </div>
  <div style="display:flex;gap:8px">
    <button id="refresh">Refresh</button>
    <button id="clear">Clear</button>
  </div>
</header>
<main id="list"><div class="empty">Loading…</div></main>
<script>
  const list = document.getElementById('list')
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  async function load() {
    const res = await fetch('/inbox/api/messages')
    const { messages } = await res.json()
    if (!messages.length) { list.innerHTML = '<div class="empty">No emails yet. Trigger a magic link, OTP, or password reset.</div>'; return }
    list.innerHTML = messages.map((m) => {
      const when = new Date(m.created_at).toLocaleTimeString()
      const code = m.code ? '<span class="code">' + esc(m.code) + '</span>' : ''
      const link = m.link ? '<a class="link" href="' + esc(m.link) + '" target="_blank" rel="noreferrer">Open link →</a>' : ''
      const actions = (code || link) ? '<div class="actions">' + code + link + '</div>' : ''
      return '<div class="msg"><div class="top"><span class="subject">' + esc(m.subject) + '</span><span class="time">' + esc(when) + '</span></div>' +
        '<div class="to">to ' + esc(m.to) + '</div><div class="body">' + esc(m.text) + '</div>' + actions + '</div>'
    }).join('')
  }
  document.getElementById('refresh').onclick = load
  document.getElementById('clear').onclick = async () => { await fetch('/inbox/api/messages', { method: 'DELETE' }); load() }
  load()
  setInterval(load, 4000)
</script>
</body>
</html>`
