import { useEffect, useRef, useState } from 'react'
import { api, type LogEntry } from '../api'
import { Button, Empty, Spinner } from '../components/ui'

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  info: 'text-neutral-500',
  warn: 'text-amber-400',
  error: 'text-red-400',
}

export function Logs() {
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const [live, setLive] = useState(true)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  async function load() {
    try {
      setLogs(await api.logs())
    } catch {
      // transient — keep the last snapshot
    }
  }

  useEffect(() => {
    load()
    if (live) {
      timer.current = setInterval(load, 2000)
      return () => {
        if (timer.current) clearInterval(timer.current)
      }
    }
  }, [live])

  if (logs === null) return <Spinner />

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div>
          <h1 className="text-sm font-semibold text-neutral-300">Logs</h1>
          <p className="text-xs text-neutral-500">Recent requests and server events</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            className={live ? '' : 'opacity-60'}
            onClick={() => setLive((v) => !v)}
            title={live ? 'Pause auto-refresh' : 'Resume auto-refresh'}
          >
            {live ? '⏸ Live' : '▶ Paused'}
          </Button>
          <Button onClick={load}>Refresh</Button>
          <Button
            onClick={async () => {
              await api.clearLogs()
              load()
            }}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12.5px] leading-relaxed">
        {logs.length === 0 ? (
          <Empty>No logs yet. Make a request or trigger an email/webhook.</Empty>
        ) : (
          logs.map((l, i) => (
            <div key={i} className="flex gap-3 whitespace-pre-wrap break-words px-3 py-0.5 hover:bg-neutral-800/40">
              <span className="shrink-0 tabular-nums text-neutral-600">{l.ts.slice(11, 23)}</span>
              <span className={'shrink-0 uppercase ' + LEVEL_COLOR[l.level]}>{l.level}</span>
              <span className="text-neutral-300">{l.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
