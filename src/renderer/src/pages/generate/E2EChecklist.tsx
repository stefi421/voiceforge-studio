import { useState, type JSX } from 'react'
import { FlaskConical } from 'lucide-react'
import { Alert, Button, Checkbox } from '@/components/ui'
import { useLocalStorage } from '@/lib/hooks'
import { navigate } from '@/store/router'

const STEPS: string[] = [
  'Both API keys are saved and "Test connection" passes in Settings.',
  'Pick a channel whose active template is NOT a placeholder and that has an ElevenLabs voice.',
  'Enter exactly one well-known title (e.g. a major release) and choose "Review Before Voice".',
  'Start the batch; in the Queue, watch the stages advance: Research → Script → Validate.',
  'When the job reaches "Awaiting Approval", open the script, make a small edit, Save, then Approve.',
  'Confirm audio generation starts, completes and the project folder contains script.txt and the MP3.',
  'Play the MP3 in the Audio Library and check the Usage page shows OpenAI and ElevenLabs entries for the job.',
  'Optional: retry a failed job, pause/resume the queue, export the channel JSON and re-import it.'
]

/** Shown on New Generation when Settings → Advanced → Manual E2E test mode is on. Nothing runs automatically. */
export function E2EChecklist(): JSX.Element {
  const [done, setDone] = useLocalStorage<boolean[]>('vf.e2e.checklist', STEPS.map(() => false))
  const [open, setOpen] = useState(true)
  const completed = done.filter(Boolean).length
  return (
    <Alert
      tone="info"
      title={
        <span className="row">
          <FlaskConical size={14} /> Live E2E test checklist ({completed}/{STEPS.length}) — uses real API credits
        </span>
      }
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
            {open ? 'Hide steps' : 'Show steps'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDone(STEPS.map(() => false))}>
            Reset
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('settings', { tab: 'advanced' })}>
            Turn off
          </Button>
        </>
      }
    >
      <div className="xs muted">This checklist only guides you through the acceptance test; nothing is started automatically.</div>
      {open && (
        <div className="checklist mt-2">
          {STEPS.map((s, i) => (
            <div key={i} className={`checklist-item ${done[i] ? 'done' : ''}`}>
              <Checkbox
                checked={Boolean(done[i])}
                onChange={(v) => {
                  const next = [...done]
                  next[i] = v
                  setDone(next)
                }}
                label={`${i + 1}. ${s}`}
              />
            </div>
          ))}
        </div>
      )}
    </Alert>
  )
}
