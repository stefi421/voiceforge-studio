import fs from 'node:fs'
import path from 'node:path'
import type { Channel, FixedTextBlock, ScriptSection, TemplateVersion } from '@shared/types'
import { GAME_VAULT_INTRO, SEED_CHANNELS, SEED_MARKER_RE } from '@shared/seedChannels'
import type { Services } from './container'
import { normalizeReferenceText, StyleService, versionToInput } from './style'
import { estimateDurationSec, newId } from '../util/common'
import { splitParagraphs } from '../pipeline/style'

/**
 * Built-in reference pack sent by the owner on 2026-10-18 (75 scripts, 15 channels × 5).
 * The owner's instruction "every script must start, last and end exactly like before — the
 * same, only the game details differ" is the explicit approval to use the pack as the
 * canonical format for these channels. The pack's own READ_ME calls the samples
 * reconstructions; that is recorded in the version notes.
 */
export const REFERENCE_PACK_ID = '2026-10-18'
export const REFERENCE_PACK_MARKER = `[reference-pack:${REFERENCE_PACK_ID}]`
const APPLIED_KEY = 'reference_pack_2026_10_18_applied'

/** Pack folder → app channel name. */
export const PACK_CHANNELS: Record<string, string> = {
  AP: 'AperoX',
  AX: 'AxioS',
  BL: 'THE BLAZE',
  FL: 'Fluxor',
  GA: 'GAMIX',
  GS: 'GameSense',
  GV: 'Game Vault',
  NE: 'Nexora',
  NP: 'NexPlay Gaming',
  NS: 'Nyx Shadow',
  PD: 'PixelDrop',
  RF: 'RazorFrame',
  VE: 'VELIX',
  VI: 'VIR3ON',
  VP: 'VoidPulse'
}
/** Format (content type) each channel's pack applies to; default format when absent. */
const PACK_CONTENT_TYPE: Record<string, string> = { VoidPulse: 'review' }

/** The owner-confirmed Game Vault intro (GAME_VAULT_INTRO) wins over the pack's shorter opening line. */
export { GAME_VAULT_INTRO }

const PACK_MIN_CHARS = 4500
const PACK_MAX_CHARS = 5000

export interface PackChannel {
  code: string
  channelName: string
  folder: string
  scripts: Array<{ title: string; fileName: string; text: string }>
  intro: string
  outro: string
  headings: string[]
}

/** Resolves the pack folder: packaged app → resources/reference-pack/<id>; dev/tests → repo resources/. */
export function resolveReferencePackDir(): string {
  const packaged = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates = [
    packaged ? path.join(packaged, 'reference-pack', REFERENCE_PACK_ID) : null,
    path.join(__dirname, '../../resources', `reference-pack-${REFERENCE_PACK_ID}`),
    path.join(process.cwd(), 'resources', `reference-pack-${REFERENCE_PACK_ID}`)
  ].filter((p): p is string => !!p)
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1]!
}

/** "03 - RuneScape - Dragonwilds.txt" → "RuneScape: Dragonwilds" (names in the pack use " - " for ":"). */
function titleFromFile(fileName: string): string {
  const base = fileName.replace(/\.txt$/i, '').replace(/^\d+\s*-\s*/, '')
  const parts = base.split(' - ')
  return parts.length > 1 ? `${parts[0]}: ${parts.slice(1).join(' - ')}` : base
}

/**
 * Reads the pack and derives each channel's fixed parts deterministically: the first and last
 * paragraphs identical in every script, and the short paragraphs (≤ 60 chars) identical in every
 * script in between — the section labels, in order.
 */
