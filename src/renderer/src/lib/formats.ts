import type { Channel, JobMode, RuleProvenance, Template, TemplateApprovalStatus, TemplateVersion } from '@shared/types'
import { api } from './api'

/**
 * Channel formats (content types) and their approval lifecycle, mirrored from main.
 * Main is the authority (it refuses a batch it cannot run); these helpers only decide
 * what the UI offers and how it explains a block.
 */

export const STATUS_LABEL: Record<TemplateApprovalStatus, string> = {
  not_configured: 'Needs references',
  references_imported: 'References added',
  template_extracted: 'Format extracted',
  awaiting_approval: 'Awaiting your approval',
  provisional: 'Provisional — review before voice',
  approved: 'Approved',
  test_passed: 'Test passed',
  test_failed: 'Test failed'
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral'

export const STATUS_TONE: Record<TemplateApprovalStatus, StatusTone> = {
  not_configured: 'danger',
  references_imported: 'info',
  template_extracted: 'info',
  awaiting_approval: 'accent',
  provisional: 'warning',
  approved: 'success',
  test_passed: 'success',
  test_failed: 'danger'
}

export const ALL_STATUSES = Object.keys(STATUS_LABEL) as TemplateApprovalStatus[]

export function normalizeStatus(s: unknown): TemplateApprovalStatus {
  return typeof s === 'string' && (ALL_STATUSES as string[]).includes(s) ? (s as TemplateApprovalStatus) : 'provisional'
}

/** Filter groups used by the Channels page chips. */
export type StatusGroup = 'ready' | 'needs_references' | 'needs_approval' | 'provisional'

export const GROUP_LABEL: Record<StatusGroup, string> = {
  ready: 'Ready',
  needs_references: 'Needs references',
  needs_approval: 'Needs approval',
  provisional: 'Provisional'
}

export function statusGroup(s: TemplateApprovalStatus): StatusGroup {
  switch (s) {
    case 'approved':
    case 'test_passed':
      return 'ready'
    case 'not_configured':
    case 'references_imported':
      return 'needs_references'
    case 'provisional':
      return 'provisional'
    default:
      return 'needs_approval'
  }
}

/** Fully automatic is only allowed for approved formats (spec Part 8). */
export function allowsAuto(s: TemplateApprovalStatus): boolean {
  return s === 'approved' || s === 'test_passed'
}

/** Review-before-voice / scripts-only: approved formats plus provisional ones (with a warning). */
export function allowsSupervised(s: TemplateApprovalStatus): boolean {
  return allowsAuto(s) || s === 'provisional'
}

export function allowsMode(s: TemplateApprovalStatus, mode: JobMode): boolean {
  return mode === 'auto' ? allowsAuto(s) : allowsSupervised(s)
}

export function blockReason(s: TemplateApprovalStatus, mode: JobMode): string | null {
  if (allowsMode(s, mode)) return null
  if (mode === 'auto' && allowsSupervised(s)) return 'Fully automatic is only available once this format is approved. Use Review before voice for now.'
  switch (s) {
    case 'not_configured':
      return 'This format has no approved reference scripts yet, so the app will not guess its structure. Import 3–5 approved scripts first.'
    case 'references_imported':
      return 'References are imported but not analysed yet. Analyse them and approve the extracted format.'
    case 'template_extracted':
    case 'awaiting_approval':
      return 'The extracted format is waiting for your approval in the Formats tab.'
    case 'test_failed':
      return 'The last style test failed. Fix the format and run the test again, or approve it explicitly.'
    default:
      return 'This format is not ready for generation.'
  }
}

export const PROVENANCE_LABEL: Record<RuleProvenance, string> = {
  user_confirmed: 'User confirmed',
  consistent: 'Consistent in all references',
  inferred: 'Inferred',
  unknown: 'Unknown'
}

/** A format as the UI needs it: the template plus a normalised status. */
export interface ChannelFormat {
  template: Template
  status: TemplateApprovalStatus
  /** The template that owns the channel's active version (the default format). */
  isDefault: boolean
}

export function toFormats(channel: Channel, templates: Template[]): ChannelFormat[] {
  return templates
    .map((t) => ({
      template: { ...t, contentType: t.contentType ?? 'review', referenceCount: t.referenceCount ?? 0 },
      status: normalizeStatus(t.approvalStatus),
      isDefault: Boolean(channel.activeTemplateVersionId && t.activeVersionId === channel.activeTemplateVersionId)
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.template.name.localeCompare(b.template.name))
}

/** Loads the formats of many channels (one templates:list per channel, failures tolerated). */
export async function loadFormats(channels: Channel[]): Promise<Record<string, ChannelFormat[]>> {
  const out: Record<string, ChannelFormat[]> = {}
  await Promise.all(
    channels.map(async (c) => {
      try {
        const list = await api.invoke('templates:list', { channelId: c.id })
        out[c.id] = toFormats(c, Array.isArray(list) ? list : [])
      } catch {
        out[c.id] = []
      }
    })
  )
  return out
}

/** The channel's overall status = its default format's status (or the best one). */
export function channelStatus(formats: ChannelFormat[] | undefined): TemplateApprovalStatus {
  if (!formats || formats.length === 0) return 'not_configured'
  return (formats.find((f) => f.isDefault) ?? formats[0])!.status
}

const WORD_CASE: Record<string, string> = { youtube: 'YouTube', tiktok: 'TikTok', pc: 'PC', ai: 'AI', tts: 'TTS' }

export function contentTypeLabel(key: string | null | undefined): string {
  if (!key) return 'Default'
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => WORD_CASE[w.toLowerCase()] ?? w)
  const out = words.join(' ')
  return out.replace(/^./, (c) => c.toUpperCase())
}

/** Defensive defaults for versions written by an older main process. */
export function normalizeVersion(v: TemplateVersion): TemplateVersion {
  return {
    ...v,
    approvalStatus: normalizeStatus(v.approvalStatus ?? (v.placeholder ? 'not_configured' : 'provisional')),
    fixedBlocks: Array.isArray(v.fixedBlocks) ? v.fixedBlocks : [],
    findings: Array.isArray(v.findings) ? v.findings : [],
    confirmedRules: v.confirmedRules ?? '',
    unverified: Array.isArray(v.unverified) ? v.unverified : [],
    headingsSpoken: v.headingsSpoken ?? false,
    referenceSetVersion: v.referenceSetVersion ?? null,
    approvedAt: v.approvedAt ?? null
  }
}
