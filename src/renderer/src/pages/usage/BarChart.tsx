import { useMemo, useState, type JSX } from 'react'
import { formatCost } from '@/lib/format'

export interface BarDatum {
  label: string
  a: number
  b: number
}

export interface BarChartProps {
  data: BarDatum[]
  aLabel: string
  bLabel: string
  height?: number
  /** Formats the axis/tooltip values. */
  format?: (v: number) => string
}

const A_COLOR = '#7c5cff'
const B_COLOR = '#2dd4bf'

/** Stacked bar chart rendered with plain SVG (no library). */
export function BarChart({ data, aLabel, bLabel, height = 180, format = (v) => formatCost(v, { estimate: false }) }: BarChartProps): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const width = 720
  const padL = 48
  const padR = 12
  const padT = 12
  const padB = 28
  const innerW = width - padL - padR
  const innerH = height - padT - padB
  const max = useMemo(() => Math.max(0.01, ...data.map((d) => d.a + d.b)), [data])
  const n = Math.max(1, data.length)
  const slot = innerW / n
  const barW = Math.max(2, Math.min(28, slot * 0.68))
  const ticks = 4
  const labelEvery = Math.ceil(n / 12)

  if (data.length === 0) {
    return (
      <div className="empty" style={{ padding: 24 }}>
        No data in this range.
      </div>
    )
  }

  return (
    <div className="col gap-2">
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${aLabel} and ${bLabel} per period`}>
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const v = (max / ticks) * i
          const y = padT + innerH - (v / max) * innerH
          return (
            <g key={i}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.08} />
              <text x={padL - 6} y={y + 3} textAnchor="end">
                {format(v)}
              </text>
            </g>
          )
        })}
        {data.map((d, i) => {
          const x = padL + i * slot + (slot - barW) / 2
          const hA = (d.a / max) * innerH
          const hB = (d.b / max) * innerH
          const yB = padT + innerH - hB
          const yA = yB - hA
          const active = hover === i
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + i * slot} y={padT} width={slot} height={innerH} fill="transparent" />
              <rect x={x} y={yB} width={barW} height={hB} fill={B_COLOR} opacity={active ? 1 : 0.85} rx={2} />
              <rect x={x} y={yA} width={barW} height={hA} fill={A_COLOR} opacity={active ? 1 : 0.85} rx={2} />
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 10} textAnchor="middle">
                  {d.label}
                </text>
              )}
              {active && (
                <g>
                  <rect x={Math.min(width - 150, Math.max(padL, x - 50))} y={padT} width={140} height={46} rx={6} fill="var(--bg-elev-3)" stroke="var(--border-strong)" />
                  <text x={Math.min(width - 150, Math.max(padL, x - 50)) + 8} y={padT + 14} style={{ fill: 'var(--fg)', fontWeight: 600 }}>
                    {d.label}
                  </text>
                  <text x={Math.min(width - 150, Math.max(padL, x - 50)) + 8} y={padT + 28} style={{ fill: A_COLOR }}>
                    {aLabel}: {format(d.a)}
                  </text>
                  <text x={Math.min(width - 150, Math.max(padL, x - 50)) + 8} y={padT + 40} style={{ fill: B_COLOR }}>
                    {bLabel}: {format(d.b)}
                  </text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: A_COLOR }} /> {aLabel}
        </span>
        <span>
          <i style={{ background: B_COLOR }} /> {bLabel}
        </span>
      </div>
    </div>
  )
}
