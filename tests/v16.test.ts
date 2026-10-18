/**
 * 1.6.0: Game Library (research saved once and reused forever), fewer credits (compact
 * prompts, local fixes instead of rewrites, voiceover reuse by content hash, part-level
 * cache) and the matching rules behind it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { createTestEnv, waitFor, type TestEnv } from './helpers/testEnv'
import { goodScript, researchFor } from './helpers/mockProviders'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { Logger } from '../src/main/services/logger'
import { gameKey, matchTitle, titleTokens } from '../src/main/pipeline/gameMatch'
import { localScriptFixes } from '../src/main/pipeline/localFixes'
import { validateScript } from '../src/main/pipeline/validator'
import { buildScriptPrompt } from '../src/main/providers/prompts'
import { StyleService } from '../src/main/services/style'
import { compactResearch } from '../src/main/services/gameLibrary'
import { BackupService } from '../src/main/services/backup'
import type { ScriptRequest } from '../src/main/providers/types'

let env: TestEnv
let engine: QueueEngine
let gen: GenerationService

beforeEach(() => {
  env = createTestEnv()
  engine = new QueueEngine(env.s, new Logger().child('t'))
  gen = new GenerationService(env.s, engine)
})
afterEach(async () => {
  await engine.stop()
  env.cleanup()
})

const ch = (name: string) => env.s.channels.getByName(name)!
/** Another channel with Game Vault's format (the mock writer produces Game Vault scripts). */
const other = (): string => {
  const b = new BackupService(env.s)
  return b.importChannel(JSON.stringify(b.exportChannel(ch('Game Vault').id)))
}
const DONE = ['completed', 'failed', 'awaiting_approval', 'research_review_required']
const settle = (ids: string[], statuses = DONE) => waitFor(() => ids.every((id) => statuses.includes(env.s.jobs.get(id)!.status)), 15000)
const run = async (titles: string[], channelId: string, mode: 'auto' | 'scripts_only' = 'scripts_only') => {
  engine.start()
  const r = gen.createBatch({ channelId, mode, entries: titles.map((title) => ({ title, channelId: null })), skipExisting: false })
  await settle(r.jobIds)
  return r.jobIds.map((id) => env.s.jobs.get(id)!)
}
const entries = (list: Array<[string, string, string[]?]>) => list.map(([gameId, canonicalTitle, aliases = []]) => ({ gameId, canonicalTitle, keys: [gameKey(canonicalTitle), ...aliases.map(gameKey)] }))

describe('title matching', () => {
  it('normalises punctuation, roman numerals, trademarks and a leading "The"', () => {
    expect(gameKey('Civilization VI')).toBe(gameKey('Civilization 6'))
    expect(gameKey("Baldur's Gate III™")).toBe(gameKey('Baldurs Gate 3'))
    expect(gameKey('The Witcher 3')).toBe(gameKey('Witcher 3'))
    expect(titleTokens('Ratchet & Clank')).toEqual(titleTokens('Ratchet and Clank'))
  })

  it('handles the tricky cases: sequels, subtitles, editions and numbering', () => {
    const lib = entries([
      ['hk', 'Hollow Knight'],
      ['civ6', 'Sid Meier’s Civilization VI'],
      ['w3', 'The Witcher 3: Wild Hunt'],
      ['ds', 'Dark Souls']
    ])
    // A sequel with a subtitle is never silently merged with the original: the user is asked once.
    const silk = matchTitle('Hollow Knight: Silksong', lib)
    expect(silk.kind).toBe('near')
    expect(silk.candidates.map((c) => c.gameId)).toContain('hk')
    expect(matchTitle('Hollow Knight', lib)).toMatchObject({ kind: 'exact', gameId: 'hk' })
    // "Civilization 6" for "Civilization VI" and "Witcher 3" for "The Witcher 3: Wild Hunt" are not new games.
    expect(['exact', 'auto', 'near']).toContain(matchTitle('Civilization 6', lib).kind)
    expect(matchTitle('Sid Meiers Civilization 6', lib)).toMatchObject({ kind: 'exact', gameId: 'civ6' })
    const w3 = matchTitle('Witcher 3', lib)
    expect(w3.kind).toBe('near')
    expect(w3.candidates[0]!.gameId).toBe('w3')
    expect(matchTitle('witcher 3 wild hunt', lib)).toMatchObject({ kind: 'exact', gameId: 'w3' })
    // Different numbers are different games.
    expect(matchTitle('Dark Souls 3', lib).kind).not.toBe('exact')
    expect(matchTitle('Dark Souls 3', lib).kind).not.toBe('auto')
    // Unrelated titles are new.
    expect(matchTitle('Stardew Valley', lib).kind).toBe('none')
  })

  it('auto-matches an unambiguous typo but asks when two entries are close', () => {
    const lib = entries([['ew', 'Emberward']])
    expect(matchTitle('Emberwrad', lib).kind).not.toBe('none')
    const two = entries([
      ['a', 'Iron Coast'],
      ['b', 'Iron Coast 2']
    ])
    expect(matchTitle('Iron Coast', two)).toMatchObject({ kind: 'exact', gameId: 'a' })
    expect(matchTitle('Iron Coast 2', two)).toMatchObject({ kind: 'exact', gameId: 'b' })
  })
})

