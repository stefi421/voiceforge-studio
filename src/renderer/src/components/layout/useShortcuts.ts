import { useEffect } from 'react'
import { DASHBOARD_PAGES } from '@shared/ipc'
import { useRouter } from '@/store/router'
import { useOverlays } from './CommandPalette'

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function modalOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
}

/**
 * Global keyboard shortcuts:
 *  Ctrl+K             → command palette (works everywhere)
 *  ?                  → shortcut help (not while typing)
 *  Ctrl+1..9, Ctrl+0  → switch pages (in DASHBOARD_PAGES order)
 *  Ctrl+N             → New generation
 *  Ctrl+,             → Settings
 * Dialogs handle Escape themselves; page shortcuts are ignored while a dialog is open
 * or while typing in a field.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const editing = isEditable(e.target)

      if (mod && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        const o = useOverlays.getState()
        o.setPalette(!o.palette)
        return
      }
      if (!mod && !e.altKey && e.key === '?' && !editing && !modalOpen()) {
        e.preventDefault()
        useOverlays.getState().setShortcuts(true)
        return
      }
      if (!mod || e.altKey) return
      if (editing || modalOpen()) return

      if (e.key === ',') {
        e.preventDefault()
        useRouter.getState().navigate('settings')
        return
      }
      if ((e.key === 'n' || e.key === 'N') && !e.shiftKey) {
        e.preventDefault()
        useRouter.getState().navigate('generate')
        return
      }
      if (/^[0-9]$/.test(e.key) && !e.shiftKey) {
        const idx = e.key === '0' ? 9 : parseInt(e.key, 10) - 1
        const page = DASHBOARD_PAGES[idx]
        if (page) {
          e.preventDefault()
          useRouter.getState().navigate(page)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
