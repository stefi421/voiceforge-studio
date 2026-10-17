import { create } from 'zustand'
import type { AppInfo, AppSettings, Channel, JobView, QueueStats, SecretsStatus, UpdateStatus } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { api, toIpcError } from '@/lib/api'
import { toast } from './toasts'

/** Deep-merges a possibly partial settings object over the defaults so pages can always read every field. */
function mergeSettings(s: Partial<AppSettings> | null | undefined): AppSettings {
  if (!s || typeof s !== 'object') return DEFAULT_SETTINGS
  const out = { ...DEFAULT_SETTINGS } as AppSettings
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    const incoming = s[key]
    if (incoming && typeof incoming === 'object') {
      ;(out as unknown as Record<string, unknown>)[key] = { ...DEFAULT_SETTINGS[key], ...incoming }
    }
  }
  return out
}

interface AppState {
  booted: boolean
  bootError: string | null
  settings: AppSettings
  secrets: SecretsStatus
  info: AppInfo | null
  channels: Channel[]
  channelsLoaded: boolean
  stats: QueueStats
  jobs: Record<string, JobView>
  sidebarCollapsed: boolean
  /** Last known updater state; null until main reports one. */
  updateStatus: UpdateStatus | null
  /** True while the first-run wizard is forced open from Settings ("Run setup again"). */
  wizardForced: boolean

  boot: () => Promise<void>
  refreshSettings: () => Promise<void>
  refreshSecrets: () => Promise<void>
  refreshChannels: () => Promise<void>
  refreshStats: () => Promise<void>
  refreshJobs: (filter?: Record<string, unknown>) => Promise<JobView[]>
  upsertJob: (job: JobView) => void
  removeJob: (id: string) => void
  setSettings: (s: AppSettings) => void
  setSidebarCollapsed: (v: boolean) => void
  updateSettings: (patch: Record<string, Record<string, unknown>>) => Promise<AppSettings>
  setUpdateStatus: (u: UpdateStatus | null) => void
  setWizardForced: (v: boolean) => void
}

const EMPTY_STATS: QueueStats = {
  total: 0,
  pending: 0,
  processing: 0,
  awaitingUser: 0,
  completed: 0,
  failed: 0,
  paused: 0,
  cancelled: 0,
  queuePaused: false,
  spendingPaused: false,
  estimatedSecondsRemaining: null
}

const EMPTY_SECRETS: SecretsStatus = { openai: false, elevenlabs: false, backend: 'unknown', encryptionAvailable: false }

let subscribed = false

