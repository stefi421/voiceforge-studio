import type { CSSProperties, JSX, ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import type { JobStatus } from '@shared/types'
import { statusLabel, statusTone, type BadgeTone } from '@/lib/jobs'
import { formatCost } from '@/lib/format'

/* ------------------------------------------------------------------------ */
/* Card                                                                      */
/* ------------------------------------------------------------------------ */

export interface CardProps {
  children: ReactNode
  className?: string
  padded?: boolean | 'sm'
  hover?: boolean
  selected?: boolean
  onClick?: () => void
  style?: CSSProperties
  title?: ReactNode
  actions?: ReactNode
}

export function Card({ children, className = '', padded = false, hover, selected, onClick, style, title, actions }: CardProps): JSX.Element {
  const cls = ['card', padded === true ? 'card-pad' : padded === 'sm' ? 'card-pad-sm' : '', hover ? 'card-hover' : '', selected ? 'card-selected' : '', className]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls} onClick={onClick} style={style} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>
      {title !== undefined && (
        <div className="card-header">
          <div className="card-title">{title}</div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Badges                                                                    */
/* ------------------------------------------------------------------------ */

export interface BadgeProps {
  tone?: BadgeTone
  dot?: boolean
  pulse?: boolean
  children: ReactNode
  title?: string
  style?: CSSProperties
}

export function Badge({ tone = 'neutral', dot, pulse, children, title, style }: BadgeProps): JSX.Element {
  return (
    <span className={`badge ${tone !== 'neutral' ? `badge-${tone}` : ''} ${dot ? 'badge-dot' : ''} ${pulse ? 'badge-pulse' : ''}`} title={title} style={style}>
      {children}
    </span>
  )
}

export function StatusBadge({ status }: { status: JobStatus }): JSX.Element {
  const tone = statusTone(status)
  const active =
    status === 'researching' || status === 'writing_script' || status === 'validating_script' || status === 'generating_audio' || status === 'saving_files'
  return (
    <Badge tone={tone} dot pulse={active}>
      {statusLabel(status)}
    </Badge>
  )
}

/* ------------------------------------------------------------------------ */
/* Channel chip / icon                                                       */
/* ------------------------------------------------------------------------ */

export function ChannelIcon({ icon, color, size = 'md' }: { icon: string; color: string; size?: 'sm' | 'md' | 'lg' }): JSX.Element {
  return (
    <span className={`channel-icon ${size}`} style={{ background: hexToSoft(color), border: `1px solid ${hexToSoft(color, 0.35)}` }}>
      {icon || '•'}
    </span>
  )
}

export function ChannelChip({ name, color, icon }: { name: string; color: string; icon?: string }): JSX.Element {
  return (
    <span className="chip" title={name}>
      {icon ? <span style={{ fontSize: 12 }}>{icon}</span> : <span className="chip-swatch" style={{ background: color }} />}
      <span className="truncate">{name}</span>
    </span>
  )
}

export function hexToSoft(hex: string, alpha = 0.16): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m || !m[1]) return `rgba(124,92,255,${alpha})`
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}

/* ------------------------------------------------------------------------ */
/* Cost label                                                                */
/* ------------------------------------------------------------------------ */

export function CostLabel({ usd, title }: { usd: number | null | undefined; title?: string }): JSX.Element {
  return (
    <span className="mono" title={title ?? 'Estimated from the pricing table in Settings. Check your provider dashboard for actual billing.'}>
      {formatCost(usd)}
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* Alert                                                                     */
/* ------------------------------------------------------------------------ */

export interface AlertProps {
  tone?: 'info' | 'warning' | 'danger' | 'success' | 'neutral'
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  style?: CSSProperties
}

export function Alert({ tone = 'info', title, children, actions, style }: AlertProps): JSX.Element {
  const Icon = tone === 'warning' ? TriangleAlert : tone === 'danger' ? CircleAlert : tone === 'success' ? CircleCheck : Info
  return (
    <div className={`alert ${tone !== 'neutral' ? `alert-${tone}` : ''}`} style={style}>
      <Icon size={16} />
      <div className="alert-body">
        {title !== undefined && <div className="alert-title">{title}</div>}
        {children !== undefined && <div>{children}</div>}
        {actions && <div className="alert-actions">{actions}</div>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Empty state                                                               */
/* ------------------------------------------------------------------------ */

export interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  compact?: boolean
}

export function EmptyState({ icon, title, description, actions, compact }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty" style={compact ? { padding: '24px 16px' } : undefined}>
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {description && <div className="empty-desc">{description}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Progress                                                                  */
/* ------------------------------------------------------------------------ */

export interface ProgressBarProps {
  value: number
  max?: number
  tone?: 'accent' | 'success' | 'warning' | 'danger'
  indeterminate?: boolean
  style?: CSSProperties
  title?: string
}

export function ProgressBar({ value, max = 100, tone = 'accent', indeterminate, style, title }: ProgressBarProps): JSX.Element {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div className="progress" style={style} title={title}>
      <div className={`progress-bar ${tone !== 'accent' ? tone : ''} ${indeterminate ? 'indeterminate' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Skeleton                                                                  */
/* ------------------------------------------------------------------------ */

export function Skeleton({ width = '100%', height = 14, style }: { width?: number | string; height?: number | string; style?: CSSProperties }): JSX.Element {
  return <div className="skeleton" style={{ width, height, ...style }} />
}

export function SkeletonRows({ rows = 4 }: { rows?: number }): JSX.Element {
  return (
    <div className="col" style={{ gap: 10 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} height={18} width={`${70 + ((i * 13) % 30)}%`} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Key / value                                                               */
/* ------------------------------------------------------------------------ */

export function KeyValue({ items }: { items: Array<{ key: ReactNode; value: ReactNode }> }): JSX.Element {
  return (
    <dl className="kv">
      {items.map((it, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{it.key}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ------------------------------------------------------------------------ */
/* Stat card                                                                 */
/* ------------------------------------------------------------------------ */

export function Stat({ label, value, sub, icon, onClick }: { label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode; onClick?: () => void }): JSX.Element {
  return (
    <Card hover={Boolean(onClick)} onClick={onClick}>
      <div className="stat">
        <div className="stat-label">
          {icon}
          {label}
        </div>
        <div className="stat-value">{value}</div>
        {sub !== undefined && <div className="stat-sub">{sub}</div>}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------------ */
/* Tabs                                                                      */
/* ------------------------------------------------------------------------ */

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  icon?: ReactNode
  badge?: ReactNode
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  variant = 'underline'
}: {
  tabs: TabItem<T>[]
  value: T
  onChange: (v: T) => void
  variant?: 'underline' | 'pill' | 'vertical'
}): JSX.Element {
  const cls = variant === 'pill' ? 'tabs-pill' : variant === 'vertical' ? 'tabs tabs-vertical' : 'tabs'
  return (
    <div className={cls} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className={`tab ${t.id === value ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.icon}
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Page header                                                               */
/* ------------------------------------------------------------------------ */

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }): JSX.Element {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <span className="kbd">{children}</span>
}
