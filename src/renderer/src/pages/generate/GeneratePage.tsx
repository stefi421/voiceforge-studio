import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react'
import { BookmarkCheck, ChevronDown, ChevronRight, ClipboardPaste, Eraser, Eye, FileInput, FileText, HelpCircle, ListChecks, RefreshCw, Search, Sparkles, TriangleAlert, Zap } from 'lucide-react'
import type { BatchEstimate, CreateBatchInput, GameMatch, JobMode, PreflightResult } from '@shared/types'
import { PreflightChecklist } from '@/components/SpeedViews'
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

  // 1.6.0: start from the last channel / format / mode used (unless a link chose a channel).
  const remembered = settings.ui
  const rememberedChannel = remembered?.lastChannelId && live.some((c) => c.id === remembered.lastChannelId) ? remembered.lastChannelId : null
  const [channelId, setChannelId] = useState<string>(params.channelId ?? rememberedChannel ?? live[0]?.id ?? '')
  const [text, setText] = useState('')
  const [rows, setRows] = useState<TitleRow[]>([])
  const [mode, setMode] = useState<JobMode>(remembered?.lastMode ?? settings.generation.defaultMode)
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
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)
  const preflightSeq = useRef(0)
  const [busy, setBusy] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!channelId && live[0]) setChannelId(live[0].id)
  }, [live, channelId])

  // Formats (content types) per channel with their approval status.
  const formatsKey = live.map((c) => `${c.id}:${c.activeTemplateVersionId}:${c.updatedAt}`).join('|')
  const formats = useAsync(() => loadFormats(live), [formatsKey], { fallback: {} })
  const channelFormats = useMemo(() => formats.data?.[channelId] ?? [], [formats.data, channelId])
  const [templateId, setTemplateId] = useState<string | null>(params.templateId ?? (!params.channelId && rememberedChannel ? (remembered?.lastTemplateId ?? null) : null))

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

  // Game Library: which titles reuse saved research (no research credits) — debounced, never blocks.
  const [matches, setMatches] = useState<Record<string, GameMatch>>({})
  const matchKey = useDebouncedValue(`${channelId}|${rows.filter((r) => r.selected).map((r) => `${r.title}@${r.channelId ?? ''}`).join('\n')}`, 350)
  useEffect(() => {
    let cancelled = false
    const groups = new Map<string, string[]>()
    for (const r of rows) {
      if (!r.selected || !r.title.trim()) continue
      const ch = r.channelId ?? channelId
      if (!ch) continue
      groups.set(ch, [...(groups.get(ch) ?? []), r.title.trim()])
    }
    if (groups.size === 0) {
      setMatches({})
      return
    }
    Promise.all([...groups.entries()].map(([ch, titles]) => api.invoke('games:match', { titles, channelId: ch }).then((res) => res.map((m) => [`${ch}|${m.title}`, m] as const))))
      .then((all) => {
        if (!cancelled) setMatches(Object.fromEntries(all.flat()))
      })
      .catch(() => {
        if (!cancelled) setMatches({})
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey])
  const matchOf = (r: TitleRow): GameMatch | undefined => matches[`${r.channelId ?? channelId}|${r.title.trim()}`]
  const selectedRows = rows.filter((r) => r.selected && r.title.trim())
  const savedCount = selectedRows.filter((r) => {
    const k = matchOf(r)?.kind
    return k === 'exact' || k === 'auto'
  }).length
  const askCount = selectedRows.filter((r) => matchOf(r)?.kind === 'near').length

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
    setPreflight(null)
    runPreflight(input)
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

  /** Pre-flight checks (v1.5). Runs alongside the estimate; the dialog shows a spinner until done. */
  const runPreflight = (input: CreateBatchInput): void => {
    const seq = ++preflightSeq.current
    setPreflightLoading(true)
    api
      .invoke('generation:preflight', input)
      .then((r) => {
        if (seq === preflightSeq.current) setPreflight(r)
      })
      .catch((err) => {
        if (seq !== preflightSeq.current) return
        // Never block on a broken check: show it as a warning and let the server decide at start.
        setPreflight({ checks: [{ key: 'format', label: 'Pre-flight checks', status: 'warning', message: err instanceof Error ? err.message : 'Could not run the checks.', overridable: false }], canStart: true, needsOverride: false, checkedAt: new Date().toISOString() })
      })
      .finally(() => {
        if (seq === preflightSeq.current) setPreflightLoading(false)
      })
  }

  const createBatch = async (startAnyway = false): Promise<void> => {
    const base = buildInput()
    if (!base) return
    const input: CreateBatchInput = startAnyway ? { ...base, startAnyway: true } : base
    setBusy('create')
    try {
      const res = await api.invoke('generation:createBatch', input)
      setConfirmOpen(false)
      toast.success('Batch started', `${res.jobIds.length} job(s) queued${res.skipped.length ? `, ${res.skipped.length} skipped (already completed)` : ''}.`)
      void useApp.getState().refreshJobs({ batchId: res.batchId })
      navigate('queue', { batchId: res.batchId })
    } catch (err) {
      toast.error('Could not start batch', err)
      // The server re-checks at start; refresh the list so the dialog shows why.
      runPreflight(input)
    } finally {
      setBusy(null)
    }
  }

  // Ctrl+Enter = Generate; in the confirmation dialog Ctrl+Enter = Start generation.
  const blockedNow = blockers.length > 0
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return
      e.preventDefault()
      if (busy != null) return
      if (confirmOpen) {
        if (!preflightLoading && preflight && preflight.canStart && !preflight.needsOverride) void createBatch(false)
      } else if (selectedCount > 0 && !blockedNow) void startEstimate()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmOpen, busy, selectedCount, rows, channelId, templateId, mode, skipExisting, batchName, notes, preflight, preflightLoading, blockedNow])

  // Titles handed over in a link (e.g. "generate?titles=A%0AB") pre-fill the list.
  useEffect(() => {
    if (params.titles?.trim()) applyTitles(params.titles.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.titles])

  // "Paste & generate" from the Dashboard: titles from the clipboard, then straight to the confirmation.
  const [autoStart, setAutoStart] = useState(false)
  const pasteNonce = useRouter((st) => st.nonce)
  useEffect(() => {
    if (params.paste !== '1') return
    let cancelled = false
    void api
      .invoke('app:readClipboard', undefined)
      .then((clip) => {
        if (cancelled) return
        if (!clip.trim()) {
          toast.warning('Clipboard is empty', 'Copy your list of titles first, one per line.')
          return
        }
        applyTitles(clip.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
        setAutoStart(true)
      })
      .catch((err) => toast.error('Could not read clipboard', err))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.paste, pasteNonce])
  useEffect(() => {
    if (!autoStart || !formatsReady || selectedCount === 0) return
    setAutoStart(false)
    if (!blockedNow) void startEstimate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, formatsReady, selectedCount, blockedNow])

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
            {selectedCount > 0 && Object.keys(matches).length > 0 && (
              <>
                <span className="muted">·</span>
                <span className="tnum" title="Saved research is reused — no research credits and no research wait">
                  {savedCount} saved research · {selectedCount - savedCount} new{askCount ? ` (${askCount} to confirm)` : ''}
                </span>
              </>
            )}
            {liveEstimate && selectedCount > 0 && (
              <>
                <span className="muted">·</span>
                <span className="tnum" title="Estimated from your pricing table and average script length">
                  ~{formatCost(liveEstimate.estimatedTotal)}
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
          {selectedRows.length > 0 && Object.keys(matches).length > 0 && (
            <ul className="title-research-list" aria-label="Research per title">
              {selectedRows.slice(0, 12).map((r) => (
                <li key={r.id}>
                  <span className="truncate">{r.title}</span>
                  <ResearchTag match={matchOf(r)} />
                </li>
              ))}
              {selectedRows.length > 12 && (
                <li className="muted">
                  …and {selectedRows.length - 12} more{savedCount ? ` (${savedCount} with saved research in total)` : ''}
                </li>
              )}
            </ul>
          )}
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
            <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => { const i = buildInput(); if (i) runPreflight(i) }} disabled={preflightLoading || busy === 'create'}>
              Check again
            </Button>
            {preflight?.needsOverride ? (
              <Button variant="danger" loading={busy === 'create'} onClick={() => void createBatch(true)}>
                Start anyway
              </Button>
            ) : (
              <Button variant="primary" data-autofocus loading={busy === 'create'} disabled={preflightLoading || (preflight != null && !preflight.canStart)} onClick={() => void createBatch(false)} title={preflight && !preflight.canStart ? 'Fix the problems marked in red first' : preflightLoading ? 'Running checks…' : undefined}>
                Start generation
              </Button>
            )}
          </>
        }
      >
        <PreflightChecklist result={preflight} loading={preflightLoading} />
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
            {(estimate.savedResearch ?? 0) > 0 && (
              <Alert tone="success" title={`${estimate.savedResearch} of ${estimate.jobs} ${estimate.jobs === 1 ? 'title uses' : 'titles use'} saved research`}>
                No research credits and no research wait for {estimate.savedResearch === 1 ? 'it' : 'them'} — only {estimate.newResearch ?? 0} new {(estimate.newResearch ?? 0) === 1 ? 'title is' : 'titles are'} researched (already included in the estimate).
              </Alert>
            )}
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

function ResearchTag({ match }: { match: GameMatch | undefined }): JSX.Element | null {
  if (!match) return null
  if (match.kind === 'exact' || match.kind === 'auto')
    return (
      <span className="research-tag saved" title={match.kind === 'auto' && match.canonicalTitle ? `Matches saved research for "${match.canonicalTitle}"` : 'Researched before — reused, no credits'}>
        <BookmarkCheck size={12} /> Saved research{match.kind === 'auto' && match.canonicalTitle ? ` · ${match.canonicalTitle}` : ''}
      </span>
    )
  if (match.kind === 'near')
    return (
      <span className="research-tag ask" title={`Might be: ${match.candidates.map((c) => c.canonicalTitle).join(' / ')}. You'll be asked once.`}>
        <HelpCircle size={12} /> Similar saved game — you'll confirm once
      </span>
    )
  return (
    <span className="research-tag new" title="Researched once, then saved for next time">
      <Search size={12} /> New research
    </span>
  )
}

/** "~4 min for this batch" (rounded up, never "0 min"). */
function batchTime(seconds: number | undefined): string {
  const s = Math.max(0, seconds ?? 0)
  if (s < 90) return `~${Math.max(1, Math.round(s / 10) * 10)} s for this batch`
  const m = Math.ceil(s / 60)
  return m < 90 ? `~${m} min for this batch` : `~${(m / 60).toFixed(1)} h for this batch`
}
