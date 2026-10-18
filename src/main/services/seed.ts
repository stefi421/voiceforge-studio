import { LEGACY_SEED_V1 } from '@shared/defaults'
import { SEED_CHANNELS, type SeedChannelV3 } from '@shared/seedChannels'
import type { Channel, ChannelInput } from '@shared/types'
import type { Services } from './container'
import { nowIso } from '../util/common'

const TEXT_FIELDS = ['description', 'writingInstructions', 'writingStyle', 'introRequirements', 'outroRequirements'] as const

function createSeedChannel(s: Services, seed: SeedChannelV3, position: number): Channel {
  const channel = s.channels.create({ ...seed.channel, position })
  seed.formats.forEach((f, i) => {
    const { version } = s.channels.createTemplate(channel.id, f.name, f.version, f.contentType)
    // Seeded statuses (provisional / not configured) are set as-is; nothing starts approved.
    if (version.approvalStatus !== f.version.approvalStatus) s.channels.setVersionStatus(version.id, f.version.approvalStatus)
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
    const { version } = s.channels.createTemplate(channel.id, f.name, f.version, f.contentType)
    if (version.approvalStatus !== f.version.approvalStatus) s.channels.setVersionStatus(version.id, f.version.approvalStatus)
  }
}

/**
 * First launch: creates every channel profile from the channel configuration spec.
 * Upgrades (1.0/1.1 installs): adds the channels that do not exist yet (matched by
 * name) and refreshes the five originally seeded channels ONLY when they are still
 * untouched. Edited or approved channels/templates are never modified.
 */
export function seedDefaults(s: Services): void {
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
