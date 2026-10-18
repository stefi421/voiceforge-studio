import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react'
import { ChevronDown, ChevronRight, ClipboardPaste, Eraser, Eye, FileInput, FileText, ListChecks, Sparkles, TriangleAlert, Zap } from 'lucide-react'
import type { BatchEstimate, CreateBatchInput, JobMode } from '@shared/types'
import { modeLabel } from '@/lib/jobs'
import { allowsAuto, allowsMode, allowsSupervised, blockReason, contentTypeLabel, loadFormats } from '@/lib/formats'
import { FormatStatusPill } from '@/components/FormatStatus'
import { api } from '@/lib/api'
import { useAsync, useDebouncedValue } from '@/lib/hooks'
import { formatCost, formatNumber } from '@/lib/format'
import { activeChannels, useApp } from '@/store/app'
import { navigate, useRouter } from '@/store/router'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, Card, ChannelIcon, Checkbox, Dialog, EmptyState, Field, Input, Kbd, PageHeader, Textarea } from '@/components/ui'
import { TitleList, newRowId, type TitleRow } from './TitleList'
import { E2EChecklist } from './E2EChecklist'

const MODES: Array<{ id: JobMode; icon: JSX.Element; line: string }> = [
  { id: 'auto', icon: <Zap size={15} />, line: 'Research, write, validate, voice and save — no stops unless a title is ambiguous.' },
  { id: 'review_before_voice', icon: <Eye size={15} />, line: 'Same, but every script waits for your approval before ElevenLabs characters are spent.' },
  { id: 'scripts_only', icon: <FileText size={15} />, line: 'Research and write the scripts only. Voice any of them later from the Scripts page.' }
]

