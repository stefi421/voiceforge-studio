import { useMemo, type JSX } from 'react'
import { FolderOpen, X } from 'lucide-react'
import type { ChannelInput, PronunciationRule, ResearchMode } from '@shared/types'
import { SUGGESTED_OPENAI_MODELS } from '@shared/defaults'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { Alert, Button, Field, Input, NumberInput, Select, Slider, StringListEditor, Switch, Textarea } from '@/components/ui'
import type { FieldErrors } from '../ChannelEditor'
import { formatDuration } from '@/lib/format'

export interface TabProps {
  form: ChannelInput
  patch: (p: Partial<ChannelInput>) => void
  errors: FieldErrors
}

const LANGUAGES = [
  { value: 'en', label: 'English (en)' },
  { value: 'sr', label: 'Serbian (sr)' },
  { value: 'de', label: 'German (de)' },
  { value: 'es', label: 'Spanish (es)' },
  { value: 'fr', label: 'French (fr)' },
  { value: 'it', label: 'Italian (it)' },
  { value: 'pt', label: 'Portuguese (pt)' },
  { value: 'pl', label: 'Polish (pl)' },
  { value: 'tr', label: 'Turkish (tr)' },
  { value: 'ja', label: 'Japanese (ja)' }
]

/* ------------------------------------------------------------------------ */

