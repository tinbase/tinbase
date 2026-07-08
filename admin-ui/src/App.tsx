import { Database, KeyRound, HardDrive, Table2, Terminal, GitBranch, ShieldCheck, ScrollText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, clearKey, getKey, setKey } from './api'
import { Button, Input } from './components/ui'
import { TableEditor } from './pages/TableEditor'
import { SqlEditor } from './pages/SqlEditor'
import { AuthUsers } from './pages/AuthUsers'
import { Storage } from './pages/Storage'
import { DatabasePage } from './pages/DatabasePage'
import { Policies } from './pages/Policies'
import { Logs } from './pages/Logs'

type Tab = 'table' | 'sql' | 'auth' | 'policies' | 'storage' | 'database' | 'logs'

const NAV: { id: Tab; label: string; icon: typeof Table2 }[] = [
  { id: 'table', label: 'Table Editor', icon: Table2 },
  { id: 'sql', label: 'SQL Editor', icon: Terminal },
  { id: 'auth', label: 'Authentication', icon: KeyRound },
  { id: 'policies', label: 'RLS Policies', icon: ShieldCheck },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'database', label: 'Database', icon: GitBranch },
  { id: 'logs', label: 'Logs', icon: ScrollText },
]

function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120">
      <path d="M24 34v56c0 8.8 16.1 16 36 16s36-7.2 36-16V34" fill="#2a9d6f" />
      <ellipse cx="60" cy="34" rx="36" ry="16" fill="#3ecf8e" />
    </svg>
  )
}

export function App() {
  const [authed, setAuthed] = useState(!!getKey())
  const [tab, setTab] = useState<Tab>('table')

  useEffect(() => {
    if (!getKey()) return
    api.ping().catch(() => {
      clearKey()
      setAuthed(false)
    })
  }, [])

  if (!authed) return <Login onOk={() => setAuthed(true)} />

  return (
    <div className="flex h-full">
      {/* icon rail */}
      <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-neutral-800 bg-[#171717] py-3">
        <div className="mb-3">
          <Logo />
        </div>
        {NAV.map((n) => {
          const Icon = n.icon
          const active = tab === n.id
          return (
            <button
              key={n.id}
              title={n.label}
              onClick={() => setTab(n.id)}
              className={
                'group relative flex size-9 items-center justify-center rounded-md transition-colors ' +
                (active ? 'bg-neutral-800 text-brand' : 'text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200')
              }
            >
              <Icon size={18} />
              <span className="pointer-events-none absolute left-11 z-20 hidden whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 group-hover:block">
                {n.label}
              </span>
            </button>
          )
        })}
        <button
          title="Log out"
          onClick={() => {
            clearKey()
            setAuthed(false)
          }}
          className="mt-auto flex size-9 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
        >
          <Database size={18} />
        </button>
      </nav>

      <main className="min-w-0 flex-1">
        {tab === 'table' && <TableEditor />}
        {tab === 'sql' && <SqlEditor />}
        {tab === 'auth' && <AuthUsers />}
        {tab === 'policies' && <Policies />}
        {tab === 'storage' && <Storage />}
        {tab === 'database' && <DatabasePage />}
        {tab === 'logs' && <Logs />}
      </main>
    </div>
  )
}

function Login({ onOk }: { onOk: () => void }) {
  const [key, setKeyInput] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setErr('')
    setKey(key.trim())
    try {
      await api.ping()
      onOk()
    } catch (e) {
      clearKey()
      setErr('Invalid service_role key: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-[400px] text-center">
        <div className="mb-4 flex justify-center">
          <Logo size={48} />
        </div>
        <h1 className="text-lg font-semibold">tinbase studio</h1>
        <p className="mt-1 text-[13px] text-neutral-500">
          Sign in with the <span className="text-neutral-300">service_role</span> key printed when tinbase started.
        </p>
        <div className="mt-5 space-y-3 text-left">
          <Input
            type="password"
            placeholder="service_role key (eyJ…)"
            value={key}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <Button className="w-full" onClick={submit} disabled={busy || !key.trim()}>
            {busy ? 'Checking…' : 'Continue'}
          </Button>
          {err && <p className="text-xs text-red-400">{err}</p>}
        </div>
      </div>
    </div>
  )
}
