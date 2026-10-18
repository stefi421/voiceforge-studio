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
    if (parsed.success) {
      this.current = parsed.data as AppSettings
    } else {
      // One value an older (or newer) version stored outside today's rules must not wipe every other
      // setting (output folder, limits, update source, onboarding): only the invalid values fall back.
      this.current = repairSettings(merged)
      repo.set(KEY, this.current)
    }
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

/** Replaces each invalid value with its default (field by field); falls back to the defaults only if that fails. */
export function repairSettings(candidate: unknown): AppSettings {
  const value: unknown = structuredClone(candidate)
  for (let round = 0; round < 50; round++) {
    const parsed = appSettingsSchema.safeParse(value)
    if (parsed.success) return parsed.data as AppSettings
    let fixed = false
    for (const issue of parsed.error.issues) {
      fixed = resetPath(value, DEFAULT_SETTINGS, issue.path as Array<string | number>) || fixed
    }
    if (!fixed) break
  }
  return DEFAULT_SETTINGS
}

function resetPath(target: unknown, defaults: unknown, p: Array<string | number>): boolean {
  if (!p.length) return false
  // Reset the deepest container that exists in the defaults (a whole record entry when needed).
  for (let depth = p.length; depth >= 1; depth--) {
    const parentPath = p.slice(0, depth - 1)
    const key = p[depth - 1]!
    const parent = walk(target, parentPath)
    const defParent = walk(defaults, parentPath)
    if (!parent || typeof parent !== 'object') continue
    const rec = parent as Record<string | number, unknown>
    if (defParent && typeof defParent === 'object' && key in (defParent as object)) {
      rec[key] = structuredClone((defParent as Record<string | number, unknown>)[key])
      return true
    }
    if (key in rec) {
      delete rec[key]
      return true
    }
  }
  return false
}

function walk(obj: unknown, p: Array<string | number>): unknown {
  let cur = obj
  for (const k of p) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[k]
  }
  return cur
}
