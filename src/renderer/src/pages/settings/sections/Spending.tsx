import { useEffect, useState, type JSX } from 'react'
import { X } from 'lucide-react'
import type { PricingConfig } from '@shared/types'
import { DEFAULT_PRICING } from '@shared/defaults'
import { Alert, Button, Field, Input, NumberInput } from '@/components/ui'
import { useSettingsPatch } from '../useSettingsPatch'
import { DeferredNumber } from './ProviderShared'

export function SpendingSection(): JSX.Element {
  const { settings, set, saving } = useSettingsPatch()
  const sp = settings.spending
  const [pricing, setPricing] = useState<PricingConfig>(sp.pricing)
  const [newModel, setNewModel] = useState('')
  useEffect(() => setPricing(sp.pricing), [sp.pricing])
  const dirty = JSON.stringify(pricing) !== JSON.stringify(sp.pricing)

  const setModel = (id: string, field: 'input' | 'output', v: number): void => {
    const cur = pricing.openai[id] ?? { input: 0, output: 0 }
    setPricing({ ...pricing, openai: { ...pricing.openai, [id]: { ...cur, [field]: v } } })
  }
  const removeModel = (id: string): void => {
    const next = { ...pricing.openai }
    delete next[id]
    setPricing({ ...pricing, openai: next })
  }
  const addModel = (): void => {
    const id = newModel.trim()
    if (!id || pricing.openai[id]) return
    setPricing({ ...pricing, openai: { ...pricing.openai, [id]: { input: 0, output: 0 } } })
    setNewModel('')
  }

  return (
    <div className="settings-section">
      <Alert tone="info" title="Estimates only">
        Costs shown anywhere in the app are computed from this table and token/character counts reported by the providers. They are not invoices. Local limits pause the queue inside this app; they are not provider-side caps.
      </Alert>
      <div className="settings-group">
        <div className="settings-group-title">Local spending limits (USD, estimated)</div>
        <div className="form-grid">
          <Field label="Daily limit" hint="Leave empty for no limit.">
            <DeferredNumber value={sp.dailyLimitUsd} onCommit={(v) => void set('spending', 'dailyLimitUsd', v)} min={0} integer={false} allowEmpty step={0.5} suffix="USD / day" />
          </Field>
          <Field label="Monthly limit" hint="Leave empty for no limit.">
            <DeferredNumber value={sp.monthlyLimitUsd} onCommit={(v) => void set('spending', 'monthlyLimitUsd', v)} min={0} integer={false} allowEmpty step={1} suffix="USD / month" />
          </Field>
        </div>
      </div>
      <div className="settings-group">
        <div className="row-between">
          <div className="settings-group-title">Pricing table</div>
          <div className="row">
            <Button size="sm" variant="ghost" onClick={() => setPricing(DEFAULT_PRICING)}>
              Reset to defaults
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={() => void set('spending', 'pricing', pricing)}>
              Save pricing
            </Button>
          </div>
        </div>
        <Field label="ElevenLabs — USD per 1,000 characters" hint="Depends on your plan (e.g. Creator ≈ $0.30/1k at the included rate). Check your plan page.">
          <NumberInput value={pricing.elevenlabsPer1kChars} onChange={(v) => setPricing({ ...pricing, elevenlabsPer1kChars: v ?? 0 })} min={0} step={0.01} style={{ maxWidth: 200 }} />
        </Field>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>OpenAI model</th>
                <th className="num">Input USD / 1M tokens</th>
                <th className="num">Output USD / 1M tokens</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {Object.entries(pricing.openai)
                .sort(([a], [b]) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
                .map(([id, p]) => (
                  <tr key={id}>
                    <td className="mono">
                      {id}
                      {id === 'default' && <span className="xs muted"> (fallback for unknown models)</span>}
                    </td>
                    <td className="num">
                      <NumberInput value={p.input} onChange={(v) => setModel(id, 'input', v ?? 0)} min={0} step={0.01} inputSize="sm" style={{ width: 120, marginLeft: 'auto' }} />
                    </td>
                    <td className="num">
                      <NumberInput value={p.output} onChange={(v) => setModel(id, 'output', v ?? 0)} min={0} step={0.01} inputSize="sm" style={{ width: 120, marginLeft: 'auto' }} />
                    </td>
                    <td className="actions">{id !== 'default' && <Button size="sm" variant="ghost" iconOnly icon={<X size={12} />} onClick={() => removeModel(id)} title="Remove" />}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <Input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="Add model id, e.g. gpt-5.1" style={{ maxWidth: 260 }} onKeyDown={(e) => { if (e.key === 'Enter') addModel() }} />
          <Button size="sm" onClick={addModel} disabled={!newModel.trim()}>
            Add model
          </Button>
        </div>
      </div>
    </div>
  )
}
