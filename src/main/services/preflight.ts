import fs from 'node:fs'
import path from 'node:path'
import type { CreateBatchInput, ElevenSubscription, ElevenVoice, PreflightCheck, PreflightResult } from '@shared/types'
import type { Services } from './container'
import type { GenerationService } from './generation'
import { AppError, toAppError } from '../util/errors'
import { ensureDir } from './files'

const TTL_MS = 60_000
const VOICES_TTL_MS = 10 * 60_000
const MIN_FREE_BYTES = 500 * 1024 * 1024
/** A check never holds the dialog longer than this; a slow provider shows as "could not verify". */
const CHECK_DEADLINE_MS = 8_000

function withDeadline<T>(p: Promise<T>, ms = CHECK_DEADLINE_MS): Promise<T> {
  let t: NodeJS.Timeout | undefined
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new AppError('network', `No answer within ${Math.round(ms / 1000)} s.`, { retryable: true })), ms)
  })
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}

interface Cached<T> {
  at: number
  value: T
}

/**
 * Fast checks before a batch starts (v1.5) so problems show up in the confirm dialog instead of
 * as failed jobs halfway through: keys, voices, ElevenLabs characters, output folder, disk space.
 * Provider answers are cached for 60 s (voices 10 min) so opening the dialog twice costs nothing.
 */
export class PreflightService {
  private openaiTest: Cached<{ ok: boolean; message: string; auth: boolean }> | null = null
  private elevenSub: Cached<{ sub: ElevenSubscription | null; error: AppError | null }> | null = null
  private voices: Cached<ElevenVoice[] | null> | null = null
  private keyFingerprint = ''

  constructor(
    private s: Services,
    private generation: GenerationService
  ) {}

  /** Keys changed → forget cached answers. */
  private checkKeys(): void {
    const st = this.s.secrets.status()
    const fp = `${st.openai}:${st.elevenlabs}:${this.s.secrets.get('openai')?.slice(-6) ?? ''}:${this.s.secrets.get('elevenlabs')?.slice(-6) ?? ''}`
    if (fp !== this.keyFingerprint) {
      this.keyFingerprint = fp
      this.openaiTest = null
      this.elevenSub = null
      this.voices = null
    }
  }

  private fresh<T>(c: Cached<T> | null, ttl = TTL_MS): c is Cached<T> {
    return !!c && Date.now() - c.at < ttl
  }

