import { useEffect } from 'react'
import { DASHBOARD_PAGES } from '@shared/ipc'
import { useRouter } from '@/store/router'

/**
 * Global keyboard shortcuts:
 *  Ctrl+1..9, Ctrl+0  → switch pages (in DASHBOARD_PAGES order)
 *  Ctrl+N             → New Generation
 *  Ctrl+,             → Settings
 * Dialogs handle Escape themselves.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.altKey) return
      const target = e.target as HTMLElement | null
      const inEditable = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))

      if (e.key === ',' ) {
        e.preventDefault()
        useRouter.getState().navigate('settings')
        return
      }
      if ((e.key === 'n' || e.key === 'N') && !e.shiftKey) {
        if (inEditable) return
        e.preventDefault()
        useRouter.getState().navigate('generate')
        return
      }
      if (/^[0-9]$/.test(e.key) && !e.shiftKey) {
        if (inEditable) return
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
