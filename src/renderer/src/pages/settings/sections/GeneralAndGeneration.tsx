import type { JSX } from 'react'
import { FolderOpen, Wand2 } from 'lucide-react'
import type { AppSettings, JobMode } from '@shared/types'
import { modeLabel } from '@/lib/jobs'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { Button, Field, Input, Select, Switch } from '@/components/ui'
import { useSettingsPatch } from '../useSettingsPatch'
import { DeferredNumber } from './ProviderShared'

export function GeneralSection(): JSX.Element {
  const { settings, set } = useSettingsPatch()
  const info = useApp((s) => s.info)
  const g = settings.general

  const pickOutput = async (): Promise<void> => {
    try {
      const dir = await api.invoke('app:selectFolder', { title: 'Choose output root folder', defaultPath: g.outputRoot ?? info?.outputRoot })
      if (dir) await set('general', 'outputRoot', dir)
    } catch (err) {
      toast.error('Could not pick folder', err)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-group">
        <div className="settings-group-title">Appearance</div>
        <div className="form-grid">
          <Field label="Theme">
            <Select
              value={g.theme}
              onChange={(v) => void set('general', 'theme', v as AppSettings['general']['theme'])}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
                { value: 'system', label: 'Follow system' }
              ]}
            />
          </Field>
          <Field label="Language" hint="Affects labels and defaults only; the interface stays in English in this version.">
            <Select
              value={g.language}
              onChange={(v) => void set('general', 'language', v as AppSettings['general']['language'])}
              options={[
                { value: 'en', label: 'English' },
                { value: 'sr', label: 'Serbian (Srpski)' }
              ]}
            />
          </Field>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-title">Output</div>
        <Field label="Output root folder" hint={`Projects are created as subfolders here${info ? `. Current: ${info.outputRoot}` : ''}.`}>
          <div className="row">
            <Input value={g.outputRoot ?? ''} readOnly placeholder={info?.outputRoot ?? 'Default'} className="mono" />
            <Button icon={<FolderOpen size={14} />} onClick={pickOutput}>
              Browse
            </Button>
            {g.outputRoot && (
              <Button variant="ghost" onClick={() => void set('general', 'outputRoot', null)}>
                Reset
              </Button>
            )}
          </div>
        </Field>
        <Switch checked={g.autoOpenFolderOnBatchComplete} onChange={(v) => void set('general', 'autoOpenFolderOnBatchComplete', v)} label="Open the output folder when a batch completes" />
      </div>
      <div className="settings-group">
        <div className="settings-group-title">Setup</div>
        <div className="row-between">
          <div className="small muted">Walk through API keys, voices per channel and the output folder again.</div>
          <Button icon={<Wand2 size={14} />} onClick={() => useApp.getState().setWizardForced(true)}>
            Run setup again
          </Button>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-title">System</div>
        <Switch checked={g.notifications} onChange={(v) => void set('general', 'notifications', v)} label="Desktop notifications" description="Notify when batches finish or jobs need your input." />
        <Switch checked={g.launchAtStartup} onChange={(v) => void set('general', 'launchAtStartup', v)} label="Launch at startup" description="Start VoiceForge Studio when you sign in to Windows." />
      </div>
    </div>
  )
}

export function GenerationSection(): JSX.Element {
  const { settings, set } = useSettingsPatch()
  const g = settings.generation
  return (
    <div className="settings-section">
      <div className="settings-group">
        <div className="settings-group-title">Defaults</div>
        <div className="form-grid">
          <Field label="Default mode">
            <Select value={g.defaultMode} onChange={(v) => void set('generation', 'defaultMode', v as JobMode)} options={(['auto', 'review_before_voice', 'scripts_only'] as JobMode[]).map((m) => ({ value: m, label: modeLabel(m) }))} />
          </Field>
          <Field label="Validation strictness" hint="Strict treats warnings as errors; relaxed only fails on hard rules.">
            <Select
              value={g.validationStrictness}
              onChange={(v) => void set('generation', 'validationStrictness', v as AppSettings['generation']['validationStrictness'])}
              options={[
                { value: 'relaxed', label: 'Relaxed' },
                { value: 'standard', label: 'Standard' },
                { value: 'strict', label: 'Strict' }
              ]}
            />
          </Field>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-title">Concurrency & retries</div>
        <div className="form-grid">
          <Field label="Max concurrent jobs" hint="Jobs processed in parallel. Provider concurrency limits still apply.">
            <DeferredNumber value={g.maxConcurrentJobs} onCommit={(v) => void set('generation', 'maxConcurrentJobs', v ?? 1)} min={1} max={20} />
          </Field>
          <Field label="Max rewrite attempts" hint="Automatic rewrites when validation fails (channel setting overrides).">
            <DeferredNumber value={g.maxRewriteAttempts} onCommit={(v) => void set('generation', 'maxRewriteAttempts', v ?? 0)} min={0} max={10} />
          </Field>
          <Field label="Stage retries" hint="Retries per stage for transient errors (network, rate limits).">
            <DeferredNumber value={g.maxStageRetries} onCommit={(v) => void set('generation', 'maxStageRetries', v ?? 0)} min={0} max={10} />
          </Field>
          <Field label="Large batch warning threshold" hint="Batches at or above this size require confirmation.">
            <DeferredNumber value={g.largeBatchWarningThreshold} onCommit={(v) => void set('generation', 'largeBatchWarningThreshold', v ?? 1)} min={1} max={1000} suffix="jobs" />
          </Field>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-title">Safety</div>
        <Switch checked={g.duplicateDetection} onChange={(v) => void set('generation', 'duplicateDetection', v)} label="Duplicate detection" description="Warn about titles that already have a project in the channel." />
        <Switch checked={g.confirmExpensiveRegeneration} onChange={(v) => void set('generation', 'confirmExpensiveRegeneration', v)} label="Confirm expensive regeneration" description="Require an explicit confirmation before re-generating audio for an existing script." />
      </div>
    </div>
  )
}