describe('Game Library reuse', () => {
  it('researches a game once and reuses it on every channel with zero research calls', async () => {
    const [first] = await run(['Emberward'], ch('Game Vault').id)
    expect(first!.status).toBe('completed')
    expect(env.openai.count('research')).toBe(1)
    const game = env.s.games.list({ subject: 'game' })[0]!
    expect(game.canonicalTitle).toBe('Emberward')

    // Same game, other channels and spellings: no research request at all.
    const later = await run(['Emberward', 'EMBERWARD!'], other())
    const more = await run(['emberward'], other())
    for (const j of [...later, ...more]) expect(j.status).toBe('completed')
    expect(env.openai.count('research')).toBe(1)
    const usedGame = env.s.games.get(game.id)!
    expect(usedGame.useCount).toBeGreaterThanOrEqual(3)
    // The writer still received the saved facts.
    const req = env.openai.calls.filter((c) => c.kind === 'script').pop()!.req as ScriptRequest
    expect(req.research?.canonicalTitle).toBe('Emberward')
    // Savings are recorded.
    const sum = env.s.reuse.summary(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 1000).toISOString())
    expect(sum.research).toBe(later.length + more.length)
    expect(sum.tokens).toBeGreaterThan(0)
    // The estimate counts only new research.
    const est = gen.estimate({ channelId: other(), mode: 'scripts_only', entries: [{ title: 'Emberward', channelId: null }, { title: 'Brand New Game', channelId: null }], skipExisting: false })
    expect(est.savedResearch).toBe(1)
    expect(est.newResearch).toBe(1)
  }, 30000)

  it('asks once for a near match, then learns the alias so the next run is automatic', async () => {
    await run(['The Witcher 3: Wild Hunt'], ch('Game Vault').id)
    expect(env.openai.count('research')).toBe(1)
    const game = env.s.games.list({})[0]!
    const [job] = await run(['Witcher 3'], other())
    expect(job!.status).toBe('research_review_required')
    expect(env.openai.count('research')).toBe(1)
    const research = env.s.research.latestForJob(job!.id)!
    const idx = research.data.ambiguityCandidates!.findIndex((c) => c.gameId === game.id)
    expect(idx).toBeGreaterThanOrEqual(0)
    engine.resolveResearch(job!.id, { candidateIndex: idx })
    await settle([job!.id], ['completed', 'failed'])
    expect(env.s.jobs.get(job!.id)!.status).toBe('completed')
    expect(env.openai.count('research')).toBe(1)
    expect(env.s.games.get(game.id)!.aliases.map(gameKey)).toContain(gameKey('Witcher 3'))
    // Next time: exact alias match, no question, no research.
    const [again] = await run(['Witcher 3'], other())
    expect(again!.status).toBe('completed')
    expect(env.openai.count('research')).toBe(1)
  }, 30000)

  it('"a different game" researches it as new and keeps both entries apart', async () => {
    await run(['Hollow Knight'], ch('Game Vault').id)
    const [job] = await run(['Hollow Knight: Silksong'], ch('Game Vault').id)
    expect(job!.status).toBe('research_review_required')
    // No candidate chosen and no manual title → "it's a different game".
    engine.resolveResearch(job!.id, { manualTitle: 'Hollow Knight: Silksong' })
    await settle([job!.id], ['completed', 'failed'])
    expect(env.s.jobs.get(job!.id)!.status).toBe('completed')
    expect(env.openai.count('research')).toBe(2)
    expect(env.s.games.list({}).map((g) => g.canonicalTitle).sort()).toEqual(['Hollow Knight', 'Hollow Knight: Silksong'])
  }, 30000)

  it('refresh re-researches and keeps notes, user facts, removed facts and aliases', async () => {
    await run(['Emberward'], ch('Game Vault').id)
    const lib = engine.pipeline.library
    const g = env.s.games.list({})[0]!
    lib.addAlias(g.id, 'Ember Ward')
    lib.addFact(g.id, 'Has a photo mode added in patch 1.2.')
    const wrong = g.data.gameplayMechanics[0]!
    lib.removeFact(g.id, wrong)
    env.s.games.update(g.id, { userNotes: 'Sponsor: none' })
    expect(lib.researchData(env.s.games.get(g.id)!).gameplayMechanics).not.toContain(wrong)
    env.openai.researchImpl = (req) => ({ data: researchFor(req.title, { developer: 'New Studio' }), sources: [], usage: { inputTokens: 900, outputTokens: 300 }, model: 'gpt-test' })
    const refreshed = await lib.refresh(g.id)
    expect(env.openai.count('research')).toBe(2)
    expect(refreshed.developer).toBe('New Studio')
    expect(refreshed.userNotes).toBe('Sponsor: none')
    expect(refreshed.userFacts).toContain('Has a photo mode added in patch 1.2.')
    expect(refreshed.removedFacts).toContain(wrong)
    expect(refreshed.aliases).toContain('Ember Ward')
    expect(env.s.usage.list(100).some((u) => u.kind === 'research')).toBe(true)
  }, 30000)

  it('flags saved research as "may be outdated" when an unreleased game is past its release date', () => {
    const lib = engine.pipeline.library
    const g = lib.record({ typedTitle: 'Future Game', subject: 'game', data: researchFor('Future Game', { releaseStatus: 'unreleased', releaseDate: '2026-01-15' }), sources: [], model: 'gpt-test', tokens: 1000 })
    env.s.db.run('UPDATE games SET researched_at = ? WHERE id = ?', '2025-12-01T00:00:00.000Z', g.id)
    expect(lib.view(env.s.games.get(g.id)!).mayBeOutdated).toBe(true)
    // Never expires by default; an explicit refresh window applies.
    const old = lib.record({ typedTitle: 'Old Game', subject: 'game', data: researchFor('Old Game'), sources: [], model: 'gpt-test', tokens: 1000 })
    env.s.db.run('UPDATE games SET researched_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', old.id)
    expect(lib.isStale(env.s.games.get(old.id)!)).toBe(false)
    env.s.settings.update({ research: { refreshAfterDays: 365 } })
    expect(lib.isStale(env.s.games.get(old.id)!)).toBe(true)
  })

  it('imports research saved by earlier versions (once) and reuses it', async () => {
    // Simulate a 1.5 database: confirmed research rows with no library link.
    await run(['Iron Coast'], ch('Game Vault').id)
    env.s.db.run('DELETE FROM game_aliases')
    env.s.db.run('DELETE FROM games')
    env.s.db.run('UPDATE research_results SET game_id = NULL')
    env.s.settingsRepo.set('gameLibrary.legacyImported', false)
    const lib = engine.pipeline.library
    const n = lib.importLegacyResearch()
    expect(n).toBeGreaterThanOrEqual(1)
    expect(env.s.games.list({}).map((g) => g.canonicalTitle)).toContain('Iron Coast')
    expect(lib.importLegacyResearch()).toBe(0)
    const before = env.openai.count('research')
    const [job] = await run(['Iron Coast'], other())
    expect(job!.status).toBe('completed')
    expect(env.openai.count('research')).toBe(before)
  }, 30000)

  it('exports and imports the library (merging, never overwriting research)', () => {
    const lib = engine.pipeline.library
    lib.record({ typedTitle: 'Alpha Game', subject: 'game', data: researchFor('Alpha Game'), sources: [], model: 'gpt-test', tokens: 1 })
    const dump = lib.exportJson()
    const raw = JSON.parse(JSON.stringify(dump))
    raw.games[0].aliases = ['Alpha']
    raw.games[0].data.developer = 'Overwritten?'
    raw.games.push({ ...raw.games[0], canonicalTitle: 'Beta Game', aliases: [] })
    const res = lib.importJson(raw)
    expect(res).toEqual({ added: 1, merged: 1 })
    const alpha = env.s.games.list({ query: 'Alpha' })[0]!
    expect(alpha.aliases).toContain('Alpha')
    expect(alpha.developer).not.toBe('Overwritten?')
    expect(() => lib.importJson({ games: [] })).toThrow(/no saved games/)
  })

  it('keeps research compact before it is saved and sent', () => {
    const big = researchFor("Huge Game", { gameplayMechanics: Array.from({ length: 40 }, (_, i) => `Feature ${i} `.repeat(30)) })
    const c = compactResearch(big)
    expect(c.gameplayMechanics.length).toBeLessThanOrEqual(14)
    expect(c.gameplayMechanics.every((f) => f.length <= 700)).toBe(true)
  })
})

