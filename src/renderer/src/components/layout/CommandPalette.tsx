import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, Keyboard, Moon, Pause, Play, Sparkles, Sun, Tv, Wand2 } from 'lucide-react'
import { DASHBOARD_PAGES } from '@shared/ipc'
import type { ProjectView } from '@shared/types'
import { api } from '@/lib/api'
import { activeChannels, useApp } from '@/store/app'
import { navigate } from '@/store/router'
import { toast } from '@/store/toasts'
import { Dialog, Kbd } from '@/components/ui'
import { PAGE_META } from './Sidebar'
import { create } from 'zustand'

interface OverlayState {
  palette: boolean
  shortcuts: boolean
  setPalette: (v: boolean) => void
  setShortcuts: (v: boolean) => void
}

export const useOverlays = create<OverlayState>((set) => ({
  palette: false,
  shortcuts: false,
  setPalette: (palette) => set({ palette }),
  setShortcuts: (shortcuts) => set({ shortcuts })
}))

interface Command {
  id: string
  group: string
  label: string
  hint?: string
  icon?: ReactNode
  keywords?: string
  run: () => void
}

function score(cmd: Command, q: string): number {
  if (!q) return 1
  const hay = `${cmd.label} ${cmd.keywords ?? ''} ${cmd.group}`.toLowerCase()
  const needle = q.toLowerCase()
  if (cmd.label.toLowerCase().startsWith(needle)) return 3
  if (hay.includes(needle)) return 2
  // subsequence match ("ngen" → "New generation")
  let i = 0
  for (const ch of hay) if (ch === needle[i]) i++
  return i === needle.length ? 1 : 0
}

