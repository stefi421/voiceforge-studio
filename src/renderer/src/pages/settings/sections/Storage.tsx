import { useState, type JSX } from 'react'
import { Database, Download, FolderOpen, HardDrive, Upload } from 'lucide-react'
import type { BackupInfo } from '@shared/types'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { formatBytes, formatDateTime, isoDay } from '@/lib/format'
import { Alert, Button, ConfirmDialog, Dialog, Field, Input, KeyValue, Select, Switch } from '@/components/ui'
import { useSettingsPatch } from '../useSettingsPatch'
import { DeferredNumber } from './ProviderShared'

const EXPORT_KINDS = ['configuration', 'channels', 'templates', 'projects', 'history', 'all']

export function StorageSection(): JSX.Element {
  const { settings, set } = useSettingsPatch()
  const info = useApp((s) => s.info)
  const st = settings.storage
  const backups = useAsync(() => api.invoke('backup:list', undefined), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<BackupInfo | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportKind, setExportKind] = useState('all')

  const pickBackupDir = async (): Promise<void> => {
    try {
      const dir = await api.invoke('app:selectFolder', { title: 'Choose backup folder', defaultPath: st.backupDir ?? undefined })
      if (dir) await set('storage', 'backupDir', dir)
    } catch (err) {
      toast.error('Could not pick folder', err)
    }
  }

  const createBackup = async (): Promise<void> => {
    setBusy('create')
    try {
      const b = await api.invoke('backup:create', undefined)
      toast.success('Backup created', `${b.path} (${formatBytes(b.bytes)})`)
      await backups.reload()
    } catch (err) {
      toast.error('Backup failed', err)
    } finally {
      setBusy(null)
    }
  }

  const restore = async (): Promise<void> => {
    if (!restoring) return
    try {
      await api.invoke('backup:restore', { path: restoring.path })
      toast.warning('Backup restored', 'Restart VoiceForge Studio to load the restored database.')
      setRestoring(null)
    } catch (err) {
      toast.error('Restore failed', err)
    }
  }

  const exportData = async (): Promise<void> => {
    try {
      const path = await api.invoke('app:saveFileDialog', { title: 'Export data', defaultPath: `voiceforge-${exportKind}-${isoDay(new Date())}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (!path) return
      setBusy('export')
      await api.invoke('backup:exportData', { kind: exportKind, path })
      toast.success('Data exported', path)
      setExportOpen(false)
    } catch (err) {
      toast.error('Export failed', err)
    } finally {
      setBusy(null)
    }
  }

  const importData = async (): Promise<void> => {
    try {
      const paths = await api.invoke('app:selectFiles', { title: 'Import data', filters: [{ name: 'JSON', extensions: ['json'] }] })
      const path = paths[0]
      if (!path) return
      setBusy('import')
      const r = await api.invoke('backup:importData', { path })
      await useApp.getState().refreshChannels()
      toast.success('Data imported', `${r.channels} channel(s), ${r.templates} template(s).`)
    } catch (err) {
      toast.error('Import failed', err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-group">
        <div className="settings-group-title row">
          <Database size={15} /> Database
        </div>
        <KeyValue
          items={[
            { key: 'Database file', value: <span className="mono xs">{info?.dbPath ?? '—'}</span> },
            { key: 'User data', value: <span className="mono xs">{info?.userDataPath ?? '—'}</span> },
            { key: 'Secrets backend', value: info?.secretsBackend ?? '—' }
          ]}
        />
        {info?.userDataPath && (
          <div>
            <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void api.invoke('app:openPath', { path: info.userDataPath })}>
              Open data folder
            </Button>
          </div>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-title row">
          <HardDrive size={15} /> Backups
        </div>
        <Field label="Backup folder" hint="Leave empty to keep backups inside the user data folder.">
          <div className="row">
            <Input value={st.backupDir ?? ''} readOnly placeholder="Default (user data folder)" className="mono" />
            <Button icon={<FolderOpen size={14} />} onClick={pickBackupDir}>
              Browse
            </Button>
            {st.backupDir && (
              <Button variant="ghost" onClick={() => void set('storage', 'backupDir', null)}>
                Reset
              </Button>
            )}
          </div>
        </Field>
        <div className="form-grid">
          <Field label="Automatic backup every" hint="0 disables automatic backups.">
            <DeferredNumber value={st.autoBackupEveryHours} onCommit={(v) => void set('storage', 'autoBackupEveryHours', v ?? 0)} min={0} max={720} suffix="hours" />
          </Field>
          <Field label="Keep backups">
            <DeferredNumber value={st.keepBackups} onCommit={(v) => void set('storage', 'keepBackups', v ?? 1)} min={1} max={100} suffix="files" />
          </Field>
        </div>
        <Switch checked={st.cleanupTempFiles} onChange={(v) => void set('storage', 'cleanupTempFiles', v)} label="Clean up temporary files" description="Remove audio chunks and temp downloads after a job finishes." />
        <div className="row">
          <Button variant="primary" loading={busy === 'create'} onClick={createBackup}>
            Create backup now
          </Button>
          <Button variant="ghost" onClick={() => void backups.reload()} loading={backups.loading}>
            Refresh list
          </Button>
        </div>
        {(Array.isArray(backups.data) ? backups.data : []).length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>File</th>
                  <th className="num">Size</th>
                  <th>App</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(Array.isArray(backups.data) ? backups.data : []).map((b) => (
                  <tr key={b.path}>
                    <td>{formatDateTime(b.createdAt)}</td>
                    <td className="mono xs truncate" style={{ maxWidth: 320 }} title={b.path}>{b.path}</td>
                    <td className="num">{formatBytes(b.bytes)}</td>
                    <td className="xs muted">{b.appVersion}</td>
                    <td className="actions">
                      <Button size="sm" onClick={() => setRestoring(b)}>
                        Restore
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-title">Export & import</div>
        <div className="row">
          <Button icon={<Download size={14} />} onClick={() => setExportOpen(true)}>
            Export data…
          </Button>
          <Button icon={<Upload size={14} />} loading={busy === 'import'} onClick={importData}>
            Import data…
          </Button>
        </div>
        <div className="xs subtle">Exports never include API keys.</div>
      </div>

      <Dialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Export data"
        footer={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy === 'export'} onClick={exportData}>Choose file & export</Button>
          </>
        }
      >
        <Field label="What to export">
          <Select value={exportKind} onChange={setExportKind} options={EXPORT_KINDS.map((k) => ({ value: k, label: k }))} />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={Boolean(restoring)}
        onClose={() => setRestoring(null)}
        onConfirm={restore}
        danger
        title="Restore this backup?"
        confirmLabel="Restore"
        message={
          <>
            The current database will be replaced by the backup from {restoring ? formatDateTime(restoring.createdAt) : ''}. <strong>The app will need to restart</strong> afterwards. Running jobs will be interrupted.
          </>
        }
      >
        <Alert tone="warning">Create a fresh backup first if you want to be able to undo this.</Alert>
      </ConfirmDialog>
    </div>
  )
}
