import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Copy, Play, RefreshCw, Square, Star } from 'lucide-react'
import type { ElevenModel, ElevenVoice, VoiceSettings } from '@shared/types'
import { ELEVEN_MODEL_NOTES, ELEVEN_OUTPUT_FORMATS, ELEVEN_VOICE_CATEGORY_LABELS } from '@shared/defaults'
import { api, previewUrl } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { toast } from '@/store/toasts'
import { useApp } from '@/store/app'
import { Alert, Badge, Button, Checkbox, Field, SearchInput, Select, Skeleton, Slider, Switch } from '@/components/ui'
import { navigate } from '@/store/router'

/* ------------------------------------------------------------------------ */
/* Voice categories                                                          */
/* ------------------------------------------------------------------------ */

/** Categories that belong to the user's own account (clones and designed voices). */
export const OWN_VOICE_CATEGORIES = new Set(['cloned', 'professional', 'generated'])

export function isOwnVoice(v: ElevenVoice): boolean {
  return OWN_VOICE_CATEGORIES.has(v.category)
}

export function voiceCategoryLabel(category: string): string {
  return ELEVEN_VOICE_CATEGORY_LABELS[category] ?? (category ? category.replace(/_/g, ' ') : 'voice')
}

type VoiceScope = 'mine' | 'library' | 'favorites' | 'all'

/* ------------------------------------------------------------------------ */
/* Voice list                                                                */
/* ------------------------------------------------------------------------ */

export interface VoicePickerProps {
  value: string | null
  onChange: (voice: ElevenVoice | null) => void
  /** Smaller list for embedding in wizards and dialogs. */
  compact?: boolean
}

