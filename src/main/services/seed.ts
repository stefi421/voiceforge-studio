import { LEGACY_SEED_V1 } from '@shared/defaults'
import { SEED_CHANNELS, SEED_MARKER_RE, SHORT_FORMATS, type SeedChannelV3, type SeedFormat } from '@shared/seedChannels'
import { versionToInput } from './style'
import type { Channel, ChannelInput } from '@shared/types'
import type { Services } from './container'
import { nowIso } from '../util/common'

const TEXT_FIELDS = ['description', 'writingInstructions', 'writingStyle', 'introRequirements', 'outroRequirements'] as const

/** Form factor and own length window of a seeded format (1.7.0). */
function applySeedLimits(s: Services, templateId: string, f: SeedFormat): void {
  if (!f.formFactor && !f.limits) return
  s.channels.setTemplateLimits(templateId, { formFactor: f.formFactor ?? 'long', ...(f.limits ?? {}) })
}

function createSeedChannel(s: Services, seed: SeedChannelV3, position: number): Channel {
  const channel = s.channels.create({ ...seed.channel, position })
  seed.formats.forEach((f, i) => {
    const { template, version } = s.channels.createTemplate(channel.id, f.name, f.version, f.contentType)
    // Seeded statuses (provisional / not configured) are set as-is; nothing starts approved.
    if (version.approvalStatus !== f.version.approvalStatus) s.channels.setVersionStatus(version.id, f.version.approvalStatus)
    applySeedLimits(s, template.id, f)
    if (i === 0) s.channels.setActiveVersion(channel.id, version.id)
  })
  return channel
}

/** True when a channel still carries the untouched 1.0/1.1 seed (one template, one version, original text). */
function isUntouchedLegacy(s: Services, channel: Channel): boolean {
  const legacy = LEGACY_SEED_V1.find((l) => l.channel.name.toLowerCase() === channel.name.toLowerCase())
  if (!legacy) return false
  const templates = s.channels.listTemplates(channel.id)
  if (templates.length !== 1) return false
  const versions = s.channels.listVersions(templates[0]!.id)
  if (versions.length !== 1) return false
  const v = versions[0]!
  return v.notes === legacy.template.notes && v.systemPrompt === legacy.template.systemPrompt && v.approvalStatus !== 'approved'
}

function upgradeLegacy(s: Services, channel: Channel, seed: SeedChannelV3): void {
  const legacy = LEGACY_SEED_V1.find((l) => l.channel.name.toLowerCase() === channel.name.toLowerCase())!
  // Only text the user never changed is replaced; voices, lengths and other settings are kept.
  const patch: Partial<ChannelInput> = {}
  for (const f of TEXT_FIELDS) if (channel[f] === legacy.channel[f]) patch[f] = seed.channel[f]
  if (JSON.stringify(channel.validation.forbiddenPhrases) === JSON.stringify(legacy.channel.validation.forbiddenPhrases)) {
    patch.validation = { ...channel.validation, forbiddenPhrases: seed.channel.validation.forbiddenPhrases }
  }
  if (Object.keys(patch).length) s.channels.update(channel.id, patch)
  const [first, ...rest] = seed.formats
  const existing = s.channels.listTemplates(channel.id)[0]!
  s.db.run('UPDATE templates SET name = ?, content_type = ?, updated_at = ? WHERE id = ?', first!.name, first!.contentType, nowIso(), existing.id)
  const v = s.channels.addVersion(existing.id, first!.version)
  if (v.approvalStatus !== first!.version.approvalStatus) s.channels.setVersionStatus(v.id, first!.version.approvalStatus)
  s.channels.setActiveVersion(channel.id, v.id)
  s.channels.setDefaultTemplate(channel.id, existing.id)
  for (const f of rest) {
    if (s.channels.getTemplateByContentType(channel.id, f.contentType)) continue
    const { template, version } = s.channels.createTemplate(channel.id, f.name, f.version, f.contentType)
    if (version.approvalStatus !== f.version.approvalStatus) s.channels.setVersionStatus(version.id, f.version.approvalStatus)
    applySeedLimits(s, template.id, f)
  }
}

/**
 * First launch: creates every channel profile from the channel configuration spec.
 * Upgrades (1.0/1.1 installs): adds the channels that do not exist yet (matched by
 * name) and refreshes the five originally seeded channels ONLY when they are still
 * untouched. Edited or approved channels/templates are never modified.
 */
