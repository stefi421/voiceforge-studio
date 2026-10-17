import { useMemo, useState, type JSX } from 'react'
import { Archive, ArchiveRestore, FolderOpen, FolderOutput, Pencil, RefreshCw, Trash } from 'lucide-react'
import type { ProjectView } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync, useDebouncedValue } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { navigate } from '@/store/router'
import { toast } from '@/store/toasts'
import { formatDateTime, relativeTime } from '@/lib/format'
import { Badge, Button, Card, ChannelIcon, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, SearchInput, StatusBadge } from '@/components/ui'

export function ProjectsPage(): JSX.Element {
  const channels = useApp((s) => s.channels)
  const stats = useApp((s) => s.stats)
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search, 200)
  const [showArchived, setShowArchived] = useState(false)
  const [renaming, setRenaming] = useState<ProjectView | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [deleting, setDeleting] = useState<ProjectView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const list = useAsync(() => api.invoke('projects:list', { search: q || undefined, limit: 5000, sort: 'updatedAt', dir: 'desc', includeArchived: true }), [q, stats.completed])
  const rows = useMemo(() => (list.data ?? []).filter((p) => showArchived || !p.archived), [list.data, showArchived])

  const groups = useMemo(() => {
    const m = new Map<string, ProjectView[]>()
    for (const p of rows) {
      const arr = m.get(p.channelId) ?? []
      arr.push(p)
      m.set(p.channelId, arr)
    }
    const order = new Map(channels.map((c, i) => [c.id, c.position ?? i]))
    return Array.from(m.entries()).sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
  }, [rows, channels])

  const openFolder = async (p: ProjectView): Promise<void> => {
    const r = await api.invoke('projects:openFolder', { id: p.id })
    if (!r.ok) toast.warning('Could not open folder', r.message ?? 'The project folder does not exist yet.')
  }

  const archive = async (p: ProjectView, archived: boolean): Promise<void> => {
    setBusy(p.id)
    try {
      await api.invoke('projects:archive', { id: p.id, archived })
      await list.reload()
      toast.success(archived ? 'Project archived' : 'Project restored', p.title)
    } catch (err) {
      toast.error('Could not update project', err)
    } finally {
      setBusy(null)
    }
  }

  const exportProject = async (p: ProjectView): Promise<void> => {
    try {
      const dir = await api.invoke('app:selectFolder', { title: 'Export project to…' })
      if (!dir) return
      const r = await api.invoke('projects:export', { id: p.id, destinationDir: dir })
      toast.success('Project exported', r.path)
    } catch (err) {
      toast.error('Export failed', err)
    }
  }

  const rename = async (): Promise<void> => {
    if (!renaming || !newTitle.trim()) return
    setBusy(renaming.id)
    try {
      await api.invoke('projects:rename', { id: renaming.id, title: newTitle.trim() })
      setRenaming(null)
      await list.reload()
      toast.success('Project renamed')
    } catch (err) {
      toast.error('Could not rename project', err)
    } finally {
      setBusy(null)
    }
  }

  const confirmDelete = async ({ checkbox }: { checkbox: boolean }): Promise<void> => {
    if (!deleting) return
    try {
      await api.invoke('projects:delete', { id: deleting.id, deleteFiles: checkbox })
      setDeleting(null)
      await list.reload()
      toast.success('Project deleted', deleting.title)
    } catch (err) {
      toast.error('Could not delete project', err)
    }
  }

  return (
    <div className="page fade-in">
      <PageHeader
        title="Projects"
        subtitle="One project per title. Each holds its script versions, audio versions and output folder."
        actions={
          <>
            <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
            <Button icon={<RefreshCw size={14} />} loading={list.loading} onClick={() => void list.reload()}>
              Refresh
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search projects…" style={{ minWidth: 260 }} />
        <span className="spacer" />
        <span className="xs muted">{rows.length} projects</span>
      </div>

      {groups.length === 0 ? (
        <Card>
          <EmptyState icon={<FolderOpen size={20} />} title={list.loading ? 'Loading…' : 'No projects yet'} description="Start a generation and each title becomes a project." actions={<Button variant="primary" onClick={() => navigate('generate')}>New generation</Button>} />
        </Card>
      ) : (
        groups.map(([channelId, projects]) => {
          const first = projects[0]
          if (!first) return null
          return (
            <Card key={channelId} title={<span className="row gap-3"><ChannelIcon icon={first.channelIcon} color={first.channelColor} size="sm" />{first.channelName}<Badge>{projects.length}</Badge></span>}>
              <div className="card-body-flush">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Folder</th>
                      <th className="num">Scripts</th>
                      <th className="num">Audio</th>
                      <th>Latest status</th>
                      <th>Updated</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <span className="strong">{p.title}</span>
                          {p.archived && <Badge style={{ marginLeft: 8 }}>archived</Badge>}
                        </td>
                        <td className="xs mono muted truncate" style={{ maxWidth: 280 }} title={p.folderPath ?? ''}>
                          {p.folderPath ?? <span className="subtle">not created yet</span>}
                        </td>
                        <td className="num">{p.scriptCount}</td>
                        <td className="num">{p.audioCount}</td>
                        <td>{p.latestJobStatus ? <StatusBadge status={p.latestJobStatus} /> : <span className="muted">—</span>}</td>
                        <td className="xs muted" title={formatDateTime(p.updatedAt)}>{relativeTime(p.updatedAt)}</td>
                        <td className="actions">
                          <span className="row-actions">
                            <Button size="sm" variant="ghost" iconOnly icon={<FolderOpen size={13} />} title="Open folder" onClick={() => openFolder(p)} />
                            <Button size="sm" variant="ghost" iconOnly icon={<Pencil size={13} />} title="Rename" onClick={() => { setRenaming(p); setNewTitle(p.title) }} />
                            <Button size="sm" variant="ghost" iconOnly icon={p.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />} title={p.archived ? 'Unarchive' : 'Archive'} loading={busy === p.id} onClick={() => archive(p, !p.archived)} />
                            <Button size="sm" variant="ghost" iconOnly icon={<FolderOutput size={13} />} title="Export project" onClick={() => exportProject(p)} />
                            <Button size="sm" variant="ghost" iconOnly icon={<Trash size={13} />} title="Delete" onClick={() => setDeleting(p)} />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        })
      )}

      <Dialog
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="Rename project"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button variant="primary" onClick={rename} loading={busy === renaming?.id} disabled={!newTitle.trim()}>Rename</Button>
          </>
        }
      >
        <Field label="Title" hint="The folder name on disk is not changed.">
          <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} data-autofocus onKeyDown={(e) => { if (e.key === 'Enter') void rename() }} />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        danger
        title={`Delete project "${deleting?.title ?? ''}"?`}
        message="The project, its scripts, audio records and job history are removed from the database. Files on disk are preserved unless you tick the option below."
        checkboxLabel="Also delete the project folder and files"
        checkboxDefault={false}
        confirmLabel="Delete project"
      />
    </div>
  )
}
