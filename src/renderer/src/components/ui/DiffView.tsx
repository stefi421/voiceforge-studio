import { useMemo, type JSX } from 'react'
import { diffLines, diffStats } from '@/lib/diff'

export function DiffView({ oldText, newText, oldLabel = 'Before', newLabel = 'After' }: { oldText: string; newText: string; oldLabel?: string; newLabel?: string }): JSX.Element {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText])
  const stats = useMemo(() => diffStats(lines), [lines])
  return (
    <div className="col">
      <div className="diff-summary">
        <span>
          {oldLabel} → {newLabel}
        </span>
        <span className="text-success">+{stats.added}</span>
        <span className="text-danger">−{stats.removed}</span>
        <span>{stats.unchanged} unchanged</span>
      </div>
      <div className="diff">
        {lines.length === 0 ? (
          <div className="muted" style={{ padding: 12 }}>
            Both texts are empty.
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`diff-line ${l.op}`}>
              <span className="ln">{l.left ?? ''}</span>
              <span className="ln">{l.right ?? ''}</span>
              <span className="txt">{l.text || ' '}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
