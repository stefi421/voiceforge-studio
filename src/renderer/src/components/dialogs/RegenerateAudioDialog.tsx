import { useEffect, useState, type JSX } from 'react'
import type { ElevenVoice, VoiceSettings } from '@shared/types'
import { DEFAULT_VOICE_SETTINGS } from '@shared/defaults'
import { api } from '@/lib/api'
import { toast } from '@/store/toasts'
import { useApp } from '@/store/app'
import { navigate } from '@/store/router'
import { Alert, Button, Dialog, Switch } from '@/components/ui'
import { VoicePicker, VoiceSettingsEditor, useElevenModels } from '@/components/VoicePicker'

export interface RegenerateAudioTarget {
  projectId: string
  scriptId?: string
  title: string
  channelId: string
  /** Characters that will be sent to ElevenLabs (for the cost hint). */
  characters?: number
}

export interface RegenerateAudioDialogProps {
  target: RegenerateAudioTarget | null
  onClose: () => void
  onDone?: () => void
}

/**
 * Shared "generate voice" dialog used by the Scripts and Audio libraries.
 * Submits `queue:regenerateAudio`; when settings.generation.confirmExpensiveRegeneration
 * is on, the user must tick the cost confirmation (sent as `confirmedCost`).
 */
export function RegenerateAudioDialog({ target, onClose, onDone }: RegenerateAudioDialogProps): JSX.Element {
  const settings = useApp((s) => s.settings)
  const channel = useApp((s) => (target ? s.channels.find((c) => c.id === target.channelId) : undefined))
  const { models } = useElevenModels()
  const [override, setOverride] = useState(false)
  const [voice, setVoice] = useState<ElevenVoice | null>(null)
  const [modelId, setModelId] = useState('')
  const [vs, setVs] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (target) {
      setOverride(false)
      setVoice(null)
      setModelId(channel?.elevenModelId ?? settings.elevenlabs.defaultModelId)
      setVs(channel?.elevenVoiceSettings ?? DEFAULT_VOICE_SETTINGS)
      setConfirmed(!settings.generation.confirmExpensiveRegeneration)
      setBusy(false)
    }
  }, [target, channel, settings])

  const needsConfirm = settings.generation.confirmExpensiveRegeneration
  const estCost = target?.characters != null ? (target.characters / 1000) * settings.spending.pricing.elevenlabsPer1kChars : null
  const channelHasVoice = Boolean(channel?.elevenVoiceId)

  const submit = async (): Promise<void> => {
    if (!target) return
    if (!override && !channelHasVoice) {
      toast.warning('No voice selected', 'This channel has no ElevenLabs voice. Choose a different voice below or set one in the channel editor.')
      return
    }
    if (override && !voice) {
      toast.warning('Pick a voice', 'Select the voice to use for this regeneration.')
      return
    }
    setBusy(true)
    try {
      const payload: Record<string, unknown> = { projectId: target.projectId, confirmedCost: confirmed }
      if (target.scriptId) payload.scriptId = target.scriptId
      if (override && voice) {
        payload.voiceId = voice.voiceId
        payload.voiceName = voice.name
        payload.modelId = modelId
        payload.voiceSettings = vs
      }
      const job = await api.invoke('queue:regenerateAudio', payload)
      useApp.getState().upsertJob(job)
      toast.success('Voiceover queued', `"${target.title}" was added to the generation queue.`)
      onDone?.()
      onClose()
      navigate('queue', { batchId: job.batchId, highlight: job.id })
    } catch (err) {
      toast.error('Could not queue voiceover', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={Boolean(target)}
      onClose={onClose}
      size="md"
      title="Generate voiceover"
      description={target ? `"${target.title}" · ${channel?.name ?? 'channel'}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={needsConfirm && !confirmed} onClick={submit}>
            Generate audio
          </Button>
        </>
      }
    >
      <div className="small muted">
        {override
          ? 'A new audio version will be created using the voice chosen below. The channel voice is not changed.'
          : channelHasVoice
            ? `Uses the channel voice: ${channel?.elevenVoiceName ?? channel?.elevenVoiceId} · ${channel?.elevenModelId}.`
            : 'This channel has no voice configured yet.'}
      </div>
      {estCost != null && (
        <Alert tone="info">
          About {target?.characters?.toLocaleString()} characters will be sent to ElevenLabs — roughly ${estCost.toFixed(3)} (estimate based on your pricing table).
        </Alert>
      )}
      <Switch checked={override} onChange={setOverride} label="Use a different voice for this generation" />
      {override && (
        <>
          <VoicePicker value={voice?.voiceId ?? null} onChange={setVoice} />
          <VoiceSettingsEditor modelId={modelId} onModelChange={setModelId} settings={vs} onSettingsChange={setVs} models={models} />
        </>
      )}
      {needsConfirm && (
        <Switch checked={confirmed} onChange={setConfirmed} label="I understand this will spend ElevenLabs characters" description="Required by Settings → Generation → Confirm expensive regeneration." />
      )}
    </Dialog>
  )
}
