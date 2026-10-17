import type { AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { appSettingsSchema, settingsPatchSchema } from '@shared/schemas'
import type { SettingsRepo } from '../db/repos/miscRepo'
import { deepMerge } from '../util/common'

const KEY = 'app_settings'

export class SettingsService {
  private current: AppSettings
  private listeners = new Set<(s: AppSettings) => void>()

  constructor(private repo: SettingsRepo) {
    const stored = repo.get<unknown>(KEY)
    const merged = deepMerge(DEFAULT_SETTINGS, stored ?? {})
    const parsed = appSettingsSchema.safeParse(merged)
    this.current = parsed.success ? (parsed.data as AppSettings) : DEFAULT_SETTINGS
    if (!parsed.success) repo.set(KEY, this.current)
  }

  get(): AppSettings {
    return this.current
  }

  update(patch: unknown): AppSettings {
    const validPatch = settingsPatchSchema.parse(patch)
    const merged = deepMerge(this.current, validPatch)
    const next = appSettingsSchema.parse(merged) as AppSettings
    this.current = next
    this.repo.set(KEY, next)
    for (const l of this.listeners) l(next)
    return next
  }

  reset(): AppSettings {
    this.current = DEFAULT_SETTINGS
    this.repo.set(KEY, DEFAULT_SETTINGS)
    for (const l of this.listeners) l(DEFAULT_SETTINGS)
    return DEFAULT_SETTINGS
  }

  onChange(fn: (s: AppSettings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}