describe('fewer credits', () => {
  it('local fixes repair URLs, citations, markdown, a title line and an "Intro:" label without a rewrite', () => {
    const gv = ch('Game Vault')
    const v = env.s.channels.activeVersionOf(env.s.channels.defaultTemplate(gv.id)!.id)!
    const good = goodScript('Emberward', v.structure.map((s) => s.label))
    const messy = `# Emberward\n\nIntro: ${good.replace('Pros\n', '**Pros**\n').replace('Cons\n', 'Cons\nSee https://example.com for  more. It ships in spring [1].\n')}`
    const { text, fixes } = localScriptFixes(messy, { titles: ['Emberward'], structure: v.structure })
    expect(fixes).toEqual(expect.arrayContaining(['web addresses', 'citation markers', 'markdown emphasis', 'title line', '"Intro" label']))
    const report = validateScript(text, { channel: gv, template: v, expectedTitle: 'Emberward', researchConfirmed: true, strictness: 'standard', lengthToleranceChars: 150 })
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(text).not.toMatch(/https?:|\[1\]|\*\*|^#/m)
    expect(text.startsWith('Welcome back to Game Vault')).toBe(true)
    // The sentence that pointed to the address is dropped whole — no "See for more." fragment.
    expect(text).not.toMatch(/\bSee\s+for\b/)
    expect(text).toContain('It ships in spring.')
    // Text that only looks like a label is never touched.
    expect(localScriptFixes('Introducing the new hero.\n\nGameplay\nText.', { titles: [], structure: v.structure }).text).toBe('Introducing the new hero.\n\nGameplay\nText.')
  })

  it('a draft with a URL is fixed locally: one writer call instead of two', async () => {
    const gv = ch('Game Vault')
    env.openai.scriptImpl = (req) => ({ text: goodScript(req.title, req.template.structure.map((s) => s.label)).replace('Cons\n', 'Cons\nVisit https://example.com for more.\n'), usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' })
    const [job] = await run(['Url Game'], gv.id)
    expect(job!.status).toBe('completed')
    expect(env.openai.count('script')).toBe(1)
    expect(env.s.scripts.get(job!.scriptId!)!.text).not.toContain('example.com')
    expect(env.s.jobs.listEvents({ jobId: job!.id }).some((e) => e.event === 'local_fixes')).toBe(true)
  }, 20000)

  it('the cached prompt prefix is byte-for-byte identical for every title in a batch', async () => {
    const jobs = await run(['Alpha One', 'Beta Two', 'Gamma Three'], ch('Game Vault').id)
    for (const j of jobs) expect(j.status).toBe('completed')
    const prompts = env.openai.calls.filter((c) => c.kind === 'script').map((c) => buildScriptPrompt(c.req as ScriptRequest))
    expect(prompts).toHaveLength(3)
    expect(new Set(prompts.map((p) => p.instructions)).size).toBe(1)
    // The per-title part is only in the input.
    expect(prompts[0]!.instructions).not.toContain('Alpha One')
    expect(prompts[0]!.input).toContain('Alpha One')
  }, 20000)

  it('rewrites use a short correction prompt (no references) — far fewer input characters', async () => {
    const gv = ch('Game Vault')
    const t = env.s.channels.defaultTemplate(gv.id)!
    for (const title of ['Ref One', 'Ref Two']) {
      const text = goodScript(title, undefined, 4100)
      env.s.channels.addReference({ channelId: gv.id, templateId: t.id, title, text, sourceFormat: 'txt', sourceFileName: `${title}.txt`, charCount: text.length, wordCount: text.split(/\s+/).length })
    }
    let n = 0
    env.openai.scriptImpl = (req) => {
      n++
      const base = goodScript(req.title, req.template.structure.map((s) => s.label))
      return { text: n === 1 ? base.replace('Cons\n', 'Cons\nAs an AI language model, I cannot verify this.\n') : base, usage: { inputTokens: 1, outputTokens: 1 }, model: 'gpt-test' }
    }
    const [job] = await run(['Rewrite Game'], gv.id)
    expect(job!.status).toBe('completed')
    const [first, fix] = env.openai.calls.filter((c) => c.kind === 'script').map((c) => buildScriptPrompt(c.req as ScriptRequest))
    expect(fix!.correction).toBe(true)
    // The draft itself has to be sent; everything else is smaller than a full rewrite (references dropped).
    expect(fix!.instructions.length).toBeLessThan(first!.instructions.length * 0.6)
  }, 20000)

  it('never voices the same narration twice: identical words + voice + settings cost 0 characters', async () => {
    const gv = ch('Game Vault')
    const [job] = await run(['Voice Once'], gv.id, 'auto')
    expect(job!.status).toBe('completed')
    expect(env.eleven.calls).toHaveLength(1)
    const regen = engine.regenerateAudio({ projectId: job!.projectId })
    await settle([regen.id], ['completed', 'failed'])
    expect(env.s.jobs.get(regen.id)!.status).toBe('completed')
    expect(env.eleven.calls).toHaveLength(1)
    expect(env.s.jobs.listEvents({ jobId: regen.id }).some((e) => e.event === 'audio_reused' && /0 characters/.test(e.detail ?? ''))).toBe(true)
    const sum = env.s.reuse.summary(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 1000).toISOString())
    expect(sum.files).toBe(1)
    expect(sum.characters).toBeGreaterThan(1000)
    // Another voice → a real request.
    const other = engine.regenerateAudio({ projectId: job!.projectId, voiceId: 'voice-2', voiceName: 'Other' })
    await settle([other.id], ['completed', 'failed'])
    expect(env.eleven.calls).toHaveLength(2)
  }, 30000)

  it('after a small edit only the changed part is voiced again', async () => {
    env.s.settings.update({ elevenlabs: { parallelParts: 3, concurrency: 3 } })
    const gv = ch('Game Vault')
    const [job] = await run(['Part Game'], gv.id, 'auto')
    expect(job!.status).toBe('completed')
    expect(env.eleven.calls).toHaveLength(3)
    const script = env.s.scripts.get(job!.scriptId!)!
    // Change one sentence in the last section only.
    const edited = script.text.replace(/(Conclusion\n[^\n]*?)make\./, '$1make, every single time.')
    expect(edited).not.toBe(script.text)
    const saved = await engine.pipeline.saveManualScript(job!.projectId, edited, script.id)
    const regen = engine.regenerateAudio({ projectId: job!.projectId, scriptId: saved.id })
    await settle([regen.id], ['completed', 'failed'])
    expect(env.s.jobs.get(regen.id)!.status).toBe('completed')
    expect(env.eleven.calls).toHaveLength(4)
    expect(env.eleven.calls[3]!.text).toContain('every single time')
    const audio = env.s.audio.get(env.s.jobs.get(regen.id)!.audioId!)!
    expect(fs.existsSync(audio.filePath)).toBe(true)
    const sum = env.s.reuse.summary(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 1000).toISOString())
    expect(sum.parts).toBe(2)
  }, 30000)

  it('a new take ignores the reuse and the part cache', async () => {
    env.s.settings.update({ elevenlabs: { parallelParts: 3, concurrency: 3 } })
    const [job] = await run(['Fresh Take'], ch('Game Vault').id, 'auto')
    expect(env.eleven.calls).toHaveLength(3)
    const regen = engine.regenerateAudio({ projectId: job!.projectId, freshTake: true })
    await settle([regen.id], ['completed', 'failed'])
    expect(env.eleven.calls).toHaveLength(6)
  }, 30000)

  it('sends one full reference to the writer for strict formats (skeleton still from all)', async () => {
    const style = new StyleService(env.s)
    const gv = ch('Game Vault')
    const t = env.s.channels.defaultTemplate(gv.id)!
    expect(style.promptReferences(t.id, 1).length).toBeLessThanOrEqual(1)
  })
})