export function seedDefaults(s: Services): void {
  seedV3(s)
  upgradeTo13(s)
  upgradeTo15(s)
  upgradeTo17(s)
}

export const SHORTS_SEED_KEY = 'seeded_v17_shorts'

/**
 * 1.7.0 short-form formats, runs once per install (idempotent):
 * - PlayTopia "short" and RENVO "short" are created only when the channel has no format of that
 *   content type yet.
 * - An existing RiftForge "short_review" becomes short-form; its length window is set only while
 *   the owner never set one, and its seed text is refreshed only while the active version is still
 *   the untouched, unapproved seed. Owner-edited or approved formats are never changed.
 */
function upgradeTo17(s: Services): void {
  if (s.settingsRepo.get<boolean>(SHORTS_SEED_KEY)) return
  const log = s.logger.child('seed')
  let created = 0
  let updated = 0
  s.db.transaction(() => {
    for (const [name, formats] of Object.entries(SHORT_FORMATS)) {
      const channel = s.channels.getByName(name)
      if (!channel) continue
      for (const f of formats) {
        const existing = s.channels.getTemplateByContentType(channel.id, f.contentType)
        if (!existing) {
          const { template, version } = s.channels.createTemplate(channel.id, f.name, f.version, f.contentType)
          if (version.approvalStatus !== f.version.approvalStatus) s.channels.setVersionStatus(version.id, f.version.approvalStatus)
          applySeedLimits(s, template.id, f)
          created++
          continue
        }
        const untouchedLimits = existing.minChars === null && existing.maxChars === null && existing.targetDurationSec === null
        if (existing.formFactor !== 'short' || (untouchedLimits && f.limits)) {
          s.channels.setTemplateLimits(existing.id, untouchedLimits && f.limits ? { formFactor: 'short', ...f.limits } : { formFactor: 'short' })
          updated++
        }
        const active = s.channels.activeVersionOf(existing.id)
        const seedOnly =
          !!active &&
          active.notes !== f.version.notes &&
          SEED_MARKER_RE.test(active.notes) &&
          !['approved', 'test_passed'].includes(active.approvalStatus) &&
          s.channels.listVersions(existing.id).length === 1
        if (seedOnly) {
          const v = s.channels.addVersion(existing.id, f.version)
          if (v.approvalStatus !== f.version.approvalStatus) s.channels.setVersionStatus(v.id, f.version.approvalStatus)
          s.channels.setActiveVersion(channel.id, v.id)
        }
      }
    }
    s.settingsRepo.set(SHORTS_SEED_KEY, true)
  })
  if (created || updated) log.info('Added short-form formats for 1.7.0', { created, updated })
}

/** Channel length limits as seeded by 1.2.0 — only these untouched values are replaced in 1.3.0. */
const V3_LIMITS: Record<string, { minChars: number; maxChars: number }> = {
  'game vault': { minChars: 3600, maxChars: 4700 },
  gamesense: { minChars: 4000, maxChars: 5000 },
  gamix: { minChars: 4000, maxChars: 5000 },
  renvo: { minChars: 4000, maxChars: 5000 }
}

/**
 * 1.3.0 upgrade, runs once:
 * - Seed format versions the owner never edited (notes still carry a seed marker) get a new
 *   version with the 1.3.0 seed text, KEEPING their current status. This restores the Game Vault
 *   intro the owner had stated (1.2.0 removed it by mistake) and adds other owner-stated rules.
 *   Versions created or edited by the owner are never touched.
 * - Channel length limits are updated only when they still equal the 1.2.0 seed values.
 * - Speed defaults: concurrency values still at the old defaults are raised, and channels still
 *   on the old default web-search context ("medium") move to "low".
 */