  async run(input: CreateBatchInput): Promise<PreflightResult> {
    this.checkKeys()
    const checks: PreflightCheck[] = []
    const needsAudio = input.mode !== 'scripts_only'
    const secrets = this.s.secrets.status()
    const estimate = this.generation.estimate(input)

    // 1) OpenAI key
    if (!secrets.openai) {
      checks.push({ key: 'openai_key', label: 'OpenAI key', status: 'error', message: 'No OpenAI API key is configured.', action: 'Open Settings → OpenAI and paste your key.', overridable: false })
    } else {
      if (!this.fresh(this.openaiTest)) {
        try {
          const r = await withDeadline(this.s.providers.openai().testConnection(AbortSignal.timeout(CHECK_DEADLINE_MS)))
          this.openaiTest = { at: Date.now(), value: { ok: r.ok, message: r.message, auth: !r.ok && /key|auth|401|permission/i.test(`${r.message} ${r.details ?? ''}`) } }
        } catch (err) {
          const e = toAppError(err)
          this.openaiTest = { at: Date.now(), value: { ok: false, message: e.message, auth: e.kind === 'auth' } }
        }
      }
      const t = this.openaiTest!.value
      if (t.ok) checks.push({ key: 'openai_key', label: 'OpenAI key', status: 'ok', message: 'Connected.', overridable: false })
      else if (t.auth) checks.push({ key: 'openai_key', label: 'OpenAI key', status: 'error', message: t.message, action: 'Check the key in Settings → OpenAI (Test connection).', overridable: false })
      else checks.push({ key: 'openai_key', label: 'OpenAI key', status: 'warning', message: `Could not verify right now: ${t.message}`, action: 'Jobs retry automatically if OpenAI is briefly unreachable.', overridable: false })
    }

    // 2) ElevenLabs key, 3) characters, 4) voices
    const channels = this.channelsUsed(input)
    if (needsAudio) {
      if (!secrets.elevenlabs) {
        checks.push({ key: 'eleven_key', label: 'ElevenLabs key', status: 'error', message: 'No ElevenLabs API key is configured.', action: 'Open Settings → ElevenLabs and paste your key.', overridable: false })
      } else {
        if (!this.fresh(this.elevenSub)) {
          try {
            this.elevenSub = { at: Date.now(), value: { sub: await withDeadline(this.s.providers.eleven().getSubscription()), error: null } }
          } catch (err) {
            this.elevenSub = { at: Date.now(), value: { sub: null, error: toAppError(err) } }
          }
        }
        const { sub, error } = this.elevenSub!.value
        if (error?.kind === 'auth') {
          checks.push({ key: 'eleven_key', label: 'ElevenLabs key', status: 'error', message: error.message, action: 'Check the key in Settings → ElevenLabs (Test connection).', overridable: false })
        } else if (!sub) {
          checks.push({ key: 'eleven_key', label: 'ElevenLabs key', status: 'warning', message: `Could not read your plan right now${error ? `: ${error.message}` : ''}.`, action: 'Jobs retry automatically if ElevenLabs is briefly unreachable.', overridable: false })
        } else {
          checks.push({ key: 'eleven_key', label: 'ElevenLabs key', status: 'ok', message: `Connected (${sub.tier} plan).`, overridable: false })
          const remaining = Math.max(0, sub.characterLimit - sub.characterCount)
          const need = Math.ceil(estimate.estimatedCharacters * 1.05)
          if (need === 0 || remaining >= need) {
            checks.push({ key: 'characters', label: 'ElevenLabs characters', status: 'ok', message: `${remaining.toLocaleString()} left, about ${need.toLocaleString()} needed.`, overridable: false })
          } else if (remaining >= need * 0.5) {
            checks.push({ key: 'characters', label: 'ElevenLabs characters', status: 'warning', message: `Only ${remaining.toLocaleString()} left for about ${need.toLocaleString()} needed — some voiceovers may stop when credits run out.`, action: 'Top up ElevenLabs credits, or start with fewer titles.', overridable: false })
          } else {
            checks.push({ key: 'characters', label: 'ElevenLabs characters', status: 'error', message: `Only ${remaining.toLocaleString()} characters left, about ${need.toLocaleString()} needed.`, action: 'Top up ElevenLabs credits or remove titles. "Start anyway" queues everything and pauses when credits run out.', overridable: true })
          }
        }
      }
      // Voices
      const missing = channels.filter((c) => !c.elevenVoiceId)
      if (missing.length) {
        checks.push({ key: 'voices', label: 'Voices', status: 'error', message: `No voice selected for ${missing.map((c) => c.name).join(', ')}.`, action: 'Open Channels → the channel → Voice and pick a voice.', overridable: false })
      } else if (secrets.elevenlabs) {
        if (!this.fresh(this.voices, VOICES_TTL_MS)) {
          try {
            const list = await withDeadline(this.s.providers.eleven().listVoices())
            this.voices = { at: Date.now(), value: list }
            this.s.cache.set('eleven_voices', list)
          } catch {
            this.voices = { at: Date.now(), value: null }
          }
        }
        const list = this.voices!.value
        if (!list) {
          checks.push({ key: 'voices', label: 'Voices', status: 'warning', message: 'Could not check the voices right now.', overridable: false })
        } else {
          const gone = channels.filter((c) => !list.some((v) => v.voiceId === c.elevenVoiceId))
          if (gone.length) checks.push({ key: 'voices', label: 'Voices', status: 'error', message: `The voice for ${gone.map((c) => `${c.name} (${c.elevenVoiceName ?? c.elevenVoiceId})`).join(', ')} is no longer in your ElevenLabs account.`, action: 'Pick another voice in Channels → the channel → Voice.', overridable: false })
          else checks.push({ key: 'voices', label: 'Voices', status: 'ok', message: channels.length === 1 ? `${channels[0]!.elevenVoiceName ?? 'Voice'} is ready.` : `All ${channels.length} channel voices are ready.`, overridable: false })
        }
      }
    }

    // Format gate (same rule as createBatch)
    const formatProblems = estimate.warnings.filter((w) => /format|reference/i.test(w))
    for (const ch of channels) {
      const gate = this.generation.gate(ch, input)
      if (!gate.allowed) checks.push({ key: 'format', label: `Format — ${ch.name}`, status: 'error', message: gate.error.message, action: gate.error.action, overridable: false })
    }
    if (!checks.some((c) => c.key === 'format') && formatProblems.length) {
      checks.push({ key: 'format', label: 'Format', status: 'warning', message: formatProblems.join(' '), overridable: false })
    }

    // 5) Output folder, 6) disk space
    const roots = [...new Set(channels.map((c) => c.outputFolder?.trim() || this.s.paths.outputRoot()))]
    for (const root of roots) {
      const label = roots.length > 1 ? `Output folder — ${path.basename(root)}` : 'Output folder'
      try {
        ensureDir(root)
        const probe = path.join(root, `.vf-write-test-${process.pid}-${Date.now()}`)
        fs.writeFileSync(probe, 'ok')
        fs.unlinkSync(probe)
        checks.push({ key: 'output_folder', label, status: 'ok', message: root, overridable: false })
      } catch (err) {
        checks.push({ key: 'output_folder', label, status: 'error', message: `Cannot write to ${root}: ${(err as Error).message}`, action: 'Choose another output folder in Settings → General, or check its permissions.', overridable: false })
        continue
      }
      const free = freeBytes(root)
      if (free === null) continue
      if (free < MIN_FREE_BYTES) {
        checks.push({ key: 'disk_space', label: 'Disk space', status: 'error', message: `Only ${(free / 1024 / 1024).toFixed(0)} MB free on the output drive (at least 500 MB recommended).`, action: 'Free up space or choose an output folder on another drive. "Start anyway" continues regardless.', overridable: true })
      } else {
        checks.push({ key: 'disk_space', label: 'Disk space', status: 'ok', message: `${(free / 1024 / 1024 / 1024).toFixed(1)} GB free.`, overridable: false })
      }
    }

    const errors = checks.filter((c) => c.status === 'error')
    return {
      checks,
      canStart: errors.every((c) => c.overridable),
      needsOverride: errors.length > 0 && errors.every((c) => c.overridable),
      checkedAt: new Date().toISOString()
    }
  }