export const useApp = create<AppState>((set, get) => ({
  booted: false,
  bootError: null,
  settings: DEFAULT_SETTINGS,
  secrets: EMPTY_SECRETS,
  info: null,
  channels: [],
  channelsLoaded: false,
  stats: EMPTY_STATS,
  jobs: {},
  sidebarCollapsed: readSidebarPref(),
  updateStatus: null,
  wizardForced: false,

  boot: async () => {
    if (!subscribed && window.vf && typeof window.vf.on === 'function') {
      subscribed = true
      try {
        api.on('job:changed', (job) => {
          if (job && typeof job.id === 'string') get().upsertJob(job)
        })
        api.on('queue:stats', (stats) => set({ stats: { ...EMPTY_STATS, ...stats } }))
        api.on('settings:changed', (settings) => set({ settings: mergeSettings(settings) }))
        api.on('secrets:changed', (secrets) => set({ secrets: { ...EMPTY_SECRETS, ...secrets } }))
        api.on('update:status', (u) => {
          if (u && typeof u === 'object' && typeof u.state === 'string') set({ updateStatus: u })
        })
        api.on('notification', (n) => {
          const level = n.level === 'success' || n.level === 'warning' || n.level === 'error' ? n.level : 'info'
          toast[level](n.title, n.message)
        })
        api.on('batch:completed', (b) => {
          const level = b.failed > 0 ? 'warning' : 'success'
          toast[level](`Batch "${b.name}" finished`, `${b.completed} completed, ${b.failed} failed.`)
        })
      } catch (err) {
        toast.warning('Live updates unavailable', toIpcError(err).message)
      }
    }
    if (!window.vf || typeof window.vf.invoke !== 'function') {
      set({ booted: true, bootError: 'The preload bridge (window.vf) is not available. The app must run inside Electron.' })
      return
    }
    // Every call degrades independently so the UI still renders when one handler is missing or fails
    // (e.g. during the headless smoke test). The first failure is surfaced as a toast, not a dead screen.
    const failures: string[] = []
    const safe = async <T,>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
      try {
        const v = await p
        return v === undefined || v === null ? fallback : v
      } catch (err) {
        failures.push(`${label}: ${toIpcError(err).message}`)
        return fallback
      }
    }
    const [settings, secrets, info, channels, stats] = await Promise.all([
      safe('settings:get', api.invoke('settings:get', undefined), DEFAULT_SETTINGS),
      safe('secrets:status', api.invoke('secrets:status', undefined), EMPTY_SECRETS),
      safe('app:info', api.invoke('app:info', undefined), null),
      safe('channels:list', api.invoke('channels:list', { includeArchived: true }), []),
      safe('queue:stats', api.invoke('queue:stats', undefined), EMPTY_STATS)
    ])
    set({
      settings: mergeSettings(settings),
      secrets: { ...EMPTY_SECRETS, ...secrets },
      info,
      channels: Array.isArray(channels) ? channels : [],
      channelsLoaded: true,
      stats: { ...EMPTY_STATS, ...stats },
      booted: true,
      bootError: null
    })
    if (failures.length > 0) {
      toast.warning('Some data could not be loaded', failures.slice(0, 3).join('\n'))
    }
    void get()
      .refreshJobs()
      .catch(() => undefined)
    // Updater state is optional: older main builds (or the portable exe) may not answer.
    void api
      .invoke('updates:status', undefined)
      .then((u) => {
        if (u && typeof u === 'object' && typeof u.state === 'string') set({ updateStatus: u })
      })
      .catch(() => undefined)
  },

  refreshSettings: async () => {
    const settings = await api.invoke('settings:get', undefined)
    set({ settings: mergeSettings(settings) })
  },
  refreshSecrets: async () => {
    const secrets = await api.invoke('secrets:status', undefined)
    set({ secrets: { ...EMPTY_SECRETS, ...secrets } })
  },
  refreshChannels: async () => {
    const channels = await api.invoke('channels:list', { includeArchived: true })
    set({ channels: Array.isArray(channels) ? channels : [], channelsLoaded: true })
  },
  refreshStats: async () => {
    const stats = await api.invoke('queue:stats', undefined)
    set({ stats: { ...EMPTY_STATS, ...stats } })
  },
  refreshJobs: async (filter = {}) => {
    const list = await api.invoke('queue:list', { limit: 2000, ...filter })
    const arr = Array.isArray(list) ? list : []
    set((s) => {
      const jobs = { ...s.jobs }
      for (const j of arr) if (j && typeof j.id === 'string') jobs[j.id] = j
      return { jobs }
    })
    return arr
  },
  upsertJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  removeJob: (id) =>
    set((s) => {
      if (!(id in s.jobs)) return s
      const jobs = { ...s.jobs }
      delete jobs[id]
      return { jobs }
    }),
  setSettings: (settings) => set({ settings }),
  setSidebarCollapsed: (v) => {
    try {
      localStorage.setItem('vf.sidebarCollapsed', v ? '1' : '0')
    } catch {
      /* ignore */
    }
    set({ sidebarCollapsed: v })
  },
  updateSettings: async (patch) => {
    const settings = mergeSettings(await api.invoke('settings:update', patch))
    set({ settings })
    return settings
  },
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  setWizardForced: (wizardForced) => set({ wizardForced })
}))

function readSidebarPref(): boolean {
  try {
    return localStorage.getItem('vf.sidebarCollapsed') === '1'
  } catch {
    return false
  }
}

export function useChannel(id: string | null | undefined): Channel | undefined {
  return useApp((s) => (id ? s.channels.find((c) => c.id === id) : undefined))
}

export function activeChannels(channels: Channel[]): Channel[] {
  return channels.filter((c) => !c.archived).sort((a, b) => a.position - b.position)
}
