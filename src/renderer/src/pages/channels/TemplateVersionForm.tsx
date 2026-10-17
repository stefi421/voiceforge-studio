import { type JSX } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import type { ScriptSection, TemplateVersionInput } from '@shared/types'
import { slugify } from '@/lib/format'
import { Button, Checkbox, Field, Input, Switch, Textarea } from '@/components/ui'

export interface TemplateVersionFormProps {
  value: TemplateVersionInput
  onChange: (v: TemplateVersionInput) => void
  errors?: Record<string, string>
}

export function emptyVersion(): TemplateVersionInput {
  return { systemPrompt: '', structure: [], exampleScript: null, notes: '', placeholder: false }
}

export function TemplateVersionForm({ value, onChange, errors = {} }: TemplateVersionFormProps): JSX.Element {
  const set = (p: Partial<TemplateVersionInput>): void => onChange({ ...value, ...p })
  return (
    <div className="col gap-4">
      <Field label="System prompt" hint="Sent to the model as the system message: channel voice, rules, do/don't. The channel's writing instructions and the research data are added separately." error={errors.systemPrompt}>
        <Textarea mono value={value.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} rows={14} style={{ minHeight: 220 }} />
      </Field>
      <Field label="Structure" hint="Ordered sections the script must contain. Keys are generated from labels; aliases are alternative headings the validator accepts." error={errors.structure}>
        <StructureEditor sections={value.structure} onChange={(structure) => set({ structure })} />
      </Field>
      <Field label="Example script (optional)" hint="An approved script used as a style reference for the writer." error={errors.exampleScript}>
        <Textarea value={value.exampleScript ?? ''} onChange={(e) => set({ exampleScript: e.target.value || null })} rows={8} placeholder="Paste an approved script…" />
      </Field>
      <div className="form-grid">
        <Field label="Notes / changelog" error={errors.notes}>
          <Textarea value={value.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} placeholder="What changed in this version and why." />
        </Field>
        <div className="field">
          <span className="field-label">Status</span>
          <Switch checked={Boolean(value.placeholder)} onChange={(v) => set({ placeholder: v })} label="Placeholder" description="Placeholder versions block generation until a real version is active." />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */

export function StructureEditor({ sections, onChange }: { sections: ScriptSection[]; onChange: (s: ScriptSection[]) => void }): JSX.Element {
  const update = (i: number, p: Partial<ScriptSection>): void => onChange(sections.map((s, j) => (j === i ? { ...s, ...p } : s)))
  const move = (i: number, dir: -1 | 1): void => {
    const t = i + dir
    if (t < 0 || t >= sections.length) return
    const next = [...sections]
    const a = next[i]
    const b = next[t]
    if (!a || !b) return
    next[i] = b
    next[t] = a
    onChange(next)
  }
  const add = (): void => onChange([...sections, { key: `section_${sections.length + 1}`, label: '', required: true, aliases: [], guidance: '' }])
  const ensureUniqueKey = (base: string, idx: number): string => {
    let key = base || `section_${idx + 1}`
    let n = 2
    while (sections.some((s, j) => j !== idx && s.key === key)) key = `${base}_${n++}`
    return key
  }
  return (
    <div className="col gap-2">
      {sections.length === 0 && <div className="small muted">No sections. Scripts will be validated for length and forbidden content only.</div>}
      {sections.map((s, i) => (
        <div key={i} className="card card-pad-sm" style={{ background: 'var(--bg-elev-2)' }}>
          <div className="row gap-3" style={{ alignItems: 'flex-start' }}>
            <span className="idx muted small" style={{ paddingTop: 7, width: 20 }}>
              {i + 1}.
            </span>
            <div className="col grow gap-3">
              <div className="row gap-3 wrap">
                <Field label="Label" className="grow">
                  <Input
                    value={s.label}
                    placeholder="e.g. Gameplay"
                    onChange={(e) => {
                      const label = e.target.value
                      update(i, { label, key: ensureUniqueKey(slugify(label), i) })
                    }}
                  />
                </Field>
                <Field label="Key" hint="auto">
                  <Input value={s.key} className="mono" style={{ width: 160 }} onChange={(e) => update(i, { key: slugify(e.target.value) })} />
                </Field>
                <div className="field" style={{ justifyContent: 'flex-end' }}>
                  <span className="field-label">&nbsp;</span>
                  <Checkbox checked={s.required} onChange={(v) => update(i, { required: v })} label="Required" />
                </div>
              </div>
              <Field label="Aliases (comma separated)">
                <Input value={s.aliases.join(', ')} placeholder="Combat & Exploration, Combat and Exploration" onChange={(e) => update(i, { aliases: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
              </Field>
              <Field label="Guidance">
                <Input value={s.guidance} placeholder="What belongs in this section." onChange={(e) => update(i, { guidance: e.target.value })} />
              </Field>
            </div>
            <div className="col" style={{ gap: 0 }}>
              <Button variant="ghost" size="sm" iconOnly icon={<ArrowUp size={12} />} disabled={i === 0} onClick={() => move(i, -1)} title="Move up" />
              <Button variant="ghost" size="sm" iconOnly icon={<ArrowDown size={12} />} disabled={i === sections.length - 1} onClick={() => move(i, 1)} title="Move down" />
              <Button variant="ghost" size="sm" iconOnly icon={<X size={12} />} onClick={() => onChange(sections.filter((_, j) => j !== i))} title="Remove" />
            </div>
          </div>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={add}>
          Add section
        </Button>
      </div>
    </div>
  )
}
