import { useEffect, useMemo, useState, type JSX } from 'react'
import { ArrowRight, Lock, LockOpen, ScanSearch, Volume2, VolumeX } from 'lucide-react'
import type { FixedTextBlock, RuleProvenance, ScriptSection, StyleAnalysis, StyleFinding, Template } from '@shared/types'
import { api } from '@/lib/api'
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format'
import { toast } from '@/store/toasts'
import { Alert, Button, EmptyState, Field, ProgressBar, Textarea } from '@/components/ui'
import { ProvenanceBadge } from '@/components/FormatStatus'
import { StructureEditor } from '../TemplateVersionForm'

export interface AnalyzeStepProps {
  template: Template
  refCount: number
  analysis: StyleAnalysis | null
  channelInstructions: string
  onAnalyzed: () => Promise<void>
  onUse: (a: StyleAnalysis, edited: { structure: ScriptSection[]; systemPrompt: string; fixedBlocks: FixedTextBlock[] }) => void
  onGoToReferences: () => void
}

const ASPECT_LABEL: Record<string, string> = {
  opening_wording: 'Opening wording',
  opening_length: 'Opening length',
  fixed_intro: 'Fixed introductory text',
  variable_intro: 'Variable introductory text',
  section_names: 'Section names',
  section_order: 'Section order',
  paragraph_structure: 'Paragraph structure',
  sentence_length: 'Sentence length',
  vocabulary: 'Vocabulary',
  narration_perspective: 'Narration perspective',
  perspective: 'Narration perspective',
  transitions: 'Transition patterns',
  transition_patterns: 'Transition patterns',
  critical_tone: 'Critical tone',
  tone: 'Tone',
  humor: 'Humour',
  closing_wording: 'Closing wording',
  calls_to_action: 'Calls to action',
  character_count: 'Character count',
  word_count: 'Word count',
  duration: 'Narration duration',
  formatting: 'Formatting rules',
  prohibited_patterns: 'Patterns to avoid'
}

