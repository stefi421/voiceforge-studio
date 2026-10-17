import { create } from 'zustand'
import type { AppInfo, AppSettings, Channel, JobView, QueueStats, SecretsStatus } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { api } from '@/lib/api'
import { toast } from './toasts'

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

  boot: async () => {
    if (!subscribed) {
      subscribed = true
      api.on('job:changed', (job) => get().upsertJob(job))
      api.on('queue:stats', (stats) => set({ stats }))
      api.on('settings:changed', (settings) => set({ settings }))
      api.on('secrets:changed', (secrets) => set({ secrets }))
      api.on('notification', (n) => {
        toast[n.level](n.title, n.message)
      })
      api.on('batch:completed', (b) => {
        const level = b.failed > 0 ? 'warning' : 'success'
        toast[level](`Batch "${b.name}" finished`, `${b.completed} completed, ${b.failed} failed.`)
      })
    }
    try {
      const [settings, secrets, info, channels, stats] = await Promise.all([
        api.invoke('settings:get', undefined),
        api.invoke('secrets:status', undefined),
        api.invoke('app:info', undefined).catch(() => null),
        api.invoke('channels:list', { includeArchived: true }),
        api.invoke('queue:stats', undefined).catch(() => EMPTY_STATS)
      ])
      set({ settings, secrets, info, channels, channelsLoaded: true, stats, booted: true, bootError: null })
      void get().refreshJobs()
    } catch (err) {
      const e = err as { message?: string }
      set({ booted: true, bootError: e?.message ?? 'Failed to connect to the main process.' })
    }
  },

  refreshSettings: async () => {
    const settings = await api.invoke('settings:get', undefined)
    set({ settings })
  },
  refreshSecrets: async () => {
    const secrets = await api.invoke('secrets:status', undefined)
    set({ secrets })
  },
  refreshChannels: async () => {
    const channels = await api.invoke('channels:list', { includeArchived: true })
    set({ channels, channelsLoaded: true })
  },
  refreshStats: async () => {
    const stats = await api.invoke('queue:stats', undefined)
    set({ stats })
  },
  refreshJobs: async (filter = {}) => {
    const list = await api.invoke('queue:list', { limit: 2000, ...filter })
    set((s) => {
      const jobs = { ...s.jobs }
      for (const j of list) jobs[j.id] = j
      return { jobs }
    })
    return list
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
    const settings = await api.invoke('settings:update', patch)
    set({ settings })
    return settings
  }
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
