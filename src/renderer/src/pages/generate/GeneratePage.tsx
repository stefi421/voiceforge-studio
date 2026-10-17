import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react'
import { Bot, ClipboardPaste, Eraser, FileInput, ListChecks, Sparkles, TriangleAlert } from 'lucide-react'
import type { BatchEstimate, CreateBatchInput, JobMode, TemplateVersion } from '@shared/types'
import { JOB_MODE_LABELS } from '@shared/defaults'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { MODE_DESCRIPTIONS } from '@/lib/jobs'
import { formatCost, formatNumber } from '@/lib/format'
import { activeChannels, useApp } from '@/store/app'
import { navigate, useRouter } from '@/store/router'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, Card, ChannelIcon, Checkbox, Dialog, EmptyState, Field, Input, Kbd, PageHeader, Textarea } from '@/components/ui'
import { TitleList, newRowId, type TitleRow } from './TitleList'
import { E2EChecklist } from './E2EChecklist'

const MODES: JobMode[] = ['auto', 'review_before_voice', 'scripts_only']

interface ChannelTemplateInfo {
  name: string | null
  placeholder: boolean
  missing: boolean
}

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
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [parseInfo, setParseInfo] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [estimate, setEstimate] = useState<BatchEstimate | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!channelId && live[0]) setChannelId(live[0].id)
  }, [live, channelId])

  // Template status per channel (placeholder detection).
  const templateInfo = useAsync(async () => {
    const out: Record<string, ChannelTemplateInfo> = {}
    await Promise.all(
      live.map(async (c) => {
        if (!c.activeTemplateVersionId) {
          out[c.id] = { name: null, placeholder: false, missing: true }
          return
        }
        try {
          const [templates, version] = await Promise.all([
            api.invoke('templates:list', { channelId: c.id }),
            api.invoke('templates:getVersion', { versionId: c.activeTemplateVersionId })
          ])
          const t = templates.find((x) => x.id === (version as TemplateVersion).templateId)
          out[c.id] = { name: t?.name ?? null, placeholder: version.placeholder, missing: false }
        } catch {
          out[c.id] = { name: null, placeholder: false, missing: true }
        }
      })
    )
    return out
  }, [live.map((c) => `${c.id}:${c.activeTemplateVersionId}`).join('|')])

  const selectedChannel = live.find((c) => c.id === channelId)
  const selectedTemplate = templateInfo.data?.[channelId]

  /** Sync textarea → rows (keeps per-row channel assignments for titles that still exist). */
  const syncRows = useCallback(
    (nextText: string) => {
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
    },
    []
  )

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
      applyTitles(
        parsed.titles,
        `${parsed.titles.length} unique title(s). Removed ${parsed.duplicatesRemoved.length} duplicate(s)${parsed.blankLinesRemoved ? ` and ${parsed.blankLinesRemoved} blank line(s)` : ''}.`
      )
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
      toast.info('Excel files', 'Use the Import file button for .xlsx so the main process can parse it.')
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

  const buildInput = (): CreateBatchInput | null => {
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
      manualResearchNotes: Object.keys(cleanNotes).length ? cleanNotes : undefined
    }
  }

  const selectedCount = rows.filter((r) => r.selected && r.title.trim()).length
  const blockers: string[] = []
  if (!secrets.openai) blockers.push('OpenAI API key is missing (Settings → OpenAI).')
  if (!secrets.elevenlabs && mode !== 'scripts_only') blockers.push('ElevenLabs API key is missing (Settings → ElevenLabs).')
  if (selectedTemplate?.placeholder) blockers.push(`The active template "${selectedTemplate.name ?? ''}" is a placeholder. Open the channel's Template Editor and create a real version first.`)
  if (selectedTemplate?.missing) blockers.push('This channel has no active template version.')
  if (selectedChannel && !selectedChannel.elevenVoiceId && mode !== 'scripts_only') blockers.push(`${selectedChannel.name} has no ElevenLabs voice selected.`)

  const startEstimate = async (): Promise<void> => {
    const input = buildInput()
    if (!input) {
      toast.warning('Nothing to generate', 'Add at least one title and select it.')
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

  // Ctrl+Enter = Generate all
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

  if (live.length === 0) {
    return (
      <div className="page">
        <PageHeader title="New Generation" subtitle="Turn a list of titles into scripts and voiceovers" />
        <Card>
          <EmptyState icon={<Sparkles size={22} />} title="Create a channel first" description="Each generation runs against a channel's writing rules, template and voice." actions={<Button variant="primary" onClick={() => navigate('channels', { edit: 'new' })}>Add channel</Button>} />
        </Card>
      </div>
    )
  }

  return (
    <div className="page fade-in">
      <PageHeader
        title="New Generation"
        subtitle="Paste titles, pick a channel and a mode, review the estimate, go."
        actions={
          <Button variant="primary" size="lg" icon={<Sparkles size={15} />} loading={busy === 'estimate'} disabled={selectedCount === 0 || busy != null} onClick={startEstimate}>
            Generate {selectedCount > 0 ? `${selectedCount} ` : ''}
            <span style={{ opacity: 0.7, marginLeft: 6 }}>
              <Kbd>Ctrl</Kbd> <Kbd>↵</Kbd>
            </span>
          </Button>
        }
      />

      {settings.advanced.manualE2EMode && <E2EChecklist />}

      {/* Step 1 */}
      <Card>
        <div className="card-header">
          <div className="card-title">
            <span className="step-badge">1</span> Choose channel
          </div>
          {selectedChannel && (
            <Button size="sm" variant="ghost" onClick={() => navigate('channels', { edit: selectedChannel.id })}>
              Edit channel
            </Button>
          )}
        </div>
        <div className="card-body">
          <div className="grid grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {live.map((c) => {
              const info = templateInfo.data?.[c.id]
              const warn = !c.elevenVoiceId || info?.placeholder || info?.missing
              return (
                <Card key={c.id} padded="sm" hover selected={c.id === channelId} onClick={() => setChannelId(c.id)}>
                  <div className="row gap-3">
                    <ChannelIcon icon={c.icon} color={c.color} />
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <span className="strong truncate">{c.name}</span>
                      <span className="xs muted truncate">{c.elevenVoiceName ?? 'No voice'} · {c.category}</span>
                    </div>
                    {warn && <TriangleAlert size={14} className="text-warning" style={{ marginLeft: 'auto', flex: '0 0 auto' }} />}
                  </div>
                  <div className="row wrap mt-2" style={{ gap: 4 }}>
                    {!c.elevenVoiceId && <Badge tone="warning">no voice</Badge>}
                    {info?.placeholder && <Badge tone="warning" title={info.name ?? ''}>placeholder template</Badge>}
                    {info?.missing && <Badge tone="danger">no template</Badge>}
                    {info && !info.placeholder && !info.missing && <Badge tone="success">{info.name ?? 'template ok'}</Badge>}
                  </div>
                </Card>
              )
            })}
          </div>
          {blockers.length > 0 && (
            <Alert tone="warning" title="Before you start" style={{ marginTop: 16 }}>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </Alert>
          )}
        </div>
      </Card>

      {/* Step 2 */}
      <Card>
        <div className="card-header">
          <div className="card-title">
            <span className="step-badge">2</span> Titles
            <Badge>{rows.length}</Badge>
          </div>
          <div className="row">
            <Button size="sm" icon={<ClipboardPaste size={13} />} onClick={paste}>
              Paste from clipboard
            </Button>
            <Button size="sm" icon={<FileInput size={13} />} onClick={importFile}>
              Import file
            </Button>
            <Button size="sm" icon={<ListChecks size={13} />} loading={busy === 'dedupe'} disabled={!text.trim()} onClick={dedupe}>
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
        <div className="card-body col gap-4">
          <div
            className={`dropzone ${over ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              rows={8}
              placeholder={'One title per line, e.g.\nHollow Knight: Silksong\nKeychron Q1 HE\nClair Obscur: Expedition 33\n\n…or drop a .txt / .csv file here.'}
              style={{ minHeight: 160 }}
            />
          </div>
          {parseInfo && <div className="small muted">{parseInfo}</div>}
          {rows.length > 0 && (
            <>
              <div className="row-between">
                <span className="small muted">
                  {selectedCount} of {rows.length} selected. Each row can target a different channel.
                </span>
                <Checkbox checked={showNotes} onChange={setShowNotes} label="Manual research notes per title" />
              </div>
              <TitleList rows={rows} channels={live} batchChannelId={channelId} onChange={setRows} notes={notes} onNotesChange={setNotes} showNotes={showNotes} />
            </>
          )}
        </div>
      </Card>

      {/* Step 3 */}
      <Card>
        <div className="card-header">
          <div className="card-title">
            <span className="step-badge">3</span> Mode & options
          </div>
        </div>
        <div className="card-body col gap-4">
          <div className="grid grid-3">
            {MODES.map((m) => (
              <button key={m} type="button" className={`mode-card ${mode === m ? 'selected' : ''}`} onClick={() => setMode(m)}>
                <span className="mode-card-title">
                  <Bot size={14} /> {JOB_MODE_LABELS[m]}
                  {settings.generation.defaultMode === m && <Badge>default</Badge>}
                </span>
                <span className="mode-card-desc">{MODE_DESCRIPTIONS[m]}</span>
              </button>
            ))}
          </div>
          <div className="form-grid">
            <Field label="Batch name (optional)">
              <Input value={batchName} onChange={(e) => setBatchName(e.target.value)} placeholder={`e.g. ${selectedChannel?.name ?? 'Channel'} – ${new Date().toLocaleDateString('en-GB')}`} maxLength={120} />
            </Field>
            <div className="field">
              <span className="field-label">Duplicates</span>
              <Checkbox checked={skipExisting} onChange={setSkipExisting} label="Skip titles that already have a completed project in this channel" />
              <span className="field-hint">Titles are matched case-insensitively against existing project titles.</span>
            </div>
          </div>
        </div>
      </Card>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={needsConfirm ? 'Confirm this batch' : 'Ready to start'}
        description={estimate ? `${estimate.jobs} job(s) · ${JOB_MODE_LABELS[mode]} · ${selectedChannel?.name ?? ''}` : undefined}
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
                <span className="stat-value" style={{ fontSize: 20 }}>{formatCost(estimate.estimatedOpenAICost)}</span>
              </div>
              <div className="stat" style={{ padding: 0 }}>
                <span className="stat-label">ElevenLabs</span>
                <span className="stat-value" style={{ fontSize: 20 }}>{formatCost(estimate.estimatedElevenCost)}</span>
                <span className="stat-sub">~{formatNumber(estimate.estimatedCharacters)} characters</span>
              </div>
              <div className="stat" style={{ padding: 0 }}>
                <span className="stat-label">Total</span>
                <span className="stat-value" style={{ fontSize: 20 }}>{formatCost(estimate.estimatedTotal)}</span>
              </div>
            </div>
            <div className="xs subtle">Costs are estimates derived from your pricing table and average script length; actual provider billing may differ.</div>
            {estimate.jobs >= settings.generation.largeBatchWarningThreshold && (
              <Alert tone="warning" title="Large batch">
                {estimate.jobs} jobs is at or above your large-batch threshold ({settings.generation.largeBatchWarningThreshold}). Consider splitting the batch or using Review Before Voice.
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
