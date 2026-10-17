import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteFile, isInside, safeSegment, uniqueFolderName, cleanupTempFiles } from '../src/main/services/files'
import { applyPronunciation, findSections, stripSectionHeadings, validateScript } from '../src/main/pipeline/validator'
import { chunksCoverText, splitIntoChunks } from '../src/main/pipeline/chunker'
import { concatMp3, id3v2Length, parseMp3 } from '../src/main/pipeline/mp3'
import { bestModelKey, elevenCost, estimateJobCost, openaiCost } from '../src/main/pipeline/cost'
import { csvFirstColumn, parseTitles } from '../src/main/pipeline/titles'
import { computeBackoffMs, Semaphore, withRetry } from '../src/main/util/retry'
import { AppError } from '../src/main/util/errors'
import { redact } from '../src/main/services/logger'
import { DEFAULT_PRICING, DEFAULT_VALIDATION, DEFAULT_RESEARCH, DEFAULT_VOICE_SETTINGS } from '../src/shared/defaults'
import type { Channel, TemplateVersion } from '../src/shared/types'
import { fakeMp3, goodScript } from './helpers/mockProviders'
import { cleanScriptText, isReasoningModel } from '../src/main/providers/openai'
import { voiceSettingsForModel } from '../src/main/providers/elevenlabs'
import { xlsxFirstColumn } from '../src/main/pipeline/xlsx'
import { SecretStore } from '../src/main/services/secrets'
import { fakeEncryptor } from './helpers/testEnv'

