import { Plus, Trash2, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Button, Empty, Input, Label, Modal, Spinner } from '../components/ui'

export function Policies() {
  const [policies, setPolicies] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  async function load() {
    setPolicies(await api.policies())
  }
  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [])

  async function del(p: any) {
    if (!confirm(`Drop policy "${p.name}" on ${p.table}?`)) return
    await api.dropPolicy(p.table, p.name)
    await load()
  }

  if (loading) return <Spinner />

  const byTable = new Map<string, any[]>()
  for (const p of policies) {
    if (!byTable.has(p.table)) byTable.set(p.table, [])
    byTable.get(p.table)!.push(p)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
        <ShieldCheck size={15} className="text-brand" />
        <span className="text-sm font-semibold">RLS Policies</span>
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">{policies.length}</span>
        <Button size="xs" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus size={13} /> New policy
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {[...byTable].map(([table, ps]) => (
          <div key={table} className="mb-5">
            <div className="mb-1.5 font-mono text-[13px] text-neutral-300">{table}</div>
            <div className="overflow-hidden rounded-md border border-neutral-800">
              <table className="w-full text-[13px]">
                <thead className="bg-[#191919] text-neutral-400">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Policy</th>
                    <th className="px-3 py-1.5 text-left font-medium">Command</th>
                    <th className="px-3 py-1.5 text-left font-medium">Roles</th>
                    <th className="px-3 py-1.5 text-left font-medium">USING / CHECK</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {ps.map((p) => (
                    <tr key={p.name} className="group border-t border-neutral-800/60">
                      <td className="px-3 py-1.5">{p.name}</td>
                      <td className="px-3 py-1.5 text-neutral-400">{p.cmd}</td>
                      <td className="px-3 py-1.5 font-mono text-[11px] text-neutral-500">
                        {Array.isArray(p.roles) ? p.roles.join(', ') : p.roles}
                      </td>
                      <td className="max-w-[360px] truncate px-3 py-1.5 font-mono text-[11px] text-amber-300/70">
                        {[p.using_expr && `USING ${p.using_expr}`, p.with_check && `CHECK ${p.with_check}`]
                          .filter(Boolean)
                          .join('  ·  ')}
                      </td>
                      <td className="px-2">
                        <button
                          className="p-1 text-neutral-500 opacity-0 hover:text-red-400 group-hover:opacity-100"
                          onClick={() => del(p)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {policies.length === 0 && <Empty>No policies. Create one, or enable RLS on a table first.</Empty>}
      </div>

      {creating && (
        <CreatePolicy
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false)
            await load()
          }}
        />
      )}
    </div>
  )
}

function CreatePolicy({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ table: '', name: '', command: 'ALL', roles: 'authenticated', using: '', check: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }))

  async function submit() {
    setBusy(true)
    setErr('')
    try {
      const r = await api.createPolicy(f)
      if (r.error) throw new Error(r.error + (r.hint ? ` (${r.hint})` : ''))
      onDone()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="New RLS policy" wide>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Table</Label>
            <Input value={f.table} onChange={(e) => set('table', e.target.value)} placeholder="todos" />
          </div>
          <div>
            <Label>Policy name</Label>
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="own rows" />
          </div>
          <div>
            <Label>Command</Label>
            <select
              className="h-8 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 text-[13px]"
              value={f.command}
              onChange={(e) => set('command', e.target.value)}
            >
              {['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Roles</Label>
            <Input value={f.roles} onChange={(e) => set('roles', e.target.value)} placeholder="authenticated" />
          </div>
        </div>
        <div>
          <Label>USING expression (read/visibility)</Label>
          <Input value={f.using} onChange={(e) => set('using', e.target.value)} placeholder="user_id = auth.uid()" />
        </div>
        <div>
          <Label>WITH CHECK expression (writes)</Label>
          <Input value={f.check} onChange={(e) => set('check', e.target.value)} placeholder="user_id = auth.uid()" />
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !f.table || !f.name}>
            {busy ? 'Creating…' : 'Create policy'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
