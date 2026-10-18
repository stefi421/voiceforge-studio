import type { JSX } from 'react'
import type { Script } from '@shared/types'
import { contentTypeLabel } from '@/lib/formats'
import { Badge } from '@/components/ui'

/** Which format, template version and reference set produced a script. */
export function ScriptProvenance({ script }: { script: Pick<Script, 'contentType' | 'templateVersionNumber' | 'referenceSetVersion' | 'approvedWithIssues'> }): JSX.Element {
  return (
    <>
      {script.contentType && <Badge title="Content type (format)">{contentTypeLabel(script.contentType)}</Badge>}
      {script.templateVersionNumber != null && <Badge title="Format version used to write this script">format v{script.templateVersionNumber}</Badge>}
      {script.referenceSetVersion != null ? <Badge title="Reference set version the format was built from">references v{script.referenceSetVersion}</Badge> : script.templateVersionNumber != null ? <Badge title="The format was not built from reference scripts">no reference set</Badge> : null}
      {script.approvedWithIssues && (
        <Badge tone="warning" title="Approved even though validation reported errors">
          approved with issues
        </Badge>
      )}
    </>
  )
}

export type ScriptView = 'script' | 'narration'

/** Switch between the saved script (with headings) and the clean narration sent to ElevenLabs. */
export function NarrationToggle({ value, onChange }: { value: ScriptView; onChange: (v: ScriptView) => void }): JSX.Element {
  return (
    <div className="segmented" role="tablist" aria-label="Script view" style={{ alignSelf: 'flex-start' }}>
      <button type="button" role="tab" aria-selected={value === 'script'} className={`segment ${value === 'script' ? 'active' : ''}`} onClick={() => onChange('script')}>
        Script
      </button>
      <button type="button" role="tab" aria-selected={value === 'narration'} className={`segment ${value === 'narration' ? 'active' : ''}`} onClick={() => onChange('narration')} title="The exact text sent to ElevenLabs: non-spoken headings and metadata removed">
        Narration (sent to ElevenLabs)
      </button>
    </div>
  )
}

/** Narration text, falling back to the script when an older main did not store one. */
export function narrationOf(script: Pick<Script, 'narrationText' | 'text'>): string {
  return typeof script.narrationText === 'string' && script.narrationText.length > 0 ? script.narrationText : script.text
}

export function NarrationView({ script, dirty }: { script: Pick<Script, 'narrationText' | 'text'>; dirty?: boolean }): JSX.Element {
  const text = narrationOf(script)
  return (
    <div className="col gap-2">
      <pre className="ref-view narration-view">{text}</pre>
      <span className="xs subtle tnum">
        {text.length.toLocaleString()} characters sent to ElevenLabs{dirty ? ' · shows the last saved version; save your edits to update it' : ''}
      </span>
    </div>
  )
}
