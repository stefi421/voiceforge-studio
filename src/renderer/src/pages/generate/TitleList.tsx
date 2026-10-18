import { memo, useState, type JSX } from 'react'
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react'
import type { Channel } from '@shared/types'
import { Checkbox, Input, Select } from '@/components/ui'
import { parseStoreLink, storeLinkTitle } from '@shared/storeLinks'

export interface TitleRow {
  id: string
  title: string
  channelId: string | null
  selected: boolean
}

export interface TitleListProps {
  rows: TitleRow[]
  channels: Channel[]
  batchChannelId: string
  onChange: (rows: TitleRow[]) => void
  notes: Record<string, string>
  onNotesChange: (notes: Record<string, string>) => void
  showNotes: boolean
}

let idCounter = 0
export function newRowId(): string {
  return `r${Date.now().toString(36)}_${idCounter++}`
}

export function TitleList({ rows, channels, batchChannelId, onChange, notes, onNotesChange, showNotes }: TitleListProps): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)

  const update = (id: string, patch: Partial<TitleRow>): void => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const remove = (id: string): void => onChange(rows.filter((r) => r.id !== id))
  const move = (id: string, dir: -1 | 1): void => {
    const idx = rows.findIndex((r) => r.id === id)
    const target = idx + dir
    if (idx < 0 || target < 0 || target >= rows.length) return
    const next = [...rows]
    const a = next[idx]
    const b = next[target]
    if (!a || !b) return
    next[idx] = b
    next[target] = a
    onChange(next)
  }
  const dropOn = (targetId: string): void => {
    if (!dragId || dragId === targetId) return
    const from = rows.findIndex((r) => r.id === dragId)
    const to = rows.findIndex((r) => r.id === targetId)
    if (from < 0 || to < 0) return
    const next = [...rows]
    const [item] = next.splice(from, 1)
    if (!item) return
    next.splice(to, 0, item)
    onChange(next)
    setDragId(null)
  }

  const allSelected = rows.length > 0 && rows.every((r) => r.selected)
  const someSelected = rows.some((r) => r.selected)

  return (
    <div className="col" style={{ gap: 2 }}>
      <div className="title-row" style={{ background: 'transparent' }}>
        <span />
        <Checkbox checked={allSelected} indeterminate={!allSelected && someSelected} onChange={(v) => onChange(rows.map((r) => ({ ...r, selected: v })))} title="Select all" />
        <span className="xs muted">Title</span>
        <span className="xs muted">Channel for this title</span>
        <span />
      </div>
      {rows.map((row, i) => (
        <Row
          key={row.id}
          row={row}
          index={i}
          isFirst={i === 0}
          isLast={i === rows.length - 1}
          channels={channels}
          batchChannelId={batchChannelId}
          dragging={dragId === row.id}
          showNotes={showNotes}
          note={notes[row.title] ?? ''}
          onUpdate={update}
          onRemove={remove}
          onMove={move}
          onDragStart={setDragId}
          onDrop={dropOn}
          onNote={(title, text) => {
            const next = { ...notes }
            if (text.trim()) next[title] = text
            else delete next[title]
            onNotesChange(next)
          }}
        />
      ))}
    </div>
  )
}

interface RowProps {
  row: TitleRow
  index: number
  isFirst: boolean
  isLast: boolean
  channels: Channel[]
  batchChannelId: string
  dragging: boolean
  showNotes: boolean
  note: string
  onUpdate: (id: string, patch: Partial<TitleRow>) => void
  onRemove: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onDragStart: (id: string | null) => void
  onDrop: (id: string) => void
  onNote: (title: string, text: string) => void
}

const Row = memo(function Row({ row, index, isFirst, isLast, channels, batchChannelId, dragging, showNotes, note, onUpdate, onRemove, onMove, onDragStart, onDrop, onNote }: RowProps) {
  const batchChannel = channels.find((c) => c.id === batchChannelId)
  // 1.6.1: a pasted Steam link shows the game name it becomes (the official title replaces it after research).
  const link = parseStoreLink(row.title)
  return (
    <div
      className={`col ${dragging ? 'dragging' : ''}`}
      style={{ gap: 0 }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(row.id)
      }}
      onDragEnd={() => onDragStart(null)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDrop(row.id)
      }}
    >
      <div className={`title-row ${dragging ? 'dragging' : ''}`}>
        <span className="drag-handle" title="Drag to reorder">
          <GripVertical size={14} />
        </span>
        <Checkbox checked={row.selected} onChange={(v) => onUpdate(row.id, { selected: v })} />
        <div className="row">
          <span className="idx">{index + 1}.</span>
          <Input inputSize="sm" value={row.title} onChange={(e) => onUpdate(row.id, { title: e.target.value })} invalid={!row.title.trim()} />
        </div>
        <Select
          inputSize="sm"
          value={row.channelId ?? ''}
          onChange={(v) => onUpdate(row.id, { channelId: v || null })}
          options={[{ value: '', label: `Batch default${batchChannel ? ` (${batchChannel.name})` : ''}` }, ...channels.map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` }))]}
        />
        <span className="row" style={{ gap: 0 }}>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={isFirst} onClick={() => onMove(row.id, -1)} title="Move up">
            <ArrowUp size={12} />
          </button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={isLast} onClick={() => onMove(row.id, 1)} title="Move down">
            <ArrowDown size={12} />
          </button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => onRemove(row.id)} title="Remove">
            <X size={12} />
          </button>
        </span>
      </div>
      {link && (
        <div className="xs muted" style={{ padding: '0 8px 4px 56px' }} title="The Steam app id identifies the game exactly; research uses the store page and the official title becomes the folder name.">
          Steam link → <span className="strong">{storeLinkTitle(link)}</span> · app {link.appId}
        </div>
      )}
      {showNotes && (
        <div style={{ padding: '0 8px 6px 56px' }}>
          <textarea
            className="textarea"
            rows={2}
            style={{ minHeight: 40, fontSize: 12 }}
            placeholder={`Manual research notes for "${row.title || 'this title'}" (optional)`}
            value={note}
            onChange={(e) => onNote(row.title, e.target.value)}
          />
        </div>
      )}
    </div>
  )
})
