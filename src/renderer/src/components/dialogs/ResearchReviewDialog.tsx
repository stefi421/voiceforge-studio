import { useEffect, useState, type JSX } from 'react'
import { ExternalLink } from 'lucide-react'
import type { JobView } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { toast } from '@/store/toasts'
import { useApp } from '@/store/app'
import { Alert, Badge, Button, Card, Dialog, Field, Input, KeyValue, SkeletonRows, Textarea } from '@/components/ui'
import { formatPercent } from '@/lib/format'

export interface ResearchReviewDialogProps {
  job: JobView | null
  onClose: () => void
  /** When true the dialog is read-only (used from "view research"). */
  readOnly?: boolean
}

export function ResearchReviewDialog({ job, onClose, readOnly }: ResearchReviewDialogProps): JSX.Element {
  const jobId = job?.id ?? null
  const research = useAsync(() => api.invoke('queue:getResearch', { jobId: jobId ?? '' }), [jobId], { enabled: Boolean(jobId) })
  const [manualTitle, setManualTitle] = useState('')
  const [manualNotes, setManualNotes] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (job) {
      setManualTitle(job.title)
      setManualNotes(job.manualResearchNotes ?? '')
      setBusy(null)
    }
  }, [job])

  const resolve = async (payload: { candidateIndex?: number; manualTitle?: string; manualNotes?: string }, key: string): Promise<void> => {
    if (!job) return
    setBusy(key)
    try {
      const updated = await api.invoke('queue:resolveResearch', { jobId: job.id, ...payload })
      useApp.getState().upsertJob(updated)
      toast.success('Research resolved', `"${job.title}" continues in the queue.`)
      onClose()
    } catch (err) {
      toast.error('Could not resolve research', err)
    } finally {
      setBusy(null)
    }
  }

  const cancel = async (): Promise<void> => {
    if (!job) return
    setBusy('cancel')
    try {
      const updated = await api.invoke('queue:cancelJob', { id: job.id })
      useApp.getState().upsertJob(updated)
      toast.info('Job cancelled', job.title)
      onClose()
    } catch (err) {
      toast.error('Could not cancel job', err)
    } finally {
      setBusy(null)
    }
  }

  const r = research.data
  const d = r?.data
  const failedOnResearch = job?.status === 'failed' && (job.lastError?.kind === 'ambiguous' || job.lastError?.kind === 'insufficient_info')
  const interactive = !readOnly && (job?.status === 'research_review_required' || failedOnResearch)
  // 1.6.0: the title looks like a game that was researched before (Game Library).
  const libraryChoice = r?.model === 'library' && r.status === 'ambiguous'

  return (
    <Dialog
      open={Boolean(job)}
      onClose={onClose}
      size="lg"
      title={readOnly ? 'Research data' : libraryChoice ? 'Is this a game you already researched?' : 'Research needs your input'}
      description={job ? `"${job.title}" · ${job.channelName}` : undefined}
      footer={
        interactive ? (
          <>
            <Button variant="danger-soft" onClick={cancel} loading={busy === 'cancel'} disabled={busy != null && busy !== 'cancel'}>
              Cancel job
            </Button>
            <div className="grow" />
            <Button variant="ghost" onClick={onClose}>
              Decide later
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {research.loading ? (
        <SkeletonRows rows={6} />
      ) : research.error ? (
        <Alert tone="danger" title="Could not load research">
          {research.error.message}
        </Alert>
      ) : !r ? (
        <Alert tone="info">No research data is stored for this job yet.</Alert>
      ) : (
        <>
          {libraryChoice ? (
            <Alert tone="info" title="Saved research may match this title">
              Pick the saved game to reuse its research (no research credits, no wait), or research it as a new game. Your choice is remembered for this spelling.
            </Alert>
          ) : (
            <div className="row wrap">
              <Badge tone={r.status === 'confirmed' ? 'success' : r.status === 'ambiguous' ? 'warning' : r.status === 'insufficient' ? 'danger' : 'info'}>{r.status}</Badge>
              <Badge>confidence {formatPercent(d?.confidence ?? 0)}</Badge>
              <Badge>{r.mode.replace(/_/g, ' ')}</Badge>
              {r.model && r.model !== 'library' && <Badge>{r.model}</Badge>}
              {r.model === 'library' && <Badge tone="success">Saved research</Badge>}
            </div>
          )}

          {d?.insufficientReason && (
            <Alert tone="warning" title="Why the pipeline stopped">
              {d.insufficientReason}
            </Alert>
          )}

          {d && d.ambiguityCandidates.length > 0 && (
            <div className="col gap-3">
              <div className="section-title">{libraryChoice ? 'Same game as one of these?' : 'Which one did you mean?'}</div>
              <div className="grid grid-2">
                {d.ambiguityCandidates.map((c, i) => (
                  <Card key={i} padded="sm" hover={interactive}>
                    <div className="col gap-1">
                      <div className="strong">{c.title}</div>
                      <div className="xs muted">
                        {[c.developer, c.year].filter(Boolean).join(' · ')}
                      </div>
                      {c.note && <div className="small">{c.note}</div>}
                      {interactive && (
                        <div className="mt-2">
                          <Button size="sm" variant="primary" loading={busy === `c${i}`} disabled={busy != null} onClick={() => resolve({ candidateIndex: i }, `c${i}`)}>
                            {c.gameId ? 'Use saved research' : 'Use this one'}
                          </Button>
                        </div>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
              {libraryChoice && interactive && job && (
                <div>
                  <Button loading={busy === 'new'} disabled={busy != null} onClick={() => resolve({ manualTitle: job.title }, 'new')}>
                    It's a different game — research it as new
                  </Button>
                </div>
              )}
            </div>
          )}

          {d && !libraryChoice && (
            <details open={!interactive}>
              <summary className="small strong clickable">Research summary</summary>
              <div className="mt-3 col gap-3">
                <KeyValue
                  items={[
                    { key: 'Canonical title', value: d.canonicalTitle || '—' },
                    { key: 'Type', value: d.subjectType },
                    { key: 'Developer', value: d.developer || '—' },
                    { key: 'Publisher', value: d.publisher || '—' },
                    { key: 'Genre', value: d.genre || '—' },
                    { key: 'Release', value: `${d.releaseStatus}${d.releaseDate ? ` · ${d.releaseDate}` : ''}` },
                    { key: 'Platforms', value: d.platforms.join(', ') || '—' }
                  ]}
                />
                {d.summary && <p className="small pre-wrap selectable">{d.summary}</p>}
                {d.confirmedFacts.length > 0 && (
                  <div>
                    <div className="xs strong muted">Confirmed facts</div>
                    <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {d.confirmedFacts.map((f, i) => (
                        <li key={i} className="selectable">{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {d.uncertainFacts.length > 0 && (
                  <div>
                    <div className="xs strong text-warning">Uncertain</div>
                    <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {d.uncertainFacts.map((f, i) => (
                        <li key={i} className="selectable">{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          )}

          {r.sources.length > 0 && (
            <div>
              <div className="xs strong muted">Sources</div>
              <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {r.sources.map((s, i) => (
                  <li key={i}>
                    <span className="selectable">{s.title || s.url}</span>{' '}
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" title={s.url} onClick={() => {
                      void api
                        .invoke('app:openPath', { path: s.url })
                        .then((r) => {
                          if (!r.ok) return api.invoke('app:copyToClipboard', { text: s.url }).then(() => toast.info('Link copied', 'Paste it into your browser to open the source.'))
                        })
                        .catch((err) => toast.error('Could not open link', err))
                    }}>
                      <ExternalLink size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {interactive && !libraryChoice && (
            <Card padded="sm">
              <div className="col gap-3">
                <div className="section-title">Or tell the pipeline what this is</div>
                <Field label="Correct title" hint="Use the exact, unambiguous name (e.g. add the year or developer).">
                  <Input value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} />
                </Field>
                <Field label="Manual research notes (optional)" hint="Facts you know to be true. They are passed to the writer as confirmed research.">
                  <Textarea value={manualNotes} onChange={(e) => setManualNotes(e.target.value)} rows={5} placeholder="Developer, release date, platforms, key mechanics, specs…" />
                </Field>
                <div>
                  <Button
                    variant="primary"
                    loading={busy === 'manual'}
                    disabled={busy != null || !manualTitle.trim()}
                    onClick={() => resolve({ manualTitle: manualTitle.trim(), manualNotes: manualNotes.trim() || undefined }, 'manual')}
                  >
                    Continue with this title
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </Dialog>
  )
}
