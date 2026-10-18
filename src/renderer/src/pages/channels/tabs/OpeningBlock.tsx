import { useEffect, useState, type JSX } from 'react'
import { Lock, Save } from 'lucide-react'
import type { ChannelOpening, ValidationRules } from '@shared/types'
import { api } from '@/lib/api'
import { toast } from '@/store/toasts'
import { Badge, Button, Field, Switch, Textarea } from '@/components/ui'

interface OpeningBlockProps {
  channelId: string | null
  channelName: string
  validation: ValidationRules
  onValidation: (v: ValidationRules) => void
}

/**
 * Fast path for a channel's opening and closing. Text typed here is saved as LOCKED spoken
 * blocks in a new version of the channel's default format — the writer must use it word for
 * word and validation enforces it. Without a fixed intro, the toggle decides whether scripts
 * start with a short channel introduction.
 */
export function OpeningBlock({ channelId, channelName, validation, onValidation }: OpeningBlockProps): JSX.Element {
  const [loaded, setLoaded] = useState<ChannelOpening | null>(null)
  const [intro, setIntro] = useState('')
  const [outro, setOutro] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!channelId) return
    let alive = true
    api
      .invoke('channels:getOpening', { channelId })
      .then((o) => {
        if (!alive) return
        setLoaded(o)
        setIntro(o.intro)
        setOutro(o.outro)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [channelId])

  const autoIntro = validation.openWithChannelIntro !== false
  const dirty = !!loaded && (intro.trim() !== loaded.intro || outro.trim() !== loaded.outro)

  const save = async (): Promise<void> => {
    if (!channelId) return
    setSaving(true)
    try {
      const o = await api.invoke('channels:setOpening', { channelId, intro, outro, openWithChannelIntro: autoIntro })
      setLoaded(o)
      setIntro(o.intro)
      setOutro(o.outro)
      toast.success('Opening saved', o.intro || o.outro ? 'Saved as locked text in a new format version.' : 'Fixed opening and closing removed.')
    } catch (err) {
      toast.error('Could not save the opening', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="limits-box opening-box">
      <div className="row gap-2" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="strong">Opening and closing</div>
          <div className="small muted">
            Text here is used word for word at the start or end of every {channelName} script and checked before audio. Leave it empty if the wording should vary.
          </div>
        </div>
        {loaded?.intro && (
          <Badge tone="success">
            <Lock size={11} /> Fixed intro
          </Badge>
        )}
      </div>
      {!channelId ? (
        <div className="small muted">Save the channel first to set a fixed opening.</div>
      ) : (
        <>
          <div className="form-grid">
            <Field label="Fixed intro" hint="First words of every script.">
              <Textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={3} placeholder={`e.g. Welcome back to ${channelName}…`} />
            </Field>
            <Field label="Fixed outro" hint="Last words of every script.">
              <Textarea value={outro} onChange={(e) => setOutro(e.target.value)} rows={3} placeholder="e.g. Thanks for watching — see you in the next one." />
            </Field>
          </div>
          {!intro.trim() && (
            <Switch
              checked={autoIntro}
              onChange={(v) => onValidation({ ...validation, openWithChannelIntro: v })}
              label="Start with a short channel introduction"
              description={`Without a fixed intro, scripts open with one or two sentences that name ${channelName} and the title, worded differently each time.`}
            />
          )}
          <div className="row gap-2" style={{ justifyContent: 'flex-end' }}>
            <Button variant={dirty ? 'primary' : 'secondary'} size="sm" icon={<Save size={14} />} loading={saving} disabled={!dirty || saving} onClick={() => void save()}>
              Save opening
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
