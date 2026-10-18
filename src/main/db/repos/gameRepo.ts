import type { Database } from '../database'
import type { GameRecord, GameSubject, ReleaseStatus, ResearchData, ResearchSource } from '@shared/types'
import { newId, nowIso, parseJson } from '../../util/common'
import { gameKey } from '../../pipeline/gameMatch'

interface GameRow {
  id: string
  subject_type: string
  canonical_title: string
  canonical_key: string
  developer: string
  publisher: string
  genre: string
  release_status: string
  release_date: string
  platforms_json: string
  data_json: string
  sources_json: string
  user_facts_json: string
  removed_facts_json: string
  user_notes: string
  pinned: number
  researched_at: string
  research_model: string | null
  research_tokens: number
  last_used_at: string | null
  use_count: number
  created_at: string
  updated_at: string
}

export interface GameInput {
  subjectType: GameSubject
  canonicalTitle: string
  data: ResearchData
  sources: ResearchSource[]
  researchModel: string | null
  researchTokens: number
  researchedAt?: string
}

export class GameRepo {
  constructor(private db: Database) {}

  private toRecord(r: GameRow): GameRecord {
    const aliases = this.db.all<{ alias: string }>('SELECT alias FROM game_aliases WHERE game_id = ? ORDER BY created_at ASC', r.id).map((a) => a.alias)
    return {
      id: r.id,
      subjectType: (r.subject_type === 'product' ? 'product' : 'game') as GameSubject,
      canonicalTitle: r.canonical_title,
      aliases,
      developer: r.developer,
      publisher: r.publisher,
      genre: r.genre,
      releaseStatus: r.release_status as ReleaseStatus,
      releaseDate: r.release_date,
      platforms: parseJson<string[]>(r.platforms_json, []),
      data: parseJson<ResearchData>(r.data_json, {} as ResearchData),
      sources: parseJson<ResearchSource[]>(r.sources_json, []),
      userFacts: parseJson<string[]>(r.user_facts_json, []),
      removedFacts: parseJson<string[]>(r.removed_facts_json, []),
      userNotes: r.user_notes,
      pinned: r.pinned === 1,
      researchedAt: r.researched_at,
      researchModel: r.research_model,
      researchTokens: r.research_tokens,
      lastUsedAt: r.last_used_at,
      useCount: r.use_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }

  get(id: string): GameRecord | undefined {
    const r = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', id)
    return r ? this.toRecord(r) : undefined
  }

  byKey(subject: GameSubject, key: string): GameRecord | undefined {
    const r = this.db.get<GameRow>('SELECT * FROM games WHERE subject_type = ? AND canonical_key = ?', subject, key)
    if (r) return this.toRecord(r)
    const a = this.db.get<{ game_id: string }>('SELECT game_id FROM game_aliases WHERE subject_type = ? AND alias_key = ?', subject, key)
    return a ? this.get(a.game_id) : undefined
  }

  list(opts: { subject?: GameSubject | 'all'; query?: string; limit?: number } = {}): GameRecord[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (opts.subject && opts.subject !== 'all') {
      where.push('g.subject_type = ?')
      params.push(opts.subject)
    }
    if (opts.query?.trim()) {
      const q = `%${opts.query.trim()}%`
      where.push('(g.canonical_title LIKE ? OR g.genre LIKE ? OR g.developer LIKE ? OR EXISTS (SELECT 1 FROM game_aliases a WHERE a.game_id = g.id AND a.alias LIKE ?))')
      params.push(q, q, q, q)
    }
    params.push(opts.limit ?? 5000)
    return this.db
      .all<GameRow>(`SELECT g.* FROM games g ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(g.last_used_at, g.researched_at) DESC LIMIT ?`, ...params)
      .map((r) => this.toRecord(r))
  }

  /** Every entry's lookup keys, for matching (cheap: no JSON parsing). */
  allKeys(subject: GameSubject): Array<{ gameId: string; canonicalTitle: string; keys: string[] }> {
    const games = this.db.all<{ id: string; canonical_title: string; canonical_key: string }>('SELECT id, canonical_title, canonical_key FROM games WHERE subject_type = ?', subject)
    const aliases = this.db.all<{ game_id: string; alias_key: string }>('SELECT game_id, alias_key FROM game_aliases WHERE subject_type = ?', subject)
    const byGame = new Map<string, string[]>()
    for (const a of aliases) {
      const list = byGame.get(a.game_id) ?? []
      list.push(a.alias_key)
      byGame.set(a.game_id, list)
    }
    return games.map((g) => ({ gameId: g.id, canonicalTitle: g.canonical_title, keys: [g.canonical_key, ...(byGame.get(g.id) ?? [])] }))
  }

  count(): number {
    return this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM games')?.c ?? 0
  }

  create(input: GameInput, id = newId()): GameRecord {
    const now = nowIso()
    const d = input.data
    this.db.run(
      `INSERT INTO games (id, subject_type, canonical_title, canonical_key, developer, publisher, genre, release_status, release_date, platforms_json,
        data_json, sources_json, researched_at, research_model, research_tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.subjectType,
      input.canonicalTitle,
      gameKey(input.canonicalTitle),
      d.developer ?? '',
      d.publisher ?? '',
      d.genre ?? '',
      d.releaseStatus ?? 'unknown',
      d.releaseDate ?? '',
      JSON.stringify(d.platforms ?? []),
      JSON.stringify(d),
      JSON.stringify(input.sources),
      input.researchedAt ?? now,
      input.researchModel,
      input.researchTokens,
      now,
      now
    )
    return this.get(id)!
  }

  /** Replaces the researched data (refresh / newer research); user notes, facts, aliases and pin are kept. */
  replaceResearch(id: string, input: Omit<GameInput, 'subjectType' | 'canonicalTitle'> & { canonicalTitle?: string }): GameRecord {
    const cur = this.get(id)
    if (!cur) throw new Error(`Game not found: ${id}`)
    const d = input.data
    const title = input.canonicalTitle?.trim() || cur.canonicalTitle
    this.db.run(
      `UPDATE games SET canonical_title = ?, canonical_key = ?, developer = ?, publisher = ?, genre = ?, release_status = ?, release_date = ?, platforms_json = ?,
         data_json = ?, sources_json = ?, researched_at = ?, research_model = ?, research_tokens = ?, updated_at = ? WHERE id = ?`,
      title,
      this.freeCanonicalKey(cur, title),
      d.developer ?? '',
      d.publisher ?? '',
      d.genre ?? '',
      d.releaseStatus ?? 'unknown',
      d.releaseDate ?? '',
      JSON.stringify(d.platforms ?? []),
      JSON.stringify(d),
      JSON.stringify(input.sources),
      input.researchedAt ?? nowIso(),
      input.researchModel,
      input.researchTokens,
      nowIso(),
      id
    )
    // The previous official title stays findable.
    if (title !== cur.canonicalTitle) this.addAlias(id, cur.canonicalTitle)
    return this.get(id)!
  }

  /** The canonical key must stay unique per subject; keep the old key when another entry already owns the new one. */
  private freeCanonicalKey(cur: GameRecord, title: string): string {
    const key = gameKey(title)
    const owner = this.db.get<{ id: string }>('SELECT id FROM games WHERE subject_type = ? AND canonical_key = ?', cur.subjectType, key)
    return owner && owner.id !== cur.id ? gameKey(cur.canonicalTitle) : key
  }

  update(id: string, patch: Partial<Pick<GameRecord, 'canonicalTitle' | 'userNotes' | 'pinned' | 'userFacts' | 'removedFacts'>>): GameRecord {
    const cur = this.get(id)
    if (!cur) throw new Error(`Game not found: ${id}`)
    const m = { ...cur, ...patch }
    const title = m.canonicalTitle.trim() || cur.canonicalTitle
    this.db.run(
      'UPDATE games SET canonical_title = ?, canonical_key = ?, user_notes = ?, pinned = ?, user_facts_json = ?, removed_facts_json = ?, updated_at = ? WHERE id = ?',
      title,
      this.freeCanonicalKey(cur, title),
      m.userNotes,
      m.pinned ? 1 : 0,
      JSON.stringify(m.userFacts),
      JSON.stringify(m.removedFacts),
      nowIso(),
      id
    )
    if (title !== cur.canonicalTitle) this.addAlias(id, cur.canonicalTitle)
    return this.get(id)!
  }

  /** Learns another spelling for an entry. Returns false when the key already belongs to a different entry. */
  addAlias(id: string, alias: string): boolean {
    const game = this.db.get<{ subject_type: string; canonical_key: string }>('SELECT subject_type, canonical_key FROM games WHERE id = ?', id)
    if (!game) return false
    const key = gameKey(alias)
    if (!key || key === game.canonical_key) return true
    const other = this.db.get<{ id: string }>('SELECT id FROM games WHERE subject_type = ? AND canonical_key = ? AND id != ?', game.subject_type, key, id)
    if (other) return false
    const existing = this.db.get<{ game_id: string }>('SELECT game_id FROM game_aliases WHERE subject_type = ? AND alias_key = ?', game.subject_type, key)
    if (existing) return existing.game_id === id
    this.db.run('INSERT INTO game_aliases (alias_key, subject_type, game_id, alias, created_at) VALUES (?, ?, ?, ?, ?)', key, game.subject_type, id, alias.trim(), nowIso())
    return true
  }

  removeAlias(id: string, alias: string): void {
    const game = this.db.get<{ subject_type: string }>('SELECT subject_type FROM games WHERE id = ?', id)
    if (!game) return
    this.db.run('DELETE FROM game_aliases WHERE game_id = ? AND (alias = ? OR alias_key = ?)', id, alias, gameKey(alias))
  }

  /**
   * Recomputes every stored lookup key with the current `gameKey` (after a normalisation change).
   * A key that would collide with another entry's key keeps the old value (canonical) or is
   * dropped (alias), so two entries never share a key. Returns the number of changed rows.
   */
  rekeyAll(): number {
    let changed = 0
    this.db.transaction(() => {
      const games = this.db.all<{ id: string; subject_type: string; canonical_title: string; canonical_key: string }>('SELECT id, subject_type, canonical_title, canonical_key FROM games')
      for (const g of games) {
        const key = gameKey(g.canonical_title)
        if (!key || key === g.canonical_key) continue
        const owner = this.db.get<{ id: string }>('SELECT id FROM games WHERE subject_type = ? AND canonical_key = ? AND id != ?', g.subject_type, key, g.id)
        if (owner) continue
        this.db.run('UPDATE games SET canonical_key = ? WHERE id = ?', key, g.id)
        changed++
      }
      // Aliases: rebuilt in one pass (a changed key may collide with another alias's old key).
      const aliases = this.db.all<{ alias_key: string; subject_type: string; game_id: string; alias: string; created_at: string }>('SELECT alias_key, subject_type, game_id, alias, created_at FROM game_aliases ORDER BY created_at ASC')
      const canonical = new Set(this.db.all<{ subject_type: string; canonical_key: string }>('SELECT subject_type, canonical_key FROM games').map((g) => `${g.subject_type}\u0000${g.canonical_key}`))
      const seen = new Set<string>()
      this.db.run('DELETE FROM game_aliases')
      for (const a of aliases) {
        const key = gameKey(a.alias)
        const k = `${a.subject_type}\u0000${key}`
        // Empty, an entry's canonical key, or already used by an earlier alias: redundant or ambiguous.
        if (!key || canonical.has(k) || seen.has(k)) {
          changed++
          continue
        }
        seen.add(k)
        if (key !== a.alias_key) changed++
        this.db.run('INSERT INTO game_aliases (alias_key, subject_type, game_id, alias, created_at) VALUES (?, ?, ?, ?, ?)', key, a.subject_type, a.game_id, a.alias, a.created_at)
      }
    })
    return changed
  }

  markUsed(id: string): void {
    this.db.run('UPDATE games SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', nowIso(), id)
  }

  delete(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM game_aliases WHERE game_id = ?', id)
      this.db.run('UPDATE research_results SET game_id = NULL WHERE game_id = ?', id)
      this.db.run('DELETE FROM games WHERE id = ?', id)
    })
  }

  /** Channels and script count per entry (scripts written from research linked to the entry). */
  usage(id: string): { channels: Array<{ channelId: string; channelName: string }>; scriptCount: number } {
    const channels = this.db.all<{ channel_id: string; channel_name: string }>(
      `SELECT DISTINCT c.id AS channel_id, c.name AS channel_name
         FROM research_results r JOIN projects p ON p.id = r.project_id JOIN channels c ON c.id = p.channel_id
        WHERE r.game_id = ? ORDER BY c.name`,
      id
    )
    const scriptCount =
      this.db.get<{ c: number }>(
        `SELECT COUNT(DISTINCT s.project_id) AS c FROM scripts s
          WHERE s.research_id IN (SELECT r.id FROM research_results r WHERE r.game_id = ?) AND s.status IN ('validated','approved')`,
        id
      )?.c ?? 0
    return { channels: channels.map((c) => ({ channelId: c.channel_id, channelName: c.channel_name })), scriptCount }
  }
}

export type ReuseKind = 'research' | 'tts_full' | 'tts_part'

/** Ledger of credits saved by reuse (shown on the Usage page). */
export class ReuseRepo {
  constructor(private db: Database) {}

  record(e: { kind: ReuseKind; jobId?: string | null; channelId?: string | null; projectId?: string | null; tokensSaved?: number; charactersSaved?: number; usdSaved?: number; detail?: string | null }): void {
    this.db.run(
      'INSERT INTO reuse_events (id, kind, job_id, channel_id, project_id, tokens_saved, characters_saved, usd_saved, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId(),
      e.kind,
      e.jobId ?? null,
      e.channelId ?? null,
      e.projectId ?? null,
      Math.max(0, Math.round(e.tokensSaved ?? 0)),
      Math.max(0, Math.round(e.charactersSaved ?? 0)),
      Math.max(0, e.usdSaved ?? 0),
      e.detail ?? null,
      nowIso()
    )
  }

  summary(fromIso: string, toIso: string): { research: number; tokens: number; characters: number; files: number; parts: number; usd: number } {
    const rows = this.db.all<{ kind: string; n: number; tokens: number; chars: number; usd: number }>(
      `SELECT kind, COUNT(*) AS n, COALESCE(SUM(tokens_saved),0) AS tokens, COALESCE(SUM(characters_saved),0) AS chars, COALESCE(SUM(usd_saved),0) AS usd
         FROM reuse_events WHERE created_at >= ? AND created_at <= ? GROUP BY kind`,
      fromIso,
      toIso
    )
    const by = (k: string) => rows.find((r) => r.kind === k)
    return {
      research: by('research')?.n ?? 0,
      tokens: rows.reduce((n, r) => n + r.tokens, 0),
      characters: rows.reduce((n, r) => n + r.chars, 0),
      files: by('tts_full')?.n ?? 0,
      parts: by('tts_part')?.n ?? 0,
      usd: rows.reduce((n, r) => n + r.usd, 0)
    }
  }
}
