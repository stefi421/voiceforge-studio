import { useEffect, useState, type JSX } from 'react'
import { Download, ExternalLink, RefreshCw, RotateCcw } from 'lucide-react'
import type { UpdateStatus } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, Field, Input, ProgressBar, Switch } from '@/components/ui'
import { formatBytes, relativeTime } from '@/lib/format'
import { useSettingsPatch } from '../useSettingsPatch'

/** Local-only text input that commits on blur / Enter so every keystroke doesn't hit settings:update. */
function DeferredText({ value, onCommit, placeholder, pattern }: { value: string; onCommit: (v: string) => void; placeholder?: string; pattern?: RegExp }): JSX.Element {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  const commit = (): void => {
    const v = local.trim()
    if (pattern && v && !pattern.test(v)) {
      toast.warning('Invalid value', 'Use only letters, digits, dots, dashes and underscores.')
      setLocal(value)
      return
    }
    if (v !== value) onCommit(v)
  }
  return <Input value={local} onChange={(e) => setLocal(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} placeholder={placeholder} autoComplete="off" spellCheck={false} />
}

export function UpdatesSection(): JSX.Element {
  const { settings, set } = useSettingsPatch()
  const info = useApp((s) => s.info)
  const status = useApp((s) => s.updateStatus)
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const u = settings.updates

  const run = async (kind: 'check' | 'download' | 'install'): Promise<void> => {
    setBusy(kind)
    try {
      if (kind === 'install') {
        const r = await api.invoke('updates:install', undefined)
        if (!r.ok) toast.warning('Could not start the installer', r.message)
        return
      }
      const next = await api.invoke(kind === 'check' ? 'updates:check' : 'updates:download', undefined)
      useApp.getState().setUpdateStatus(next)
      if (kind === 'check' && next.state === 'not_available') toast.success("You're up to date", `VoiceForge Studio ${next.currentVersion} is the latest version.`)
    } catch (err) {
      toast.error(kind === 'check' ? 'Update check failed' : 'Download failed', err)
    } finally {
      setBusy(null)
    }
  }

  const openRelease = async (url: string): Promise<void> => {
    try {
      const r = await api.invoke('app:openPath', { path: url })
      if (!r.ok) toast.warning('Could not open the release page', r.message)
    } catch (err) {
      toast.error('Could not open the release page', err)
    }
  }

  const feedConfigured = Boolean(u.owner && u.repo)
  const version = status?.currentVersion ?? info?.version ?? '—'

  return (
    <div className="settings-section">
      <div className="settings-group">
        <div className="row-between">
          <div className="settings-group-title">Updates</div>
          <Badge tone="neutral">Installed: {version}</Badge>
        </div>
        <p className="small muted" style={{ maxWidth: 620 }}>
          New versions install over the current one — your channels, scripts, audio and keys stay where they are. Nothing downloads without you clicking it, and every download is checked against the checksum in the published release manifest before it runs.
        </p>
        <UpdateStatusPanel status={status} busy={busy} feedConfigured={feedConfigured} onCheck={() => void run('check')} onDownload={() => void run('download')} onInstall={() => void run('install')} onOpenRelease={(url) => void openRelease(url)} />
      </div>
      <div className="settings-group">
        <div className="settings-group-title">Release source</div>
        <div className="form-grid">
          <Field label="GitHub owner" hint="The account or organisation that publishes releases.">
            <DeferredText value={u.owner} onCommit={(v) => void set('updates', 'owner', v)} placeholder="owner" pattern={/^[A-Za-z0-9-]+$/} />
          </Field>
          <Field label="Repository" hint="Releases must contain the installer and its latest.yml manifest.">
            <DeferredText value={u.repo} onCommit={(v) => void set('updates', 'repo', v)} placeholder="voiceforge-studio" pattern={/^[A-Za-z0-9_.-]+$/} />
          </Field>
        </div>
        <Switch checked={u.checkOnStartup} onChange={(v) => void set('updates', 'checkOnStartup', v)} label="Check for updates when the app starts" description="Only checks the version number; nothing is downloaded automatically." />
        <Switch checked={u.allowPrerelease} onChange={(v) => void set('updates', 'allowPrerelease', v)} label="Include pre-releases" description="Offer beta builds marked as pre-release on GitHub." />
      </div>
    </div>
  )
}

export function UpdateStatusPanel({
  status,
  busy,
  feedConfigured,
  onCheck,
  onDownload,
  onInstall,
  onOpenRelease
}: {
  status: UpdateStatus | null
  busy: 'check' | 'download' | 'install' | null
  feedConfigured: boolean
  onCheck: () => void
  onDownload: () => void
  onInstall: () => void
  onOpenRelease: (url: string) => void
}): JSX.Element {
  const state = status?.state ?? 'idle'
  const checkButton = (
    <Button icon={<RefreshCw size={14} />} loading={busy === 'check'} disabled={!feedConfigured || busy !== null} onClick={onCheck}>
      Check for updates
    </Button>
  )

  if (!feedConfigured) {
    return <Alert tone="neutral" title="No release source yet">Enter the GitHub owner and repository below to enable update checks.</Alert>
  }

  if (state === 'unsupported') {
    return (
      <Alert tone="info" title={status?.portable ? 'Portable build' : 'Updates are not available in this build'} actions={status?.releaseUrl ? <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => onOpenRelease(status.releaseUrl!)}>Open download page</Button> : checkButton}>
        {status?.portable
          ? 'The portable version cannot replace its own file while it is running. Download the new portable exe (or the installer) from the release page and swap it in; your data in %APPDATA% is kept.'
          : (status?.error ?? 'This build was not packaged with an updater.')}
      </Alert>
    )
  }

  if (state === 'checking') {
    return (
      <div className="update-panel">
        <ProgressBar value={0} indeterminate />
        <span className="small muted">Checking for a newer version…</span>
      </div>
    )
  }

  if (state === 'available' && status) {
    return (
      <div className="update-panel">
        <div className="row-between">
          <div>
            <div className="strong">Version {status.latestVersion} is available</div>
            <div className="xs subtle">
              {status.releaseDate ? `Published ${relativeTime(status.releaseDate)}` : 'Published on GitHub'} · you have {status.currentVersion}
            </div>
          </div>
          <div className="row">
            {status.releaseUrl && (
              <Button variant="ghost" size="sm" icon={<ExternalLink size={13} />} onClick={() => onOpenRelease(status.releaseUrl!)}>
                Release page
              </Button>
            )}
            <Button variant="primary" icon={<Download size={14} />} loading={busy === 'download'} disabled={busy !== null} onClick={onDownload}>
              Download update
            </Button>
          </div>
        </div>
        {status.releaseNotes && <pre className="release-notes selectable">{status.releaseNotes}</pre>}
      </div>
    )
  }

  if (state === 'downloading' && status) {
    const pct = status.progressPercent ?? 0
    return (
      <div className="update-panel">
        <div className="row-between small">
          <span>Downloading version {status.latestVersion}…</span>
          <span className="muted">
            {Math.round(pct)}%{status.bytesPerSecond ? ` · ${formatBytes(status.bytesPerSecond)}/s` : ''}
          </span>
        </div>
        <ProgressBar value={pct} max={100} />
      </div>
    )
  }

  if (state === 'downloaded' && status) {
    return (
      <Alert tone="success" title={`Version ${status.latestVersion} is ready to install`} actions={<Button variant="primary" size="sm" icon={<RotateCcw size={13} />} loading={busy === 'install'} onClick={onInstall}>Restart and install</Button>}>
        The app will close, the installer will run over the current version, and VoiceForge Studio will start again. Running jobs are paused safely and resume afterwards.
      </Alert>
    )
  }

  if (state === 'error') {
    return (
      <Alert tone="danger" title="Update check failed" actions={checkButton}>
        {status?.error ?? 'Unknown error.'}
      </Alert>
    )
  }

  return (
    <div className="update-panel">
      <div className="row-between">
        <div>
          <div className="strong">{state === 'not_available' ? "You're up to date" : 'Not checked yet'}</div>
          <div className="xs subtle">{status?.checkedAt ? `Last checked ${relativeTime(status.checkedAt)}` : 'Click the button to look for a newer version.'}</div>
        </div>
        {checkButton}
      </div>
    </div>
  )
}
