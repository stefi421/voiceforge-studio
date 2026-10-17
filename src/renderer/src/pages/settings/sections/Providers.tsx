import { useMemo, useState, type JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AppSettings } from '@shared/types'
import { ELEVEN_OUTPUT_FORMATS, SUGGESTED_OPENAI_MODELS } from '@shared/defaults'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { Button, Field, ProgressBar, Select, Slider } from '@/components/ui'
import { ElevenModelSelect } from '@/components/VoicePicker'
import { formatNumber, formatPercent, relativeTime } from '@/lib/format'
import { useSettingsPatch } from '../useSettingsPatch'
import { ApiKeyCard, DeferredNumber } from './ProviderShared'

export function OpenAISection(): JSX.Element {
  const { settings, set } = useSettingsPatch()
  const hasKey = useApp((s) => s.secrets.openai)
  const o = settings.openai
  const models = useAsync(() => api.invoke('openai:listModels', undefined), [hasKey], { enabled: hasKey })
  const options = useMemo(() => {
    const ids = new Set<string>(SUGGESTED_OPENAI_MODELS)
    for (const m of Array.isArray(models.data) ? models.data : []) ids.add(m.id)
    for (const v of [o.defaultModel, o.researchModel, o.reviewModel]) ids.add(v)
    return Array.from(ids).sort().map((id) => ({ value: id, label: id }))
  }, [models.data, o.defaultModel, o.researchModel, o.reviewModel])

  return (
    <div className="settings-section">
      <ApiKeyCard provider="openai" label="OpenAI" testChannel="openai:test" />
      <div className="settings-group">
        <div className="row-between">
          <div className="settings-group-title">Models</div>
          <span className="xs muted">{Array.isArray(models.data) ? `${models.data.length} models from your account` : 'Suggested models shown; live list loads once a key is saved.'}</span>
        </div>
        <div className="form-grid">
          <Field label="Default writing model" hint="Used to write scripts unless a channel overrides it.">
            <Select value={o.defaultModel} onChange={(v) => void set('openai', 'defaultModel', v)} options={options} />
          </Field>
          <Field label="Research model" hint="Used with the web_search tool to collect facts.">
            <Select value={o.researchModel} onChange={(v) => void set('openai', 'researchModel', v)} options={options} />
          </Field>
          <Field label="Review model" hint="Used by the AI review pass; a cheaper model is fine.">
            <Select value={o.reviewModel} onChange={(v) => void set('openai', 'reviewModel', v)} options={options} />
          </Field>
          <Field label="Reasoning effort" hint="For reasoning-capable models. Ignored by models that do not support it.">
            <Select
              value={o.reasoningEffort}
              onChange={(v) => void set('openai', 'reasoningEffort', v as AppSettings['openai']['reasoningEffort'])}
              options={['none', 'minimal', 'low', 'medium', 'high'].map((x) => ({ value: x, label: x }))}
            />
          </Field>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-title">Request parameters</div>
        <div className="form-grid">
          <Slider label="Temperature" min={0} max={2} step={0.05} value={o.temperature} onChange={(v) => void set('openai', 'temperature', Math.round(v * 100) / 100)} hint="Some models ignore temperature." />
          <Field label="Max output tokens">
            <DeferredNumber value={o.maxOutputTokens} onCommit={(v) => void set('openai', 'maxOutputTokens', v ?? 8000)} min={256} max={128000} />
          </Field>
          <Field label="Timeout">
            <DeferredNumber value={o.timeoutMs} onCommit={(v) => void set('openai', 'timeoutMs', v ?? 240000)} min={5000} max={900000} step={1000} suffix="ms" />
          </Field>
          <Field label="Max retries">
            <DeferredNumber value={o.maxRetries} onCommit={(v) => void set('openai', 'maxRetries', v ?? 0)} min={0} max={10} />
          </Field>
          <Field label="Concurrency" hint="Parallel OpenAI requests across all jobs.">
            <DeferredNumber value={o.concurrency} onCommit={(v) => void set('openai', 'concurrency', v ?? 1)} min={1} max={10} />
          </Field>
        </div>
      </div>
    </div>
  )
}

