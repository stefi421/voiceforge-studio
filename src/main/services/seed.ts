import { SEED_CHANNELS } from '@shared/defaults'
import type { Services } from './container'

/**
 * Creates the initial channel profiles on first launch only. Existing
 * channels are never modified by seeding, so edits survive upgrades.
 */
export function seedDefaults(s: Services): void {
  const seeded = s.settingsRepo.get<boolean>('seeded_v1')
  if (seeded) return
  if (s.channels.count() > 0) {
    s.settingsRepo.set('seeded_v1', true)
    return
  }
  s.db.transaction(() => {
    SEED_CHANNELS.forEach((seed, i) => {
      const channel = s.channels.create({ ...seed.channel, position: i })
      const { version } = s.channels.createTemplate(channel.id, seed.templateName, seed.template)
      s.channels.setActiveVersion(channel.id, version.id)
    })
    s.settingsRepo.set('seeded_v1', true)
  })
  s.logger.child('seed').info('Seeded default channel profiles', { count: SEED_CHANNELS.length })
}
