/**
 * tinbase-vs-competitor feature table, driven by lib/comparisons.ts.
 * Tone colours a cell (good / neutral / gap) but is never a verdict on its own —
 * the labels carry the actual meaning, so the table reads honestly either way.
 */
import type { Cell, Row } from '@/lib/comparisons'

const TONE: Record<NonNullable<Cell['tone']>, string> = {
  good: 'text-accent',
  neutral: 'text-muted',
  warn: 'text-warn',
}

function CellText({ cell }: { cell: Cell }) {
  return <span className={TONE[cell.tone ?? 'neutral']}>{cell.label}</span>
}

export function ComparisonTable({ rows, competitorName }: { rows: Row[]; competitorName: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-2 text-left">
            <th className="w-1/3 px-4 py-3 font-semibold text-subtle"></th>
            <th className="px-4 py-3 font-semibold text-accent">tinbase</th>
            <th className="px-4 py-3 font-semibold text-fg">{competitorName}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.feature} className="border-b border-border align-top last:border-0">
              <td className="px-4 py-3 font-medium text-fg">{row.feature}</td>
              <td className="px-4 py-3">
                <CellText cell={row.tinbase} />
              </td>
              <td className="px-4 py-3">
                <CellText cell={row.other} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
