import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Play, RefreshCw, Square, Star } from 'lucide-react'
import type { ElevenModel, ElevenVoice, VoiceSettings } from '@shared/types'
import { ELEVEN_OUTPUT_FORMATS } from '@shared/defaults'
import { api, previewUrl } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { toast } from '@/store/toasts'
import { useApp } from '@/store/app'
import { Alert, Button, Field, SearchInput, Select, Skeleton, Slider, Switch } from '@/components/ui'
import { navigate } from '@/store/router'

/* ------------------------------------------------------------------------ */
/* Voice list                                                                */
/* ------------------------------------------------------------------------ */

export interface VoicePickerProps {
  value: string | null
  onChange: (voice: ElevenVoice | null) => void
}

export function VoicePicker({ value, onChange }: VoicePickerProps): JSX.Element {
  const hasKey = useApp((s) => s.secrets.elevenlabs)
  const [query, setQuery] = useState('')
  const [onlyFav, setOnlyFav] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const voices = useAsync(() => api.invoke('eleven:listVoices', {}), [hasKey], { enabled: hasKey })
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
    }
  }, [])

  const list = useMemo(() => {
    const all = voices.data ?? []
    const q = query.trim().toLowerCase()
    return all
      .filter((v) => !onlyFav || v.favorite)
      .filter((v) => {
        if (!q) return true
        const hay = `${v.name} ${v.category} ${v.description} ${Object.values(v.labels).join(' ')}`.toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
  }, [voices.data, query, onlyFav])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const fresh = await api.invoke('eleven:listVoices', { refresh: true })
      voices.setData(fresh)
      toast.success('Voices refreshed', `${fresh.length} voices available.`)
    } catch (err) {
      toast.error('Could not refresh voices', err)
    } finally {
      setRefreshing(false)
    }
  }

  const toggleFav = async (voiceId: string): Promise<void> => {
    try {
      const fresh = await api.invoke('eleven:toggleFavorite', { voiceId })
      voices.setData(fresh)
    } catch (err) {
      toast.error('Could not update favorite', err)
    }
  }

  const preview = (voiceId: string): void => {
    if (playingId === voiceId) {
      audioRef.current?.pause()
      setPlayingId(null)
      return
    }
    audioRef.current?.pause()
    const a = new Audio(previewUrl(voiceId))
    audioRef.current = a
    a.onended = () => setPlayingId(null)
    a.onerror = () => {
      setPlayingId(null)
      toast.warning('Preview unavailable', 'This voice has no preview sample or it could not be loaded.')
    }
    setPlayingId(voiceId)
    a.play().catch(() => setPlayingId(null))
  }

  if (!hasKey) {
    return (
      <Alert tone="warning" title="ElevenLabs API key missing" actions={<Button size="sm" onClick={() => navigate('settings', { tab: 'elevenlabs' })}>Open Settings</Button>}>
        Add your ElevenLabs API key to load voices.
      </Alert>
    )
  }

  const selected = (voices.data ?? []).find((v) => v.voiceId === value)

  return (
    <div className="col gap-3">
      <div className="toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Search voices by name, accent, label…" style={{ flex: 1, minWidth: 220 }} />
        <Switch checked={onlyFav} onChange={setOnlyFav} label="Favorites only" />
        <Button size="sm" icon={<RefreshCw size={13} />} loading={refreshing} onClick={refresh}>
          Refresh
        </Button>
      </div>
      {value && !selected && !voices.loading && (
        <Alert tone="warning">The currently selected voice ({value}) is not in your ElevenLabs library any more. Pick another voice.</Alert>
      )}
      {voices.error && <Alert tone="danger" title="Could not load voices">{voices.error.message}{voices.error.action ? ` — ${voices.error.action}` : ''}</Alert>}
      <div className="voice-list">
        {voices.loading ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={34} style={{ margin: 4 }} />)
        ) : list.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            {voices.data?.length ? 'No voices match your search.' : 'No voices found. Add voices in your ElevenLabs library, then refresh.'}
          </div>
        ) : (
          list.map((v) => (
            <div key={v.voiceId} className={`voice-row ${v.voiceId === value ? 'selected' : ''}`} onClick={() => onChange(v)} role="option" aria-selected={v.voiceId === value}>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={playingId === v.voiceId ? <Square size={12} /> : <Play size={12} />}
                title="Preview"
                onClick={(e) => {
                  e.stopPropagation()
                  preview(v.voiceId)
                }}
              />
              <div className="col" style={{ gap: 1, minWidth: 0 }}>
                <span className="voice-name truncate">{v.name}</span>
                <span className="voice-meta">
                  <span>{v.category}</span>
                  {Object.entries(v.labels)
                    .slice(0, 4)
                    .map(([k, val]) => (
                      <span key={k}>· {val}</span>
                    ))}
                </span>
              </div>
              <span className="xs subtle mono">{v.voiceId.slice(0, 8)}</span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Star size={13} className={`star ${v.favorite ? 'on' : ''}`} />}
                title={v.favorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={(e) => {
                  e.stopPropagation()
                  void toggleFav(v.voiceId)
                }}
              />
            </div>
          ))
        )}
      </div>
      {selected && (
        <div className="row small">
          <span className="muted">Selected:</span>
          <span className="strong">{selected.name}</span>
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Clear
          </Button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Model + voice settings                                                    */
/* ------------------------------------------------------------------------ */

export function modelSupportsSpeed(modelId: string): boolean {
  if (modelId.startsWith('eleven_v3')) return false
  return modelId.includes('v2') || modelId.includes('flash') || modelId.includes('turbo')
}

export interface VoiceSettingsEditorProps {
  modelId: string
  onModelChange: (id: string) => void
  settings: VoiceSettings
  onSettingsChange: (s: VoiceSettings) => void
  outputFormat?: string
  onOutputFormatChange?: (f: string) => void
  models?: ElevenModel[] | null
}

export function useElevenModels(): { models: ElevenModel[] | null; loading: boolean } {
  const hasKey = useApp((s) => s.secrets.elevenlabs)
  const st = useAsync(() => api.invoke('eleven:listModels', {}), [hasKey], { enabled: hasKey })
  return { models: st.data, loading: st.loading }
}

export function VoiceSettingsEditor({ modelId, onModelChange, settings, onSettingsChange, outputFormat, onOutputFormatChange, models }: VoiceSettingsEditorProps): JSX.Element {
  const model = models?.find((m) => m.modelId === modelId)
  const canStyle = model ? model.canUseStyle : true
  const canBoost = model ? model.canUseSpeakerBoost : true
  const canSpeed = modelSupportsSpeed(modelId)
  const modelOptions = useMemo(() => {
    const opts = (models ?? []).filter((m) => m.canDoTextToSpeech).map((m) => ({ value: m.modelId, label: `${m.name} (${m.modelId})` }))
    if (modelId && !opts.some((o) => o.value === modelId)) opts.unshift({ value: modelId, label: modelId })
    return opts
  }, [models, modelId])

  const set = (patch: Partial<VoiceSettings>): void => onSettingsChange({ ...settings, ...patch })

  return (
    <div className="col gap-4">
      <div className="form-grid">
        <Field label="ElevenLabs model" hint={model?.description ?? 'Model list loads from your ElevenLabs account.'}>
          {modelOptions.length > 0 ? (
            <Select value={modelId} onChange={onModelChange} options={modelOptions} />
          ) : (
            <input className="input" value={modelId} onChange={(e) => onModelChange(e.target.value)} placeholder="eleven_multilingual_v2" />
          )}
        </Field>
        {outputFormat !== undefined && onOutputFormatChange && (
          <Field label="Output format" hint="MP3 44.1 kHz 128 kbps is the usual choice for YouTube voiceovers.">
            <Select value={outputFormat} onChange={onOutputFormatChange} options={ELEVEN_OUTPUT_FORMATS.map((f) => ({ value: f, label: f }))} />
          </Field>
        )}
      </div>
      <div className="form-grid">
        <Slider label="Stability" min={0} max={1} value={settings.stability ?? 0.5} onChange={(v) => set({ stability: v })} hint="Lower = more expressive, higher = more consistent." />
        <Slider label="Similarity boost" min={0} max={1} value={settings.similarityBoost ?? 0.75} onChange={(v) => set({ similarityBoost: v })} hint="How closely to match the original voice." />
        {canStyle && <Slider label="Style" min={0} max={1} value={settings.style ?? 0} onChange={(v) => set({ style: v })} hint="Style exaggeration. 0 is the safest for narration." />}
        {canSpeed && (
          <Slider label="Speed" min={0.7} max={1.2} step={0.01} value={settings.speed ?? 1} onChange={(v) => set({ speed: v })} format={(v) => `${v.toFixed(2)}×`} hint="Supported by multilingual v2, flash v2.5 and turbo v2.5." />
        )}
      </div>
      {canBoost && <Switch checked={settings.useSpeakerBoost ?? true} onChange={(v) => set({ useSpeakerBoost: v })} label="Speaker boost" description="Boosts similarity to the original speaker; slightly higher latency." />}
      {model?.maxCharacters != null && (
        <div className="xs subtle">
          Model limit: {model.maxCharacters.toLocaleString()} characters per request. Longer scripts are chunked automatically.
        </div>
      )}
    </div>
  )
}