function upgradeTo13(s: Services): void {
  if (s.settingsRepo.get<boolean>('seeded_v4')) return
  const log = s.logger.child('seed')
  let refreshed = 0
  s.db.transaction(() => {
    for (const seed of SEED_CHANNELS) {
      const channel = s.channels.getByName(seed.channel.name)
      if (!channel) continue
      const old = V3_LIMITS[channel.name.toLowerCase()]
      if (old && channel.minChars === old.minChars && channel.maxChars === old.maxChars) {
        s.channels.update(channel.id, { minChars: seed.channel.minChars, maxChars: seed.channel.maxChars })
      }
      for (const f of seed.formats) {
        const template = s.channels.getTemplateByContentType(channel.id, f.contentType)
        if (!template) continue
        const active = s.channels.activeVersionOf(template.id)
        if (!active || !SEED_MARKER_RE.test(active.notes)) continue
        const next = { ...versionToInput(active), systemPrompt: f.version.systemPrompt, structure: f.version.structure, confirmedRules: f.version.confirmedRules ?? '', unverified: f.version.unverified ?? [], notes: f.version.notes }
        // Keep blocks the owner locked/added; add seed blocks that are missing (e.g. the Game Vault intro).
        const blocks = [...active.fixedBlocks]
        for (const b of f.version.fixedBlocks ?? []) if (!blocks.some((x) => x.kind === b.kind && x.locked && x.text.trim() === b.text.trim())) blocks.push(b)
        next.fixedBlocks = blocks
        const same = active.systemPrompt === next.systemPrompt && active.confirmedRules === next.confirmedRules && JSON.stringify(active.fixedBlocks) === JSON.stringify(blocks) && JSON.stringify(active.unverified) === JSON.stringify(next.unverified)
        if (same) continue
        const status = active.approvalStatus
        const v = s.channels.addVersion(template.id, { ...next, approvalStatus: status })
        if (v.approvalStatus !== status) s.channels.setVersionStatus(v.id, status)
        s.channels.setActiveVersion(channel.id, v.id)
        refreshed++
      }
    }
    for (const c of s.channels.list(true)) {
      if (c.research.searchContextSize === 'medium') s.channels.update(c.id, { research: { ...c.research, searchContextSize: 'low' } })
    }
    const st = s.settings.get()
    const patch: Record<string, Record<string, number>> = {}
    if (st.openai.concurrency === 2) patch.openai = { concurrency: 4 }
    if (st.elevenlabs.concurrency === 1) patch.elevenlabs = { concurrency: 3 }
    if (st.generation.maxConcurrentJobs === 2) patch.generation = { maxConcurrentJobs: 6 }
    if (Object.keys(patch).length) s.settings.update(patch)
    s.settingsRepo.set('seeded_v4', true)
  })
  if (refreshed) log.info('Refreshed untouched seed formats for 1.3.0', { refreshed })
}

/**
 * 1.5.0 speed defaults for existing installs: values still at the 1.3/1.4 defaults move to the
 * new ones (research on the small model, more titles in flight). Owner-changed values stay.
 */
function upgradeTo15(s: Services): void {
  if (s.settingsRepo.get<boolean>('seeded_v15')) return
  const st = s.settings.get()
  const patch: Record<string, Record<string, unknown>> = {}
  if (st.openai.researchModel === 'gpt-6.1-sol') patch.openai = { researchModel: 'gpt-6-luna' }
  if (st.generation.maxConcurrentJobs === 6) patch.generation = { maxConcurrentJobs: 16 }
  if (Object.keys(patch).length) s.settings.update(patch)
  s.settingsRepo.set('seeded_v15', true)
  if (Object.keys(patch).length) s.logger.child('seed').info('Applied 1.5.0 speed defaults', { patch })
}

function seedV3(s: Services): void {
  if (s.settingsRepo.get<boolean>('seeded_v3')) return
  const log = s.logger.child('seed')
  const firstLaunch = !s.settingsRepo.get<boolean>('seeded_v1') && s.channels.count() === 0
  let added = 0
  let upgraded = 0
  s.db.transaction(() => {
    let position = firstLaunch ? 0 : (s.channels.list(true).reduce((m, c) => Math.max(m, c.position), -1) + 1)
    for (const seed of SEED_CHANNELS) {
      const existing = firstLaunch ? undefined : s.channels.getByName(seed.channel.name)
      if (!existing) {
        createSeedChannel(s, seed, position++)
        added++
      } else if (isUntouchedLegacy(s, existing)) {
        upgradeLegacy(s, existing, seed)
        upgraded++
      }
    }
    s.settingsRepo.set('seeded_v1', true)
    s.settingsRepo.set('seeded_v3', true)
  })
  log.info(firstLaunch ? 'Seeded default channel profiles' : 'Added channel profiles from the channel configuration', { added, upgraded })
}
