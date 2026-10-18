import { useEffect, useMemo, useState, type JSX } from 'react'
import { ExternalLink, Pin, Plus, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react'
import type { GameView, ResearchData } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { toast } from '@/store/toasts'
import { formatDateTime, formatNumber, relativeTime } from '@/lib/format'
import { Alert, Badge, Button, ConfirmDialog, Drawer, Field, Input, KeyValue, SkeletonRows, Textarea } from '@/components/ui'
import { releaseLabel } from './GamesPage'

/** Every fact-like line of a saved entry (same order as the main process uses for prompts). */
function factLines(d: ResearchData): string[] {
  const lines = [
    ...(d.confirmedFacts ?? []),
    ...(d.gameplayMechanics ?? []),
    ...(d.keyMechanics ?? []),
    ...(d.technicalInfo ?? []),
    ...(d.specifications ?? []),
    ...(d.uncertainFacts ?? []),
    d.combatSystems,
    d.explorationSystems,
    d.multiplayer,
    d.summary
  ]
  return [...new Set(lines.map((l) => (typeof l === 'string' ? l.trim() : '')).filter(Boolean))]
}

function openLink(url: string): void {
  void api
    .invoke('app:openPath', { path: url })
    .then((r) => {
      if (!r.ok) return api.invoke('app:copyToClipboard', { text: url }).then(() => toast.info('Link copied', 'Paste it into your browser to open the source.'))
    })
    .catch((err) => toast.error('Could not open link', err))
}

export function GameDrawer({ gameId, onClose, onChanged }: { gameId: string | null; onClose: () => void; onChanged: () => void }): JSX.Element {
  const game = useAsync(() => api.invoke('games:get', { id: gameId ?? '' }), [gameId], { enabled: Boolean(gameId) })
  const g = game.data
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [newFact, setNewFact] = useState('')
  const [newAlias, setNewAlias] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'refresh' | 'delete' | null>(null)

  useEffect(() => {
    if (g) {
      setTitle(g.canonicalTitle)
      setNotes(g.userNotes)
    }
  }, [g])
  useEffect(() => {
    setNewFact('')
    setNewAlias('')
  }, [gameId])

  const facts = useMemo(() => {
    if (!g) return []
    const userSet = new Set(g.userFacts.map((f) => f.trim().toLowerCase()))
    const removed = new Set(g.removedFacts.map((f) => f.trim().toLowerCase()))
    const researched = factLines(g.data).filter((f) => !userSet.has(f.toLowerCase()))
    return [
      ...g.userFacts.map((text) => ({ text, kind: 'user' as const })),
      ...researched.map((text) => ({ text, kind: removed.has(text.toLowerCase()) ? ('removed' as const) : ('research' as const) })),
      // Facts marked wrong are no longer in the compact data; keep them visible so they can be restored.
      ...g.removedFacts.filter((f) => !researched.some((r) => r.toLowerCase() === f.trim().toLowerCase())).map((text) => ({ text, kind: 'removed' as const }))
    ]
  }, [g])

  const run = async (key: string, fn: () => Promise<GameView>, done?: string): Promise<boolean> => {
    setBusy(key)
    try {
      const next = await fn()
      game.setData(next)
      onChanged()
      if (done) toast.success(done)
      return true
    } catch (err) {
      toast.error('Could not save the change', err)
      return false
    } finally {
      setBusy(null)
    }
  }

  const id = g?.id ?? ''
  const titleDirty = g ? title.trim() !== g.canonicalTitle && title.trim().length > 0 : false
  const notesDirty = g ? notes !== g.userNotes : false

  const footer = g ? (
    <>
      <Button variant="danger-soft" icon={<Trash2 size={14} />} onClick={() => setConfirm('delete')}>
        Delete
      </Button>
      <span className="spacer" />
      <Button icon={<Pin size={14} />} loading={busy === 'pin'} onClick={() => void run('pin', () => api.invoke('games:update', { id, pinned: !g.pinned }), g.pinned ? 'Unpinned' : 'Pinned — never refreshed automatically')}>
        {g.pinned ? 'Unpin' : 'Pin'}
      </Button>
      <Button variant="primary" icon={<RefreshCw size={14} />} loading={busy === 'refresh'} onClick={() => setConfirm('refresh')}>
        Refresh research
      </Button>
    </>
  ) : undefined

  return (
    <Drawer
      open={Boolean(gameId)}
      onClose={onClose}
      wide
      title={g ? g.canonicalTitle : 'Saved game'}
      description={g ? `Researched ${relativeTime(g.researchedAt)} · reused ${formatNumber(g.useCount)} ${g.useCount === 1 ? 'time' : 'times'} · no research credits on reuse` : undefined}
      headerExtra={g?.mayBeOutdated ? <Badge tone="warning">May be outdated</Badge> : undefined}
      footer={footer}
    >
      {game.loading && !g && <SkeletonRows rows={6} />}
      {game.error && <Alert tone="danger" title="Could not load this entry">{game.error.message}</Alert>}
      {g && (
        <div className="col gap-4">
          {g.mayBeOutdated && (
            <Alert
              tone="warning"
              title="This research may be outdated"
              actions={<Button size="sm" onClick={() => setConfirm('refresh')}>Refresh</Button>}
            >
              It was saved before the game's release date, which has now passed. Refresh once to pick up launch facts (uses research credits once).
            </Alert>
          )}

          <div className="detail-section">
            <div className="detail-title">Details</div>
            <KeyValue
              items={[
                { key: 'Type', value: g.subjectType === 'product' ? 'Product' : 'Game' },
                { key: 'Developer', value: g.developer || '—' },
                { key: 'Publisher', value: g.publisher || '—' },
                { key: 'Genre', value: g.genre || '—' },
                { key: 'Release', value: releaseLabel(g) },
                { key: 'Platforms', value: g.platforms.length ? g.platforms.join(', ') : '—' },
                { key: 'Researched', value: <span title={formatDateTime(g.researchedAt)}>{formatDateTime(g.researchedAt)}{g.researchModel ? ` · ${g.researchModel}` : ''}</span> },
                { key: 'Used by', value: g.channels.length ? `${g.scriptCount} ${g.scriptCount === 1 ? 'script' : 'scripts'} on ${g.channels.map((c) => c.channelName).join(', ')}` : 'Not used in a script yet' }
              ]}
            />
          </div>

          <Field label="Official title" hint="Renaming keeps the old name as an alias, so typed titles still match.">
            <div className="row gap-1">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              <Button disabled={!titleDirty} loading={busy === 'title'} onClick={() => void run('title', () => api.invoke('games:update', { id, canonicalTitle: title.trim() }), 'Title saved')}>
                Save
              </Button>
            </div>
          </Field>

          <Field label="Your notes" hint="Sent to the writer with every script for this game (for example sponsor details or what to emphasise).">
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Nothing yet" />
            {notesDirty && (
              <div className="row gap-1 mt-2">
                <Button size="sm" variant="primary" loading={busy === 'notes'} onClick={() => void run('notes', () => api.invoke('games:update', { id, userNotes: notes }), 'Notes saved')}>
                  Save notes
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNotes(g.userNotes)}>
                  Discard
                </Button>
              </div>
            )}
          </Field>

          <div className="detail-section">
            <div className="detail-title">Facts used in scripts</div>
            <div className="xs muted">Mark a fact wrong and it is never sent to the writer again. Facts you add are treated as confirmed.</div>
            <ul className="game-facts">
              {facts.map((f) => (
                <li key={`${f.kind}:${f.text}`} className={`game-fact ${f.kind}`}>
                  <span className="grow selectable">
                    {f.kind === 'user' && <Badge tone="success">Added by you</Badge>} {f.text}
                  </span>
                  {f.kind === 'research' && (
                    <Button size="sm" variant="ghost" icon={<X size={12} />} title="Mark as wrong" loading={busy === `rm:${f.text}`} onClick={() => void run(`rm:${f.text}`, () => api.invoke('games:removeFact', { id, text: f.text }))}>
                      Wrong
                    </Button>
                  )}
                  {f.kind === 'user' && (
                    <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} title="Remove this fact" loading={busy === `rm:${f.text}`} onClick={() => void run(`rm:${f.text}`, () => api.invoke('games:removeFact', { id, text: f.text }))}>
                      Remove
                    </Button>
                  )}
                  {f.kind === 'removed' && (
                    <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} title="Use this fact again" loading={busy === `rs:${f.text}`} onClick={() => void run(`rs:${f.text}`, () => api.invoke('games:restoreFact', { id, text: f.text }))}>
                      Restore
                    </Button>
                  )}
                </li>
              ))}
              {facts.length === 0 && <li className="small muted">No facts saved.</li>}
            </ul>
            <form
              className="row gap-1 mt-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!newFact.trim()) return
                void run('fact', () => api.invoke('games:addFact', { id, text: newFact.trim() }), 'Fact added').then((ok) => ok && setNewFact(''))
              }}
            >
              <Input value={newFact} onChange={(e) => setNewFact(e.target.value)} placeholder="Add a fact you know is true…" />
              <Button type="submit" icon={<Plus size={14} />} disabled={!newFact.trim()} loading={busy === 'fact'}>
                Add fact
              </Button>
            </form>
          </div>

          <div className="detail-section">
            <div className="detail-title">Other spellings</div>
            <div className="xs muted">Titles typed this way reuse this research automatically.</div>
            <div className="row wrap gap-1 mt-2">
              {g.aliases.map((a) => (
                <span key={a} className="chip">
                  {a}
                  <button type="button" className="chip-remove" aria-label={`Remove ${a}`} title="Remove" onClick={() => void run(`al:${a}`, () => api.invoke('games:removeAlias', { id, alias: a }))}>
                    <X size={11} />
                  </button>
                </span>
              ))}
              {g.aliases.length === 0 && <span className="small muted">None yet — they are learned when you confirm a match.</span>}
            </div>
            <form
              className="row gap-1 mt-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!newAlias.trim()) return
                void run('alias', () => api.invoke('games:addAlias', { id, alias: newAlias.trim() }), 'Spelling added').then((ok) => ok && setNewAlias(''))
              }}
            >
              <Input value={newAlias} onChange={(e) => setNewAlias(e.target.value)} placeholder="e.g. Civ 6" />
              <Button type="submit" icon={<Plus size={14} />} disabled={!newAlias.trim()} loading={busy === 'alias'}>
                Add spelling
              </Button>
            </form>
          </div>

          {g.sources.length > 0 && (
            <div className="detail-section">
              <div className="detail-title">Sources</div>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {g.sources.map((s, i) => (
                  <li key={i}>
                    <span className="selectable">{s.title || s.url}</span>{' '}
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" title={s.url} aria-label="Open source" onClick={() => openLink(s.url)}>
                      <ExternalLink size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'refresh'}
        onClose={() => setConfirm(null)}
        title="Refresh this research?"
        message="The game is researched again once (uses research credits). Your notes, added facts, facts marked wrong and spellings are kept."
        confirmLabel="Refresh research"
        onConfirm={async () => {
          setConfirm(null)
          await run('refresh', () => api.invoke('games:refresh', { id }), 'Research refreshed')
        }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        danger
        title="Delete this saved research?"
        message="Scripts already written are not affected. The next script for this title researches it again (uses credits)."
        confirmLabel="Delete"
        onConfirm={async () => {
          setConfirm(null)
          setBusy('delete')
          try {
            await api.invoke('games:delete', { id })
            toast.success('Saved research deleted')
            onChanged()
            onClose()
          } catch (err) {
            toast.error('Could not delete', err)
          } finally {
            setBusy(null)
          }
        }}
      />
    </Drawer>
  )
}