export function CommandPalette(): JSX.Element | null {
  const open = useOverlays((s) => s.palette)
  const setOpen = useOverlays((s) => s.setPalette)
  const channels = useApp((s) => s.channels)
  const stats = useApp((s) => s.stats)
  const theme = useApp((s) => s.settings.general.theme)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [projects, setProjects] = useState<ProjectView[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    setActive(0)
    window.setTimeout(() => inputRef.current?.focus(), 0)
    api
      .invoke('projects:list', { limit: 30, sort: 'updatedAt', dir: 'desc' })
      .then((p) => setProjects(Array.isArray(p) ? p : []))
      .catch(() => setProjects([]))
  }, [open])

  const commands = useMemo<Command[]>(() => {
    const close = (fn: () => void) => () => {
      setOpen(false)
      fn()
    }
    const list: Command[] = []
    list.push({ id: 'act:generate', group: 'Actions', label: 'New generation', icon: <Sparkles size={15} />, hint: 'Ctrl N', keywords: 'generate start batch titles', run: close(() => navigate('generate')) })
    list.push({
      id: 'act:queue',
      group: 'Actions',
      label: stats.queuePaused ? 'Resume queue' : 'Pause queue',
      icon: stats.queuePaused ? <Play size={15} /> : <Pause size={15} />,
      run: close(() => {
        void api
          .invoke(stats.queuePaused ? 'queue:resumeAll' : 'queue:pauseAll', undefined)
          .then((s) => {
            useApp.setState({ stats: s })
            toast.success(stats.queuePaused ? 'Queue resumed' : 'Queue paused')
          })
          .catch((err) => toast.error('Queue action failed', err))
      })
    })
    list.push({ id: 'act:channel', group: 'Actions', label: 'Add channel', icon: <Tv size={15} />, run: close(() => navigate('channels', { edit: 'new' })) })
    list.push({
      id: 'act:output',
      group: 'Actions',
      label: 'Open output folder',
      icon: <FolderOpen size={15} />,
      run: close(() => {
        void api
          .invoke('app:info', undefined)
          .then((info) => api.invoke('app:openPath', { path: info.outputRoot }))
          .catch((err) => toast.error('Could not open folder', err))
      })
    })
    list.push({
      id: 'act:theme',
      group: 'Actions',
      label: theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
      icon: theme === 'light' ? <Moon size={15} /> : <Sun size={15} />,
      keywords: 'theme appearance',
      run: close(() => void useApp.getState().updateSettings({ general: { theme: theme === 'light' ? 'dark' : 'light' } }).catch((err) => toast.error('Could not change theme', err)))
    })
    list.push({ id: 'act:setup', group: 'Actions', label: 'Run setup assistant', icon: <Wand2 size={15} />, keywords: 'wizard onboarding keys', run: close(() => useApp.getState().setWizardForced(true)) })
    list.push({ id: 'act:keys', group: 'Actions', label: 'Keyboard shortcuts', icon: <Keyboard size={15} />, hint: '?', run: close(() => useOverlays.getState().setShortcuts(true)) })
    DASHBOARD_PAGES.forEach((p, i) => {
      const meta = PAGE_META[p]
      const Icon = meta.icon
      list.push({ id: `page:${p}`, group: 'Go to', label: meta.label, icon: <Icon size={15} />, hint: i < 10 ? `Ctrl ${i === 9 ? 0 : i + 1}` : undefined, keywords: meta.subtitle, run: close(() => navigate(p)) })
    })
    for (const c of activeChannels(channels)) {
      list.push({ id: `ch:${c.id}`, group: 'Channels', label: c.name, icon: <span>{c.icon}</span>, hint: 'Edit', keywords: `channel ${c.category}`, run: close(() => navigate('channels', { edit: c.id })) })
      list.push({ id: `gen:${c.id}`, group: 'Channels', label: `Generate for ${c.name}`, icon: <Sparkles size={15} />, keywords: 'new generation', run: close(() => navigate('generate', { channelId: c.id })) })
    }
    for (const p of projects) {
      list.push({
        id: `prj:${p.id}`,
        group: 'Recent projects',
        label: p.title,
        icon: <FolderOpen size={15} />,
        hint: p.channelName,
        run: close(() => {
          if (p.folderPath) void api.invoke('app:openPath', { path: p.folderPath }).catch((err) => toast.error('Could not open folder', err))
          else navigate('projects')
        })
      })
    }
    return list
  }, [channels, projects, stats.queuePaused, theme, setOpen])

  const filtered = useMemo(() => {
    const term = q.trim()
    return commands
      .map((c) => ({ c, s: score(c, term) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
      .slice(0, 60)
  }, [commands, q])

  useEffect(() => setActive(0), [q])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(filtered.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      filtered[active]?.run()
    }
  }

  let lastGroup = ''
  return createPortal(
    <div className="palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <input ref={inputRef} className="palette-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a page, channel or project…" aria-label="Search commands" />
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette-empty">Nothing matches “{q}”.</div>
          ) : (
            filtered.map((c, i) => {
              const header = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null
              lastGroup = c.group
              return (
                <div key={c.id}>
                  {header}
                  <button type="button" data-idx={i} className={`palette-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={c.run}>
                    {c.icon}
                    <span className="truncate">{c.label}</span>
                    {c.hint && <span className="palette-item-hint">{c.hint}</span>}
                  </button>
                </div>
              )
            })
          )}
        </div>
        <div className="palette-footer">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}

const SHORTCUTS: Array<{ label: string; keys: string[] }> = [
  { label: 'Command palette', keys: ['Ctrl', 'K'] },
  { label: 'New generation', keys: ['Ctrl', 'N'] },
  { label: 'Start the generation (on New generation)', keys: ['Ctrl', '↵'] },
  { label: 'Go to page 1–10', keys: ['Ctrl', '1…0'] },
  { label: 'Settings', keys: ['Ctrl', ','] },
  { label: 'Close dialog or drawer', keys: ['Esc'] },
  { label: 'This list', keys: ['?'] }
]

export function ShortcutsDialog(): JSX.Element {
  const open = useOverlays((s) => s.shortcuts)
  const setOpen = useOverlays((s) => s.setShortcuts)
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">
      <div className="shortcut-list">
        {SHORTCUTS.map((s) => (
          <div key={s.label} style={{ display: 'contents' }}>
            <span>{s.label}</span>
            <span className="shortcut-keys">
              {s.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </Dialog>
  )
}
