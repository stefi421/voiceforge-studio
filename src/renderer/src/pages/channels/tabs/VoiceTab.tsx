import type { JSX } from 'react'
import { Alert } from '@/components/ui'
import { VoicePicker, VoiceSettingsEditor, useElevenModels } from '@/components/VoicePicker'
import type { TabProps } from './BasicTabs'

export function VoiceTab({ form, patch, errors }: TabProps): JSX.Element {
  const { models } = useElevenModels()
  return (
    <div className="col gap-4">
      {errors.elevenVoiceId && <Alert tone="danger">{errors.elevenVoiceId}</Alert>}
      <div className="section-title">Voice</div>
      <VoicePicker
        value={form.elevenVoiceId}
        onChange={(v) => patch({ elevenVoiceId: v?.voiceId ?? null, elevenVoiceName: v?.name ?? null })}
      />
      <div className="divider" />
      <div className="section-title">Model & delivery</div>
      <VoiceSettingsEditor
        modelId={form.elevenModelId}
        onModelChange={(id) => patch({ elevenModelId: id })}
        settings={form.elevenVoiceSettings}
        onSettingsChange={(s) => patch({ elevenVoiceSettings: s })}
        outputFormat={form.outputFormat}
        onOutputFormatChange={(f) => patch({ outputFormat: f })}
        models={models}
      />
      {errors.elevenModelId && <div className="field-error">{errors.elevenModelId}</div>}
      {errors.outputFormat && <div className="field-error">{errors.outputFormat}</div>}
    </div>
  )
}
