/**
 * 1.6.1: OpenAI limits per model (token budget learned from headers, priority order, 429 →
 * Retry-After), visible waits, the provider_calls log, smaller output reservations, and titles
 * pasted as Steam links (app id beats name, official title for the folder, 1.6.0 repair).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { APIError } from 'openai'
import { createTestEnv, waitFor, type TestEnv } from './helpers/testEnv'
import { researchFor } from './helpers/mockProviders'
import { QueueEngine } from '../src/main/queue/engine'
import { GenerationService } from '../src/main/services/generation'
import { Logger } from '../src/main/services/logger'
import { ModelBudget, PRIORITY, retryAfterFromHeaders, type OpenAIRateInfo } from '../src/main/queue/limits'
import { jobWaits } from '../src/main/queue/callContext'
import { mapOpenAIError, OpenAIClientProvider } from '../src/main/providers/openai'
import { legacyScriptOutputTokens, RESEARCH_OUTPUT_TOKENS, scriptOutputTokens } from '../src/main/pipeline/tokens'
import { looksLikeUrl, parseStoreLink, slugToTitle } from '../src/shared/storeLinks'
import { ProviderCallRepo } from '../src/main/db/repos/providerCallRepo'
import { AppError } from '../src/main/util/errors'
import { withRetry } from '../src/main/util/retry'
import { nowIso } from '../src/main/util/common'
import type { ResearchRequest, ScriptRequest } from '../src/main/providers/types'

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

const gv = () => env.s.channels.getByName('Game Vault')!
const DONE = ['completed', 'failed', 'awaiting_approval', 'research_review_required']
const settle = (ids: string[], timeout = 15000) => waitFor(() => ids.every((id) => DONE.includes(env.s.jobs.get(id)!.status)), timeout)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rate = (o: Partial<OpenAIRateInfo>): OpenAIRateInfo => ({ limitRequests: 500, remainingRequests: 500, limitTokens: 30000, remainingTokens: 30000, resetRequestsMs: 0, resetTokensMs: 0, at: Date.now(), ...o })

describe('Steam links as titles', () => {
  it('parses store and community links and derives the title from the slug', () => {
    const cases: Array<[string, string, string]> = [
      ['https://store.steampowered.com/app/2581940/Brick_by_Brick_Tidy_Up_the_Small_Town/', '2581940', 'Brick by Brick Tidy Up the Small Town'],
      ['https://store.steampowered.com/app/1172520/DisneyPixar_Toy_Story_3_Complete_Edition/?snr=1_7_15', '1172520', 'Disney Pixar Toy Story 3 Complete Edition'],
      ['store.steampowered.com/app/1043810/Frosthaven', '1043810', 'Frosthaven'],
      ['http://www.store.steampowered.com/agecheck/app/1091500/Cyberpunk_2077/', '1091500', 'Cyberpunk 2077'],
      ['https://steamcommunity.com/app/1043810/discussions/', '1043810', ''],
      ['https://steamcommunity.com/app/1043810', '1043810', ''],
      ['https://store.steampowered.com/app/620', '620', ''],
      ['steam://store/620', '620', ''],
      ['https://s.team/a/620', '620', '']
    ]
    for (const [url, appId, title] of cases) {
      const l = parseStoreLink(url)
      expect(l, url).not.toBeNull()
      expect(l!.appId).toBe(appId)
      expect(l!.slugTitle).toBe(title)
    }
    expect(parseStoreLink('Frosthaven')).toBeNull()
    expect(parseStoreLink('https://example.com/app/1/X')).toBeNull()
    expect(parseStoreLink('https://store.steampowered.com/app/0/X')).toBeNull()
    expect(slugToTitle('Baldurs_Gate_3')).toBe('Baldurs Gate 3')
    expect(slugToTitle('LEGO_Batman')).toBe('LEGO Batman')
    expect(slugToTitle('Caf%C3%A9_Owner')).toBe('Café Owner')
    expect(looksLikeUrl('https://example.com/x')).toBe(true)
    expect(looksLikeUrl('Half-Life 2')).toBe(false)
  })

  it('creates the job under the link title, researches it with the app id and takes the official title', async () => {
    const requests: ResearchRequest[] = []
    env.openai.researchImpl = (req) => {
      requests.push(req)
      // Ambiguity candidates are ignored for links: the app id names the game.
      return { data: researchFor('Brick by Brick: Tidy Up the Small Town', { confidence: 0.7, ambiguityCandidates: [{ title: 'Brick by Brick', developer: 'A', year: '2020', note: '' }, { title: 'Brick by Brick: Tidy Up', developer: 'B', year: '2025', note: '' }] }), sources: [], usage: { inputTokens: 900, outputTokens: 600 }, model: 'gpt-6-luna' }
    }
    engine.start()
    const url = 'https://store.steampowered.com/app/2581940/Brick_by_Brick_Tidy_Up_the_Small_Town/'
    const r = gen.createBatch({ channelId: gv().id, mode: 'scripts_only', entries: [{ title: url, channelId: null }], skipExisting: false })
    const created = env.s.jobs.get(r.jobIds[0]!)!
    expect(created.title).toBe('Brick by Brick Tidy Up the Small Town')
    expect(created.overrides).toMatchObject({ steamAppId: '2581940', storeUrl: url, titleFromUrl: true })
    await settle(r.jobIds)
    const job = env.s.jobs.get(r.jobIds[0]!)!
    expect(job.status).toBe('completed')
    expect(requests[0]!.storeHint).toEqual({ appId: '2581940', url })
    expect(requests[0]!.maxOutputTokens).toBe(RESEARCH_OUTPUT_TOKENS)
    expect(job.title).toBe('Brick by Brick: Tidy Up the Small Town')
    const project = env.s.projects.get(job.projectId)!
    expect(project.title).toBe('Brick by Brick: Tidy Up the Small Town')
    expect(project.folderName).not.toMatch(/http|steampowered/)
    expect(fs.readdirSync(path.dirname(project.folderPath!))).toContain(project.folderName)
    const game = env.s.games.byAppId('2581940')!
    expect(game.canonicalTitle).toBe('Brick by Brick: Tidy Up the Small Town')
    expect(game.aliases).toContain(url)
    expect(engine.pipeline.library.match('Brick by Brick Tidy Up the Small Town', 'gaming')).toMatchObject({ kind: 'exact', gameId: game.id })
    // Next time the same app is known: no research, the official title right away.
    const again = gen.identify('https://store.steampowered.com/app/2581940/')
    expect(again.title).toBe('Brick by Brick: Tidy Up the Small Town')
  })

  it('matches by app id before the name, and treats a same-name game with another app id as different', async () => {
    const lib = engine.pipeline.library
    const a = lib.record({ typedTitle: 'Frosthaven', steamAppId: '1043810', subject: 'game', data: researchFor('Frosthaven'), sources: [], model: 'm', tokens: 100 })
    expect(lib.match('https://store.steampowered.com/app/1043810/Some_Other_Slug/', 'gaming')).toMatchObject({ kind: 'exact', gameId: a.id })
    expect(lib.match('https://store.steampowered.com/app/999/Frosthaven/', 'gaming').kind).toBe('none')
    expect(lib.match('Frosthaven', 'gaming')).toMatchObject({ kind: 'exact', gameId: a.id })
    const b = lib.record({ typedTitle: 'Frosthaven', steamAppId: '999', subject: 'game', data: researchFor('Frosthaven', { developer: 'Other Dev', releaseDate: '2030-01-01' }), sources: [], model: 'm', tokens: 100 })
    expect(b.id).not.toBe(a.id)
    expect(env.s.games.byAppId('999')!.id).toBe(b.id)

    // In the queue: the link to app 1043810 reuses saved research (no OpenAI call), the other is researched.
    engine.start()
    const before = env.openai.count('research')
    const r = gen.createBatch({ channelId: gv().id, mode: 'scripts_only', entries: [{ title: 'https://store.steampowered.com/app/1043810/', channelId: null }], skipExisting: false })
    await settle(r.jobIds)
    expect(env.openai.count('research')).toBe(before)
    expect(env.s.jobs.get(r.jobIds[0]!)!.title).toBe('Frosthaven')
  })

  it('skips a link and the same game typed by name (and two links to one app) as duplicates', () => {
    const r = gen.createBatch({
      channelId: gv().id,
      mode: 'scripts_only',
      entries: [
        { title: 'Frosthaven', channelId: null },
        { title: 'https://store.steampowered.com/app/1043810/Frosthaven/', channelId: null },
        { title: 'https://store.steampowered.com/app/2581940/Brick_by_Brick/', channelId: null },
        { title: 'https://steamcommunity.com/app/2581940/discussions/', channelId: null }
      ],
      skipExisting: false
    })
    expect(r.jobIds).toHaveLength(2)
    expect(r.skipped).toHaveLength(2)
    expect(r.skipped.join('\n')).toMatch(/duplicate in this batch/)
  })

  it('repairs 1.6.0 rows titled with a URL (library and projects; files are not moved)', () => {
    const lib = engine.pipeline.library
    const urls = {
      frost: 'https://store.steampowered.com/app/1043810/Frosthaven/',
      toy: 'https://store.steampowered.com/app/1172520/DisneyPixar_Toy_Story_3_Complete_Edition/',
      brick: 'https://store.steampowered.com/app/2581940/Brick_by_Brick_Tidy_Up_the_Small_Town/'
    }
    // 1.6.0 stored the URL as the typed title; one entry even got the URL as its official title.
    const frost = lib.record({ typedTitle: urls.frost, subject: 'game', data: researchFor('Frosthaven'), sources: [], model: 'm', tokens: 1 })
    const toy = lib.record({ typedTitle: urls.toy, subject: 'game', data: researchFor(urls.toy), sources: [], model: 'm', tokens: 1 })
    const brick = lib.record({ typedTitle: urls.brick, subject: 'game', data: researchFor('Brick by Brick: Tidy Up the Small Town'), sources: [], model: 'm', tokens: 1 })
    expect(toy.canonicalTitle).toBe(urls.toy)
    // The research row of the URL-titled entry knows the official name.
    const projects = Object.entries(urls).map(([k, url]) => {
      const p = env.s.projects.create({ channelId: gv().id, title: url, titleNormalized: url.toLowerCase(), folderName: `folder-${k}`, folderPath: path.join(env.dir, 'output', `folder-${k}`) })
      return p
    })
    const batch = env.s.jobs.createBatch('old', 'auto')
    const job = env.s.jobs.create({ batchId: batch.id, projectId: projects[1]!.id, channelId: gv().id, title: urls.toy, mode: 'auto', position: 0 })
    const row = env.s.research.create({ jobId: job.id, projectId: projects[1]!.id, status: 'confirmed', data: researchFor('Toy Story 3'), sources: [], model: 'm', mode: 'openai_web_search' })
    env.s.research.setGame(row.id, toy.id)

    const out = lib.repairStoreLinkTitles()
    expect(out).toEqual({ games: 3, projects: 3 })
    expect(env.s.games.get(frost.id)).toMatchObject({ canonicalTitle: 'Frosthaven', steamAppId: '1043810' })
    expect(env.s.games.get(toy.id)).toMatchObject({ canonicalTitle: 'Toy Story 3', steamAppId: '1172520' })
    expect(env.s.games.get(toy.id)!.aliases).toEqual(expect.arrayContaining([urls.toy, 'Disney Pixar Toy Story 3 Complete Edition']))
    expect(env.s.games.get(brick.id)).toMatchObject({ canonicalTitle: 'Brick by Brick: Tidy Up the Small Town', steamAppId: '2581940' })
    expect(env.s.projects.get(projects[0]!.id)!.title).toBe('Frosthaven')
    expect(env.s.projects.get(projects[1]!.id)!.title).toBe('Toy Story 3')
    expect(env.s.projects.get(projects[2]!.id)!.title).toBe('Brick by Brick: Tidy Up the Small Town')
    // Folders are left alone; the job shows the new title.
    expect(env.s.projects.get(projects[1]!.id)!.folderName).toBe('folder-toy')
    expect(env.s.jobs.get(job.id)!.title).toBe('Toy Story 3')
    // Matching works by link and by name afterwards, and the repair runs once.
    expect(lib.match(urls.toy, 'gaming')).toMatchObject({ kind: 'exact', gameId: toy.id })
    expect(lib.match('Toy Story 3', 'gaming')).toMatchObject({ kind: 'exact', gameId: toy.id })
    expect(lib.repairStoreLinkTitles()).toEqual({ games: 0, projects: 0 })
  })
})

describe('output-token reservations', () => {
  it('sizes the script cap to the format (old vs new for 4,700–6,000 characters)', () => {
    expect(scriptOutputTokens(5000, 'low', 8000)).toBe(2163)
    expect(scriptOutputTokens(4700, 'low', 8000)).toBe(2069)
    expect(scriptOutputTokens(6000, 'low', 8000)).toBe(2475)
    expect(legacyScriptOutputTokens(5000, 8000)).toBe(4358)
    expect(legacyScriptOutputTokens(4700, 8000)).toBe(4186)
    expect(scriptOutputTokens(5000, 'high', 8000)).toBe(4563)
    expect(scriptOutputTokens(30000, 'low', 8000)).toBe(8000)
    expect(RESEARCH_OUTPUT_TOKENS).toBe(1500)
  })

  it('sends the small caps and retries once with the full cap when a model runs out (visible in history)', async () => {
    const caps: number[] = []
    env.openai.scriptImpl = ((orig) => (req: ScriptRequest) => {
      caps.push(req.maxOutputTokens)
      if (caps.length === 1) throw new AppError('config', 'OpenAI stopped the script early (max_output_tokens).', { retryable: false, code: 'MAX_OUTPUT_TOKENS' })
      return orig(req)
    })(env.openai.scriptImpl)
    const researchCaps: Array<number | undefined> = []
    env.openai.researchImpl = ((orig) => (req: ResearchRequest) => {
      researchCaps.push(req.maxOutputTokens)
      if (researchCaps.length === 1) throw new AppError('config', 'OpenAI stopped the research response early (max_output_tokens).', { retryable: false, code: 'MAX_OUTPUT_TOKENS' })
      return orig(req)
    })(env.openai.researchImpl)
    engine.start()
    const r = gen.createBatch({ channelId: gv().id, mode: 'scripts_only', entries: [{ title: 'Capped Game', channelId: null }], skipExisting: false })
    await settle(r.jobIds)
    expect(env.s.jobs.get(r.jobIds[0]!)!.status).toBe('completed')
    expect(researchCaps).toEqual([1500, 5000])
    const max = gv().maxChars || 5000
    expect(caps[0]).toBe(scriptOutputTokens(max, env.s.settings.get().openai.reasoningEffort, env.s.settings.get().openai.maxOutputTokens))
    expect(caps[1]).toBe(env.s.settings.get().openai.maxOutputTokens)
    const retries = env.s.jobs.listEvents({ jobId: r.jobIds[0]! }).filter((e) => e.event === 'retry').map((e) => e.detail)
    expect(retries.join('\n')).toMatch(/Research needed more than 1,500 output tokens/)
    expect(retries.join('\n')).toMatch(/script needed more than/)
  })
})

describe('per-model token budget', () => {
  it('is unlimited until headers arrive, then waits for the window to refill', () => {
    const b = new ModelBudget()
    expect(b.waitMs(50_000)).toBe(0)
    const t0 = 1_000_000
    b.observe(rate({ limitTokens: 30000, remainingTokens: 2000, resetTokensMs: 56_000, at: t0 }), t0 - 100)
    // 28,000 tokens refill in 56 s → 0.5 token/ms; 10,000 tokens need (10,000 − 2,000) / 0.5 = 16 s.
    expect(b.waitMs(10_000, t0)).toBe(16_000)
    expect(b.waitMs(10_000, t0 + 16_000)).toBe(0)
    expect(b.tokensAvailable(t0 + 112_000)).toBe(30000) // never above the limit
    // A request sent after the headers' request is not in them yet: its reservation counts.
    const r = b.reserve(8000, t0 + 16_000)
    expect(b.waitMs(10_000, t0 + 16_000)).toBe(16_000)
    b.release(r.id)
    expect(b.waitMs(10_000, t0 + 16_000)).toBe(16_000) // still not in any headers
    b.observe(rate({ limitTokens: 30000, remainingTokens: 20000, resetTokensMs: 20_000, at: t0 + 16_500 }), r.sentAt)
    expect(b.waitMs(10_000, t0 + 16_500)).toBe(0)
    // Older headers never replace newer ones.
    b.observe(rate({ remainingTokens: 0, at: t0 + 17_000 }), t0)
    expect(b.tokensAvailable(t0 + 16_500)).toBe(20000)
  })

  it('keeps models apart: a spent model never holds another model', async () => {
    const gov = engine.pipeline.governor
    env.s.settings.update({ generation: { autoTuneConcurrency: true } })
    gov.onOpenAIHeaders(rate({ limitTokens: 30000, remainingTokens: 0, resetTokensMs: 60_000 }), 'gpt-6.1-sol')
    let solStarted = false
    const ac = new AbortController()
    const sol = gov.withOpenAI({ model: 'gpt-6.1-sol', priority: PRIORITY.script, estTokens: 8000, jobId: null }, ac.signal, async () => {
      solStarted = true
      return 1
    }).catch((e) => e)
    const t0 = Date.now()
    const luna = await gov.withOpenAI({ model: 'gpt-6-luna', priority: PRIORITY.research, estTokens: 5000 }, undefined, async () => 'luna')
    expect(luna).toBe('luna')
    expect(Date.now() - t0).toBeLessThan(200)
    expect(solStarted).toBe(false)
    const st = gov.status().openai.models!
    expect(st.find((m) => m.model === 'gpt-6.1-sol')).toMatchObject({ tokensPerMinute: 30000, waiting: 1, source: 'headers' })
    expect(st.find((m) => m.model === 'gpt-6-luna')).toMatchObject({ tokensPerMinute: null, source: 'unknown' })
    ac.abort()
    expect(await sol).toMatchObject({ kind: 'cancelled' })
  })

  it('sends in priority order when the budget refills, and shows the wait on the job', async () => {
    const gov = engine.pipeline.governor
    const batch = env.s.jobs.createBatch('b', 'auto')
    const project = env.s.projects.create({ channelId: gv().id, title: 'W', titleNormalized: 'w', folderName: 'W', folderPath: null })
    const job = env.s.jobs.create({ batchId: batch.id, projectId: project.id, channelId: gv().id, title: 'W', mode: 'auto', position: 0 })
    // Window: 10,000 tokens/min, 1,000 left, full again in 1.5 s (6 tokens/ms).
    gov.onOpenAIHeaders(rate({ limitTokens: 10000, remainingTokens: 1000, resetTokensMs: 1500 }), 'm1')
    const order: string[] = []
    const t0 = Date.now()
    const research = gov.withOpenAI({ model: 'm1', priority: PRIORITY.research, estTokens: 5000, jobId: job.id }, undefined, async () => order.push('research'))
    const script = gov.withOpenAI({ model: 'm1', priority: PRIORITY.script, estTokens: 5000 }, undefined, async () => order.push('script'))
    await sleep(50)
    expect(env.s.jobs.getView(job.id)!.waitingFor).toMatchObject({ provider: 'openai', reason: 'budget', model: 'm1' })
    await Promise.all([research, script])
    expect(order).toEqual(['script', 'research'])
    // (5,000 − 1,000) / 6 ≈ 667 ms for the first; the second needs another 5,000 (≈ 833 ms).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400)
    expect(env.s.jobs.getView(job.id)!.waitingFor ?? null).toBeNull()
    expect(jobWaits.get(job.id)).toBeNull()
  })
})

describe('429 handling and the provider_calls log', () => {
  it('keeps the SDK from retrying and reads retry-after-ms / retry-after / reset headers', () => {
    const p = new OpenAIClientProvider({ apiKey: 'sk-test', timeoutMs: 1000 }, new Logger().child('t'))
    expect((p as unknown as { client: { maxRetries: number } }).client.maxRetries).toBe(0)
    const e1 = mapOpenAIError(APIError.generate(429, { message: 'Rate limit reached for gpt-6.1-sol' }, 'Rate limit reached', new Headers({ 'retry-after-ms': '1834', 'retry-after': '2' })))
    expect(e1).toMatchObject({ kind: 'rate_limit', retryAfterMs: 1834, httpStatus: 429 })
    const e2 = mapOpenAIError(APIError.generate(429, { message: 'Rate limit' }, 'Rate limit', new Headers({ 'retry-after': '3' })))
    expect(e2.retryAfterMs).toBe(3000)
    expect(retryAfterFromHeaders(new Headers({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '6s', 'x-ratelimit-limit-tokens': '30000' }))).toBe(6000)
    const quota = mapOpenAIError(APIError.generate(429, { message: 'You exceeded your current quota', code: 'insufficient_quota' }, 'You exceeded your current quota', new Headers()))
    expect(quota.kind).toBe('quota')
  })

  it('waits as long as OpenAI asks, shows it on the job, and records every request', async () => {
    let calls = 0
    env.openai.scriptImpl = ((orig) => (req: ScriptRequest) => {
      calls++
      if (calls === 1) throw new AppError('rate_limit', 'OpenAI rate limit reached.', { retryable: true, retryAfterMs: 700, httpStatus: 429 })
      return orig(req)
    })(env.openai.scriptImpl)
    engine.start()
    const r = gen.createBatch({ channelId: gv().id, mode: 'scripts_only', entries: [{ title: 'Limited Game', channelId: null }], skipExisting: false })
    const id = r.jobIds[0]!
    await waitFor(() => env.s.jobs.getView(id)!.waitingFor?.reason === 'rate_limit', 5000)
    const w = env.s.jobs.getView(id)!.waitingFor!
    expect(w.provider).toBe('openai')
    expect(w.untilMs - Date.now()).toBeGreaterThan(200)
    await settle(r.jobIds)
    expect(env.s.jobs.get(id)!.status).toBe('completed')
    expect(env.s.jobs.getView(id)!.waitingFor ?? null).toBeNull()
    const rows = env.s.providerCalls.list({ jobId: id }).reverse()
    expect(rows.map((c) => [c.kind, c.status, c.retry])).toEqual([
      ['research', 200, 0],
      ['script', 429, 0],
      ['script', 200, 1]
    ])
    expect(rows[1]).toMatchObject({ errorKind: 'rate_limit', provider: 'openai' })
    expect(rows.every((c) => (c.estTokens ?? 0) > 0)).toBe(true)
  })

  it('records rate-limit headers and prunes the log to the newest rows', () => {
    const repo = new ProviderCallRepo(env.s.db, 50)
    for (let i = 0; i < 260; i++) {
      repo.record({ provider: 'openai', model: 'gpt-6.1-sol', kind: 'script', jobId: null, status: 200, errorKind: null, latencyMs: i, waitedMs: 0, estTokens: 1000, retry: 0, limitRequests: 500, remainingRequests: 499, resetRequestsMs: 120, limitTokens: 30000, remainingTokens: 20000 - i, resetTokensMs: 2000 })
    }
    expect(repo.count()).toBeLessThanOrEqual(50 + 100)
    repo.prune()
    expect(repo.count()).toBe(50)
    expect(repo.list({ limit: 1 })[0]).toMatchObject({ latencyMs: 259, limitTokens: 30000, remainingTokens: 20000 - 259 })
    void nowIso
  })

  it('allows more retries for rate limits than for other errors', async () => {
    let n = 0
    const out = await withRetry(
      async () => {
        n++
        if (n <= 4) throw new AppError('rate_limit', '429', { retryable: true, retryAfterMs: 1 })
        return 'ok'
      },
      { maxRetries: 2, maxRateLimitRetries: 8, baseDelayMs: 1, maxDelayMs: 5 }
    )
    expect(out).toBe('ok')
    let m = 0
    await expect(
      withRetry(
        async () => {
          m++
          throw new AppError('network', 'down', { retryable: true })
        },
        { maxRetries: 2, maxRateLimitRetries: 8, baseDelayMs: 1, maxDelayMs: 5 }
      )
    ).rejects.toMatchObject({ kind: 'network' })
    expect(m).toBe(3)
  })
})
