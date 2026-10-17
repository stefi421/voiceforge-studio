import { useMemo, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'

export interface Column<T> {
  id: string
  header: ReactNode
  render: (row: T) => ReactNode
  /** Value used for sorting; when omitted the column is not sortable. */
  sortValue?: (row: T) => string | number | null | undefined
  width?: number | string
  align?: 'left' | 'right'
  className?: string
}

export interface SortState {
  id: string
  dir: 'asc' | 'desc'
}

export interface TableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  sort?: SortState | null
  onSortChange?: (s: SortState | null) => void
  defaultSort?: SortState
  emptyState?: ReactNode
  onRowClick?: (row: T) => void
  rowClassName?: (row: T) => string | undefined
  /** Optional leading cell (e.g. checkbox) rendered per row + header. */
  leading?: { header: ReactNode; render: (row: T) => ReactNode }
  maxHeight?: number | string
  style?: CSSProperties
  /** When provided, sorting is done by the parent (server side). */
  externalSort?: boolean
}

export function useSortedRows<T>(rows: T[], columns: Column<T>[], sort: SortState | null): T[] {
  return useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.id === sort.id)
    if (!col?.sortValue) return rows
    const get = col.sortValue
    const withIndex = rows.map((r, i) => ({ r, i, v: get(r) }))
    withIndex.sort((a, b) => {
      const av = a.v
      const bv = b.v
      let cmp = 0
      if (av == null && bv == null) cmp = 0
      else if (av == null) cmp = 1
      else if (bv == null) cmp = -1
      else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
      else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' })
      if (cmp === 0) cmp = a.i - b.i
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return withIndex.map((x) => x.r)
  }, [rows, columns, sort])
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  sort: controlledSort,
  onSortChange,
  defaultSort,
  emptyState,
  onRowClick,
  rowClassName,
  leading,
  maxHeight,
  style,
  externalSort
}: TableProps<T>): JSX.Element {
  const [internalSort, setInternalSort] = useState<SortState | null>(defaultSort ?? null)
  const sort = controlledSort !== undefined ? controlledSort : internalSort
  const setSort = (s: SortState | null): void => {
    if (onSortChange) onSortChange(s)
    if (controlledSort === undefined) setInternalSort(s)
  }
  const sorted = useSortedRows(rows, columns, externalSort ? null : sort)

  const toggle = (col: Column<T>): void => {
    if (!col.sortValue) return
    if (!sort || sort.id !== col.id) setSort({ id: col.id, dir: 'asc' })
    else if (sort.dir === 'asc') setSort({ id: col.id, dir: 'desc' })
    else setSort(null)
  }

  return (
    <div className="table-wrap" style={{ maxHeight, ...style }}>
      <table className="table">
        <thead>
          <tr>
            {leading && <th style={{ width: 36 }}>{leading.header}</th>}
            {columns.map((c) => {
              const active = sort?.id === c.id
              return (
                <th
                  key={c.id}
                  className={`${c.sortValue ? 'sortable' : ''} ${c.align === 'right' ? 'num' : ''} ${c.className ?? ''}`}
                  style={{ width: c.width }}
                  onClick={() => toggle(c)}
                  aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <span className="th-inner">
                    {c.header}
                    {c.sortValue &&
                      (active ? sort?.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : <ArrowUpDown size={11} style={{ opacity: 0.4 }} />)}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length + (leading ? 1 : 0)} style={{ padding: 0 }}>
                {emptyState ?? <div className="empty">No rows.</div>}
              </td>
            </tr>
          ) : (
            sorted.map((row) => (
              <tr
                key={rowKey(row)}
                className={rowClassName?.(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {leading && (
                  <td className="compact" onClick={(e) => e.stopPropagation()}>
                    {leading.render(row)}
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.id} className={`${c.align === 'right' ? 'num' : ''} ${c.className ?? ''}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
