import { useEffect, useMemo, useState, type JSX } from 'react'
import { Copy, Download, FolderOpen, Mic } from 'lucide-react'
import type { Script, ScriptView, ValidationReport } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { estimateDurationSec, formatDateTime, formatDuration, formatNumber, wordCount } from '@/lib/format'
import { Alert, Badge, Button, ConfirmDialog, DiffView, Drawer, Field, Select, SkeletonRows, Tabs, Textarea } from '@/components/ui'
import { CharCounter, countIssues, ValidationIssues } from '@/components/ScriptQuality'
import { RegenerateAudioDialog, type RegenerateAudioTarget } from '@/components/dialogs/RegenerateAudioDialog'

type DrawerTab = 'editor' | 'validation' | 'versions'

export function ScriptDrawer({ scriptId, onClose, onChanged }: { scriptId: string | null; onClose: () => void; onChanged: () => void }): JSX.Element {
  const script = useAsync(() => api.invoke('scripts:get', { id: scriptId ?? '' }), [scriptId], { enabled: Boolean(scriptId) })
  const projectId = script.data?.projectId ?? null
  const versions = useAsync(() => api.invoke('scripts:versions', { projectId: projectId ?? '' }), [projectId, script.data?.version], { enabled: Boolean(projectId) })
  const channel = useApp((s) => (script.data ? s.channels.find((c) => c.id === script.data?.channelId) : undefined))
  const [tab, setTab] = useState<DrawerTab>('editor')
  const [text, setText] = useState('')
  const [validation, setValidation] = useState<ValidationReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [compare, setCompare] = useState<{ a: string; b: string } | null>(null)
  const [regen, setRegen] = useState<RegenerateAudioTarget | null>(null)
  const [confirmForce, setConfirmForce] = useState(false)

  useEffect(() => {
    if (script.data) {
      setText(script.data.text)
      setValidation(script.data.validation)
    }
  }, [script.data])

  useEffect(() => {
    if (scriptId) {
      setTab('editor')
      setCompare(null)
    }
  }, [scriptId])

  const s = script.data
  const dirty = s ? text !== s.text : false
  const wpm = channel?.validation.wordsPerMinute ?? 150
  const stats = useMemo(() => ({ chars: text.length, words: wordCount(text), dur: estimateDurationSec(text, wpm) }), [text, wpm])

  const applySaved = (saved: Script): void => {
    script.setData((prev) => (prev ? { ...prev, ...saved } : prev))
    setValidation(saved.validation)
    onChanged()
  }

  const saveEdit = async (): Promise<Script | null> => {
    if (!s || !dirty) return null
    setBusy('save')
    try {
      const saved = await api.invoke('scripts:saveEdit', { projectId: s.projectId, text, baseScriptId: s.id })
      applySaved(saved)
      toast.success('Saved as new version', `v${saved.version}`)
      return saved
    } catch (err) {
      toast.error('Could not save', err)
      return null
    } finally {
      setBusy(null)
    }
  }

  const validate = async (): Promise<void> => {
    if (!s) return
    setBusy('validate')
    try {
      let id = s.id
      if (dirty) {
        const saved = await api.invoke('scripts:saveEdit', { projectId: s.projectId, text, baseScriptId: s.id })
        applySaved(saved)
        id = saved.id
      }
      const report = await api.invoke('scripts:validate', { scriptId: id })
      setValidation(report)
      setTab('validation')
    } catch (err) {
      toast.error('Validation failed', err)
    } finally {
      setBusy(null)
    }
  }

  const approve = async (force = false): Promise<void> => {
    if (!s) return
    setBusy('approve')
    try {
      let id = s.id
      if (dirty) {
        const saved = await api.invoke('scripts:saveEdit', { projectId: s.projectId, text, baseScriptId: s.id })
        applySaved(saved)
        id = saved.id
      }
      const approved = await api.invoke('scripts:approve', { scriptId: id, force: force || undefined })
      applySaved(approved)
      setConfirmForce(false)
      toast.success(force ? 'Approved with open issues' : 'Script approved')
    } catch (err) {
      const e = err as { message?: string }
      if (!force && /validation/i.test(e?.message ?? '')) setConfirmForce(true)
      else toast.error('Could not approve', err)
    } finally {
      setBusy(null)
    }
  }
  const issueCounts = countIssues(validation)
  const outOfRange = channel ? stats.chars < channel.minChars || stats.chars > channel.maxChars : false

  const restore = async (v: Script): Promise<void> => {
    setBusy(`restore:${v.id}`)
    try {
      const restored = await api.invoke('scripts:restore', { scriptId: v.id })
      applySaved(restored)
      setText(restored.text)
      toast.success('Version restored', `Created v${restored.version} from v${v.version}`)
    } catch (err) {
      toast.error('Could not restore version', err)
    } finally {
      setBusy(null)
    }
  }

  const exportScript = async (): Promise<void> => {
    if (!s) return
    try {
      const path = await api.invoke('app:saveFileDialog', { title: 'Export script', defaultPath: `${s.title}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] })
      if (!path) return
      await api.invoke('scripts:export', { scriptId: s.id, path })
      toast.success('Script exported', path)
    } catch (err) {
      toast.error('Export failed', err)
    }
  }

  const vlist = versions.data ?? []
  const versionOptions = vlist.map((v) => ({ value: v.id, label: `v${v.version} · ${v.status} · ${formatDateTime(v.createdAt)}` }))

  return (
    <>
      <Drawer
        open={Boolean(scriptId)}
        onClose={onClose}
        wide
        title={s ? s.title : 'Script'}
        description={s ? `${s.channelName} · v${s.version} · ${s.source} · ${s.model ?? 'manual'} · ${formatDateTime(s.createdAt)}` : undefined}
        headerExtra={s ? <Badge tone={s.status === 'approved' ? 'success' : s.status === 'invalid' || s.status === 'rejected' ? 'danger' : s.status === 'validated' ? 'info' : 'neutral'}>{s.status}</Badge> : undefined}
        footer={
          s && (
            <>
              <Button variant="ghost" icon={<Copy size={13} />} onClick={() => void api.invoke('app:copyToClipboard', { text }).then(() => toast.success('Copied to clipboard'))}>
                Copy text
              </Button>
              <Button variant="ghost" icon={<Download size={13} />} onClick={exportScript}>
                Export .txt
              </Button>
              {s.filePath && <Button variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void api.invoke('app:showItemInFolder', { path: s.filePath ?? '' })}>Show file</Button>}
              <div className="grow" />
              <Button loading={busy === 'validate'} disabled={busy != null} onClick={validate}>
                Validate
              </Button>
              <Button loading={busy === 'save'} disabled={busy != null || !dirty} onClick={() => void saveEdit()}>
                Save as new version
              </Button>
              {(issueCounts.errors > 0 || outOfRange) && s.status !== 'approved' && (
                <Button variant="secondary" disabled={busy != null} onClick={() => setConfirmForce(true)} title="Approve even though validation reported errors">
                  Approve anyway
                </Button>
              )}
              <Button loading={busy === 'approve'} disabled={busy != null || s.status === 'approved'} onClick={() => void approve(false)}>
                {dirty ? 'Save & approve' : 'Approve'}
              </Button>
              <Button variant="primary" icon={<Mic size={13} />} disabled={busy != null} onClick={() => setRegen({ projectId: s.projectId, scriptId: s.id, title: s.title, channelId: s.channelId, characters: text.length })}>
                Generate voice
              </Button>
            </>
          )
        }
      >
        {script.loading ? (
          <SkeletonRows rows={10} />
        ) : script.error ? (
          <Alert tone="danger" title="Could not load script">{script.error.message}</Alert>
        ) : s ? (
          <>
            <div className="row wrap" style={{ gap: 10 }}>
              {channel ? <CharCounter chars={stats.chars} min={channel.minChars} max={channel.maxChars} /> : <Badge>{formatNumber(stats.chars)} chars</Badge>}
              <Badge>{formatNumber(stats.words)} words</Badge>
              <Badge>~{formatDuration(stats.dur)} at {wpm} wpm</Badge>
              {issueCounts.errors > 0 && <Badge tone="danger">{issueCounts.errors} error(s)</Badge>}
              {issueCounts.warnings > 0 && <Badge tone="warning">{issueCounts.warnings} warning(s)</Badge>}
              {s.templateVersionNumber != null && <Badge>template v{s.templateVersionNumber}</Badge>}
              {dirty && <Badge tone="accent">unsaved edits</Badge>}
            </div>
            <Tabs
              variant="pill"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'editor', label: 'Editor' },
                { id: 'validation', label: 'Validation', badge: issueCounts.errors > 0 ? <Badge tone="danger">{issueCounts.errors}</Badge> : issueCounts.warnings > 0 ? <Badge tone="warning">{issueCounts.warnings}</Badge> : undefined },
                { id: 'versions', label: 'Versions', badge: <Badge>{vlist.length}</Badge> }
              ]}
            />
            {tab === 'editor' && <Textarea className="script-editor" value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 480 }} spellCheck={false} />}
            {tab === 'validation' &&
              (validation ? (
                <div className="col gap-3">
                  <div className="row wrap xs muted">
                    <span>Checked {formatDateTime(validation.checkedAt)}</span>
                    <span>· {validation.charCount} chars · {validation.wordCount} words · ~{formatDuration(validation.estimatedDurationSec)}</span>
                    {validation.sectionsFound.length > 0 && <span>· sections: {validation.sectionsFound.join(', ')}</span>}
                  </div>
                  <ValidationIssues report={validation} />
                </div>
              ) : (
                <Alert tone="info" actions={<Button size="sm" onClick={validate} loading={busy === 'validate'}>Validate now</Button>}>
                  This version has not been validated yet.
                </Alert>
              ))}
            {tab === 'versions' && (
              <div className="col gap-3">
                {vlist.length >= 2 && (
                  <div className="form-grid">
                    <Field label="Compare: older">
                      <Select value={compare?.a ?? vlist[1]?.id ?? ''} onChange={(v) => setCompare({ a: v, b: compare?.b ?? vlist[0]?.id ?? '' })} options={versionOptions} />
                    </Field>
                    <Field label="Compare: newer">
                      <Select value={compare?.b ?? vlist[0]?.id ?? ''} onChange={(v) => setCompare({ a: compare?.a ?? vlist[1]?.id ?? '', b: v })} options={versionOptions} />
                    </Field>
                  </div>
                )}
                {vlist.length >= 2 && (
                  <DiffView
                    oldText={vlist.find((v) => v.id === (compare?.a ?? vlist[1]?.id))?.text ?? ''}
                    newText={vlist.find((v) => v.id === (compare?.b ?? vlist[0]?.id))?.text ?? ''}
                    oldLabel={`v${vlist.find((v) => v.id === (compare?.a ?? vlist[1]?.id))?.version ?? ''}`}
                    newLabel={`v${vlist.find((v) => v.id === (compare?.b ?? vlist[0]?.id))?.version ?? ''}`}
                  />
                )}
                <div className="version-list">
                  {vlist.map((v) => (
                    <div key={v.id} className={`version-row ${v.id === s.id ? 'active' : ''}`}>
                      <span className="strong">v{v.version}</span>
                      <Badge tone={v.status === 'approved' ? 'success' : v.status === 'invalid' ? 'danger' : 'neutral'}>{v.status}</Badge>
                      <span className="xs muted">{v.source}</span>
                      <span className="xs muted">{formatNumber(v.charCount)} chars</span>
                      <span className="xs muted grow">{formatDateTime(v.createdAt)}</span>
                      {v.id !== s.id && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => { script.setData({ ...s, ...v } as ScriptView); setText(v.text); setValidation(v.validation) }}>
                            Open
                          </Button>
                          <Button size="sm" loading={busy === `restore:${v.id}`} onClick={() => restore(v)}>
                            Restore
                          </Button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      </Drawer>
      <RegenerateAudioDialog target={regen} onClose={() => setRegen(null)} />
      <ConfirmDialog
        open={confirmForce}
        onClose={() => setConfirmForce(false)}
        onConfirm={() => approve(true)}
        title="Approve with open issues?"
        message={`The validator reports ${issueCounts.errors} error(s)${outOfRange && channel ? ` and the length (${formatNumber(stats.chars)}) is outside ${formatNumber(channel.minChars)}–${formatNumber(channel.maxChars)}` : ''}. Approved scripts can be voiced as they are.`}
        confirmLabel="Approve anyway"
      />
    </>
  )
}