export function GeneratePage(): JSX.Element {
  const channels = useApp((s) => s.channels)
  const settings = useApp((s) => s.settings)
  const secrets = useApp((s) => s.secrets)
  const params = useRouter((s) => s.params)
  const live = useMemo(() => activeChannels(channels), [channels])

  const [channelId, setChannelId] = useState<string>(params.channelId ?? live[0]?.id ?? '')
  const [text, setText] = useState('')
  const [rows, setRows] = useState<TitleRow[]>([])
  const [mode, setMode] = useState<JobMode>(settings.generation.defaultMode)
  const [skipExisting, setSkipExisting] = useState(true)
  const [batchName, setBatchName] = useState('')
  const [showNotes, setShowNotes] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [parseInfo, setParseInfo] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [estimate, setEstimate] = useState<BatchEstimate | null>(null)
  const [liveEstimate, setLiveEstimate] = useState<BatchEstimate | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!channelId && live[0]) setChannelId(live[0].id)
  }, [live, channelId])

  // Formats (content types) per channel with their approval status.
  const formatsKey = live.map((c) => `${c.id}:${c.activeTemplateVersionId}:${c.updatedAt}`).join('|')
  const formats = useAsync(() => loadFormats(live), [formatsKey], { fallback: {} })
  const channelFormats = useMemo(() => formats.data?.[channelId] ?? [], [formats.data, channelId])
  const [templateId, setTemplateId] = useState<string | null>(params.templateId ?? null)

  // Keep the chosen format valid for the chosen channel (default format otherwise).
  useEffect(() => {
    if (channelFormats.length === 0) return
    if (templateId && channelFormats.some((f) => f.template.id === templateId)) return
    setTemplateId((channelFormats.find((f) => f.isDefault) ?? channelFormats[0])!.template.id)
  }, [channelFormats, templateId])

  const selectedChannel = live.find((c) => c.id === channelId)
  const selectedFormat = channelFormats.find((f) => f.template.id === templateId) ?? null
  const formatStatus = selectedFormat?.status ?? (formats.data && !formats.loading ? 'not_configured' : null)
  const formatsReady = Boolean(formats.data && formats.data[channelId])

  // A format that is not approved cannot run unattended: fall back to Review before voice.
  useEffect(() => {
    if (!formatStatus || mode !== 'auto') return
    if (!allowsAuto(formatStatus) && allowsSupervised(formatStatus)) {
      setMode('review_before_voice')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatStatus, templateId])

  /** Sync textarea → rows (keeps per-row channel assignments for titles that still exist). */
  const syncRows = useCallback((nextText: string) => {
    const lines = nextText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    setRows((prev) => {
      const byTitle = new Map(prev.map((r) => [r.title, r]))
      return lines.map((title) => {
        const existing = byTitle.get(title)
        return existing ? { ...existing } : { id: newRowId(), title, channelId: null, selected: true }
      })
    })
  }, [])

  const onTextChange = (v: string): void => {
    setText(v)
    setParseInfo(null)
    syncRows(v)
  }

  const applyTitles = (titles: string[], info?: string): void => {
    const v = titles.join('\n')
    setText(v)
    syncRows(v)
    if (info) setParseInfo(info)
  }

  const paste = async (): Promise<void> => {
    try {
      const clip = await api.invoke('app:readClipboard', undefined)
      if (!clip.trim()) {
        toast.warning('Clipboard is empty')
        return
      }
      onTextChange(text ? `${text.trimEnd()}\n${clip}` : clip)
    } catch (err) {
      toast.error('Could not read clipboard', err)
    }
  }

  const importFile = async (): Promise<void> => {
    try {
      const paths = await api.invoke('app:selectFiles', {
        title: 'Import titles',
        filters: [
          { name: 'Title lists', extensions: ['txt', 'csv', 'xlsx'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      const path = paths[0]
      if (!path) return
      const parsed = await api.invoke('generation:importTitles', { path })
      const merged = [...rows.map((r) => r.title), ...parsed.titles]
      applyTitles(merged, `Imported ${parsed.titles.length} titles${parsed.duplicatesRemoved.length ? `, ${parsed.duplicatesRemoved.length} duplicates removed` : ''}.`)
    } catch (err) {
      toast.error('Import failed', err)
    }
  }

  const dedupe = async (): Promise<void> => {
    setBusy('dedupe')
    try {
      const parsed = await api.invoke('generation:parseTitles', { text })
      applyTitles(parsed.titles, `${parsed.titles.length} unique title(s). Removed ${parsed.duplicatesRemoved.length} duplicate(s)${parsed.blankLinesRemoved ? ` and ${parsed.blankLinesRemoved} blank line(s)` : ''}.`)
    } catch (err) {
      toast.error('Could not parse titles', err)
    } finally {
      setBusy(null)
    }
  }

  const onDrop = async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const name = file.name.toLowerCase()
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      toast.info('Excel files', 'Use Import file for .xlsx so the main process can parse it.')
      return
    }
    try {
      const content = await file.text()
      onTextChange(text ? `${text.trimEnd()}\n${content}` : content)
      toast.success('File loaded', file.name)
    } catch {
      toast.error('Could not read dropped file')
    }
  }

  const buildInput = useCallback((): CreateBatchInput | null => {
    if (!channelId) return null
    const entries = rows.filter((r) => r.selected && r.title.trim()).map((r) => ({ title: r.title.trim(), channelId: r.channelId }))
    if (entries.length === 0) return null
    const cleanNotes: Record<string, string> = {}
    for (const e of entries) {
      const n = notes[e.title]
      if (n?.trim()) cleanNotes[e.title] = n.trim()
    }
    return {
      name: batchName.trim() || undefined,
      channelId,
      mode,
      entries,
      skipExisting,
      manualResearchNotes: Object.keys(cleanNotes).length ? cleanNotes : undefined,
      templateId: templateId ?? undefined
    }
  }, [channelId, rows, notes, batchName, mode, skipExisting, templateId])

  const selectedCount = rows.filter((r) => r.selected && r.title.trim()).length

  // Live estimate line under the titles box (debounced, never blocks).
  const estimateKey = useDebouncedValue(`${channelId}|${templateId ?? ''}|${mode}|${rows.filter((r) => r.selected).map((r) => `${r.title}@${r.channelId ?? ''}`).join('\n')}`, 500)
  useEffect(() => {
    let cancelled = false
    const input = buildInput()
    if (!input) {
      setLiveEstimate(null)
      return
    }
    api
      .invoke('generation:estimate', input)
      .then((est) => {
        if (!cancelled) setLiveEstimate(est)
      })
      .catch(() => {
        if (!cancelled) setLiveEstimate(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey])

  const blockers: string[] = []
  if (!secrets.openai) blockers.push('OpenAI API key is missing (Settings → OpenAI).')
  if (!secrets.elevenlabs && mode !== 'scripts_only') blockers.push('ElevenLabs API key is missing (Settings → ElevenLabs).')
  const formatBlock = formatsReady && formatStatus && !allowsSupervised(formatStatus) ? blockReason(formatStatus, mode) : formatsReady && channelFormats.length === 0 ? 'This channel has no format yet. Add one and import approved reference scripts.' : null
  if (formatBlock) blockers.push(formatBlock)
  if (selectedChannel && !selectedChannel.elevenVoiceId && mode !== 'scripts_only') blockers.push(`${selectedChannel.name} has no ElevenLabs voice selected.`)

  const startEstimate = async (): Promise<void> => {
    const input = buildInput()
    if (!input) {
      toast.warning('Nothing to generate', 'Add at least one title.')
      return
    }
    setBusy('estimate')
    try {
      const est = await api.invoke('generation:estimate', input)
      setEstimate(est)
      setConfirmOpen(true)
    } catch (err) {
      toast.error('Could not estimate batch', err)
    } finally {
      setBusy(null)
    }
  }

  const createBatch = async (): Promise<void> => {
    const input = buildInput()
    if (!input) return
    setBusy('create')
    try {
      const res = await api.invoke('generation:createBatch', input)
      setConfirmOpen(false)
      toast.success('Batch started', `${res.jobIds.length} job(s) queued${res.skipped.length ? `, ${res.skipped.length} skipped (already completed)` : ''}.`)
      void useApp.getState().refreshJobs({ batchId: res.batchId })
      navigate('queue', { batchId: res.batchId })
    } catch (err) {
      toast.error('Could not start batch', err)
    } finally {
      setBusy(null)
    }
  }

  // Ctrl+Enter = Generate
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        if (!confirmOpen && busy == null && selectedCount > 0) void startEstimate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmOpen, busy, selectedCount, rows, channelId, mode, skipExisting, batchName, notes])

  const needsConfirm = Boolean(estimate && (estimate.warnings.length > 0 || estimate.jobs >= settings.generation.largeBatchWarningThreshold))
  const blocked = blockers.length > 0

  if (live.length === 0) {
    return (
      <div className="page">
        <PageHeader title="New generation" subtitle="Turn a list of titles into scripts and voiceovers" />
        <Card>
          <EmptyState icon={<Sparkles size={22} />} title="Create a channel first" description="Each generation runs against a channel's writing rules, template and voice." actions={<Button variant="primary" onClick={() => navigate('channels', { edit: 'new' })}>Add channel</Button>} />
        </Card>
      </div>
    )
  }

  const generateButton = (size: 'md' | 'lg'): JSX.Element => (
    <Button variant="primary" size={size} icon={<Sparkles size={15} />} loading={busy === 'estimate'} disabled={selectedCount === 0 || busy != null || blocked} onClick={startEstimate} title={blocked ? blockers[0] : undefined}>
      Generate{selectedCount > 0 ? ` ${selectedCount} ${selectedCount === 1 ? 'title' : 'titles'}` : ''}
      <span style={{ opacity: 0.7, marginLeft: 8 }}>
        <Kbd>Ctrl</Kbd> <Kbd>↵</Kbd>
      </span>
    </Button>
  )

  return (
    <div className="page fade-in gen-page">
      <PageHeader title="New generation" subtitle="Pick a channel, paste titles, choose how much you want to check, go." actions={generateButton('md')} />

      {settings.advanced.manualE2EMode && <E2EChecklist />}

      <div className="gen-column">
        {/* Channel */}
        <section className="gen-section">
          <div className="gen-label">
            <span>Channel</span>
            {selectedChannel && (
              <Button size="sm" variant="ghost" onClick={() => navigate('channels', { edit: selectedChannel.id })}>
                Edit {selectedChannel.name}
              </Button>
            )}
          </div>
          <div className="channel-chips">
            {live.map((c) => {
              const fs = formats.data?.[c.id]
              const def = fs ? (fs.find((f) => f.isDefault) ?? fs[0]) : undefined
              const notReady = Boolean(fs) && (!def || !allowsSupervised(def.status))
              const warn = !c.elevenVoiceId || notReady
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`channel-chip ${c.id === channelId ? 'selected' : ''}`}
                  onClick={() => {
                    setChannelId(c.id)
                    setTemplateId(null)
                  }}
                  title={warn ? (notReady ? 'Format needs references or approval' : 'No voice') : `${c.elevenVoiceName ?? 'No voice'} · ${c.elevenModelId}`}
                >
                  <ChannelIcon icon={c.icon} color={c.color} size="sm" />
                  <span className="channel-chip-name">{c.name}</span>
                  {warn ? <TriangleAlert size={12} className="text-warning" /> : <span className="channel-chip-voice">{c.elevenVoiceName ?? ''}</span>}
                </button>
              )
            })}
          </div>
          {selectedChannel && channelFormats.length > 1 && (
            <div className="format-picker" role="radiogroup" aria-label="Format">
              <span className="xs muted">Format</span>
              {channelFormats.map((f) => (
                <button key={f.template.id} type="button" role="radio" aria-checked={f.template.id === templateId} className={`filter-chip ${f.template.id === templateId ? 'active' : ''}`} onClick={() => setTemplateId(f.template.id)} title={f.template.name}>
                  {contentTypeLabel(f.template.contentType)}
                </button>
              ))}
            </div>
          )}
          {selectedChannel && (
            <div className="row wrap gen-channel-meta">
              {formatStatus && <FormatStatusPill status={formatStatus} prefix={selectedFormat ? contentTypeLabel(selectedFormat.template.contentType) : undefined} />}
              <span className="xs muted">
                Voice: {selectedChannel.elevenVoiceName ?? 'none'} · {formatNumber(selectedChannel.minChars)}–{formatNumber(selectedChannel.maxChars)} chars
              </span>
              {formatStatus && allowsSupervised(formatStatus) && !allowsAuto(formatStatus) && (
                <Button size="sm" variant="ghost" onClick={() => navigate('channels', { edit: channelId, tab: 'formats', format: templateId ?? undefined })}>
                  {formatStatus === 'not_configured' || formatStatus === 'references_imported' ? 'Verify with reference scripts' : 'Approve this format'}
                </Button>
              )}
            </div>
          )}
          {blocked && (
            <Alert
              tone="warning"
              title="Before you can generate"
              actions={
                formatBlock ? (
                  <Button size="sm" variant="primary" onClick={() => navigate('channels', { edit: channelId, tab: 'formats', format: templateId ?? undefined })}>
                    Import references
                  </Button>
                ) : !secrets.openai || !secrets.elevenlabs ? (
                  <Button size="sm" onClick={() => navigate('settings', { tab: !secrets.openai ? 'openai' : 'elevenlabs' })}>
                    Open settings
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => navigate('channels', { edit: channelId, tab: 'voice' })}>
                    Pick a voice
                  </Button>
                )
              }
            >
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </Alert>
          )}
        </section>

        {/* Titles */}
        <section className="gen-section">
          <div className="gen-label">
            <span>Titles</span>
            <div className="row">
              <Button size="sm" variant="ghost" icon={<ClipboardPaste size={13} />} onClick={paste}>
                Paste
              </Button>
              <Button size="sm" variant="ghost" icon={<FileInput size={13} />} onClick={importFile}>
                Import file
              </Button>
              <Button size="sm" variant="ghost" icon={<ListChecks size={13} />} loading={busy === 'dedupe'} disabled={!text.trim()} onClick={dedupe}>
                Remove duplicates
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Eraser size={13} />}
                disabled={!text}
                onClick={() => {
                  onTextChange('')
                  setNotes({})
                }}
              >
                Clear
              </Button>
            </div>
          </div>
          <div
            className={`dropzone ${over ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <Textarea ref={textareaRef} className="titles-box" value={text} onChange={(e) => onTextChange(e.target.value)} rows={8} placeholder={'One title per line, e.g.\nHollow Knight: Silksong\nKeychron Q1 HE\nClair Obscur: Expedition 33\n\n…or drop a .txt / .csv file here.'} spellCheck={false} />
          </div>
          <div className="gen-live-line">
            <span className="tnum">
              {selectedCount} {selectedCount === 1 ? 'title' : 'titles'}
            </span>
            {liveEstimate && selectedCount > 0 && (
              <>
                <span className="muted">·</span>
                <span className="tnum" title="Estimated from your pricing table and average script length">
                  ~{formatCost(liveEstimate.estimatedTotal)} est.
                </span>
                {(liveEstimate.estimatedSeconds ?? 0) > 0 && (
                  <>
                    <span className="muted">·</span>
                    <span className="tnum" title="Wall-clock estimate with your concurrency settings; improves as the app learns real stage times">
                      {batchTime(liveEstimate.estimatedSeconds)}
                    </span>
                  </>
                )}
                {mode !== 'scripts_only' && (
                  <>
                    <span className="muted">·</span>
                    <span className="muted tnum">~{formatNumber(liveEstimate.estimatedCharacters)} ElevenLabs characters</span>
                  </>
                )}
              </>
            )}
            {parseInfo && (
              <>
                <span className="muted">·</span>
                <span className="muted">{parseInfo}</span>
              </>
            )}
          </div>
        </section>

        {/* Mode */}
        <section className="gen-section">
          <div className="gen-label">
            <span>How much do you want to check?</span>
          </div>
          <div className="mode-cards">
            {MODES.map((m) => {
              const disabled = Boolean(formatStatus) && !allowsMode(formatStatus!, m.id)
              const why = disabled && formatStatus ? blockReason(formatStatus, m.id) : null
              return (
                <button key={m.id} type="button" className={`mode-card ${mode === m.id ? 'selected' : ''} ${disabled ? 'disabled' : ''}`} onClick={() => !disabled && setMode(m.id)} aria-disabled={disabled} title={why ?? undefined}>
                  <span className="mode-card-title">
                    {m.icon} {modeLabel(m.id)}
                    {settings.generation.defaultMode === m.id && !disabled && <Badge>default</Badge>}
                    {disabled && <Badge tone="warning">{formatStatus && allowsSupervised(formatStatus) ? 'needs approval' : 'not available'}</Badge>}
                  </span>
                  <span className="mode-card-desc">{disabled && m.id === 'auto' && formatStatus && allowsSupervised(formatStatus) ? 'Available once this format is approved in the Formats tab.' : m.line}</span>
                </button>
              )
            })}
          </div>
        </section>

        {/* Advanced */}
        <section className="gen-section">
          <button type="button" className="gen-advanced-toggle" onClick={() => setAdvanced(!advanced)}>
            {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Advanced options
            <span className="xs muted">batch name · per-title channel · research notes · duplicates</span>
          </button>
          {advanced && (
            <div className="col gap-4 mt-2">
              <div className="form-grid">
                <Field label="Batch name (optional)">
                  <Input value={batchName} onChange={(e) => setBatchName(e.target.value)} placeholder={`e.g. ${selectedChannel?.name ?? 'Channel'} – ${new Date().toLocaleDateString('en-GB')}`} maxLength={120} />
                </Field>
                <div className="field">
                  <span className="field-label">Duplicates</span>
                  <Checkbox checked={skipExisting} onChange={setSkipExisting} label="Skip titles that already have a completed project in this channel" />
                </div>
              </div>
              {rows.length > 0 ? (
                <>
                  <div className="row-between">
                    <span className="small muted">
                      {selectedCount} of {rows.length} selected. Each row can target a different channel.
                    </span>
                    <Checkbox checked={showNotes} onChange={setShowNotes} label="Manual research notes per title" />
                  </div>
                  <TitleList rows={rows} channels={live} batchChannelId={channelId} onChange={setRows} notes={notes} onNotesChange={setNotes} showNotes={showNotes} />
                </>
              ) : (
                <span className="small muted">Add titles above to assign channels or research notes per title.</span>
              )}
            </div>
          )}
        </section>

        <div className="gen-footer">{generateButton('lg')}</div>
      </div>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={needsConfirm ? 'Confirm this batch' : 'Ready to start'}
        description={estimate ? `${estimate.jobs} job(s) · ${modeLabel(mode)} · ${selectedChannel?.name ?? ''}${selectedFormat && channelFormats.length > 1 ? ` · ${contentTypeLabel(selectedFormat.template.contentType)}` : ''}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy === 'create'}>
              Back
            </Button>
            <Button variant="primary" data-autofocus loading={busy === 'create'} onClick={createBatch}>
              Start generation
            </Button>
          </>
        }
      >
        {estimate && (
          <>
            <div className="grid grid-3">
              <div className="stat" style={{ padding: 0 }}>
                <span className="stat-label">OpenAI</span>
                <span className="stat-value" style={{ fontSize: 20 }}>
                  {formatCost(estimate.estimatedOpenAICost)}
                </span>
              </div>
              <div className="stat" style={{ padding: 0 }}>
                <span className="stat-label">ElevenLabs</span>
                <span className="stat-value" style={{ fontSize: 20 }}>
                  {formatCost(estimate.estimatedElevenCost)}
                </span>
                <span className="stat-sub">~{formatNumber(estimate.estimatedCharacters)} characters from your plan</span>
              </div>
              <div className="stat" style={{ padding: 0 }}>
                <span className="stat-label">Total</span>
                <span className="stat-value" style={{ fontSize: 20 }}>
                  {formatCost(estimate.estimatedTotal)}
                </span>
                {(estimate.estimatedSeconds ?? 0) > 0 && <span className="stat-sub">{batchTime(estimate.estimatedSeconds)}</span>}
              </div>
            </div>
            <div className="xs subtle">Estimates from your pricing table and average script length. ElevenLabs characters come out of your subscription; OpenAI is billed per token.</div>
            {estimate.jobs >= settings.generation.largeBatchWarningThreshold && (
              <Alert tone="warning" title="Large batch">
                {estimate.jobs} jobs is at or above your large-batch threshold ({settings.generation.largeBatchWarningThreshold}). Consider splitting it or using Review before voice.
              </Alert>
            )}
            {estimate.warnings.map((w, i) => (
              <Alert key={i} tone="warning">
                {w}
              </Alert>
            ))}
          </>
        )}
      </Dialog>
    </div>
  )
}

/** "~4 min for this batch" (rounded up, never "0 min"). */
function batchTime(seconds: number | undefined): string {
  const s = Math.max(0, seconds ?? 0)
  if (s < 90) return `~${Math.max(1, Math.round(s / 10) * 10)} s for this batch`
  const m = Math.ceil(s / 60)
  return m < 90 ? `~${m} min for this batch` : `~${(m / 60).toFixed(1)} h for this batch`
}
