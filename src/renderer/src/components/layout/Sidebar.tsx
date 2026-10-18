import type { JSX } from 'react'
import {
  AudioLines,
  ChartColumn,
  Clock,
  Download,
  Gamepad2,
  FileText,
  FolderOpen,
  LayoutDashboard,
  ListOrdered,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sparkles,
  Tv,
  type LucideIcon
} from 'lucide-react'
import { DASHBOARD_PAGES, type PageId } from '@shared/ipc'
import { useRouter } from '@/store/router'
import { useApp } from '@/store/app'
import { formatDurationHuman } from '@/lib/format'
import { useOverlays } from './CommandPalette'

export const PAGE_META: Record<PageId, { label: string; icon: LucideIcon; subtitle: string }> = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard, subtitle: 'Overview of channels, queue and usage' },
  generate: { label: 'New generation', icon: Sparkles, subtitle: 'Turn a list of titles into scripts and voiceovers' },
  channels: { label: 'Channels', icon: Tv, subtitle: 'Per-channel writing rules, voices and templates' },
  queue: { label: 'Queue', icon: ListOrdered, subtitle: 'Live status of every job' },
  scripts: { label: 'Scripts', icon: FileText, subtitle: 'Every generated script, with versions and validation' },
  audio: { label: 'Audio', icon: AudioLines, subtitle: 'Generated voiceovers' },
  projects: { label: 'Projects', icon: FolderOpen, subtitle: 'One project per title, grouped by channel' },
  history: { label: 'History', icon: Clock, subtitle: 'Timeline of job events' },
  games: { label: 'Games', icon: Gamepad2, subtitle: 'Saved research — researched once, reused for every script' },
  usage: { label: 'Usage & costs', icon: ChartColumn, subtitle: 'Estimated provider spend' },
  settings: { label: 'Settings', icon: Settings, subtitle: 'Providers, generation defaults, storage' }
}

/** Navigation groups; keyboard shortcuts still follow DASHBOARD_PAGES order (Ctrl+1 … Ctrl+0). */
const GROUPS: Array<{ label: string | null; pages: PageId[] }> = [
  { label: null, pages: ['dashboard', 'generate', 'queue'] },
  { label: 'Library', pages: ['channels', 'games', 'scripts', 'audio', 'projects', 'history'] },
  { label: 'System', pages: ['usage', 'settings'] }
]

export function Sidebar(): JSX.Element {
  const page = useRouter((s) => s.page)
  const navigate = useRouter((s) => s.navigate)
  const collapsed = useApp((s) => s.sidebarCollapsed)
  const setCollapsed = useApp((s) => s.setSidebarCollapsed)
  const stats = useApp((s) => s.stats)
  const update = useApp((s) => s.updateStatus)

  const busy = stats.processing > 0
  const dotClass = stats.queuePaused || stats.spendingPaused ? 'paused' : stats.failed > 0 && !busy ? 'failed' : busy ? 'busy' : 'idle'
  const pillTitle = stats.queuePaused
    ? 'Queue paused'
    : stats.spendingPaused
      ? 'Paused: spending limit reached'
      : busy
        ? `Processing ${stats.processing} job(s)` + (stats.estimatedSecondsRemaining != null ? ` · about ${formatDurationHuman(stats.estimatedSecondsRemaining)} left` : '')
        : 'Queue idle'

  const pillText = stats.queuePaused
    ? 'Paused'
    : stats.spendingPaused
      ? 'Spend limit'
      : busy
        ? `${stats.processing} running`
        : stats.pending > 0
          ? `${stats.pending} waiting`
          : 'Idle'

  const updateReady = update?.state === 'downloaded'
  const updateAvailable = update?.state === 'available'

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
      <button type="button" className="sidebar-search" onClick={() => useOverlays.getState().setPalette(true)} title="Search and jump (Ctrl+K)">
        <Search size={14} />
        <span>Search or jump…</span>
        <span className="kbd">Ctrl K</span>
      </button>
      <nav className="sidebar-nav">
        {GROUPS.map((g) => (
          <div key={g.label ?? 'main'} className="nav-group">
            {g.label && <div className="nav-group-label">{g.label}</div>}
            {g.pages.map((id) => {
              const meta = PAGE_META[id]
              const Icon = meta.icon
              const i = DASHBOARD_PAGES.indexOf(id)
              const key = i === 9 ? '0' : i < 9 ? String(i + 1) : null
              const badge = id === 'queue' && stats.awaitingUser > 0 ? stats.awaitingUser : null
              return (
                <button
                  key={id}
                  type="button"
                  className={`nav-item ${page === id ? 'active' : ''}`}
                  onClick={() => navigate(id)}
                  title={collapsed ? (key ? `${meta.label} (Ctrl+${key})` : meta.label) : undefined}
                  aria-current={page === id ? 'page' : undefined}
                >
                  <Icon size={16} />
                  <span className="nav-label">{meta.label}</span>
                  {badge != null && (
                    <span className="nav-badge" title="Jobs waiting for you">
                      {badge}
                    </span>
                  )}
                  {key && <span className="nav-kbd">⌃{key}</span>}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        {(updateReady || updateAvailable) && (
          <button type="button" className="update-banner" onClick={() => navigate('settings', { tab: 'updates' })} title={updateReady ? 'Restart to install the update' : 'A newer version can be downloaded'}>
            <Download size={14} />
            <span className="nav-label">{updateReady ? 'Update ready — restart to install' : `Version ${update?.latestVersion} available`}</span>
          </button>
        )}
        <div className="queue-pill" title={pillTitle} onClick={() => navigate('queue')} role="button">
          <span className={`dot ${dotClass}`} />
          <div className="queue-pill-counts">
            <span>{pillText}</span>
            {stats.awaitingUser > 0 && <span className="text-warning">{stats.awaitingUser} need you</span>}
            {stats.failed > 0 && <span className="text-danger">{stats.failed} failed</span>}
          </div>
        </div>
        <button type="button" className="nav-item" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          <span className="nav-label">Collapse</span>
        </button>
      </div>
    </aside>
  )
}
