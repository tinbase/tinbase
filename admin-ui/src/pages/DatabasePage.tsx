import { useEffect, useState } from 'react'
import { api, type Stats } from '../api'
import { Empty, Spinner } from '../components/ui'

export function DatabasePage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [migrations, setMigrations] = useState<{ version: string; name: string | null; applied_at: string }[]>([])
  const [functions, setFunctions] = useState<any[]>([])
  const [triggers, setTriggers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([api.stats(), api.migrations(), api.functions(), api.triggers()])
      .then(([s, m, f, t]) => {
        setStats(s)
        setMigrations(m)
        setFunctions(f)
        setTriggers(t)
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner />

  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="text-sm font-semibold text-neutral-300">Database</h1>
      {stats && (
        <>
          <p className="mt-1 font-mono text-xs text-neutral-500">{stats.version}</p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Tables" value={stats.tables} />
            <Stat label="Users" value={stats.users} />
            <Stat label="Buckets" value={stats.buckets} />
            <Stat label="Objects" value={stats.objects} />
            <Stat label="Migrations" value={stats.migrations} />
            <Stat label="DB size" value={stats.dbSize} />
          </div>
        </>
      )}

      <h2 className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wide text-neutral-500">Migrations</h2>
      <div className="overflow-hidden rounded-md border border-neutral-800">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-[#191919]">
            <tr className="border-b border-neutral-800 text-left text-neutral-400">
              <th className="px-4 py-2 font-medium">Version</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Applied</th>
            </tr>
          </thead>
          <tbody>
            {migrations.map((m) => (
              <tr key={m.version} className="border-b border-neutral-800/60">
                <td className="px-4 py-1.5 font-mono text-neutral-400">{m.version}</td>
                <td className="px-4 py-1.5 font-mono">{m.name || '—'}</td>
                <td className="px-4 py-1.5 text-neutral-400">{(m.applied_at || '').slice(0, 19).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {migrations.length === 0 && <Empty>No migrations applied.</Empty>}
      </div>

      <h2 className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wide text-neutral-500">Functions</h2>
      <div className="overflow-hidden rounded-md border border-neutral-800">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-[#191919]">
            <tr className="border-b border-neutral-800 text-left text-neutral-400">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Arguments</th>
              <th className="px-4 py-2 font-medium">Returns</th>
              <th className="px-4 py-2 font-medium">Language</th>
            </tr>
          </thead>
          <tbody>
            {functions.map((f) => (
              <tr key={f.name} className="border-b border-neutral-800/60">
                <td className="px-4 py-1.5 font-mono text-neutral-200">{f.name}</td>
                <td className="max-w-[280px] truncate px-4 py-1.5 font-mono text-[11px] text-neutral-500">{f.args || '—'}</td>
                <td className="px-4 py-1.5 font-mono text-neutral-400">{f.returns}</td>
                <td className="px-4 py-1.5 text-neutral-400">{f.language}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {functions.length === 0 && <Empty>No user functions.</Empty>}
      </div>

      <h2 className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wide text-neutral-500">Triggers</h2>
      <div className="overflow-hidden rounded-md border border-neutral-800">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-[#191919]">
            <tr className="border-b border-neutral-800 text-left text-neutral-400">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Table</th>
              <th className="px-4 py-2 font-medium">Timing</th>
              <th className="px-4 py-2 font-medium">Events</th>
              <th className="px-4 py-2 font-medium">Function</th>
            </tr>
          </thead>
          <tbody>
            {triggers.map((t) => (
              <tr key={t.table + t.name} className="border-b border-neutral-800/60">
                <td className="px-4 py-1.5 font-mono text-neutral-200">{t.name}</td>
                <td className="px-4 py-1.5 font-mono text-neutral-400">{t.table}</td>
                <td className="px-4 py-1.5 text-neutral-400">{t.timing}</td>
                <td className="px-4 py-1.5 text-neutral-400">{(t.events || []).join(', ')}</td>
                <td className="px-4 py-1.5 font-mono text-[11px] text-neutral-500">{t.function}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {triggers.length === 0 && <Empty>No triggers.</Empty>}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-[#191919] p-3">
      <div className="text-lg font-semibold text-neutral-100">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </div>
  )
}
