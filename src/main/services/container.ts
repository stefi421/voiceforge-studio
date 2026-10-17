import type { AppNotification, JobView, MainEvents, QueueStats } from '@shared/types'
import type { Database } from '../db/database'
import { ChannelRepo } from '../db/repos/channelRepo'
import { AudioRepo, ProjectRepo, ResearchRepo, ScriptRepo } from '../db/repos/contentRepo'
import { JobRepo } from '../db/repos/jobRepo'
import { BackupRepo, ProviderCacheRepo, SettingsRepo, UsageRepo } from '../db/repos/miscRepo'
import type { ElevenLabsProvider, OpenAIProvider } from '../providers/types'
import { Logger } from './logger'
import type { SecretStore } from './secrets'
import { SettingsService } from './settings'
import { newId, nowIso } from '../util/common'

/** Typed in-process event bus; main forwards selected events to the renderer. */
export class EventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>()

  on<E extends keyof MainEvents>(event: E, fn: (payload: MainEvents[E]) => void): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(fn as (payload: unknown) => void)
    return () => set!.delete(fn as (payload: unknown) => void)
  }

  emit<E extends keyof MainEvents>(event: E, payload: MainEvents[E]): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const fn of set) {
      try {
        fn(payload)
      } catch {
        /* listeners must not break the bus */
      }
    }
  }

  notify(level: AppNotification['level'], title: string, message: string): void {
    this.emit('notification', { id: newId(), level, title, message, at: nowIso() })
  }

  jobChanged(job: JobView): void {
    this.emit('job:changed', job)
  }

  stats(stats: QueueStats): void {
    this.emit('queue:stats', stats)
  }
}

export interface ProviderFactory {
  openai(): OpenAIProvider
  eleven(): ElevenLabsProvider
  /** Drop cached clients (after an API key changes). */
  reset(): void
}

export interface AppPaths {
  userData: string
  logs: string
  /** The effective root output directory (settings override or default). */
  outputRoot(): string
  defaultOutputRoot: string
}

export interface Services {
  db: Database
  channels: ChannelRepo
  jobs: JobRepo
  projects: ProjectRepo
  research: ResearchRepo
  scripts: ScriptRepo
  audio: AudioRepo
  usage: UsageRepo
  cache: ProviderCacheRepo
  backups: BackupRepo
  settingsRepo: SettingsRepo
  settings: SettingsService
  secrets: SecretStore
  providers: ProviderFactory
  events: EventBus
  logger: Logger
  paths: AppPaths
  appVersion: string
}

export function buildRepos(db: Database): Pick<Services, 'channels' | 'jobs' | 'projects' | 'research' | 'scripts' | 'audio' | 'usage' | 'cache' | 'backups' | 'settingsRepo' | 'settings'> {
  const settingsRepo = new SettingsRepo(db)
  return {
    channels: new ChannelRepo(db),
    jobs: new JobRepo(db),
    projects: new ProjectRepo(db),
    research: new ResearchRepo(db),
    scripts: new ScriptRepo(db),
    audio: new AudioRepo(db),
    usage: new UsageRepo(db),
    cache: new ProviderCacheRepo(db),
    backups: new BackupRepo(db),
    settingsRepo,
    settings: new SettingsService(settingsRepo)
  }
}
