/**
 * How tinbase is put together: the unmodified supabase-js SDK talks to a single
 * (Request) => Response fetch handler, which fans out to the service handlers,
 * which all sit on one swappable DbEngine adapter (wasm / native / pg-mem).
 * The same handler runs as an HTTP+WS server in Node or in-process in a browser.
 */
const SVC = ['REST', 'Auth', 'Storage', 'Realtime', 'Functions']
const SERVICES = [
  ['PostgREST', '/rest/v1'],
  ['GoTrue', '/auth/v1'],
  ['Storage', '/storage/v1'],
  ['Realtime', 'WebSocket'],
  ['Edge Fns', '/functions/v1'],
  ['Studio', '/_/'],
]
const ENGINES = [
  ['tinbase (wasm)', 'PGlite — Postgres in WASM'],
  ['tinbase (native)', 'embedded Postgres 17'],
  ['tinbase (pg-mem)', 'pure JS, in-memory'],
]

export function ArchitectureDiagram() {
  return (
    <figure className="overflow-x-auto">
      <svg viewBox="0 0 960 620" className="min-w-[720px] w-full" fontFamily="ui-sans-serif, system-ui, sans-serif">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#3f3f46" />
          </marker>
        </defs>

        {/* client */}
        <rect x="80" y="24" width="800" height="96" rx="12" fill="#0f2a1f" stroke="#134e35" />
        <text x="100" y="52" fill="#6ee7b7" fontSize="15" fontWeight="700">@supabase/supabase-js</text>
        <text x="332" y="52" fill="#71717a" fontSize="12.5">the official SDK, unmodified</text>
        {SVC.map((s, i) => (
          <g key={s}>
            <rect x={100 + i * 150} y="70" width="134" height="34" rx="8" fill="#0a0a0a" stroke="#27272a" />
            <text x={167 + i * 150} y="92" fill="#d4d4d8" fontSize="13" textAnchor="middle">{s}</text>
          </g>
        ))}

        {/* client → core */}
        <line x1="480" y1="120" x2="480" y2="168" stroke="#3f3f46" strokeWidth="1.5" markerEnd="url(#arrow)" />
        <text x="496" y="148" fill="#a1a1aa" fontSize="12">same wire protocol — HTTP in Node · in-process <tspan fill="#34d399">fetch</tspan> in the browser</text>

        {/* core */}
        <rect x="80" y="172" width="800" height="150" rx="12" fill="#111113" stroke="#2b2b30" />
        <text x="100" y="200" fill="#fafafa" fontSize="15" fontWeight="700">tinbase</text>
        <text x="168" y="200" fill="#71717a" fontSize="12.5">
          one <tspan fill="#d4d4d8" fontFamily="ui-monospace, monospace">(Request) ⇒ Response</tspan> fetch handler
        </text>
        {SERVICES.map(([name, path], i) => (
          <g key={name}>
            <rect x={100 + i * 128} y="224" width="116" height="72" rx="9" fill="#18181b" stroke="#3f3f46" />
            <text x={158 + i * 128} y="258" fill="#e4e4e7" fontSize="13" fontWeight="600" textAnchor="middle">{name}</text>
            <text x={158 + i * 128} y="278" fill="#8b8b93" fontSize="11" fontFamily="ui-monospace, monospace" textAnchor="middle">{path}</text>
          </g>
        ))}

        {/* core → engine */}
        <line x1="480" y1="322" x2="480" y2="392" stroke="#3f3f46" strokeWidth="1.5" markerEnd="url(#arrow)" />
        <rect x="330" y="336" width="300" height="40" rx="8" fill="#0a0a0a" stroke="#27272a" />
        <text x="480" y="361" fill="#d4d4d8" fontSize="12.5" textAnchor="middle">
          <tspan fontFamily="ui-monospace, monospace" fill="#93c5fd">DbEngine</tspan> adapter · query · exec · transaction · listen
        </text>

        {/* engines */}
        {ENGINES.map(([name, desc], i) => (
          <g key={name}>
            <rect x={100 + i * 262} y="404" width="240" height="72" rx="10" fill="#0f2a1f" stroke="#134e35" />
            <text x={220 + i * 262} y="438" fill="#6ee7b7" fontSize="13.5" fontWeight="700" textAnchor="middle">{name}</text>
            <text x={220 + i * 262} y="458" fill="#a1a1aa" fontSize="11.5" textAnchor="middle">{desc}</text>
          </g>
        ))}
        <text x="480" y="500" fill="#52525b" fontSize="12" textAnchor="middle">real Postgres semantics — RLS, triggers, FKs, jsonb (pg-mem is a subset)</text>

        {/* runtime annotations */}
        <rect x="80" y="536" width="386" height="56" rx="10" fill="#0a0a0a" stroke="#27272a" />
        <text x="100" y="562" fill="#d4d4d8" fontSize="13" fontWeight="600">In Node</text>
        <text x="100" y="580" fill="#8b8b93" fontSize="11.5">HTTP + WebSocket server — one process, no Docker</text>
        <rect x="494" y="536" width="386" height="56" rx="10" fill="#0a0a0a" stroke="#27272a" />
        <text x="514" y="562" fill="#d4d4d8" fontSize="13" fontWeight="600">In the browser</text>
        <text x="514" y="580" fill="#8b8b93" fontSize="11.5">in-process fetch handler — the whole backend in a tab</text>
      </svg>
    </figure>
  )
}