export function readReferencePack(dir: string): PackChannel[] {
  if (!fs.existsSync(dir)) return []
  const out: PackChannel[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const code = entry.name.split(' - ')[0]!.trim()
    const channelName = PACK_CHANNELS[code]
    if (!channelName) continue
    const folder = path.join(dir, entry.name)
    const files = fs
      .readdirSync(folder)
      .filter((f) => /^\d+\s*-.*\.txt$/i.test(f))
      .sort()
    const scripts = files.map((f) => ({ title: titleFromFile(f), fileName: f, text: normalizeReferenceText(fs.readFileSync(path.join(folder, f), 'utf8')) }))
    if (scripts.length < 2) continue
    const paras = scripts.map((s) => splitParagraphs(s.text))
    const firsts = new Set(paras.map((p) => p[0]))
    const lasts = new Set(paras.map((p) => p[p.length - 1]))
    if (firsts.size !== 1 || lasts.size !== 1) continue
    const first = paras[0]!
    const headings = first.slice(1, -1).filter((p) => p.length <= 60 && !p.includes('\n') && paras.every((q) => q.includes(p)))
    out.push({ code, channelName, folder, scripts, intro: first[0]!, outro: first[first.length - 1]!, headings })
  }
  return out.sort((a, b) => a.channelName.localeCompare(b.channelName))
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

function sectionsFor(pack: PackChannel, previous: ScriptSection[]): ScriptSection[] {
  const n = pack.headings.length
  return pack.headings.map((label, i) => {
    const prev = previous.find((p) => p.label.toLowerCase() === label.toLowerCase())
    const aliases = new Set(prev?.aliases ?? [])
    if (pack.channelName === 'Game Vault' && /^combat/i.test(label)) for (const a of ['Combat', 'Combat & Exploration']) if (a !== label) aliases.add(a)
    const guidance =
      prev?.guidance ||
      (i === 0
        ? 'Opening section: what the game is and its core idea, from the research.'
        : i === n - 1
          ? 'Closing section: overall assessment and who the game is for.'
          : 'Continue in the order and with the focus the reference scripts give this section.')
    return { key: prev?.key ?? (slug(label) || `section_${i + 1}`), label, required: true, aliases: [...aliases], guidance }
  })
}

const COVERED_UNVERIFIED = /\b(intro|introduction|opening|outro|conclusion|closing|ending|structure|section|order|length|duration|character|template|format|reference script|fixed text)\b/i

/** True when the version is one the app created (seed or this pack), not one the owner edited. */
function isAppVersion(v: TemplateVersion): boolean {
  if (v.notes.includes(REFERENCE_PACK_MARKER)) return true
  if (/Opening\/closing set in the Writing tab/.test(v.notes)) return false
  return SEED_MARKER_RE.test(v.notes)
}

function seedLimits(name: string): Array<{ minChars: number; maxChars: number }> {
  const seed = SEED_CHANNELS.find((c) => c.channel.name.toLowerCase() === name.toLowerCase())
  const v3: Record<string, { minChars: number; maxChars: number }> = {
    'game vault': { minChars: 3600, maxChars: 4700 },
    gamesense: { minChars: 4000, maxChars: 5000 },
    gamix: { minChars: 4000, maxChars: 5000 }
  }
  return [seed ? { minChars: seed.channel.minChars, maxChars: seed.channel.maxChars } : null, v3[name.toLowerCase()] ?? null, { minChars: 4000, maxChars: 5000 }].filter(
    (x): x is { minChars: number; maxChars: number } => !!x
  )
}

export interface PackResult {
  applied: string[]
  awaitingApproval: string[]
  skipped: Array<{ channel: string; reason: string }>
}

/**
 * One-time, idempotent: imports the pack's scripts as references and creates a new, approved
 * format version per channel with the locked intro/outro and the labelled structure. Never
 * mutates existing versions and never creates channels.
 */
export function applyReferencePack(s: Services, dir = resolveReferencePackDir(), opts: { notifyDelayMs?: number } = {}): PackResult | null {
  const log = s.logger.child('reference-pack')
  // At startup the window is not listening yet, so the app passes a delay; tests notify immediately.
  const pending: Array<[Parameters<Services['events']['notify']>[0], string, string]> = []
  const notify = (level: Parameters<Services['events']['notify']>[0], title: string, message: string): void => {
    pending.push([level, title, message])
  }
  if (s.settingsRepo.get<boolean>(APPLIED_KEY)) return null
  const packs = readReferencePack(dir)
  if (!packs.length) {
    log.info('Reference pack not found or empty; nothing applied', { dir })
    return null
  }
  const style = new StyleService(s)
  const result: PackResult = { applied: [], awaitingApproval: [], skipped: [] }
  s.db.transaction(() => {
    for (const pack of packs) {
      const channel = s.channels.getByName(pack.channelName)
      if (!channel) {
        result.skipped.push({ channel: pack.channelName, reason: 'channel not found' })
        continue
      }
      const ct = PACK_CONTENT_TYPE[channel.name]
      const template = (ct && s.channels.getTemplateByContentType(channel.id, ct)) || s.channels.defaultTemplate(channel.id)
      const active = template ? s.channels.activeVersionOf(template.id) : undefined
      if (!template || !active) {
        result.skipped.push({ channel: channel.name, reason: 'no format' })
        continue
      }
      const ownerEdited = !isAppVersion(active)
      // References (skip texts already imported).
      const existing = new Set(s.channels.listReferences(template.id).map((r) => r.text.trim()))
      for (const sc of pack.scripts) {
        if (existing.has(sc.text.trim())) continue
        try {
          style.addReference({ templateId: template.id, title: sc.title, text: sc.text, sourceFormat: 'txt', sourceFileName: sc.fileName })
        } catch (err) {
          // One reference that cannot be added (format already holds the maximum, file too short) must
          // not roll back the whole pack for every channel — and make it fail again on every start.
          log.warn('Skipped a reference from the pack', { channel: channel.name, file: sc.fileName, error: (err as Error).message })
        }
      }
      const intro = channel.name === 'Game Vault' ? GAME_VAULT_INTRO : pack.intro
      const blocks: FixedTextBlock[] = [
        { id: newId(), kind: 'intro', text: intro, locked: true, provenance: 'user_confirmed', spoken: true, occurrences: channel.name === 'Game Vault' ? 0 : pack.scripts.length, wholeParagraph: true },
        { id: newId(), kind: 'outro', text: pack.outro, locked: true, provenance: 'user_confirmed', spoken: true, occurrences: pack.scripts.length, wholeParagraph: true }
      ]
      // Earlier length rules (e.g. Game Vault "3,500–4,500 characters") are superseded by the pack length.
      const previousRules = active.confirmedRules
        .split('\n')
        .filter((l) => !/\bcharacters?\b/i.test(l))
        .join('\n')
        .trim()
      const rules = [
        previousRules,
        'Format approved by owner from reference pack 2026-10-18: same intro, same section headings in the same order, same outro; only game-specific details change.',
        'Length: about 4,700–4,850 characters, like the reference scripts.'
      ]
        .filter(Boolean)
        .join('\n')
      const base = versionToInput(active)
      const status = ownerEdited ? 'awaiting_approval' : 'approved'
      const v = s.channels.addVersion(template.id, {
        ...base,
        placeholder: false,
        structure: sectionsFor(pack, active.structure),
        fixedBlocks: blocks,
        confirmedRules: rules,
        unverified: active.unverified.filter((u) => !COVERED_UNVERIFIED.test(u)),
        headingsSpoken: true,
        referenceSetVersion: s.channels.referenceSetVersion(template.id),
        notes: `${REFERENCE_PACK_MARKER} Approved by owner from reference pack 2026-10-18 ("every script must start, last and end exactly like before; only the game details differ"). The pack's own README describes the samples as reconstructions, not the original historical scripts.${channel.name === 'Game Vault' ? ' Intro kept as the owner-confirmed Game Vault intro.' : ''}`,
        approvalStatus: 'awaiting_approval'
      })
      if (status === 'approved') {
        s.channels.setVersionStatus(v.id, 'approved')
        s.channels.setActiveVersion(channel.id, v.id)
        const def = s.channels.defaultTemplate(channel.id)
        if (!def || def.id === template.id || !ct) s.channels.setDefaultTemplate(channel.id, template.id)
        result.applied.push(channel.name)
      } else {
        result.awaitingApproval.push(channel.name)
        notify('info', 'Format waiting for approval', `New format from the reference pack is waiting for approval in Channels → ${channel.name} → Formats`)
      }
      // Channel lengths and order: only when the owner kept the seed values.
      applyLimits(s, channel, pack.scripts.map((x) => x.text), log)
    }
    s.settingsRepo.set(APPLIED_KEY, true)
  })
  log.info('Reference pack applied', { applied: result.applied.length, awaitingApproval: result.awaitingApproval, skipped: result.skipped })
  if (result.applied.length) {
    notify('success', 'Reference pack applied', `Reference pack applied: ${result.applied.length} channel formats approved (intro, structure and outro locked)`)
  }
  const flush = (): void => {
    for (const [level, title, message] of pending) s.events.notify(level, title, message)
  }
  if (opts.notifyDelayMs) setTimeout(flush, opts.notifyDelayMs).unref?.()
  else flush()
  return result
}

function applyLimits(s: Services, channel: Channel, texts: string[], log: ReturnType<Services['logger']['child']>): void {
  const fresh = s.channels.get(channel.id)!
  const patch: Partial<Channel> = {}
  if (!fresh.validation.enforceSectionOrder) patch.validation = { ...fresh.validation, enforceSectionOrder: true }
  if (seedLimits(fresh.name).some((l) => l.minChars === fresh.minChars && l.maxChars === fresh.maxChars)) {
    patch.minChars = PACK_MIN_CHARS
    patch.maxChars = PACK_MAX_CHARS
    const durs = texts.map((t) => estimateDurationSec(t, fresh.validation.wordsPerMinute))
    patch.targetDurationSec = Math.max(60, Math.round(durs.reduce((a, b) => a + b, 0) / Math.max(1, durs.length)))
  } else {
    log.info('Kept owner-set length limits', { channel: fresh.name, minChars: fresh.minChars, maxChars: fresh.maxChars })
  }
  if (Object.keys(patch).length) s.channels.update(channel.id, patch as Parameters<Services['channels']['update']>[1])
}