export function aspectLabel(a: string): string {
  return ASPECT_LABEL[a] ?? a.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

const PROV_ORDER: Record<RuleProvenance, number> = { user_confirmed: 0, consistent: 1, inferred: 2, unknown: 3 }

const KIND_LABEL: Record<FixedTextBlock['kind'], string> = { intro: 'Intro', outro: 'Outro', heading: 'Heading', transition: 'Transition', cta: 'Call to action', other: 'Other' }

export function AnalyzeStep({ template, refCount, analysis, channelInstructions, onAnalyzed, onUse, onGoToReferences }: AnalyzeStepProps): JSX.Element {
  const [instructions, setInstructions] = useState(channelInstructions)
  const [busy, setBusy] = useState(false)
  const [structure, setStructure] = useState<ScriptSection[]>([])
  const [prompt, setPrompt] = useState('')
  const [blocks, setBlocks] = useState<FixedTextBlock[]>([])

  useEffect(() => {
    if (!analysis) return
    setStructure(analysis.suggestedStructure.map((s) => ({ ...s, aliases: [...s.aliases] })))
    setPrompt(analysis.suggestedSystemPrompt)
    setBlocks(analysis.fixedBlocks.map((b) => ({ ...b })))
  }, [analysis])

  const grouped = useMemo(() => {
    const m = new Map<string, StyleFinding[]>()
    for (const f of analysis?.findings ?? []) {
      const list = m.get(f.aspect) ?? []
      list.push(f)
      m.set(f.aspect, list)
    }
    for (const list of m.values()) list.sort((a, b) => PROV_ORDER[a.provenance] - PROV_ORDER[b.provenance])
    return [...m.entries()]
  }, [analysis])

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.invoke('style:analyze', { templateId: template.id, instructions: instructions.trim() || undefined })
      await onAnalyzed()
      toast.success('Analysis finished', 'Review the findings, lock the fixed text you want enforced, then continue.')
    } catch (err) {
      toast.error('Analysis failed', err)
    } finally {
      setBusy(false)
    }
  }

  if (refCount === 0) {
    return (
      <EmptyState
        icon={<ScanSearch size={22} />}
        title="Add references first"
        description="The analysis only reads your approved scripts. Without them it would have to guess the structure, which this app never does."
        actions={<Button variant="primary" onClick={onGoToReferences}>Add reference scripts</Button>}
      />
    )
  }

  const toggle = (id: string, patch: Partial<FixedTextBlock>): void => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)))

  return (
    <div className="col gap-4">
      <div className="row-between wrap" style={{ alignItems: 'flex-start' }}>
        <div style={{ maxWidth: 640 }}>
          <div className="section-title">Analyze the references</div>
          <div className="section-sub">
            Compares all {refCount} reference script{refCount === 1 ? '' : 's'}: exactly repeated text is detected locally, then OpenAI describes the structure and style. Every finding is labelled with where it comes from; only text you lock is enforced. Uses a small amount of OpenAI usage.
          </div>
        </div>
        <Button variant={analysis ? 'secondary' : 'primary'} icon={<ScanSearch size={14} />} loading={busy} onClick={run}>
          {analysis ? 'Analyze again' : 'Analyze references'}
        </Button>
      </div>

      <Field label="Writing instructions you already follow (optional)" hint="Rules you state here are marked “User confirmed”. Leave empty to rely on the references only.">
        <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder="e.g. Always open with the channel greeting; never use the term AAA." />
      </Field>

      {busy && (
        <div className="col gap-2">
          <ProgressBar value={0} indeterminate />
          <span className="xs muted">Reading {refCount} script{refCount === 1 ? '' : 's'} and comparing them… this usually takes under a minute.</span>
        </div>
      )}

      {!analysis && !busy && <EmptyState compact icon={<ScanSearch size={20} />} title="Not analysed yet" description="Run the analysis to see the extracted structure, fixed text and style findings." />}

      {analysis && (
        <>
          <div className="mini-stat-strip">
            <MiniStat label="References" value={String(analysis.stats.count)} />
            <MiniStat label="Characters" value={`${formatNumber(analysis.stats.minChars)}–${formatNumber(analysis.stats.maxChars)}`} sub={`avg ${formatNumber(Math.round(analysis.stats.avgChars))}`} />
            <MiniStat label="Words (avg)" value={formatNumber(Math.round(analysis.stats.avgWords))} />
            <MiniStat label="Narration (avg)" value={formatDuration(analysis.stats.avgDurationSec)} />
            <MiniStat label="Reference set" value={`v${analysis.referenceSetVersion}`} sub={formatDateTime(analysis.analyzedAt)} />
          </div>

          {analysis.caveats.length > 0 && (
            <Alert tone="warning" title="Read before approving">
              <ul className="plain-list">
                {analysis.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </Alert>
          )}

          <section className="col gap-2">
            <div className="section-title">Fixed text</div>
            <div className="section-sub">Text repeated word for word across references. Locked blocks must appear verbatim in every script; unlocked ones are only shown to the writer as examples.</div>
            {blocks.length === 0 ? (
              <div className="small muted">No exactly repeated text was found.</div>
            ) : (
              <div className="fixed-list">
                {blocks.map((b) => (
                  <FixedBlockRow key={b.id} block={b} onToggleLock={() => toggle(b.id, { locked: !b.locked })} onToggleSpoken={() => toggle(b.id, { spoken: !b.spoken })} />
                ))}
              </div>
            )}
          </section>

          <section className="col gap-2">
            <div className="section-title">Findings</div>
            <div className="legend-row">
              <ProvenanceBadge provenance="user_confirmed" />
              <ProvenanceBadge provenance="consistent" />
              <ProvenanceBadge provenance="inferred" />
              <ProvenanceBadge provenance="unknown" />
              <span className="xs subtle">Inferred findings are suggestions from limited evidence, not rules.</span>
            </div>
            {grouped.length === 0 ? (
              <div className="small muted">No findings returned.</div>
            ) : (
              <div className="findings">
                {grouped.map(([aspect, list]) => (
                  <div key={aspect} className="finding-group">
                    <div className="finding-aspect">{aspectLabel(aspect)}</div>
                    <div className="col gap-2">
                      {list.map((f, i) => (
                        <div key={i} className={`finding finding-${f.provenance}`}>
                          <div className="row gap-2" style={{ alignItems: 'flex-start' }}>
                            <span className="grow">{f.finding}</span>
                            <ProvenanceBadge provenance={f.provenance} />
                          </div>
                          {f.evidence && <q className="finding-evidence">{f.evidence}</q>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {analysis.unknowns.length > 0 && (
            <section className="col gap-2">
              <div className="section-title">Unverified</div>
              <div className="section-sub">The references did not settle these. They stay marked as unverified until you confirm them.</div>
              <ul className="unverified-list">
                {analysis.unknowns.map((u, i) => (
                  <li key={i}>
                    <span className="unverified-tag">Unverified</span> {u}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="col gap-2">
            <div className="section-title">Suggested structure</div>
            <StructureEditor sections={structure} onChange={setStructure} />
          </section>

          <Field label="Suggested master prompt" hint="Edit freely; it is saved only when you create a version in the next step.">
            <Textarea mono value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={14} />
          </Field>

          <div className="row-between">
            <span className="xs subtle">Nothing is saved or activated yet.</span>
            <Button variant="primary" icon={<ArrowRight size={14} />} onClick={() => onUse(analysis, { structure, systemPrompt: prompt, fixedBlocks: blocks })}>
              Use this for review
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */

export function FixedBlockRow({ block, onToggleLock, onToggleSpoken, disabled }: { block: FixedTextBlock; onToggleLock: () => void; onToggleSpoken: () => void; disabled?: boolean }): JSX.Element {
  return (
    <div className={`fixed-block ${block.locked ? 'locked' : ''}`}>
      <div className="fixed-block-meta">
        <span className="strong small">{KIND_LABEL[block.kind] ?? block.kind}</span>
        <ProvenanceBadge provenance={block.provenance} />
        <span className="xs muted">{block.occurrences > 0 ? `in ${block.occurrences} reference${block.occurrences === 1 ? '' : 's'}` : 'typed by you'}</span>
        <span className="grow" />
        <Button size="sm" variant="ghost" icon={block.spoken ? <Volume2 size={12} /> : <VolumeX size={12} />} onClick={onToggleSpoken} disabled={disabled} title={block.spoken ? 'Read aloud by ElevenLabs' : 'Kept in Script.txt, not read aloud'}>
          {block.spoken ? 'Spoken' : 'Not spoken'}
        </Button>
        <Button size="sm" variant={block.locked ? 'primary' : 'secondary'} icon={block.locked ? <Lock size={12} /> : <LockOpen size={12} />} onClick={onToggleLock} disabled={disabled}>
          {block.locked ? 'Locked' : 'Lock'}
        </Button>
      </div>
      <blockquote className="fixed-block-text">{block.text}</blockquote>
    </div>
  )
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="mini-stat">
      <span className="mini-stat-label">{label}</span>
      <span className="mini-stat-value tnum">{value}</span>
      {sub && <span className="xs subtle">{sub}</span>}
    </div>
  )
}