export function ElevenLabsSection(): JSX.Element {
  const { settings, set } = useSettingsPatch()
  const hasKey = useApp((s) => s.secrets.elevenlabs)
  const e = settings.elevenlabs
  const models = useAsync(() => api.invoke('eleven:listModels', {}), [hasKey], { enabled: hasKey })
  const sub = useAsync(() => api.invoke('eleven:subscription', undefined), [hasKey], { enabled: hasKey })
  const [refreshing, setRefreshing] = useState(false)

  const refreshVoices = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const [voices] = await Promise.all([api.invoke('eleven:listVoices', { refresh: true }), models.reload(), sub.reload()])
      toast.success('ElevenLabs data refreshed', `${voices.length} voices cached.`)
    } catch (err) {
      toast.error('Refresh failed', err)
    } finally {
      setRefreshing(false)
    }
  }

  const s = sub.data

  return (
    <div className="settings-section">
      <ApiKeyCard provider="elevenlabs" label="ElevenLabs" testChannel="eleven:test" />
      {hasKey && (
        <div className="settings-group">
          <div className="row-between">
            <div className="settings-group-title">Subscription</div>
            <Button size="sm" icon={<RefreshCw size={13} />} loading={refreshing} onClick={refreshVoices}>
              Refresh voices & models
            </Button>
          </div>
          {s ? (
            <div className="col gap-2">
              <div className="row-between small">
                <span>
                  <strong>{s.tier}</strong> · {s.status}
                </span>
                <span className="muted">
                  {formatNumber(s.characterCount)} / {formatNumber(s.characterLimit)} characters ({formatPercent(s.characterCount / Math.max(1, s.characterLimit))})
                  {s.nextResetUnix ? ` · resets ${relativeTime(new Date(s.nextResetUnix * 1000).toISOString())}` : ''}
                </span>
              </div>
              <ProgressBar value={s.characterCount} max={s.characterLimit} tone={s.characterCount / Math.max(1, s.characterLimit) > 0.9 ? 'danger' : 'accent'} />
            </div>
          ) : (
            <span className="small muted">{sub.loading ? 'Loading…' : 'Subscription details unavailable.'}</span>
          )}
        </div>
      )}
      <div className="settings-group">
        <div className="settings-group-title">Defaults for new channels</div>
        <div className="form-grid">
          <ElevenModelSelect value={e.defaultModelId} onChange={(v) => void set('elevenlabs', 'defaultModelId', v)} models={Array.isArray(models.data) ? models.data : null} hint="Used when you create a new channel. Each channel can pick its own model." />
          <Field label="Default output format">
            <Select value={e.defaultOutputFormat} onChange={(v) => void set('elevenlabs', 'defaultOutputFormat', v)} options={ELEVEN_OUTPUT_FORMATS.map((f) => ({ value: f, label: f }))} />
          </Field>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-title">Request parameters</div>
        <div className="form-grid">
          <Field label="Timeout">
            <DeferredNumber value={e.timeoutMs} onCommit={(v) => void set('elevenlabs', 'timeoutMs', v ?? 300000)} min={5000} max={900000} step={1000} suffix="ms" />
          </Field>
          <Field label="Max retries">
            <DeferredNumber value={e.maxRetries} onCommit={(v) => void set('elevenlabs', 'maxRetries', v ?? 0)} min={0} max={10} />
          </Field>
          <Field label="Concurrency" hint="Parallel TTS requests. Keep low on Starter/Creator plans.">
            <DeferredNumber value={e.concurrency} onCommit={(v) => void set('elevenlabs', 'concurrency', v ?? 1)} min={1} max={5} />
          </Field>
          <Field label="Max characters per request" hint="0 = use the model's limit. Lower values create more, shorter chunks.">
            <DeferredNumber value={e.maxCharsPerRequest} onCommit={(v) => void set('elevenlabs', 'maxCharsPerRequest', v ?? 0)} min={0} max={40000} />
          </Field>
        </div>
      </div>
    </div>
  )
}
