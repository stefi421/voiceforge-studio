import { useCallback, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'

type Section = keyof AppSettings

/**
 * Saves one field of one settings section immediately via settings:update
 * with a partial patch `{ section: { field: value } }`. Keeps a busy flag so
 * controls can show saving state.
 */
export function useSettingsPatch(): {
  settings: AppSettings
  saving: boolean
  set: <S extends Section, K extends keyof AppSettings[S]>(section: S, key: K, value: AppSettings[S][K]) => Promise<void>
  setMany: <S extends Section>(section: S, patch: Partial<AppSettings[S]>) => Promise<void>
} {
  const settings = useApp((s) => s.settings)
  const [saving, setSaving] = useState(false)

  const setMany = useCallback(async <S extends Section>(section: S, patch: Partial<AppSettings[S]>): Promise<void> => {
    setSaving(true)
    try {
      await useApp.getState().updateSettings({ [section]: patch } as Record<string, Record<string, unknown>>)
    } catch (err) {
      toast.error('Could not save settings', err)
    } finally {
      setSaving(false)
    }
  }, [])

  const set = useCallback(
    async <S extends Section, K extends keyof AppSettings[S]>(section: S, key: K, value: AppSettings[S][K]): Promise<void> => {
      await setMany(section, { [key]: value } as unknown as Partial<AppSettings[S]>)
    },
    [setMany]
  )

  return { settings, saving, set, setMany }
}