function channelFixture(over: Partial<Channel> = {}): Channel {
  return {
    id: 'c1',
    name: 'Game Vault',
    slug: 'game-vault',
    icon: '',
    color: '#000000',
    description: '',
    category: 'gaming',
    language: 'en',
    writingInstructions: '',
    writingStyle: '',
    introRequirements: 'Open with: "Welcome back to Game Vault, where we mine the hidden gems and dive into the big releases—breaking down the mechanics that matter."',
    outroRequirements: '',
    targetDurationSec: 270,
    minChars: 3500,
    maxChars: 4500,
    pronunciationRules: [],
    elevenVoiceId: 'v',
    elevenVoiceName: 'V',
    elevenModelId: 'eleven_multilingual_v2',
    elevenVoiceSettings: DEFAULT_VOICE_SETTINGS,
    outputFormat: 'mp3_44100_128',
    outputFolder: null,
    openaiModel: null,
    research: DEFAULT_RESEARCH,
    validation: { ...DEFAULT_VALIDATION, forbiddenPhrases: ['AAA'] },
    activeTemplateVersionId: 'tv1',
    position: 0,
    archived: false,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

const template: TemplateVersion = {
  id: 'tv1',
  templateId: 't1',
  channelId: 'c1',
  version: 1,
  systemPrompt: '',
  structure: ['Gameplay', 'Combat', 'Pros', 'Cons', 'Conclusion'].map((l) => ({ key: l.toLowerCase(), label: l, required: true, aliases: l === 'Combat' ? ['Combat & Exploration'] : [], guidance: '' })),
  exampleScript: null,
  notes: '',
  placeholder: false,
  createdAt: ''
}

describe('file naming', () => {
  it('sanitises invalid Windows characters, reserved names and trailing dots', () => {
    expect(safeSegment('RuneScape: Dragonwilds')).toBe('RuneScape Dragonwilds')
    expect(safeSegment('a/b\\c<d>e|f?g*h"i')).toBe('a b c d e f g h i')
    expect(safeSegment('CON')).toBe('_CON')
    expect(safeSegment('aux.txt')).toBe('_aux.txt')
    expect(safeSegment('Trailing... ')).toBe('Trailing')
    expect(safeSegment('   ')).toBe('untitled')
    expect(safeSegment('../../etc')).toBe('etc')
    expect(safeSegment('x'.repeat(200)).length).toBeLessThanOrEqual(80)
  })
  it('detects path traversal', () => {
    expect(isInside('/root/out', '/root/out/a/b')).toBe(true)
    expect(isInside('/root/out', '/root/out')).toBe(true)
    expect(isInside('/root/out', '/root/other')).toBe(false)
    expect(isInside('/root/out', '/root/out/../other')).toBe(false)
  })
  it('appends a stable id on folder collisions', () => {
    const existing = new Set(['Emberward'])
    expect(uniqueFolderName('/x', 'Emberward', 'ab12c', (n) => existing.has(n))).toBe('Emberward (ab12c)')
    expect(uniqueFolderName('/x', 'Other', 'ab12c', (n) => existing.has(n))).toBe('Other')
  })
})

describe('atomic writes and temp cleanup', () => {
  it('writes atomically and leaves no temp files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-atomic-'))
    const dest = path.join(dir, 'nested', 'Script.txt')
    await atomicWriteFile(dest, 'hello')
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello')
    await atomicWriteFile(dest, 'world')
    expect(fs.readFileSync(dest, 'utf8')).toBe('world')
    expect(fs.readdirSync(path.dirname(dest)).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    // stale temp cleanup
    const stale = path.join(dir, 'nested', 'Voice.mp3.123.456.tmp')
    fs.writeFileSync(stale, 'x')
    const old = Date.now() / 1000 - 7200
    fs.utimesSync(stale, old, old)
    expect(await cleanupTempFiles(dir)).toBe(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('script validation', () => {
  it('accepts a well-formed script', () => {
    const report = validateScript(goodScript('Emberward'), { channel: channelFixture(), template, expectedTitle: 'Emberward', researchConfirmed: false, strictness: 'standard' })
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.sectionsFound).toEqual(['Gameplay', 'Combat', 'Pros', 'Cons', 'Conclusion'])
    expect(report.charCount).toBeGreaterThan(3500)
  })
  it('flags character limits', () => {
    const long = goodScript('Emberward', undefined, 5000)
    const r = validateScript(long, { channel: channelFixture(), template, expectedTitle: 'Emberward', researchConfirmed: false, strictness: 'standard' })
    expect(r.issues.some((i) => i.code === 'too_long')).toBe(true)
    const short = 'Welcome back to Game Vault, where we mine the hidden gems and dive into the big releases—breaking down the mechanics that matter.\nGameplay\nShort.\nCombat\nShort.\nPros\nGood.\nCons\nBad.\nConclusion\nDone with Emberward.'
    const r2 = validateScript(short, { channel: channelFixture(), template, expectedTitle: 'Emberward', researchConfirmed: false, strictness: 'standard' })
    expect(r2.issues.some((i) => i.code === 'too_short' && i.severity === 'error')).toBe(true)
  })
  it('flags URLs, citations, markdown, forbidden phrases, AI leaks and missing/misordered sections', () => {
    const text = goodScript('Emberward').replace('Pros\n', 'Pros\nThis AAA title is at https://example.com [1] and **bold**. As an AI I cannot verify.\n')
    const r = validateScript(text, { channel: channelFixture(), template, expectedTitle: 'Emberward', researchConfirmed: false, strictness: 'standard' })
    const codes = r.issues.map((i) => i.code)
    expect(codes).toEqual(expect.arrayContaining(['url', 'citation', 'markdown', 'forbidden_phrase', 'ai_leak']))
    const missing = goodScript('Emberward', ['Gameplay', 'Pros', 'Cons', 'Conclusion'])
    const r2 = validateScript(missing, { channel: channelFixture(), template, expectedTitle: 'Emberward', researchConfirmed: false, strictness: 'standard' })
    expect(r2.issues.some((i) => i.code === 'section_missing')).toBe(true)
    const misordered = goodScript('Emberward', ['Gameplay', 'Pros', 'Combat', 'Cons', 'Conclusion'])
    const r3 = validateScript(misordered, { channel: channelFixture(), template, expectedTitle: 'Emberward', researchConfirmed: false, strictness: 'standard' })
    expect(r3.issues.some((i) => i.code === 'section_order')).toBe(true)
  })
  it('accepts section aliases and requires the fixed intro', () => {
    const alias = goodScript('Emberward', ['Gameplay', 'Combat & Exploration', 'Pros', 'Cons', 'Conclusion'])
    const r = validateScript(alias, { channel: channelFixture(), template, expectedTitle: 'Emberward', researchConfirmed: false, strictness: 'standard' })
    expect(r.ok).toBe(true)
    const noIntro = goodScript('Emberward').replace('Welcome back to Game Vault', 'Hello')
    const r2 = validateScript(noIntro, { channel: channelFixture(), template, expectedTitle: 'Emberward', researchConfirmed: false, strictness: 'standard' })
    expect(r2.issues.some((i) => i.code === 'intro_missing')).toBe(true)
  })
  it('warns about firsthand claims and strips headings / applies pronunciation for TTS', () => {
    const text = goodScript('Emberward').replace('Cons\n', 'Cons\nIn my testing it ran at 120 fps.\n')
    const r = validateScript(text, { channel: channelFixture(), template, expectedTitle: 'Emberward', researchConfirmed: false, strictness: 'standard' })
    expect(r.issues.some((i) => i.code === 'firsthand_claim')).toBe(true)
    expect(findSections(text, template.structure)).toHaveLength(5)
    const stripped = stripSectionHeadings(text, template.structure)
    expect(stripped).not.toMatch(/^Pros$/m)
    expect(applyPronunciation('Use USB-C and QMK today', [{ from: 'USB-C', to: 'u s b c' }])).toBe('Use u s b c and QMK today')
  })
})

describe('chunking', () => {
  it('splits at paragraph/sentence boundaries and preserves text', () => {
    const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. This is sentence one of the paragraph. This is sentence two, which is a bit longer than the first. Final sentence here!`)
    const text = paras.join('\n\n')
    const chunks = splitIntoChunks(text, 400)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400)
    expect(chunksCoverText(text, chunks)).toBe(true)
    expect(chunks[1]!.previousText.length).toBeGreaterThan(0)
    expect(chunks[0]!.nextText.length).toBeGreaterThan(0)
    expect(chunks[chunks.length - 1]!.nextText).toBe('')
  })
  it('returns a single chunk for short text and handles giant sentences', () => {
    expect(splitIntoChunks('short', 100)).toHaveLength(1)
    const giant = 'word '.repeat(500).trim()
    const chunks = splitIntoChunks(giant, 300)
    expect(chunks.every((c) => c.text.length <= 300)).toBe(true)
    expect(chunksCoverText(giant, chunks)).toBe(true)
  })
})

describe('mp3 parsing and concatenation', () => {
  it('computes duration and rejects garbage', () => {
    const info = parseMp3(fakeMp3(10))
    expect(info.valid).toBe(true)
    expect(info.durationSec).toBeGreaterThan(9.5)
    expect(info.durationSec).toBeLessThan(10.5)
    expect(info.sampleRate).toBe(44100)
    expect(parseMp3(Buffer.from('this is not audio at all, just text that is long enough')).valid).toBe(false)
    expect(parseMp3(Buffer.alloc(0)).valid).toBe(false)
  })
  it('strips ID3 tags from later chunks and keeps total duration', () => {
    const tag = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...Array(10).fill(0)])
    expect(id3v2Length(tag)).toBe(20)
    const a = Buffer.concat([tag, fakeMp3(3)])
    const b = Buffer.concat([tag, fakeMp3(2)])
    const joined = concatMp3([a, b])
    expect(joined.length).toBe(a.length + b.length - 20)
    const info = parseMp3(joined)
    expect(info.valid).toBe(true)
    expect(Math.round(info.durationSec)).toBe(5)
  })
})

describe('cost tracking', () => {
  it('estimates OpenAI and ElevenLabs costs from the pricing table', () => {
    expect(openaiCost(DEFAULT_PRICING, 'gpt-5-mini', 1_000_000, 1_000_000)).toBeCloseTo(2.25, 5)
    expect(bestModelKey(DEFAULT_PRICING, 'gpt-5-mini-2026-01-01')).toBe('gpt-5-mini')
    expect(bestModelKey(DEFAULT_PRICING, 'unknown-model')).toBe('default')
    expect(elevenCost(DEFAULT_PRICING, 4000)).toBeCloseTo(1.2, 5)
    const est = estimateJobCost(DEFAULT_PRICING, { model: 'gpt-5', expectedChars: 4000, research: true, reviewPass: true, audio: true })
    expect(est.characters).toBe(4000)
    expect(est.eleven).toBeCloseTo(1.2, 5)
    expect(est.openai).toBeGreaterThan(0)
  })
})

describe('title parsing and duplicate detection', () => {
  it('parses lines, strips numbering and removes duplicates', () => {
    const r = parseTitles('1. Emberward\n\nPolice Chief Simulator\n- emberward \n"RuneScape: Dragonwilds"\nEMBERWARD\n')
    expect(r.titles).toEqual(['Emberward', 'Police Chief Simulator', 'RuneScape: Dragonwilds'])
    expect(r.duplicatesRemoved).toHaveLength(2)
    expect(r.blankLinesRemoved).toBe(2)
  })
  it('reads the first CSV column and skips header rows', () => {
    expect(csvFirstColumn('title,platform\n"Active Matter, Deluxe",PC\nENDLESS Legend 2;PC')).toEqual(['Active Matter, Deluxe', 'ENDLESS Legend 2'])
  })
  it('reads the first column of an xlsx workbook', () => {
    const file = path.join(__dirname, 'fixtures', 'titles.xlsx')
    if (!fs.existsSync(file)) return
    expect(xlsxFirstColumn(fs.readFileSync(file))).toEqual(['Emberward', 'Police Chief Simulator', 'RuneScape: Dragonwilds'])
  })
})

describe('retry behaviour and rate limits', () => {
  it('uses exponential backoff with jitter and honours retry-after', () => {
    const r = () => 0.5
    expect(computeBackoffMs(0, 1000, 60000, r)).toBe(1000)
    expect(computeBackoffMs(3, 1000, 60000, r)).toBe(4500)
    expect(computeBackoffMs(20, 1000, 60000, r)).toBeLessThanOrEqual(60500)
    expect(computeBackoffMs(0, 1000, 60000, r, 7000)).toBe(7250)
  })
  it('retries transient errors and stops on permanent ones', async () => {
    let n = 0
    const result = await withRetry(
      async () => {
        n++
        if (n < 3) throw new AppError('rate_limit', '429', { retryable: true, retryAfterMs: 1 })
        return 'ok'
      },
      { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, random: () => 0 }
    )
    expect(result).toBe('ok')
    expect(n).toBe(3)
    let m = 0
    await expect(
      withRetry(
        async () => {
          m++
          throw new AppError('auth', 'bad key', { retryable: false })
        },
        { maxRetries: 5, baseDelayMs: 1, random: () => 0 }
      )
    ).rejects.toMatchObject({ kind: 'auth' })
    expect(m).toBe(1)
  })
  it('gives up after maxRetries', async () => {
    let n = 0
    await expect(
      withRetry(
        async () => {
          n++
          throw new AppError('provider_down', '503', { retryable: true })
        },
        { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, random: () => 0 }
      )
    ).rejects.toMatchObject({ kind: 'provider_down' })
    expect(n).toBe(3)
  })
  it('semaphore limits concurrency', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const release = await sem.acquire()
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        release()
      })
    )
    expect(peak).toBe(2)
  })
  it('cancels while waiting', async () => {
    const sem = new Semaphore(1)
    const release = await sem.acquire()
    const ac = new AbortController()
    const p = sem.acquire(ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' })
    release()
  })
})

describe('provider helpers', () => {
  it('redacts secrets in logs', () => {
    expect(redact('key sk-abcdefghijklmnopqrstuvwxyz1234 used')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234')
    expect(redact('xi-api-key: 0123456789abcdef0123456789abcdef')).not.toContain('0123456789abcdef0123456789abcdef')
  })
  it('detects reasoning models and cleans script output', () => {
    expect(isReasoningModel('gpt-5')).toBe(true)
    expect(isReasoningModel('gpt-5-mini')).toBe(true)
    expect(isReasoningModel('gpt-4.1')).toBe(false)
    expect(isReasoningModel('gpt-5-chat-latest')).toBe(false)
    expect(cleanScriptText('```\nScript:\nHello world\n```')).toBe('Hello world')
  })
  it('only sends voice settings the model supports', () => {
    const v2 = voiceSettingsForModel('eleven_multilingual_v2', { stability: 0.4, similarityBoost: 0.8, style: 0.2, useSpeakerBoost: true, speed: 1.1 })
    expect(v2).toEqual({ stability: 0.4, similarityBoost: 0.8, style: 0.2, useSpeakerBoost: true, speed: 1.1 })
    const v3 = voiceSettingsForModel('eleven_v3', { stability: 0.4, similarityBoost: 0.8, style: 0.2, useSpeakerBoost: true, speed: 1.1 })
    expect(v3).toEqual({ stability: 0.5, similarityBoost: 0.8 })
  })
})

describe('API key storage', () => {
  it('encrypts at rest, round-trips, clears and refuses when encryption is unavailable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-secrets-'))
    const store = new SecretStore(dir, fakeEncryptor())
    expect(store.has('openai')).toBe(false)
    store.set('openai', ' sk-secret-value-1234567890 ')
    expect(store.get('openai')).toBe('sk-secret-value-1234567890')
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')
    expect(raw).not.toContain('sk-secret-value')
    const fresh = new SecretStore(dir, fakeEncryptor())
    expect(fresh.get('openai')).toBe('sk-secret-value-1234567890')
    store.clear('openai')
    expect(store.has('openai')).toBe(false)
    const unavailable = new SecretStore(dir, fakeEncryptor(false))
    expect(() => unavailable.set('elevenlabs', 'abcdefghijkl')).toThrow(/encryption/i)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