export function IdentityTab({ form, patch, errors }: TabProps): JSX.Element {
  return (
    <div className="form-grid">
      <Field label="Name" error={errors.name}>
        <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Game Vault" invalid={Boolean(errors.name)} maxLength={80} />
      </Field>
      <div className="row gap-3" style={{ alignItems: 'flex-end' }}>
        <Field label="Icon" hint="An emoji or 1–2 characters." error={errors.icon} className="grow">
          <Input value={form.icon} onChange={(e) => patch({ icon: e.target.value })} maxLength={16} style={{ fontSize: 18 }} />
        </Field>
        <Field label="Color" error={errors.color}>
          <div className="row">
            <input type="color" className="input" value={/^#[0-9a-fA-F]{6}$/.test(form.color) ? form.color : '#7C5CFF'} onChange={(e) => patch({ color: e.target.value.toUpperCase() })} />
            <Input value={form.color} onChange={(e) => patch({ color: e.target.value })} style={{ width: 110 }} className="mono" invalid={Boolean(errors.color)} />
          </div>
        </Field>
      </div>
      <Field label="Description" className="span-2" error={errors.description}>
        <Textarea value={form.description} onChange={(e) => patch({ description: e.target.value })} rows={3} placeholder="What this channel is about and how scripts should feel." />
      </Field>
      <Field label="Category" error={errors.category}>
        <Select
          value={form.category}
          onChange={(v) => patch({ category: v as ChannelInput['category'] })}
          options={[
            { value: 'gaming', label: 'Gaming' },
            { value: 'tech', label: 'Tech' },
            { value: 'other', label: 'Other' }
          ]}
        />
      </Field>
      <Field label="Script language" hint="Language the scripts are written in (also used by validation)." error={errors.language}>
        <Select value={form.language} onChange={(v) => patch({ language: v, validation: { ...form.validation, language: v } })} options={LANGUAGES.some((l) => l.value === form.language) ? LANGUAGES : [{ value: form.language, label: form.language }, ...LANGUAGES]} />
      </Field>
      <div className="span-2">
        <Switch checked={form.archived} onChange={(v) => patch({ archived: v })} label="Archived" description="Archived channels are hidden from pickers but keep their projects and history." />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */

export function WritingTab({ form, patch, errors }: TabProps): JSX.Element {
  const rules = form.pronunciationRules
  const setRule = (i: number, r: Partial<PronunciationRule>): void => {
    const next = rules.map((x, j) => (j === i ? { ...x, ...r } : x))
    patch({ pronunciationRules: next })
  }
  return (
    <div className="col gap-4">
      <Field label="Writing instructions" hint="The core brief for every script on this channel. Sent to the model together with the active template." error={errors.writingInstructions}>
        <Textarea value={form.writingInstructions} onChange={(e) => patch({ writingInstructions: e.target.value })} rows={6} />
      </Field>
      <div className="form-grid">
        <Field label="Writing style" error={errors.writingStyle}>
          <Textarea value={form.writingStyle} onChange={(e) => patch({ writingStyle: e.target.value })} rows={3} placeholder="Natural, energetic spoken review narration." />
        </Field>
        <div />
        <Field label="Intro requirements" error={errors.introRequirements}>
          <Textarea value={form.introRequirements} onChange={(e) => patch({ introRequirements: e.target.value })} rows={3} placeholder='e.g. Open with the fixed intro: "Welcome back to…"' />
        </Field>
        <Field label="Outro requirements" error={errors.outroRequirements}>
          <Textarea value={form.outroRequirements} onChange={(e) => patch({ outroRequirements: e.target.value })} rows={3} placeholder="e.g. Close with a clear verdict." />
        </Field>
        <Field label="Target duration (seconds)" hint={`≈ ${formatDuration(form.targetDurationSec)} at ${form.validation.wordsPerMinute} wpm`} error={errors.targetDurationSec}>
          <NumberInput integer value={form.targetDurationSec} onChange={(v) => patch({ targetDurationSec: v ?? 0 })} min={10} max={3600} />
        </Field>
        <div className="row gap-3">
          <Field label="Min characters" error={errors.minChars} className="grow">
            <NumberInput integer value={form.minChars} onChange={(v) => patch({ minChars: v ?? 0 })} min={0} />
          </Field>
          <Field label="Max characters" error={errors.maxChars} className="grow">
            <NumberInput integer value={form.maxChars} onChange={(v) => patch({ maxChars: v ?? 0 })} min={100} />
          </Field>
        </div>
      </div>
      <Field label="Forbidden phrases" hint="Case-insensitive whole-word matches fail validation (e.g. AAA)." error={errors['validation.forbiddenPhrases']}>
        <StringListEditor values={form.validation.forbiddenPhrases} onChange={(v) => patch({ validation: { ...form.validation, forbiddenPhrases: v } })} placeholder="phrase" addLabel="Add phrase" />
      </Field>
      <Field label="Pronunciation rules" hint="Applied to the text sent to ElevenLabs only; the saved script keeps the original spelling." error={errors.pronunciationRules}>
        <div className="list-editor">
          {rules.map((r, i) => (
            <div key={i} className="list-editor-row">
              <Input value={r.from} placeholder="Written as (e.g. GPU)" onChange={(e) => setRule(i, { from: e.target.value })} />
              <span className="muted">→</span>
              <Input value={r.to} placeholder="Spoken as (e.g. gee pee you)" onChange={(e) => setRule(i, { to: e.target.value })} />
              <Button variant="ghost" iconOnly icon={<X size={14} />} onClick={() => patch({ pronunciationRules: rules.filter((_, j) => j !== i) })} aria-label="Remove" />
            </div>
          ))}
          <div>
            <Button size="sm" onClick={() => patch({ pronunciationRules: [...rules, { from: '', to: '' }] })}>
              Add rule
            </Button>
          </div>
        </div>
      </Field>
    </div>
  )
}

/* ------------------------------------------------------------------------ */

const RESEARCH_MODES: Array<{ value: ResearchMode; label: string; desc: string; tone: 'success' | 'warning' | 'info' }> = [
  { value: 'openai_web_search', label: 'OpenAI web search (recommended)', desc: 'Uses the Responses API web_search tool to collect current facts and sources before writing.', tone: 'success' },
  { value: 'model_knowledge', label: 'Model knowledge only (not recommended)', desc: 'No live search. Faster and cheaper, but facts may be outdated or wrong for new releases.', tone: 'warning' },
  { value: 'manual', label: 'Manual', desc: 'You paste research notes per title on the New Generation page; nothing is looked up.', tone: 'info' }
]

export function ResearchTab({ form, patch, errors }: TabProps): JSX.Element {
  const r = form.research
  const set = (p: Partial<ChannelInput['research']>): void => patch({ research: { ...r, ...p } })
  const current = RESEARCH_MODES.find((m) => m.value === r.mode)
  return (
    <div className="col gap-4">
      <Switch checked={r.enabled} onChange={(v) => set({ enabled: v })} label="Research before writing" description="When off, the writer only gets the title and any manual notes." />
      <Field label="Research mode" error={errors['research.mode']}>
        <Select value={r.mode} onChange={(v) => set({ mode: v as ResearchMode })} options={RESEARCH_MODES.map((m) => ({ value: m.value, label: m.label }))} disabled={!r.enabled} />
      </Field>
      {current && (
        <Alert tone={current.tone}>
          {current.desc}
        </Alert>
      )}
      <div className="form-grid">
        <Slider label="Minimum confidence to continue automatically" min={0} max={1} step={0.05} value={r.minConfidence} onChange={(v) => set({ minConfidence: v })} format={(v) => `${Math.round(v * 100)}%`} hint="Below this, the job stops for your review (if Ask on ambiguity is on) or is marked insufficient." />
        <Field label="Search context size" hint="How much web content the model reads. Higher = more thorough, more tokens.">
          <Select
            value={r.searchContextSize}
            onChange={(v) => set({ searchContextSize: v as ChannelInput['research']['searchContextSize'] })}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]}
            disabled={r.mode !== 'openai_web_search'}
          />
        </Field>
      </div>
      <Switch checked={r.askOnAmbiguity} onChange={(v) => set({ askOnAmbiguity: v })} label="Ask me when a title is ambiguous" description="The job pauses with candidates to choose from instead of guessing." />
      <Field label="Extra research instructions" hint='Appended to the research prompt, e.g. "prefer the Steam store page" or "prioritize the manufacturer product page".' error={errors['research.extraInstructions']}>
        <Textarea value={r.extraInstructions} onChange={(e) => set({ extraInstructions: e.target.value })} rows={3} />
      </Field>
    </div>
  )
}

/* ------------------------------------------------------------------------ */

export function ValidationTab({ form, patch, errors }: TabProps): JSX.Element {
  const v = form.validation
  const set = (p: Partial<ChannelInput['validation']>): void => patch({ validation: { ...v, ...p } })
  return (
    <div className="col gap-4">
      <div className="form-grid">
        <Switch checked={v.forbidUrls} onChange={(x) => set({ forbidUrls: x })} label="Forbid URLs" description="Fail when the script contains links." />
        <Switch checked={v.forbidCitations} onChange={(x) => set({ forbidCitations: x })} label="Forbid citation markers" description="[1], (source: …) and similar." />
        <Switch checked={v.forbidMarkdown} onChange={(x) => set({ forbidMarkdown: x })} label="Forbid markdown" description="#, **, bullets and other formatting." />
        <Switch checked={v.enforceSectionOrder} onChange={(x) => set({ enforceSectionOrder: x })} label="Enforce section order" description="Required sections must appear in the template's order." />
        <Switch checked={v.aiReviewPass} onChange={(x) => set({ aiReviewPass: x })} label="AI review pass" description="Extra model pass that flags unsupported claims (uses the review model)." />
        <Switch checked={v.narrateSectionHeadings} onChange={(x) => set({ narrateSectionHeadings: x })} label="Narrate section headings" description="Keep headings in the text sent to ElevenLabs; off = strip them before TTS." />
      </div>
      <div className="form-grid">
        <Field label="Max automatic rewrite attempts" error={errors['validation.maxRewriteAttempts']}>
          <NumberInput integer value={v.maxRewriteAttempts} onChange={(x) => set({ maxRewriteAttempts: x ?? 0 })} min={0} max={10} />
        </Field>
        <Field label="Words per minute (duration estimate)" error={errors['validation.wordsPerMinute']}>
          <NumberInput integer value={v.wordsPerMinute} onChange={(x) => set({ wordsPerMinute: x ?? 150 })} min={80} max={260} />
        </Field>
        <Field label="Required language code" error={errors['validation.language']}>
          <Input value={v.language} onChange={(e) => set({ language: e.target.value })} maxLength={10} />
        </Field>
      </div>
      <div className="xs subtle">Forbidden phrases are edited on the Writing tab.</div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */

export function OutputTab({ form, patch, errors }: TabProps): JSX.Element {
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.info)
  const hasKey = useApp((s) => s.secrets.openai)
  const models = useAsync(() => api.invoke('openai:listModels', undefined), [hasKey], { enabled: hasKey })
  const modelOptions = useMemo(() => {
    const ids = new Set<string>(SUGGESTED_OPENAI_MODELS)
    for (const m of models.data ?? []) ids.add(m.id)
    if (form.openaiModel) ids.add(form.openaiModel)
    return [{ value: '', label: `Global default (${settings.openai.defaultModel})` }, ...Array.from(ids).sort().map((id) => ({ value: id, label: id }))]
  }, [models.data, form.openaiModel, settings.openai.defaultModel])

  const pickFolder = async (): Promise<void> => {
    try {
      const dir = await api.invoke('app:selectFolder', { title: 'Choose output folder for this channel', defaultPath: form.outputFolder ?? info?.outputRoot })
      if (dir) patch({ outputFolder: dir })
    } catch (err) {
      toast.error('Could not pick folder', err)
    }
  }

  return (
    <div className="col gap-4">
      <Field label="Output folder override" hint={`Leave empty to use the global output root${info ? ` (${info.outputRoot})` : ''}. Each project gets its own subfolder.`} error={errors.outputFolder}>
        <div className="row">
          <Input value={form.outputFolder ?? ''} onChange={(e) => patch({ outputFolder: e.target.value || null })} placeholder="Global default" className="mono" />
          <Button icon={<FolderOpen size={14} />} onClick={pickFolder}>
            Browse
          </Button>
          {form.outputFolder && (
            <Button variant="ghost" onClick={() => patch({ outputFolder: null })}>
              Reset
            </Button>
          )}
        </div>
      </Field>
      <Field label="OpenAI model override" hint="Model used to write scripts for this channel. Research and review models come from Settings." error={errors.openaiModel}>
        <Select value={form.openaiModel ?? ''} onChange={(v) => patch({ openaiModel: v || null })} options={modelOptions} />
      </Field>
      {!hasKey && <Alert tone="info">Add an OpenAI key in Settings to load the live model list; suggested models are shown meanwhile.</Alert>}
    </div>
  )
}