export function VoicePicker({ value, onChange, compact }: VoicePickerProps): JSX.Element {
  const hasKey = useApp((s) => s.secrets.elevenlabs)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<VoiceScope | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const voices = useAsync(() => api.invoke('eleven:listVoices', {}), [hasKey], { enabled: hasKey, fallback: [] })
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
    }
  }, [])

  const all = useMemo(() => (Array.isArray(voices.data) ? voices.data : []), [voices.data])
  const counts = useMemo(() => {
    const mine = all.filter(isOwnVoice).length
    const favorites = all.filter((v) => v.favorite).length
    return { mine, library: all.length - mine, favorites, all: all.length }
  }, [all])
  // Default scope: the user's own voices when there are any, otherwise the library.
  const effectiveScope: VoiceScope = scope ?? (counts.mine > 0 ? 'mine' : 'library')

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all
      .filter((v) => {
        if (effectiveScope === 'mine') return isOwnVoice(v)
        if (effectiveScope === 'library') return !isOwnVoice(v)
        if (effectiveScope === 'favorites') return v.favorite
        return true
      })
      .filter((v) => {
        if (!q) return true
        const hay = `${v.name} ${v.category} ${v.description} ${Object.values(v.labels).join(' ')} ${v.voiceId}`.toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || Number(isOwnVoice(b)) - Number(isOwnVoice(a)) || a.name.localeCompare(b.name))
  }, [all, query, effectiveScope])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const fresh = await api.invoke('eleven:listVoices', { refresh: true })
      voices.setData(fresh)
      const mine = fresh.filter(isOwnVoice).length
      toast.success('Voices refreshed', `${fresh.length} voices available, ${mine} of them your own.`)
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

  const copyId = async (voiceId: string): Promise<void> => {
    try {
      await api.invoke('app:copyToClipboard', { text: voiceId })
      toast.info('Voice ID copied', voiceId)
    } catch (err) {
      toast.error('Could not copy', err)
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
      <Alert tone="warning" title="ElevenLabs API key missing" actions={<Button size="sm" onClick={() => navigate('settings', { tab: 'elevenlabs' })}>Open settings</Button>}>
        Add your ElevenLabs API key to load your voices.
      </Alert>
    )
  }

  const selected = all.find((v) => v.voiceId === value)
  const scopes: Array<{ id: VoiceScope; label: string; count: number }> = [
    { id: 'mine', label: 'My voices', count: counts.mine },
    { id: 'library', label: 'Library', count: counts.library },
    { id: 'favorites', label: 'Favorites', count: counts.favorites },
    { id: 'all', label: 'All', count: counts.all }
  ]

  return (
    <div className="col gap-3 voice-picker">
      <div className="toolbar">
        <div className="segmented" role="tablist">
          {scopes.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={effectiveScope === s.id} className={`segment ${effectiveScope === s.id ? 'active' : ''}`} onClick={() => setScope(s.id)}>
              {s.label}
              <span className="segment-count">{s.count}</span>
            </button>
          ))}
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder="Search by name, accent, label or ID" style={{ flex: 1, minWidth: 200 }} />
        <Button size="sm" icon={<RefreshCw size={13} />} loading={refreshing} onClick={refresh} title="Reload voices from your ElevenLabs account">
          Refresh
        </Button>
      </div>
      {value && !selected && !voices.loading && (
        <Alert tone="warning">The selected voice ({value}) is no longer in your ElevenLabs account. Pick another voice.</Alert>
      )}
      {voices.error && (
        <Alert tone="danger" title="Could not load voices">
          {voices.error.message}
          {voices.error.action ? ` — ${voices.error.action}` : ''}
        </Alert>
      )}
      <div className={`voice-list ${compact ? 'voice-list-compact' : ''}`}>
        {voices.loading ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={40} style={{ margin: 4 }} />)
        ) : list.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            <div className="empty-title">{all.length ? (query ? 'No voices match your search' : effectiveScope === 'mine' ? 'No cloned or designed voices yet' : effectiveScope === 'favorites' ? 'No favorites yet' : 'Nothing here') : 'No voices found'}</div>
            <div className="empty-desc">
              {all.length === 0
                ? 'Add or clone voices in your ElevenLabs account, then refresh.'
                : effectiveScope === 'mine'
                  ? 'Voices you clone or design in ElevenLabs appear here. Until then, pick one from the library.'
                  : effectiveScope === 'favorites'
                    ? 'Star a voice to keep it at hand across channels.'
                    : 'Try another tab or clear the search.'}
            </div>
            {all.length > 0 && effectiveScope !== 'all' && (
              <div className="empty-actions">
                <Button size="sm" onClick={() => setScope('all')}>
                  Show all voices
                </Button>
              </div>
            )}
          </div>
        ) : (
          list.map((v) => (
            <div key={v.voiceId} className={`voice-row ${v.voiceId === value ? 'selected' : ''}`} onClick={() => onChange(v)} role="option" aria-selected={v.voiceId === value}>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={playingId === v.voiceId ? <Square size={12} /> : <Play size={12} />}
                title={playingId === v.voiceId ? 'Stop preview' : 'Preview'}
                onClick={(e) => {
                  e.stopPropagation()
                  preview(v.voiceId)
                }}
              />
              <div className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                <span className="row" style={{ gap: 6, minWidth: 0 }}>
                  <span className="voice-name truncate">{v.name}</span>
                  <Badge tone={isOwnVoice(v) ? 'accent' : 'neutral'}>{voiceCategoryLabel(v.category)}</Badge>
                </span>
                <span className="voice-meta truncate">
                  {[v.description, ...Object.values(v.labels).slice(0, 4)].filter(Boolean).join(', ') || 'No description'}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Copy size={12} />}
                title={`Copy voice ID ${v.voiceId}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void copyId(v.voiceId)
                }}
              />
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
          <span className="muted">Selected</span>
          <span className="strong">{selected.name}</span>
          <Badge tone={isOwnVoice(selected) ? 'accent' : 'neutral'}>{voiceCategoryLabel(selected.category)}</Badge>
          <span className="xs subtle mono selectable">{selected.voiceId}</span>
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Clear
          </Button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Models                                                                    */
/* ------------------------------------------------------------------------ */

/** Mirrors `modelSupportsSpeed` in the main process: v3 and newer take no speed value. */
export function modelSupportsSpeed(modelId: string): boolean {
  if (/^eleven_v[3-9]/.test(modelId)) return false
  return modelId.includes('v2') || modelId.includes('flash') || modelId.includes('turbo')
}

export function isExpressiveModel(modelId: string): boolean {
  return /^eleven_v[3-9]/.test(modelId)
}

const BADGE_TONE: Record<string, 'accent' | 'success' | 'info' | 'neutral' | 'warning'> = {
  newest: 'accent',
  recommended: 'success',
  fast: 'info',
  legacy: 'neutral',
  deprecated: 'warning'
}

export const MODEL_BADGE_LABEL: Record<string, string> = {
  newest: 'Newest',
  recommended: 'Recommended',
  fast: 'Fast',
  legacy: 'Previous generation',
  deprecated: 'Deprecated'
}

export function useElevenModels(): { models: ElevenModel[] | null; loading: boolean } {
  const hasKey = useApp((s) => s.secrets.elevenlabs)
  const st = useAsync(() => api.invoke('eleven:listModels', {}), [hasKey], { enabled: hasKey })
  return { models: Array.isArray(st.data) ? st.data : null, loading: st.loading }
}

/** Preferred order for models when the API returns them unordered. */
const MODEL_ORDER = ['eleven_v4', 'eleven_v4_turbo', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_flash_v2', 'eleven_v3', 'eleven_v3_conversational']

export interface ElevenModelSelectProps {
  value: string
  onChange: (id: string) => void
  models: ElevenModel[] | null | undefined
  hint?: string
}

/** Model picker with newest/recommended/deprecated badges and a note for the chosen model. */
export function ElevenModelSelect({ value, onChange, models, hint }: ElevenModelSelectProps): JSX.Element {
  const [showDeprecated, setShowDeprecated] = useState(false)
  const note = ELEVEN_MODEL_NOTES[value]
  const options = useMemo(() => {
    const live = (models ?? []).filter((m) => m.canDoTextToSpeech)
    const byId = new Map(live.map((m) => [m.modelId, m]))
    // Always offer the known current models even before the live list has loaded.
    for (const id of MODEL_ORDER) if (!byId.has(id) && ELEVEN_MODEL_NOTES[id]?.badge !== 'deprecated') byId.set(id, { modelId: id, name: id, description: '', canDoTextToSpeech: true, canUseStyle: false, canUseSpeakerBoost: false, maxCharacters: null, languages: [] })
    if (value && !byId.has(value)) byId.set(value, { modelId: value, name: value, description: '', canDoTextToSpeech: true, canUseStyle: false, canUseSpeakerBoost: false, maxCharacters: null, languages: [] })
    return Array.from(byId.values())
      .filter((m) => showDeprecated || m.modelId === value || ELEVEN_MODEL_NOTES[m.modelId]?.badge !== 'deprecated')
      .sort((a, b) => {
        const ia = MODEL_ORDER.indexOf(a.modelId)
        const ib = MODEL_ORDER.indexOf(b.modelId)
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.modelId.localeCompare(b.modelId)
      })
      .map((m) => {
        const n = ELEVEN_MODEL_NOTES[m.modelId]
        const pretty = m.name && m.name !== m.modelId ? m.name : prettyModelName(m.modelId)
        return { value: m.modelId, label: n ? `${pretty} — ${MODEL_BADGE_LABEL[n.badge]}` : pretty }
      })
  }, [models, value, showDeprecated])

  return (
    <div className="col gap-2">
      <Field
        label="ElevenLabs model"
        hint={hint}
        labelRight={<Checkbox checked={showDeprecated} onChange={setShowDeprecated} label="Show deprecated" />}
      >
        <Select value={value} onChange={onChange} options={options} />
      </Field>
      <div className="model-note">
        <div className="row" style={{ gap: 8 }}>
          <span className="strong">{prettyModelName(value)}</span>
          {note && <Badge tone={BADGE_TONE[note.badge] ?? 'neutral'}>{MODEL_BADGE_LABEL[note.badge]}</Badge>}
          <span className="xs subtle mono">{value}</span>
        </div>
        <div className="small muted">{note?.note ?? 'A model reported by your ElevenLabs account. Controls below follow what the model supports.'}</div>
      </div>
    </div>
  )
}

const PRETTY_MODEL_NAMES: Record<string, string> = {
  eleven_v4: 'Eleven v4',
  eleven_v4_turbo: 'Eleven v4 Turbo',
  eleven_v3: 'Eleven v3',
  eleven_v3_conversational: 'Eleven v3 Conversational',
  eleven_multilingual_v2: 'Multilingual v2',
  eleven_flash_v2_5: 'Flash v2.5',
  eleven_flash_v2: 'Flash v2',
  eleven_turbo_v2_5: 'Turbo v2.5',
  eleven_turbo_v2: 'Turbo v2',
  eleven_multilingual_v1: 'Multilingual v1',
  eleven_monolingual_v1: 'Monolingual v1'
}

export function prettyModelName(id: string): string {
  return PRETTY_MODEL_NAMES[id] ?? id
}

/* ------------------------------------------------------------------------ */
/* Model + voice settings                                                    */
/* ------------------------------------------------------------------------ */

export interface VoiceSettingsEditorProps {
  modelId: string
  onModelChange: (id: string) => void
  settings: VoiceSettings
  onSettingsChange: (s: VoiceSettings) => void
  outputFormat?: string
  onOutputFormatChange?: (f: string) => void
  models?: ElevenModel[] | null
}

export function VoiceSettingsEditor({ modelId, onModelChange, settings, onSettingsChange, outputFormat, onOutputFormatChange, models }: VoiceSettingsEditorProps): JSX.Element {
  const model = models?.find((m) => m.modelId === modelId)
  const expressive = isExpressiveModel(modelId)
  // The live model list decides; before it loads, fall back to what the docs say about each family.
  const canStyle = model ? model.canUseStyle : !expressive
  const canBoost = model ? model.canUseSpeakerBoost : !expressive
  const canSpeed = modelSupportsSpeed(modelId)
  const isV3 = /^eleven_v3/.test(modelId)

  const set = (patch: Partial<VoiceSettings>): void => onSettingsChange({ ...settings, ...patch })
  const stability = settings.stability ?? 0.5

  return (
    <div className="col gap-4">
      <div className="form-grid">
        <ElevenModelSelect value={modelId} onChange={onModelChange} models={models} hint={models ? `${models.filter((m) => m.canDoTextToSpeech).length} text-to-speech models available on your account.` : 'The model list loads from your ElevenLabs account.'} />
        {outputFormat !== undefined && onOutputFormatChange && (
          <Field label="Output format" hint="MP3 44.1 kHz 128 kbps is the usual choice for YouTube voiceovers.">
            <Select value={outputFormat} onChange={onOutputFormatChange} options={ELEVEN_OUTPUT_FORMATS.map((f) => ({ value: f, label: f }))} />
          </Field>
        )}
      </div>
      <div className="form-grid">
        {isV3 ? (
          <Field label="Stability" hint="v3 uses three fixed modes.">
            <Select
              value={stability < 0.25 ? '0' : stability < 0.75 ? '0.5' : '1'}
              onChange={(v) => set({ stability: Number(v) })}
              options={[
                { value: '0', label: 'Creative — most expressive, may drift' },
                { value: '0.5', label: 'Natural — closest to the original voice' },
                { value: '1', label: 'Robust — very stable, less responsive' }
              ]}
            />
          </Field>
        ) : (
          <Slider label="Stability" min={0} max={1} value={stability} onChange={(v) => set({ stability: v })} hint="Lower is more expressive, higher is more consistent from sentence to sentence." />
        )}
        <Slider label="Similarity" min={0} max={1} value={settings.similarityBoost ?? 0.75} onChange={(v) => set({ similarityBoost: v })} hint="How closely the output sticks to the original voice." />
        {canStyle && <Slider label="Style" min={0} max={1} value={settings.style ?? 0} onChange={(v) => set({ style: v })} hint="Style exaggeration. 0 is the safest for narration." />}
        {canSpeed && (
          <Slider label="Speed" min={0.7} max={1.2} step={0.01} value={settings.speed ?? 1} onChange={(v) => set({ speed: v })} format={(v) => `${v.toFixed(2)}×`} hint="Supported by multilingual v2 and the Flash models." />
        )}
      </div>
      {canBoost && <Switch checked={settings.useSpeakerBoost ?? true} onChange={(v) => set({ useSpeakerBoost: v })} label="Speaker boost" description="Boosts similarity to the original speaker; slightly higher latency." />}
      <div className="xs subtle col" style={{ gap: 4 }}>
        {expressive && (
          <span>
            {prettyModelName(modelId)} has no style or speed sliders; it reads delivery from the text itself and understands audio tags such as <code className="inline-code">[laughs]</code>, <code className="inline-code">[whispers]</code> or <code className="inline-code">[sighs]</code> when they appear in a script.
          </span>
        )}
        {model?.maxCharacters != null && <span>Limit: {model.maxCharacters.toLocaleString()} characters per request. Longer scripts are split at sentence boundaries and joined automatically.</span>}
      </div>
    </div>
  )
}
