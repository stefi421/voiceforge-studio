import fs from 'node:fs'
import type { Channel, GameMatch, GameRecord, GameSubject, GameView, ResearchData, ResearchSource } from '@shared/types'
import type { Services } from './container'
import type { ScopedLogger } from './logger'
import { GAME_KEY_VERSION, gameKey, matchTitle, type MatchResult } from '../pipeline/gameMatch'
import { openaiCost } from '../pipeline/cost'
import { AppError } from '../util/errors'
import { looksLikeUrl, parseStoreLink, storeLinkTitle } from '@shared/storeLinks'
import { normalizeTitle, nowIso } from '../util/common'

const IMPORTED_KEY = 'game_library_imported_v1'
const KEY_VERSION_KEY = 'game_library_key_version'
const STORE_LINK_REPAIR_KEY = 'store_link_titles_repaired_v1'
/** Used when the original research cost is unknown (imported entries): a typical web-search research call. */
export const TYPICAL_RESEARCH_TOKENS = 9000

export function subjectFor(category: Channel['category']): GameSubject {
  return category === 'tech' ? 'product' : 'game'
}

const MAX_LIST = 14
const MAX_TEXT = 700

function clip(s: unknown): string {
  const t = typeof s === 'string' ? s.trim() : ''
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT).trim()}…` : t
}

function clipList(v: unknown, removed: Set<string>): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    const t = clip(item)
    const k = t.toLowerCase()
    if (!t || seen.has(k) || removed.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= MAX_LIST) break
  }
  return out
}

/**
 * Keeps only what the writer needs (1.6.0, fewer tokens): no ambiguity candidates, no
 * insufficiency notes, no duplicates, bounded list and text sizes. Facts the user marked wrong
 * are removed everywhere; facts the user added are confirmed facts.
 */
export function compactResearch(data: ResearchData, opts: { removedFacts?: string[]; userFacts?: string[] } = {}): ResearchData {
  const removed = new Set((opts.removedFacts ?? []).map((f) => f.trim().toLowerCase()))
  const notRemoved = (s: string): string => (removed.has(s.trim().toLowerCase()) ? '' : s)
  const confirmed = clipList([...(data.confirmedFacts ?? []), ...(opts.userFacts ?? [])], removed)
  return {
    subjectType: data.subjectType === 'product' ? 'product' : 'game',
    canonicalTitle: clip(data.canonicalTitle),
    developer: clip(data.developer),
    publisher: clip(data.publisher),
    genre: clip(data.genre),
    releaseStatus: data.releaseStatus ?? 'unknown',
    releaseDate: clip(data.releaseDate),
    platforms: clipList(data.platforms, removed),
    summary: notRemoved(clip(data.summary)),
    gameplayMechanics: clipList(data.gameplayMechanics, removed),
    combatSystems: notRemoved(clip(data.combatSystems)),
    explorationSystems: notRemoved(clip(data.explorationSystems)),
    multiplayer: notRemoved(clip(data.multiplayer)),
    keyMechanics: clipList(data.keyMechanics, removed),
    technicalInfo: clipList(data.technicalInfo, removed),
    specifications: clipList(data.specifications, removed),
    confirmedFacts: confirmed,
    uncertainFacts: clipList(data.uncertainFacts, removed),
    confidence: typeof data.confidence === 'number' ? data.confidence : 1,
    ambiguityCandidates: [],
    insufficientReason: ''
  }
}

/** Every fact-like line of an entry, for the "mark wrong" UI. */
export function factLines(data: ResearchData): string[] {
  const lines = [
    ...(data.confirmedFacts ?? []),
    ...(data.gameplayMechanics ?? []),
    ...(data.keyMechanics ?? []),
    ...(data.technicalInfo ?? []),
    ...(data.specifications ?? []),
    ...(data.uncertainFacts ?? []),
    data.combatSystems,
    data.explorationSystems,
    data.multiplayer,
    data.summary
  ]
  return [...new Set(lines.map((l) => (typeof l === 'string' ? l.trim() : '')).filter(Boolean))]
}

export class GameLibrary {
  constructor(
    private s: Services,
    private log: ScopedLogger
  ) {}

  /** Classifies a typed title against the saved entries for the channel's subject (game / product). */
  match(title: string, category: Channel['category'], steamAppId?: string | null): MatchResult {
    return this.matchWith(title, this.s.games.allKeys(subjectFor(category)), steamAppId)
  }

  matchMany(titles: string[], category: Channel['category']): GameMatch[] {
    const entries = this.s.games.allKeys(subjectFor(category))
    return titles.map((title) => {
      const m = this.matchWith(title, entries)
      return { title, kind: m.kind, gameId: m.gameId, canonicalTitle: m.canonicalTitle, candidates: m.candidates }
    })
  }

  /**
   * 1.6.1: a pasted Steam link (or a known app id) matches by app id first — exactly — then by the
   * title in the link. A name match that is a different Steam app is not a match.
   */
  private matchWith(title: string, entries: ReturnType<Services['games']['allKeys']>, steamAppId?: string | null): MatchResult {
    const link = parseStoreLink(title)
    const appId = steamAppId ?? link?.appId ?? null
    if (appId) {
      const g = this.s.games.byAppId(appId)
      if (g) return { kind: 'exact', gameId: g.id, canonicalTitle: g.canonicalTitle, candidates: [] }
    }
    const name = link ? link.slugTitle : title
    if (!name.trim()) return { kind: 'none', gameId: null, canonicalTitle: null, candidates: [] }
    const m = matchTitle(name, entries)
    if (appId && m.gameId && (m.kind === 'exact' || m.kind === 'auto')) {
      const other = this.s.games.get(m.gameId)?.steamAppId
      if (other && other !== appId) return { kind: 'none', gameId: null, canonicalTitle: null, candidates: [] }
    }
    return m
  }

  /** Research data to send to the writer for an entry (compact; user corrections applied). */
  researchData(game: GameRecord): ResearchData {
    // The owner's notes travel with the facts (inside <research_data>, so they are treated as data).
    const notes = game.userNotes.trim() ? [`Note from the channel owner: ${game.userNotes.trim().replace(/\s+/g, ' ').slice(0, 600)}`] : []
    return compactResearch({ ...game.data, canonicalTitle: game.canonicalTitle }, { removedFacts: game.removedFacts, userFacts: [...game.userFacts, ...notes] })
  }

  /** True when the saved research is past the refresh window (never for pinned entries; 0 = never). */
  isStale(game: GameRecord): boolean {
    const days = this.s.settings.get().research?.refreshAfterDays ?? 0
    if (!days || game.pinned) return false
    return Date.now() - new Date(game.researchedAt).getTime() > days * 86_400_000
  }

  mayBeOutdated(game: GameRecord): boolean {
    if (this.isStale(game)) return true
    if (game.releaseStatus !== 'unreleased' && game.releaseStatus !== 'early_access') return false
    const t = Date.parse(game.releaseDate)
    return Number.isFinite(t) && t < Date.now() && t > Date.parse(game.researchedAt)
  }

  view(game: GameRecord): GameView {
    const u = this.s.games.usage(game.id)
    return { ...game, channels: u.channels, scriptCount: u.scriptCount, mayBeOutdated: this.mayBeOutdated(game) }
  }

  require(id: string): GameRecord {
    const g = this.s.games.get(id)
    if (!g) throw new AppError('config', 'That saved game no longer exists.', { retryable: false, code: 'GAME_NOT_FOUND' })
    return g
  }

  /**
   * Stores confirmed research. When the typed title or the official title is already known, the
   * existing entry is updated (newer research wins; notes, user facts, aliases and pin are kept).
   */
  record(input: { typedTitle: string; aliases?: string[]; steamAppId?: string | null; subject: GameSubject; data: ResearchData; sources: ResearchSource[]; model: string | null; tokens: number }): GameRecord {
    const canonical = input.data.canonicalTitle?.trim() || input.typedTitle.trim()
    const data = compactResearch({ ...input.data, canonicalTitle: canonical })
    // 1.6.1: a Steam app id beats a name; a name match that is a different Steam app is not the same game.
    const byApp = input.steamAppId ? this.s.games.byAppId(input.steamAppId) : undefined
    const byName = byApp ? undefined : (this.s.games.byKey(input.subject, gameKey(canonical)) ?? this.s.games.byKey(input.subject, gameKey(input.typedTitle)))
    const existing = byApp ?? (byName && input.steamAppId && byName.steamAppId && byName.steamAppId !== input.steamAppId ? undefined : byName)
    const game = existing
      ? this.s.games.replaceResearch(existing.id, { canonicalTitle: canonical, data, sources: input.sources, researchModel: input.model, researchTokens: input.tokens || existing.researchTokens })
      : this.createUnique({ subjectType: input.subject, canonicalTitle: canonical, data, sources: input.sources, researchModel: input.model, researchTokens: input.tokens })
    if (input.steamAppId && game.steamAppId !== input.steamAppId && !this.s.games.setSteamAppId(game.id, input.steamAppId)) {
      this.log.info('Steam app id already belongs to another saved game; not stored', { appId: input.steamAppId, gameId: game.id })
    }
    for (const a of [input.typedTitle, ...(input.aliases ?? [])]) {
      if (a?.trim() && !this.s.games.addAlias(game.id, a)) this.log.info('Alias already belongs to another saved game; not learned', { alias: a, gameId: game.id })
    }
    return this.s.games.get(game.id)!
  }

  /** Creates an entry; a canonical-title clash with a different game gets a disambiguated key. */
  private createUnique(input: Parameters<Services['games']['create']>[0]): GameRecord {
    if (!this.s.games.byKey(input.subjectType, gameKey(input.canonicalTitle))) return this.s.games.create(input)
    const dev = input.data.developer?.trim()
    const year = (input.data.releaseDate ?? '').slice(0, 4)
    const suffix = [dev, /^\d{4}$/.test(year) ? year : ''].filter(Boolean).join(', ') || 'another game'
    return this.s.games.create({ ...input, canonicalTitle: `${input.canonicalTitle} (${suffix})` })
  }

  /** Estimated cost of the research call an entry saves on reuse. */
  savedResearchUsd(game: GameRecord): number {
    const tokens = game.researchTokens || TYPICAL_RESEARCH_TOKENS
    const settings = this.s.settings.get()
    return openaiCost(settings.spending.pricing, game.researchModel || settings.openai.researchModel, Math.round(tokens * 0.8), Math.round(tokens * 0.2))
  }

  /** Recomputes stored title keys once after the normalisation changed (idempotent). */
  rekeyIfNeeded(): number {
    if ((this.s.settingsRepo.get<number>(KEY_VERSION_KEY) ?? 1) >= GAME_KEY_VERSION) return 0
    const changed = this.s.games.rekeyAll()
    this.s.settingsRepo.set(KEY_VERSION_KEY, GAME_KEY_VERSION)
    if (changed) this.log.info('Updated saved game title keys', { changed })
    return changed
  }

  /**
   * 1.6.1, one-time repair: titles pasted as Steam links in 1.6.0 became library entries and
   * projects named after the URL. Entries get their Steam app id and the official title from
   * their stored research (the URL and the link's title stay as aliases); projects get the
   * official title in the database. Files and folders are not moved. Idempotent.
   */
  repairStoreLinkTitles(): { games: number; projects: number } {
    if (this.s.settingsRepo.get<boolean>(STORE_LINK_REPAIR_KEY)) return { games: 0, projects: 0 }
    let games = 0
    let projects = 0
    this.s.db.transaction(() => {
      for (const g of this.s.games.list({ subject: 'all' })) {
        const links = [g.canonicalTitle, ...g.aliases].map((t) => parseStoreLink(t)).filter((l): l is NonNullable<typeof l> => !!l)
        const urlTitled = looksLikeUrl(g.canonicalTitle)
        if (!links.length && !urlTitled) continue
        let changed = false
        const link = links[0]
        if (link && !g.steamAppId && this.s.games.setSteamAppId(g.id, link.appId)) changed = true
        if (urlTitled) {
          const official = this.officialTitleFor(g) || (link ? storeLinkTitle(link) : '')
          if (official && !looksLikeUrl(official)) {
            this.s.games.update(g.id, { canonicalTitle: official }) // the URL becomes an alias
            changed = true
          }
        }
        if (link?.slugTitle) this.s.games.addAlias(g.id, link.slugTitle)
        for (const l of links) this.s.games.addAlias(g.id, l.url)
        if (changed) games++
      }
      const rows = this.s.db.all<{ id: string; channel_id: string; title: string; canonical_title: string | null }>('SELECT id, channel_id, title, canonical_title FROM projects')
      for (const p of rows) {
        if (!looksLikeUrl(p.title)) continue
        const link = parseStoreLink(p.title)
        const gameId = this.s.db.get<{ game_id: string | null }>("SELECT game_id FROM research_results WHERE project_id = ? AND game_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", p.id)?.game_id
        const game = (gameId ? this.s.games.get(gameId) : undefined) ?? (link ? this.s.games.byAppId(link.appId) : undefined)
        const official = [game?.canonicalTitle, p.canonical_title, link ? storeLinkTitle(link) : ''].find((t) => !!t && !looksLikeUrl(t))
        if (!official) continue
        const norm = normalizeTitle(official)
        const clash = this.s.projects.findByTitle(p.channel_id, norm)
        if (clash && clash.id !== p.id) continue
        this.s.projects.update(p.id, { title: official, titleNormalized: norm, canonicalTitle: official })
        this.s.db.run('UPDATE jobs SET title = ? WHERE project_id = ? AND title = ?', official, p.id, p.title)
        projects++
      }
      this.s.settingsRepo.set(STORE_LINK_REPAIR_KEY, true)
    })
    if (games || projects) this.log.info('Repaired titles pasted as store links', { games, projects })
    return { games, projects }
  }

  /** The official title from an entry's research (its own data, then linked research rows). */
  private officialTitleFor(g: GameRecord): string {
    const own = g.data?.canonicalTitle?.trim()
    if (own && !looksLikeUrl(own)) return own
    const rows = this.s.db.all<{ data_json: string }>("SELECT data_json FROM research_results WHERE game_id = ? AND status = 'confirmed' ORDER BY created_at DESC LIMIT 5", g.id)
    for (const r of rows) {
      try {
        const t = (JSON.parse(r.data_json) as ResearchData).canonicalTitle?.trim()
        if (t && !looksLikeUrl(t)) return t
      } catch {
        /* skip */
      }
    }
    return ''
  }

  /** One-time import of research saved by 1.5 and earlier (confirmed rows, newest wins). */
  importLegacyResearch(): number {
    if (this.s.settingsRepo.get<boolean>(IMPORTED_KEY)) return 0
    let imported = 0
    const rows = this.s.research.unlinkedConfirmed()
    this.s.db.transaction(() => {
      for (const r of rows) {
        if (r.mode === 'manual' || r.model === 'library') continue
        const project = this.s.projects.get(r.projectId)
        const channel = project ? this.s.channels.get(project.channelId) : undefined
        const subject: GameSubject = channel ? subjectFor(channel.category) : r.data?.subjectType === 'product' ? 'product' : 'game'
        const typed = project?.title || r.data?.canonicalTitle || ''
        if (!typed.trim() || !r.data) continue
        try {
          const game = this.record({ typedTitle: typed, subject, data: r.data, sources: r.sources, model: r.model, tokens: 0 })
          this.s.research.setGame(r.id, game.id)
          imported++
        } catch (err) {
          this.log.warn('Could not import a saved research result into the Game Library', { researchId: r.id, error: (err as Error).message })
        }
      }
      this.s.settingsRepo.set(IMPORTED_KEY, true)
    })
    if (imported) this.log.info('Imported earlier research into the Game Library', { rows: imported, games: this.s.games.count() })
    return imported
  }

  addFact(id: string, text: string): GameRecord {
    const g = this.require(id)
    const t = text.trim()
    if (!t) throw new AppError('config', 'Type the fact first.', { retryable: false })
    if (t.length > 600) throw new AppError('config', 'Keep a fact under 600 characters.', { retryable: false })
    const removedFacts = g.removedFacts.filter((f) => f.toLowerCase() !== t.toLowerCase())
    const userFacts = g.userFacts.some((f) => f.toLowerCase() === t.toLowerCase()) ? g.userFacts : [...g.userFacts, t]
    return this.s.games.update(id, { userFacts, removedFacts })
  }

  removeFact(id: string, text: string): GameRecord {
    const g = this.require(id)
    const t = text.trim().toLowerCase()
    if (g.userFacts.some((f) => f.toLowerCase() === t)) return this.s.games.update(id, { userFacts: g.userFacts.filter((f) => f.toLowerCase() !== t) })
    if (g.removedFacts.some((f) => f.toLowerCase() === t)) return g
    return this.s.games.update(id, { removedFacts: [...g.removedFacts, text.trim()] })
  }

  restoreFact(id: string, text: string): GameRecord {
    const g = this.require(id)
    const t = text.trim().toLowerCase()
    return this.s.games.update(id, { removedFacts: g.removedFacts.filter((f) => f.toLowerCase() !== t) })
  }

  addAlias(id: string, alias: string): GameRecord {
    this.require(id)
    if (!gameKey(alias)) throw new AppError('config', 'Type the other title first.', { retryable: false })
    if (!this.s.games.addAlias(id, alias)) {
      throw new AppError('config', `"${alias.trim()}" already belongs to another saved game.`, { action: 'Remove it from that game first, or delete the duplicate entry.', retryable: false, code: 'ALIAS_TAKEN' })
    }
    return this.s.games.get(id)!
  }

  /** Re-researches an entry (uses OpenAI credits); keeps notes, user facts, removed facts, aliases and pin. */
  async refresh(id: string, signal?: AbortSignal): Promise<GameRecord> {
    const g = this.require(id)
    const settings = this.s.settings.get()
    const channel = this.s.channels.list(false).find((c) => subjectFor(c.category) === g.subjectType)
    const res = await this.s.providers.openai().research({
      title: g.canonicalTitle,
      category: g.subjectType === 'product' ? 'tech' : 'gaming',
      settings: channel?.research ?? { enabled: true, mode: 'openai_web_search', minConfidence: 0.6, searchContextSize: 'low', askOnAmbiguity: true, extraInstructions: '' },
      model: settings.openai.researchModel || settings.openai.defaultModel,
      manualNotes: g.userNotes || null,
      signal
    })
    const tokens = res.usage.inputTokens + res.usage.outputTokens
    this.s.usage.record({
      provider: 'openai',
      kind: 'research',
      model: res.model,
      jobId: null,
      channelId: null,
      projectId: null,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      characters: 0,
      estimatedCost: openaiCost(settings.spending.pricing, res.model, res.usage.inputTokens, res.usage.outputTokens),
      reported: null
    })
    if (res.data.insufficientReason?.trim()) {
      throw new AppError('insufficient_info', `The new research was not reliable enough: ${res.data.insufficientReason}`, { action: 'The saved research was kept unchanged.', retryable: true })
    }
    const data = compactResearch({ ...res.data, canonicalTitle: res.data.canonicalTitle?.trim() || g.canonicalTitle })
    return this.s.games.replaceResearch(id, { canonicalTitle: data.canonicalTitle, data, sources: res.sources, researchModel: res.model, researchTokens: tokens })
  }

  exportJson(): { version: 1; exportedAt: string; games: GameRecord[] } {
    return { version: 1, exportedAt: nowIso(), games: this.s.games.list({ subject: 'all' }) }
  }

  exportToFile(filePath: string): number {
    const data = this.exportJson()
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
    return data.games.length
  }

  /** Merges an export: unknown entries are added, known ones get missing aliases/facts (research is never overwritten). */
  importJson(raw: unknown): { added: number; merged: number } {
    const games = (raw && typeof raw === 'object' && Array.isArray((raw as { games?: unknown }).games) ? (raw as { games: unknown[] }).games : []) as Array<Partial<GameRecord>>
    if (!games.length) throw new AppError('config', 'The file contains no saved games.', { retryable: false, code: 'GAMES_IMPORT_EMPTY' })
    let added = 0
    let merged = 0
    this.s.db.transaction(() => {
      for (const g of games) {
        if (!g || typeof g.canonicalTitle !== 'string' || !g.canonicalTitle.trim() || !g.data || typeof g.data !== 'object') continue
        const subject: GameSubject = g.subjectType === 'product' ? 'product' : 'game'
        const existing = this.s.games.byKey(subject, gameKey(g.canonicalTitle))
        const target = existing
          ? existing
          : this.s.games.create({
              subjectType: subject,
              canonicalTitle: g.canonicalTitle.trim(),
              data: compactResearch(g.data as ResearchData),
              sources: Array.isArray(g.sources) ? (g.sources as ResearchSource[]).filter((x) => x && typeof x.url === 'string').slice(0, 30) : [],
              researchModel: typeof g.researchModel === 'string' ? g.researchModel : null,
              researchTokens: typeof g.researchTokens === 'number' ? g.researchTokens : 0,
              researchedAt: typeof g.researchedAt === 'string' ? g.researchedAt : undefined
            })
        if (existing) merged++
        else added++
        for (const a of Array.isArray(g.aliases) ? g.aliases : []) if (typeof a === 'string') this.s.games.addAlias(target.id, a)
        const cur = this.s.games.get(target.id)!
        const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [])
        const userFacts = [...new Set([...cur.userFacts, ...strings(g.userFacts)])]
        const removedFacts = [...new Set([...cur.removedFacts, ...strings(g.removedFacts)])]
        const userNotes = cur.userNotes || (typeof g.userNotes === 'string' ? g.userNotes : '')
        this.s.games.update(target.id, { userFacts, removedFacts, userNotes, pinned: cur.pinned || g.pinned === true })
      }
    })
    return { added, merged }
  }
}
