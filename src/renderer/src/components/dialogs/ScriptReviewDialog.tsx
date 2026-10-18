import { useEffect, useMemo, useState, type JSX } from 'react'
import { Sparkles } from 'lucide-react'
import type { JobView, Script, ValidationReport } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { toast } from '@/store/toasts'
import { useApp } from '@/store/app'
import { Alert, Badge, Button, ConfirmDialog, Dialog, Field, SkeletonRows, Textarea } from '@/components/ui'
import { estimateDurationSec, formatDuration, formatNumber, wordCount } from '@/lib/format'
import { CharCounter, countIssues, ValidationIssues } from '@/components/ScriptQuality'
import { NarrationToggle, NarrationView, ScriptProvenance, type ScriptView } from '@/components/ScriptMeta'

export { ValidationIssues } from '@/components/ScriptQuality'

export interface ScriptReviewDialogProps {
  job: JobView | null
  onClose: () => void
}

/**
 * Review a script that is waiting for approval (review_before_voice mode), or look at
 * a finished one. Edits are saved as a new version before approving. A script with
 * validation errors can still be approved on purpose ("Approve anyway" → force).
 */
export function ScriptReviewDialog({ job, onClose }: ScriptReviewDialogProps): JSX.Element {
  const scriptId = job?.scriptId ?? null
  const script = useAsync(() => api.invoke('scripts:get', { id: scriptId ?? '' }), [scriptId], { enabled: Boolean(scriptId) })
  const channel = useApp((s) => (job ? s.channels.find((c) => c.id === job.channelId) : undefined))
  const [text, setText] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [validation, setValidation] = useState<ValidationReport | null>(null)
  const [confirmForce, setConfirmForce] = useState(false)
  const [view, setView] = useState<ScriptView>('script')

  useEffect(() => {
    if (script.data) {
      setText(script.data.text)
      setValidation(script.data.validation)
    }
  }, [script.data])

  useEffect(() => {
    if (job) {
      setFeedback('')
      setBusy(null)
      setConfirmForce(false)
      setView('script')
    }
  }, [job])

  const dirty = script.data ? text !== script.data.text : false
  const wpm = channel?.validation.wordsPerMinute ?? 150
  const stats = useMemo(() => ({ chars: text.length, words: wordCount(text), dur: estimateDurationSec(text, wpm) }), [text, wpm])
  const issues = countIssues(validation)
  const hasErrors = issues.errors > 0 || (channel ? text.length > channel.maxChars || text.length < channel.minChars : false)

  const saveEditIfNeeded = async (): Promise<Script | null> => {
    if (!job || !script.data || !dirty) return null
    return api.invoke('scripts:saveEdit', { projectId: job.projectId, text, baseScriptId: script.data.id })
  }

  const approve = async (force: boolean): Promise<void> => {
    if (!job) return
    setBusy('approve')
    try {
      const saved = await saveEditIfNeeded()
      const updated = await api.invoke('queue:approveScript', { jobId: job.id, force: force || undefined })
      useApp.getState().upsertJob(updated)
      toast.success(saved ? 'Edited script approved' : force ? 'Approved with open issues' : 'Script approved', `"${job.title}" continues to audio generation.`)
      setConfirmForce(false)
      onClose()
    } catch (err) {
      const e = err as { code?: string; message?: string }
      if (!force && /validation/i.test(e?.message ?? '')) {
        // Main refused because of validation errors: offer the explicit override.
        setConfirmForce(true)
      } else {
        toast.error('Could not approve script', err)
      }
    } finally {
      setBusy(null)
    }
  }

  const reject = async (): Promise<void> => {
    if (!job) return
    if (!feedback.trim()) {
      toast.warning('Feedback required', 'Tell the writer what to change so the rewrite can improve.')
      return
    }
    setBusy('reject')
    try {
      const updated = await api.invoke('queue:rejectScript', { jobId: job.id, feedback: feedback.trim() })
      useApp.getState().upsertJob(updated)
      toast.info('Rewrite queued', 'The script is being rewritten with your feedback.')
      onClose()
    } catch (err) {
      toast.error('Could not reject script', err)
    } finally {
      setBusy(null)
    }
  }

  const regenerate = async (): Promise<void> => {
    if (!job) return
    setBusy('regen')
    try {
      const updated = await api.invoke('queue:regenerateScript', { jobId: job.id, feedback: feedback.trim() || undefined })
      useApp.getState().upsertJob(updated)
      toast.info('Fixing with AI', 'A fresh script is being written from the research data.')
      onClose()
    } catch (err) {
      toast.error('Could not regenerate script', err)
    } finally {
      setBusy(null)
    }
  }

  const saveOnly = async (): Promise<void> => {
    if (!job) return
    setBusy('save')
    try {
      const saved = await saveEditIfNeeded()
      if (saved) {
        script.setData((prev) => (prev ? { ...prev, ...saved } : prev))
        setValidation(saved.validation)
        toast.success('Saved as new version', `Version ${saved.version}`)
      }
    } catch (err) {
      toast.error('Could not save edit', err)
    } finally {
      setBusy(null)
    }
  }

  const validate = async (): Promise<void> => {
    if (!script.data) return
    setBusy('validate')
    try {
      const saved = dirty ? await saveEditIfNeeded() : null
      const id = saved?.id ?? script.data.id
      if (saved) script.setData((prev) => (prev ? { ...prev, ...saved } : prev))
      const report = await api.invoke('scripts:validate', { scriptId: id })
      setValidation(report)
      const c = countIssues(report)
      toast[report.ok ? 'success' : 'warning'](report.ok ? 'Validation passed' : 'Validation found issues', c.errors || c.warnings ? `${c.errors} error(s), ${c.warnings} warning(s)` : undefined)
    } catch (err) {
      toast.error('Validation failed', err)
    } finally {
      setBusy(null)
    }
  }

  const interactive = job?.status === 'awaiting_approval'
  // A job that failed validation can still be edited and approved on purpose (the "Approve anyway…" fix).
  const failedValidation = job?.status === 'failed' && job.lastError?.kind === 'validation'

  return (
    <>
      <Dialog
        open={Boolean(job)}
        onClose={onClose}
        size="xl"
        title={interactive ? 'Review script before voice' : failedValidation ? 'Script did not pass validation' : 'Script'}
        description={job ? `"${job.title}" · ${job.channelName}${script.data ? ` · version ${script.data.version}` : ''}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy != null}>
              {interactive ? 'Later' : 'Close'}
            </Button>
            <Button onClick={validate} loading={busy === 'validate'} disabled={busy != null || !script.data}>
              Validate
            </Button>
            <Button onClick={saveOnly} loading={busy === 'save'} disabled={busy != null || !dirty}>
              Save edit
            </Button>
            {interactive && (
              <>
                <div className="grow" />
                <Button icon={<Sparkles size={13} />} onClick={regenerate} loading={busy === 'regen'} disabled={busy != null}>
                  Fix with AI
                </Button>
                <Button variant="danger-soft" onClick={reject} loading={busy === 'reject'} disabled={busy != null}>
                  Reject with feedback
                </Button>
                {hasErrors && (
                  <Button variant="secondary" onClick={() => setConfirmForce(true)} disabled={busy != null || !script.data} title="Approve even though validation reported errors">
                    Approve anyway
                  </Button>
                )}
                <Button variant="primary" onClick={() => void approve(false)} loading={busy === 'approve'} disabled={busy != null || !script.data}>
                  {dirty ? 'Save & approve' : 'Approve'} → voice
                </Button>
              </>
            )}
            {failedValidation && (
              <>
                <div className="grow" />
                <Button variant={hasErrors ? 'primary' : 'secondary'} onClick={() => setConfirmForce(true)} disabled={busy != null || !script.data || !hasErrors} title="Continue with this script even though validation reported errors">
                  Approve anyway
                </Button>
                {!hasErrors && (
                  <Button variant="primary" onClick={() => void approve(false)} loading={busy === 'approve'} disabled={busy != null || !script.data}>
                    {dirty ? 'Save & approve' : 'Approve'}
                  </Button>
                )}
              </>
            )}
          </>
        }
      >
        {script.loading ? (
          <SkeletonRows rows={8} />
        ) : script.error ? (
          <Alert tone="danger" title="Could not load script">
            {script.error.message}
          </Alert>
        ) : !script.data ? (
          <Alert tone="info">This job has no script yet.</Alert>
        ) : (
          <>
            <div className="row wrap" style={{ gap: 10 }}>
              {channel ? <CharCounter chars={stats.chars} min={channel.minChars} max={channel.maxChars} /> : <Badge>{formatNumber(stats.chars)} chars</Badge>}
              <Badge>{formatNumber(stats.words)} words</Badge>
              <Badge>
                ~{formatDuration(stats.dur)} at {wpm} wpm
              </Badge>
              {dirty && <Badge tone="accent">unsaved edits</Badge>}
              <ScriptProvenance script={script.data} />
              {issues.errors > 0 && <Badge tone="danger">{issues.errors} error(s)</Badge>}
              {issues.warnings > 0 && <Badge tone="warning">{issues.warnings} warning(s)</Badge>}
            </div>
            <NarrationToggle value={view} onChange={setView} />
            {view === 'script' ? <Textarea className="script-editor" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /> : <NarrationView script={script.data} dirty={dirty} />}
            <ValidationIssues report={validation} />
            {interactive && (
              <Field label="Feedback for the rewrite" hint="Used by Reject; Fix with AI also sends it when present.">
                <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="e.g. The Cons section repeats the Gameplay section; make the conclusion shorter and more decisive." />
              </Field>
            )}
          </>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirmForce}
        onClose={() => setConfirmForce(false)}
        onConfirm={() => approve(true)}
        title="Approve with open issues?"
        message={`The validator still reports ${issues.errors} error(s)${channel && (stats.chars > channel.maxChars || stats.chars < channel.minChars) ? ` and the length (${formatNumber(stats.chars)}) is outside ${formatNumber(channel.minChars)}–${formatNumber(channel.maxChars)}` : ''}. The script is sent to ElevenLabs exactly as it is now.`}
        confirmLabel="Approve anyway"
      />
    </>
  )
}
