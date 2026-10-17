import type { JSX } from 'react'
import {
  AudioLines,
  ChartColumn,
  Clock,
  FileText,
  FolderOpen,
  LayoutDashboard,
  ListOrdered,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Tv,
  type LucideIcon
} from 'lucide-react'
import { DASHBOARD_PAGES, type PageId } from '@shared/ipc'
import { useRouter } from '@/store/router'
import { useApp } from '@/store/app'
import { formatDurationHuman } from '@/lib/format'

export const PAGE_META: Record<PageId, { label: string; icon: LucideIcon; subtitle: string }> = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard, subtitle: 'Overview of channels, queue and usage' },
  generate: { label: 'New Generation', icon: Sparkles, subtitle: 'Turn a list of titles into scripts and voiceovers' },
  channels: { label: 'Channels', icon: Tv, subtitle: 'Per-channel writing rules, voices and templates' },
  queue: { label: 'Generation Queue', icon: ListOrdered, subtitle: 'Live status of every job' },
  scripts: { label: 'Scripts Library', icon: FileText, subtitle: 'Every generated script, with versions and validation' },
  audio: { label: 'Audio Library', icon: AudioLines, subtitle: 'Generated voiceovers' },
  projects: { label: 'Projects', icon: FolderOpen, subtitle: 'One project per title, grouped by channel' },
  history: { label: 'Generation History', icon: Clock, subtitle: 'Timeline of job events' },
  usage: { label: 'Usage & Costs', icon: ChartColumn, subtitle: 'Estimated provider spend' },
  settings: { label: 'Settings', icon: Settings, subtitle: 'Providers, generation defaults, storage' }
}

export function Sidebar(): JSX.Element {
  const page = useRouter((s) => s.page)
  const navigate = useRouter((s) => s.navigate)
  const collapsed = useApp((s) => s.sidebarCollapsed)
  const setCollapsed = useApp((s) => s.setSidebarCollapsed)
  const stats = useApp((s) => s.stats)

  const busy = stats.processing > 0
  const dotClass = stats.queuePaused || stats.spendingPaused ? 'paused' : stats.failed > 0 && !busy ? 'failed' : busy ? 'busy' : 'idle'
  const pillTitle = stats.queuePaused
    ? 'Queue paused'
    : stats.spendingPaused
      ? 'Paused: spending limit reached'
      : busy
        ? `Processing ${stats.processing} job(s)` + (stats.estimatedSecondsRemaining != null ? ` · ~${formatDurationHuman(stats.estimatedSecondsRemaining)} left` : '')
        : 'Queue idle'

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand">
        <div className="brand-mark">
          <Mic size={15} />
        </div>
        <div>
          <div className="brand-text">VoiceForge</div>
          <div className="brand-sub">Studio</div>
        </div>
      </div>
      <nav className="sidebar-nav">
        {DASHBOARD_PAGES.map((id, i) => {
          const meta = PAGE_META[id]
          const Icon = meta.icon
          const key = i === 9 ? '0' : String(i + 1)
          const badge = id === 'queue' && stats.awaitingUser > 0 ? stats.awaitingUser : null
          return (
            <button
              key={id}
              type="button"
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => navigate(id)}
              title={collapsed ? `${meta.label} (Ctrl+${key})` : undefined}
            >
              <Icon size={17} />
              <span className="nav-label">{meta.label}</span>
              {badge != null && <span className="nav-badge" title="Jobs waiting for you">{badge}</span>}
              <span className="nav-kbd">⌃{key}</span>
            </button>
          )
        })}
      </nav>
      <div className="sidebar-footer">
        <div className="queue-pill" title={pillTitle} onClick={() => navigate('queue')} role="button">
          <span className={`dot ${dotClass}`} />
          <div className="queue-pill-counts">
            {stats.queuePaused ? (
              <span>Paused</span>
            ) : stats.spendingPaused ? (
              <span>Spend limit</span>
            ) : (
              <>
                <span>
                  <b>{stats.processing}</b> run
                </span>
                <span>
                  <b>{stats.pending}</b> wait
                </span>
                {stats.awaitingUser > 0 && (
                  <span className="text-warning">
                    <b>{stats.awaitingUser}</b> you
                  </span>
                )}
                {stats.failed > 0 && (
                  <span className="text-danger">
                    <b>{stats.failed}</b> fail
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <button type="button" className="nav-item" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          <span className="nav-label">Collapse</span>
        </button>
      </div>
    </aside>
  )
}
