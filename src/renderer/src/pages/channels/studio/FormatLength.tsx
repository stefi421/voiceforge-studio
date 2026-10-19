import { useEffect, useState, type JSX } from 'react'
import type { FormFactor, Template } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/store/toasts'
import { formatDuration } from '@/lib/formats'
import { Button, Field, NumberInput } from '@/components/ui'

/** 1.7.0 presets: chars at roughly 13–15 characters per spoken second. */
const PRESETS: Record<FormFactor, Array<{ label: string; sub: string; minChars: number; maxChars: number; targetDurationSec: number }>> = {
  short: [
    { label: '15 s', sub: '120–260 chars', minChars: 120, maxChars: 260, targetDurationSec: 15 },
    { label: '30 s', sub: '300–550 chars', minChars: 300, maxChars: 550, targetDurationSec: 30 },
    { label: '60 s', sub: '650–1,000 chars', minChars: 650, maxChars: 1000, targetDurationSec: 60 }
  ],
  long: [
    { label: '3 min', sub: '2,400–3,000 chars', minChars: 2400, maxChars: 3000, targetDurationSec: 180 },
    { label: '5 min', sub: '4,000–5,000 chars', minChars: 4000, maxChars: 5000, targetDurationSec: 300 },
    { label: '8 min', sub: '6,000–7,500 chars', minChars: 6000, maxChars: 7500, targetDurationSec: 480 },
    { label: '10 min', sub: '8,000–9,500 chars', minChars: 8000, maxChars: 9500, targetDurationSec: 600 }
  ]
}

export interface FormatLengthProps {
  template: Template
  /** Channel defaults (Writing tab) used when the format has no length of its own. */
  channelMinChars: number
  channelMaxChars: number
  channelTargetSec: number
  onChanged: () => Promise<void>
}

/** Long/short form and the format's own length window (null = channel default). */
export function FormatLength({ template, channelMinChars, channelMaxChars, channelTargetSec, onChanged }: FormatLengthProps): JSX.Element {
  const [ff, setFf] = useState<FormFactor>(template.formFactor === 'short' ? 'short' : 'long')
  const [minChars, setMin] = useState<number | null>(template.minChars ?? null)
  const [maxChars, setMax] = useState<number | null>(template.maxChars ?? null)
  const [target, setTarget] = useState<number | null>(template.targetDurationSec ?? null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setFf(template.formFactor === 'short' ? 'short' : 'long')
    setMin(template.minChars ?? null)
    setMax(template.maxChars ?? null)
    setTarget(template.targetDurationSec ?? null)
  }, [template.id, template.formFactor, template.minChars, template.maxChars, template.targetDurationSec])

  const dirty = ff !== template.formFactor || minChars !== (template.minChars ?? null) || maxChars !== (template.maxChars ?? null) || target !== (template.targetDurationSec ?? null)
  const effMin = minChars ?? channelMinChars
  const effMax = maxChars ?? channelMaxChars
  const invalid = effMax < effMin
  const usesChannel = minChars === null && maxChars === null && target === null

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.invoke('templates:setLimits', { templateId: template.id, formFactor: ff, minChars, maxChars, targetDurationSec: target })
      toast.success('Format length saved', ff === 'short' ? 'Short form' : 'Long form')
      await onChanged()
    } catch (err) {
      toast.error('Could not save the format length', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="limits-box">
      <div className="row wrap" style={{ justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div className="strong">Video length</div>
          <div className="small muted">
            {usesChannel ? `Uses the channel length (${channelMinChars.toLocaleString('en-US')}–${channelMaxChars.toLocaleString('en-US')} chars · ~${formatDuration(channelTargetSec)}).` : 'This format has its own length; the channel length in the Writing tab stays the default for other formats.'}
          </div>
        </div>
        <div className="segmented" role="tablist" aria-label="Form factor">
          {(['long', 'short'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={ff === k} className={`segment ${ff === k ? 'active' : ''}`} onClick={() => setFf(k)}>
              {k === 'long' ? 'Long form' : 'Short form'}
            </button>
          ))}
        </div>
      </div>
      <div className="preset-row">
        {PRESETS[ff].map((p) => (
          <button
            key={p.label}
            type="button"
            className={`preset ${minChars === p.minChars && maxChars === p.maxChars && target === p.targetDurationSec ? 'active' : ''}`}
            onClick={() => {
              setMin(p.minChars)
              setMax(p.maxChars)
              setTarget(p.targetDurationSec)
            }}
          >
            <span>{p.label}</span>
            <small>{p.sub}</small>
          </button>
        ))}
      </div>
      <div className="row gap-3 wrap" style={{ alignItems: 'flex-start' }}>
        <Field label="Minimum characters" hint={minChars === null ? `Channel: ${channelMinChars.toLocaleString('en-US')}` : undefined} className="grow">
          <NumberInput integer allowEmpty value={minChars} placeholder={String(channelMinChars)} onChange={(v) => setMin(v ?? null)} min={0} max={100000} />
        </Field>
        <Field label="Maximum characters" hint={maxChars === null ? `Channel: ${channelMaxChars.toLocaleString('en-US')}` : undefined} error={invalid ? 'Must be at least the minimum.' : undefined} className="grow">
          <NumberInput integer allowEmpty value={maxChars} placeholder={String(channelMaxChars)} onChange={(v) => setMax(v ?? null)} min={50} max={100000} />
        </Field>
        <Field label="Target duration (seconds)" hint={target !== null ? `≈ ${formatDuration(target)}` : `Channel: ~${formatDuration(channelTargetSec)}`} className="grow">
          <NumberInput integer allowEmpty value={target} placeholder={String(channelTargetSec)} onChange={(v) => setTarget(v ?? null)} min={5} max={3600} />
        </Field>
      </div>
      <div className="row gap-2">
        <Button size="sm" variant="primary" disabled={!dirty || invalid} loading={saving} onClick={() => void save()}>
          Save length
        </Button>
        {!usesChannel && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMin(null)
              setMax(null)
              setTarget(null)
            }}
          >
            Use channel length
          </Button>
        )}
      </div>
    </div>
  )
}
