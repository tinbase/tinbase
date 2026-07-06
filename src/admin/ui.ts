/**
 * The dashboard served at /_/ — one self-contained HTML file (inline CSS/JS,
 * no build step) so it embeds cleanly in the single-binary build.
 * It authenticates with the service_role key, which the user pastes on first
 * load (kept in localStorage).
 */
export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>tinbase admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #09090b; color: #e4e4e7; }
  a { color: #34d399; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 20px; border-bottom: 1px solid #27272a; position: sticky; top: 0; background: #09090bcc; backdrop-filter: blur(8px); }
  header h1 { font-size: 15px; }
  header .stats { margin-left: auto; color: #71717a; font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 10px 20px 0; border-bottom: 1px solid #27272a; }
  nav button { background: none; border: none; color: #a1a1aa; padding: 8px 14px; cursor: pointer; font: inherit; border-bottom: 2px solid transparent; }
  nav button.active { color: #34d399; border-bottom-color: #34d399; }
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #27272a; white-space: nowrap; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  th { color: #a1a1aa; font-weight: 600; position: sticky; top: 0; background: #09090b; }
  .wrap { overflow: auto; max-height: 70vh; border: 1px solid #27272a; border-radius: 10px; }
  .row { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  button.btn, select, input, textarea { background: #18181b; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 8px; padding: 7px 12px; font: inherit; }
  button.btn { cursor: pointer; } button.btn:hover { border-color: #34d399; }
  button.primary { background: #059669; border-color: #059669; color: #fff; font-weight: 600; }
  textarea { width: 100%; min-height: 120px; font-family: ui-monospace, monospace; font-size: 13px; }
  .muted { color: #71717a; font-size: 12px; }
  .err { color: #f87171; white-space: pre-wrap; }
  .pill { font-size: 11px; padding: 1px 8px; border-radius: 99px; background: #27272a; color: #a1a1aa; margin-left: 6px; }
  #login { max-width: 460px; margin: 12vh auto; text-align: center; }
  #login input { width: 100%; margin: 14px 0; }
  .logo { width: 40px; height: 40px; }
</style>
</head>
<body>
<div id="app"></div>
<script>
const $ = (s) => document.querySelector(s)
let KEY = localStorage.getItem('tinbase_service_key') || ''
let state = { tab: 'tables', tables: [], table: null, rows: [], page: 0, users: [], buckets: [], sqlOut: null, stats: null }

const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { apikey: KEY, authorization: 'Bearer ' + KEY, 'content-type': 'application/json', ...(opts.headers || {}) } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || body.message || body.msg || res.status)
  return body
}

function esc(v) {
  if (v === null || v === undefined) return '<span class="muted">null</span>'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function render() {
  if (!KEY) return renderLogin()
  const tabs = ['tables', 'sql', 'users', 'storage']
  $('#app').innerHTML = \`
    <header>
      <svg class="logo" viewBox="0 0 120 120"><path d="M24 34v56c0 8.8 16.1 16 36 16s36-7.2 36-16V34" fill="#059669"/><ellipse cx="60" cy="34" rx="36" ry="16" fill="#34d399"/></svg>
      <h1>tinbase admin</h1>
      <span class="stats" id="stats"></span>
      <button class="btn" onclick="logout()">Log out</button>
    </header>
    <nav>\${tabs.map((t) => \`<button class="\${state.tab === t ? 'active' : ''}" onclick="go('\${t}')">\${t[0].toUpperCase() + t.slice(1)}</button>\`).join('')}</nav>
    <main id="main"></main>\`
  loadStats()
  ;({ tables: renderTables, sql: renderSql, users: renderUsers, storage: renderStorage })[state.tab]()
}

function renderLogin() {
  $('#app').innerHTML = \`<div id="login">
    <svg class="logo" style="width:64px;height:64px" viewBox="0 0 120 120"><path d="M24 34v56c0 8.8 16.1 16 36 16s36-7.2 36-16V34" fill="#059669"/><ellipse cx="60" cy="34" rx="36" ry="16" fill="#34d399"/></svg>
    <h1 style="margin-top:16px">tinbase admin</h1>
    <p class="muted" style="margin-top:6px">Paste the <b>service_role key</b> printed when tinbase started.</p>
    <input id="key" type="password" placeholder="service_role key (eyJ...)">
    <button class="btn primary" onclick="login()">Continue</button>
    <p class="err" id="loginerr" style="margin-top:10px"></p>
  </div>\`
}

async function login() {
  KEY = $('#key').value.trim()
  try {
    await api('/admin/v1/stats')
    localStorage.setItem('tinbase_service_key', KEY)
    render()
  } catch (e) {
    KEY = ''
    $('#loginerr').textContent = 'Invalid key: ' + e.message
  }
}
function logout() { KEY = ''; localStorage.removeItem('tinbase_service_key'); render() }
function go(tab) { state.tab = tab; render() }

async function loadStats() {
  try {
    const s = await api('/admin/v1/stats')
    $('#stats').textContent = \`\${s.users} users · \${s.objects} objects · \${s.migrations} migrations · \${s.dbSize}\`
  } catch {}
}

// ── tables ──
async function renderTables() {
  const { tables } = await api('/admin/v1/tables')
  state.tables = tables
  if (!state.table && tables[0]) state.table = tables[0].name
  const t = tables.find((x) => x.name === state.table)
  $('#main').innerHTML = \`
    <div class="row">
      <select onchange="state.table=this.value;state.page=0;renderTables()">\${tables.map((x) => \`<option \${x.name === state.table ? 'selected' : ''}>\${x.name}</option>\`).join('')}</select>
      <span class="pill">\${t ? t.rowCount + ' rows' : ''}</span>
      <button class="btn" onclick="state.page=Math.max(0,state.page-1);renderTables()">‹ Prev</button>
      <span class="muted">page \${state.page + 1}</span>
      <button class="btn" onclick="state.page++;renderTables()">Next ›</button>
    </div>
    <div class="wrap"><table id="rows"></table></div>\`
  if (!t) return
  const rows = await api(\`/rest/v1/\${encodeURIComponent(t.name)}?select=*&limit=50&offset=\${state.page * 50}\`)
  const cols = t.columns.map((c) => c.name)
  $('#rows').innerHTML =
    '<tr>' + cols.map((c) => \`<th>\${esc(c)}</th>\`).join('') + '</tr>' +
    rows.map((r) => '<tr>' + cols.map((c) => \`<td>\${esc(r[c])}</td>\`).join('') + '</tr>').join('')
}

// ── sql ──
function renderSql() {
  $('#main').innerHTML = \`
    <textarea id="q" placeholder="select * from ...">\${state.sqlQ || ''}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary" onclick="runSql()">Run (⌘⏎)</button><span class="muted" id="sqlmeta"></span></div>
    <div id="sqlout"></div>\`
  $('#q').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runSql() })
}
async function runSql() {
  state.sqlQ = $('#q').value
  try {
    const out = await api('/admin/v1/sql', { method: 'POST', body: JSON.stringify({ query: state.sqlQ }) })
    $('#sqlmeta').textContent = \`\${out.rowCount} rows · \${out.ms} ms\`
    const cols = out.rows[0] ? Object.keys(out.rows[0]) : []
    $('#sqlout').innerHTML = cols.length
      ? \`<div class="wrap" style="margin-top:12px"><table><tr>\${cols.map((c) => \`<th>\${esc(c)}</th>\`).join('')}</tr>\${out.rows.map((r) => '<tr>' + cols.map((c) => \`<td>\${esc(r[c])}</td>\`).join('') + '</tr>').join('')}</table></div>\`
      : \`<p class="muted" style="margin-top:12px">OK\${out.affectedRows !== null ? ' · ' + out.affectedRows + ' affected' : ''}</p>\`
  } catch (e) {
    $('#sqlout').innerHTML = \`<p class="err" style="margin-top:12px">\${esc(e.message)}</p>\`
  }
}

// ── users ──
async function renderUsers() {
  const { users } = await api('/auth/v1/admin/users')
  $('#main').innerHTML = \`<div class="wrap"><table>
    <tr><th>email</th><th>id</th><th>created</th><th>last sign-in</th><th>anon</th></tr>
    \${users.map((u) => \`<tr><td>\${esc(u.email)}</td><td class="muted">\${esc(u.id)}</td><td>\${esc((u.created_at || '').slice(0, 19))}</td><td>\${esc((u.last_sign_in_at || '').slice(0, 19))}</td><td>\${u.is_anonymous ? 'yes' : ''}</td></tr>\`).join('')}
  </table></div>\`
}

// ── storage ──
async function renderStorage() {
  const buckets = await api('/storage/v1/bucket')
  $('#main').innerHTML = \`<div class="wrap"><table>
    <tr><th>bucket</th><th>public</th><th>size limit</th><th>created</th></tr>
    \${buckets.map((b) => \`<tr><td>\${esc(b.id)}</td><td>\${b.public ? 'public' : 'private'}</td><td>\${esc(b.file_size_limit)}</td><td>\${esc((b.created_at || '').slice(0, 19))}</td></tr>\`).join('')}
  </table></div>\`
}

window.go = go; window.login = login; window.logout = logout; window.runSql = runSql
window.renderTables = renderTables
render()
</script>
</body>
</html>`
