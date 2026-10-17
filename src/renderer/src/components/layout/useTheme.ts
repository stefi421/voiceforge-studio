import { useEffect } from 'react'
import type { Theme } from '@shared/types'
import { useApp } from '@/store/app'

function apply(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.setAttribute('data-theme', dark ? 'dark' : 'light')
  } else {
    root.setAttribute('data-theme', theme)
  }
}

/** Applies settings.general.theme to <html data-theme> and follows the OS when set to "system". */
export function useTheme(): void {
  const theme = useApp((s) => s.settings.general.theme)
  useEffect(() => {
    apply(theme)
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => apply('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])
}