  /** Throws when the batch cannot start (used by the createBatch IPC handler). */
  async assertCanStart(input: CreateBatchInput): Promise<PreflightResult> {
    const r = await this.run(input)
    const errors = r.checks.filter((c) => c.status === 'error')
    if (!r.canStart) {
      throw new AppError('config', `Can't start yet: ${errors.filter((c) => !c.overridable).map((c) => c.message).join(' ')}`, {
        action: errors.find((c) => !c.overridable)?.action ?? 'Fix the listed problems, then start again.',
        retryable: false,
        code: 'PREFLIGHT_BLOCKED'
      })
    }
    if (r.needsOverride && !input.startAnyway) {
      throw new AppError('config', errors.map((c) => c.message).join(' '), { action: 'Fix it, or choose "Start anyway".', retryable: false, code: 'PREFLIGHT_NEEDS_OVERRIDE' })
    }
    return r
  }

  private channelsUsed(input: CreateBatchInput) {
    const base = this.s.channels.get(input.channelId)
    const ids = new Set<string>([input.channelId, ...input.entries.map((e) => e.channelId).filter((x): x is string => !!x)])
    return [...ids].map((id) => (id === base?.id ? base : this.s.channels.get(id))).filter((c): c is NonNullable<typeof c> => !!c)
  }
}

export function freeBytes(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}
