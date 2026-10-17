import { useEffect, useMemo, useState, type JSX } from 'react'
import type { JobView, Script, ValidationReport } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { toast } from '@/store/toasts'
import { useApp } from '@/store/app'
import { Alert, Badge, Button, Dialog, Field, SkeletonRows, Textarea } from '@/components/ui'
import { estimateDurationSec, formatDuration, formatNumber, wordCount } from '@/lib/format'

export interface ScriptReviewDialogProps {
  job: JobView | null
  onClose: () => void
}

export function ValidationIssues({ report }: { report: ValidationReport | null }): JSX.Element | null {
  if (!report) return null
  if (report.ok && report.issues.length === 0) {
    return <Alert tone="success">Validation passed. {report.sectionsFound.length > 0 ? `Sections found: ${report.sectionsFound.join(', ')}.` : ''}</Alert>
  }
  return (
    <div className="col gap-1">
      {report.issues.map((i, idx) => (
        <Alert key={idx} tone={i.severity === 'error' ? 'danger' : 'warning'}>
          <span className="mono xs">{i.code}</span> · {i.message}
        </Alert>
      ))}
    </div>
  )
}

/**
 * Review a script that is waiting for approval (review_before_voice mode).
 * Edits are saved as a new script version via scripts:saveEdit before approving.
 */
export function ScriptReviewDialog({ job, onClose }: ScriptReviewDialogProps): JSX.Element {
  const scriptId = job?.scriptId ?? null
  const script = useAsync(() => api.invoke('scripts:get', { id: scriptId ?? '' }), [scriptId], { enabled: Boolean(scriptId) })
  const channel = useApp((s) => (job ? s.channels.find((c) => c.id === job.channelId) : undefined))
  const [text, setText] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [validation, setValidation] = useState<ValidationReport | null>(null)

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
    }
  }, [job])

  const dirty = script.data ? text !== script.data.text : false
  const wpm = channel?.validation.wordsPerMinute ?? 150
  const stats = useMemo(() => ({ chars: text.length, words: wordCount(text), dur: estimateDurationSec(text, wpm) }), [text, wpm])
  const charsOut = channel ? text.length < channel.minChars || text.length > channel.maxChars : false

  const saveEditIfNeeded = async (): Promise<Script | null> => {
    if (!job || !script.data || !dirty) return null
    const saved = await api.invoke('scripts:saveEdit', { projectId: job.projectId, text, baseScriptId: script.data.id })
    return saved
  }

  const approve = async (): Promise<void> => {
    if (!job) return
    setBusy('approve')
    try {
      const saved = await saveEditIfNeeded()
      const updated = await api.invoke('queue:approveScript', { jobId: job.id })
      useApp.getState().upsertJob(updated)
      toast.success(saved ? 'Edited script approved' : 'Script approved', `"${job.title}" continues to audio generation.`)
      onClose()
    } catch (err) {
      toast.error('Could not approve script', err)
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
      toast.info('Script rejected', 'A rewrite with your feedback has been queued.')
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
      toast.info('Regenerating script', 'A fresh script will be written from the research data.')
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
      toast[report.ok ? 'success' : 'warning'](report.ok ? 'Validation passed' : 'Validation found issues', `${report.issues.length} issue(s)`)
    } catch (err) {
      toast.error('Validation failed', err)
    } finally {
      setBusy(null)
    }
  }

  const interactive = job?.status === 'awaiting_approval'

  return (
    <Dialog
      open={Boolean(job)}
      onClose={onClose}
      size="xl"
      title="Review script before voice"
      description={job ? `"${job.title}" · ${job.channelName}${script.data ? ` · version ${script.data.version}` : ''}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy != null}>
            Later
          </Button>
          <Button onClick={validate} loading={busy === 'validate'} disabled={busy != null || !script.data}>
            Validate
          </Button>
          <Button onClick={saveOnly} loading={busy === 'save'} disabled={busy != null || !dirty}>
            Save edit
          </Button>
          {interactive && (
            <>
              <Button onClick={regenerate} loading={busy === 'regen'} disabled={busy != null}>
                Regenerate
              </Button>
              <Button variant="danger-soft" onClick={reject} loading={busy === 'reject'} disabled={busy != null}>
                Reject with feedback
              </Button>
              <Button variant="primary" onClick={approve} loading={busy === 'approve'} disabled={busy != null || !script.data}>
                {dirty ? 'Save & approve' : 'Approve'} → generate audio
              </Button>
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
          <div className="row wrap">
            <Badge>{formatNumber(stats.chars)} chars</Badge>
            <Badge>{formatNumber(stats.words)} words</Badge>
            <Badge>~{formatDuration(stats.dur)} at {wpm} wpm</Badge>
            {channel && (
              <Badge tone={charsOut ? 'warning' : 'success'}>
                target {formatNumber(channel.minChars)}–{formatNumber(channel.maxChars)} chars
              </Badge>
            )}
            {dirty && <Badge tone="accent">unsaved edits</Badge>}
            {script.data.templateVersionNumber != null && <Badge>template v{script.data.templateVersionNumber}</Badge>}
          </div>
          <Textarea className="script-editor" value={text} onChange={(e) => setText(e.target.value)} />
          <ValidationIssues report={validation} />
          {interactive && (
            <Field label="Feedback for rewrite (used by Reject and optionally Regenerate)">
              <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="e.g. The Cons section repeats the Gameplay section; make the conclusion shorter and more decisive." />
            </Field>
          )}
        </>
      )}
    </Dialog>
  )
}
