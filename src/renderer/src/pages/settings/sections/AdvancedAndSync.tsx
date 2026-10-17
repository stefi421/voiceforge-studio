import { useState, type JSX } from 'react'
import { Bug, Cloud, FolderOpen, RefreshCw, RotateCcw, ScrollText, ShieldCheck } from 'lucide-react'
import type { AppSettings } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { Alert, Button, ConfirmDialog, Field, KeyValue, Select, Switch } from '@/components/ui'
import { useSettingsPatch } from '../useSettingsPatch'

export function SyncSection(): JSX.Element {
  const settings = useApp((s) => s.settings)
  return (
    <div className="settings-section">
      <Alert tone="info" title={<span className="row"><Cloud size={14} /> Cloud synchronization is not implemented in this version.</span>}>
        The app is designed so an optional Supabase-based sync can be added; see <span className="inline-code">docs/SYNC_ARCHITECTURE.md</span>. API keys are never synchronized.
      </Alert>
      <div className="settings-group">
        <Switch checked={settings.sync.enabled} onChange={() => undefined} disabled label="Enable cloud sync" description={`Provider: ${settings.sync.provider} · status: ${settings.sync.status.replace('_', ' ')}`} />
      </div>
    </div>
  )
}

export function AdvancedSection(): JSX.Element {
  const { settings, set } = useSettingsPatch()
  const info = useApp((s) => s.info)
  const [logs, setLogs] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [integrity, setIntegrity] = useState<{ ok: boolean; details: string } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const a = settings.advanced

  const readLogs = async (): Promise<void> => {
    setBusy('logs')
    try {
      setLogs(await api.invoke('app:readRecentLogs', { lines: 200 }))
    } catch (err) {
      toast.error('Could not read logs', err)
    } finally {
      setBusy(null)
    }
  }

  const checkDb = async (): Promise<void> => {
    setBusy('db')
    try {
      const r = await api.invoke('app:dbIntegrityCheck', undefined)
      setIntegrity(r)
      toast[r.ok ? 'success' : 'error'](r.ok ? 'Database integrity OK' : 'Database integrity problems', r.details)
    } catch (err) {
      toast.error('Integrity check failed', err)
    } finally {
      setBusy(null)
    }
  }

  const reset = async (): Promise<void> => {
    try {
      const s = await api.invoke('app:resetSettings', undefined)
      useApp.getState().setSettings(s)
      toast.success('Settings reset to defaults', 'API keys and channels were not touched.')
      setConfirmReset(false)
    } catch (err) {
      toast.error('Could not reset settings', err)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-group">
        <div className="settings-group-title row">
          <ScrollText size={15} /> Logging
        </div>
        <div className="form-grid">
          <Field label="Log level">
            <Select value={a.logLevel} onChange={(v) => void set('advanced', 'logLevel', v as AppSettings['advanced']['logLevel'])} options={['debug', 'info', 'warn', 'error'].map((l) => ({ value: l, label: l }))} />
          </Field>
        </div>
        <div className="row">
          <Button icon={<FolderOpen size={14} />} onClick={() => void api.invoke('app:openLogs', undefined)}>
            Open logs folder
          </Button>
          <Button icon={<RefreshCw size={14} />} loading={busy === 'logs'} onClick={readLogs}>
            {logs ? 'Reload recent log lines' : 'Show recent log lines'}
          </Button>
        </div>
        {logs && <pre className="log-view">{logs.length ? logs.join('\n') : 'Log is empty.'}</pre>}
      </div>

      <div className="settings-group">
        <div className="settings-group-title row">
          <ShieldCheck size={15} /> Maintenance
        </div>
        <div className="row">
          <Button loading={busy === 'db'} onClick={checkDb}>
            Database integrity check
          </Button>
          <Button variant="danger-soft" icon={<RotateCcw size={14} />} onClick={() => setConfirmReset(true)}>
            Reset settings to defaults
          </Button>
        </div>
        {integrity && (
          <Alert tone={integrity.ok ? 'success' : 'danger'}>
            <span className="mono xs pre-wrap">{integrity.details}</span>
          </Alert>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-title row">
          <Bug size={15} /> Testing
        </div>
        <Switch
          checked={a.manualE2EMode}
          onChange={(v) => void set('advanced', 'manualE2EMode', v)}
          label="Manual E2E test mode"
          description="When enabled, the New Generation page shows a 'Live E2E test' checklist that walks through the acceptance test using real API credits — nothing runs automatically."
        />
      </div>

      <div className="settings-group">
        <div className="settings-group-title">About</div>
        <KeyValue
          items={[
            { key: 'VoiceForge Studio', value: info?.version ?? '—' },
            { key: 'Electron', value: info?.electron ?? '—' },
            { key: 'Node', value: info?.node ?? '—' },
            { key: 'Platform', value: info?.platform ?? window.vf.platform },
            { key: 'Logs', value: <span className="mono xs">{info?.logsPath ?? '—'}</span> }
          ]}
        />
      </div>

      <ConfirmDialog open={confirmReset} onClose={() => setConfirmReset(false)} onConfirm={reset} danger title="Reset all settings?" confirmLabel="Reset" message="General, provider, generation, spending, storage and advanced settings return to their defaults. API keys, channels, templates and projects are not affected." />
    </div>
  )
}
