import { useEffect, useMemo, useState, type JSX } from 'react'
import { ArrowLeft, ArrowRight, Check, FolderOpen, KeyRound, Mic, Sparkles, Tv, Wand2 } from 'lucide-react'
import type { Channel, ElevenVoice } from '@shared/types'
import { ELEVEN_MODEL_NOTES } from '@shared/defaults'
import { api } from '@/lib/api'
import { useApp, activeChannels } from '@/store/app'
import { navigate } from '@/store/router'
import { toast } from '@/store/toasts'
import { Badge, Button, ChannelIcon, Input } from '@/components/ui'
import { ElevenModelSelect, MODEL_BADGE_LABEL, VoicePicker, isOwnVoice, prettyModelName, useElevenModels, voiceCategoryLabel } from '@/components/VoicePicker'
import { ApiKeyCard } from '@/pages/settings/sections/ProviderShared'

type StepId = 'welcome' | 'openai' | 'elevenlabs' | 'voices' | 'output' | 'done'

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'openai', label: 'OpenAI key' },
  { id: 'elevenlabs', label: 'ElevenLabs key' },
  { id: 'voices', label: 'Voices per channel' },
  { id: 'output', label: 'Output folder' },
  { id: 'done', label: 'Ready' }
]

/**
 * First-run setup. Shown instead of the app shell until the person finishes or skips it;
 * every step is optional so a half-configured app still opens. Reachable again from
 * Settings → General → "Run setup again".
 */
export function OnboardingWizard(): JSX.Element {
  const [index, setIndex] = useState(0)
  const [finishing, setFinishing] = useState(false)
  const secrets = useApp((s) => s.secrets)
  const settings = useApp((s) => s.settings)
  const channels = useApp((s) => s.channels)
  const info = useApp((s) => s.info)
  const step = STEPS[index]!.id

  const finish = async (goTo: 'generate' | 'dashboard' = 'dashboard'): Promise<void> => {
    setFinishing(true)
    try {
      await useApp.getState().updateSettings({ general: { onboardingCompleted: true } })
      useApp.getState().setWizardForced(false)
      navigate(goTo)
    } catch (err) {
      toast.error('Could not save setup state', err)
    } finally {
      setFinishing(false)
    }
  }

  // Smoke-test hook: window.dispatchEvent(new CustomEvent('vf:navigate', { detail: '__wizard:3' })) jumps to a step.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<unknown>).detail
      if (typeof detail === 'string' && detail.startsWith('__wizard:')) {
        const n = Number(detail.slice('__wizard:'.length))
        if (Number.isInteger(n) && n >= 0 && n < STEPS.length) setIndex(n)
      }
    }
    window.addEventListener('vf:navigate', handler)
    return () => window.removeEventListener('vf:navigate', handler)
  }, [])

  const next = (): void => setIndex((i) => Math.min(STEPS.length - 1, i + 1))
  const back = (): void => setIndex((i) => Math.max(0, i - 1))

  // Enter advances when the current step is satisfied (or has nothing to satisfy), unless typing in a field.
  const stepDone = stepSatisfied(step, { openai: secrets.openai, elevenlabs: secrets.elevenlabs, channels })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return
      if (step === 'done') {
        void finish('generate')
      } else if (stepDone) {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, stepDone])

  return (
    <div className="wizard">
      <aside className="wizard-rail">
        <div className="wizard-brand">
          <div className="brand-mark">
            <Mic size={15} />
          </div>
          <div>
            <div className="brand-text">VoiceForge</div>
            <div className="brand-sub">Studio · first-run setup</div>
          </div>
        </div>
        <ol className="wizard-steps">
          {STEPS.map((s, i) => {
            const state = i < index ? 'done' : i === index ? 'current' : 'todo'
            return (
              <li key={s.id} className={`wizard-step ${state}`}>
                <button type="button" className="wizard-step-btn" onClick={() => setIndex(i)} disabled={i > index}>
                  <span className="wizard-step-dot">{state === 'done' ? <Check size={11} /> : i + 1}</span>
                  <span>{s.label}</span>
                </button>
              </li>
            )
          })}
        </ol>
        <div className="wizard-rail-footer">
          <Button variant="ghost" size="sm" onClick={() => void finish('dashboard')} loading={finishing}>
            Skip setup
          </Button>
          <span className="xs subtle">You can run this again from Settings.</span>
        </div>
      </aside>

      <section className="wizard-main">
        <div className="wizard-panel" key={step}>
          <div className="wizard-panel-inner">
          {step === 'welcome' && <WelcomeStep />}
          {step === 'openai' && <OpenAIStep configured={secrets.openai} models={settings.openai} />}
          {step === 'elevenlabs' && <ElevenLabsStep configured={secrets.elevenlabs} />}
          {step === 'voices' && <VoicesStep channels={activeChannels(channels)} hasKey={secrets.elevenlabs} />}
          {step === 'output' && <OutputStep current={settings.general.outputRoot} fallback={info?.outputRoot ?? null} />}
          {step === 'done' && <DoneStep channels={activeChannels(channels)} />}
          </div>
        </div>
        <div className="wizard-footer">
          <div>
            {index > 0 && step !== 'done' && (
              <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={back}>
                Back
              </Button>
            )}
          </div>
          <div className="row">
            {step === 'done' ? (
              <>
                <Button onClick={() => void finish('dashboard')} loading={finishing}>
                  Go to dashboard
                </Button>
                <Button variant="primary" icon={<Sparkles size={14} />} onClick={() => void finish('generate')} loading={finishing}>
                  Start a generation
                </Button>
              </>
            ) : (
              <>
                {!stepDone && step !== 'welcome' && (
                  <Button variant="ghost" onClick={next}>
                    Skip this step
                  </Button>
                )}
                <Button variant="primary" icon={<ArrowRight size={14} />} onClick={next} disabled={step !== 'welcome' && !stepDone}>
                  {step === 'welcome' ? 'Start' : 'Continue'}
                </Button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function stepSatisfied(step: StepId, s: { openai: boolean; elevenlabs: boolean; channels: Channel[] }): boolean {
  switch (step) {
    case 'openai':
      return s.openai
    case 'elevenlabs':
      return s.elevenlabs
    case 'voices':
      return activeChannels(s.channels).some((c) => Boolean(c.elevenVoiceId))
    default:
      return true
  }
}

/* ------------------------------------------------------------------------ */
/* Steps                                                                     */
/* ------------------------------------------------------------------------ */

function StepHeader({ icon, title, lead }: { icon: JSX.Element; title: string; lead: string }): JSX.Element {
  return (
    <header className="wizard-head">
      <div className="wizard-head-icon">{icon}</div>
      <h1 className="wizard-title">{title}</h1>
      <p className="wizard-lead">{lead}</p>
    </header>
  )
}

function WelcomeStep(): JSX.Element {
  return (
    <>
      <StepHeader
        icon={<Wand2 size={20} />}
        title="Welcome to VoiceForge Studio"
        lead="Paste a list of game or product titles, pick a channel, and get finished scripts and voiceovers in neatly named folders. This takes about three minutes: two API keys, a voice for each channel, and a folder."
      />
      <ol className="wizard-overview">
        <li>
          <KeyRound size={15} />
          <div>
            <div className="strong">Connect OpenAI</div>
            <div className="small muted">Researches each title and writes the script in your channel's style.</div>
          </div>
        </li>
        <li>
          <Mic size={15} />
          <div>
            <div className="strong">Connect ElevenLabs</div>
            <div className="small muted">Turns the script into audio with the voices you already cloned or designed.</div>
          </div>
        </li>
        <li>
          <Tv size={15} />
          <div>
            <div className="strong">Assign a voice to each channel</div>
            <div className="small muted">So every batch sounds right without choosing a voice again.</div>
          </div>
        </li>
        <li>
          <FolderOpen size={15} />
          <div>
            <div className="strong">Choose where files go</div>
            <div className="small muted">One folder per channel, one subfolder per title: Script.txt, Voice.mp3, Research.json.</div>
          </div>
        </li>
      </ol>
      <p className="small subtle">Your keys are encrypted with Windows DPAPI for your user account and never leave this computer except to call the provider.</p>
    </>
  )
}

function OpenAIStep({ configured, models }: { configured: boolean; models: { defaultModel: string; researchModel: string; reviewModel: string } }): JSX.Element {
  return (
    <>
      <StepHeader
        icon={<KeyRound size={20} />}
        title="Connect OpenAI"
        lead="Create a key at platform.openai.com → API keys, paste it here and save. Then test the connection once so you know billing is enabled on the account."
      />
      <ApiKeyCard provider="openai" label="OpenAI" testChannel="openai:test" />
      <div className="wizard-note">
        <div className="strong small">Models used by default</div>
        <div className="wizard-models">
          <span>
            <span className="muted">Research & writing</span> <code className="inline-code">{models.defaultModel}</code>
          </span>
          <span>
            <span className="muted">Fact check</span> <code className="inline-code">{models.reviewModel}</code>
          </span>
        </div>
        <div className="xs subtle">Change them any time in Settings → OpenAI; the full list of models comes from your account.</div>
      </div>
      {configured && (
        <div className="wizard-ok">
          <Check size={14} /> Key saved. Press Continue.
        </div>
      )}
    </>
  )
}

function ElevenLabsStep({ configured }: { configured: boolean }): JSX.Element {
  const hasKey = useApp((s) => s.secrets.elevenlabs)
  const vs = useVoicesState(hasKey)
  const voices = vs.voices
  const mine = voices.filter(isOwnVoice)
  return (
    <>
      <StepHeader
        icon={<Mic size={20} />}
        title="Connect ElevenLabs"
        lead="Your API key is under your profile in ElevenLabs. Once saved, your cloned, professional and designed voices load automatically."
      />
      <ApiKeyCard provider="elevenlabs" label="ElevenLabs" testChannel="eleven:test" />
      {configured && (
        <div className="wizard-ok">
          <Check size={14} />
          {vs.error ? `Key saved, but voices could not be loaded: ${vs.error}` : !vs.loaded ? 'Key saved. Loading your voices…' : voices.length === 0 ? 'Key saved. This account has no voices yet — create or clone one in ElevenLabs, then refresh in the channel Voice tab.' : `Key saved. ${voices.length} voices available, ${mine.length} of them your own${mine.length ? `: ${mine.slice(0, 4).map((v) => v.name).join(', ')}${mine.length > 4 ? '…' : ''}` : ''}.`}
        </div>
      )}
    </>
  )
}

interface VoicesState {
  voices: ElevenVoice[]
  loaded: boolean
  error: string | null
}

function useVoicesState(enabled: boolean): VoicesState {
  const [state, setState] = useState<VoicesState>({ voices: [], loaded: false, error: null })
  useEffect(() => {
    if (!enabled) {
      setState({ voices: [], loaded: false, error: null })
      return
    }
    let cancelled = false
    setState((s) => ({ ...s, loaded: false, error: null }))
    api
      .invoke('eleven:listVoices', {})
      .then((v) => {
        if (!cancelled) setState({ voices: Array.isArray(v) ? v : [], loaded: true, error: null })
      })
      .catch((err: { message?: string }) => {
        if (!cancelled) setState({ voices: [], loaded: true, error: err?.message ?? 'Could not load voices' })
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return state
}

function useAsyncVoices(enabled: boolean): ElevenVoice[] {
  return useVoicesState(enabled).voices
}

function VoicesStep({ channels, hasKey }: { channels: Channel[]; hasKey: boolean }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const { models } = useElevenModels()
  const defaultModel = useApp((s) => s.settings.elevenlabs.defaultModelId)
  const note = ELEVEN_MODEL_NOTES[defaultModel]
  const voices = useAsyncVoices(hasKey)
  const byId = useMemo(() => new Map(voices.map((v) => [v.voiceId, v])), [voices])

  const patch = async (channel: Channel, p: { elevenVoiceId?: string | null; elevenVoiceName?: string | null; elevenModelId?: string }): Promise<void> => {
    setBusy(channel.id)
    try {
      await api.invoke('channels:update', { id: channel.id, patch: p })
      await useApp.getState().refreshChannels()
    } catch (err) {
      toast.error(`Could not update ${channel.name}`, err)
    } finally {
      setBusy(null)
    }
  }

  const applyModelToAll = async (): Promise<void> => {
    setBusy('all')
    try {
      for (const c of channels) if (c.elevenModelId !== defaultModel) await api.invoke('channels:update', { id: c.id, patch: { elevenModelId: defaultModel } })
      await useApp.getState().refreshChannels()
      toast.success('Model applied', `${prettyModelName(defaultModel)} is now used by every channel.`)
    } catch (err) {
      toast.error('Could not apply the model', err)
    } finally {
      setBusy(null)
    }
  }

  const allOnDefault = channels.every((c) => c.elevenModelId === defaultModel)

  return (
    <>
      <StepHeader
        icon={<Tv size={20} />}
        title="Give each channel a voice"
        lead="Pick the voice a channel should always narrate with. Your own cloned and designed voices are listed first; you can change this later in the channel's Voice tab."
      />
      {!hasKey && <div className="wizard-note">Add the ElevenLabs key in the previous step to load your voices, or skip this and assign voices later.</div>}
      <div className="wizard-channels">
        {channels.map((c) => {
          const v = c.elevenVoiceId ? byId.get(c.elevenVoiceId) : undefined
          const isOpen = open === c.id
          return (
            <div key={c.id} className={`wizard-channel ${isOpen ? 'open' : ''}`}>
              <div className="wizard-channel-row">
                <ChannelIcon icon={c.icon} color={c.color} />
                <div className="col" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                  <span className="strong truncate">{c.name}</span>
                  <span className="xs subtle truncate">
                    {c.elevenVoiceId ? (
                      <>
                        {c.elevenVoiceName ?? c.elevenVoiceId}
                        {v && <> · {voiceCategoryLabel(v.category)}</>}
                        {' · '}
                        {prettyModelName(c.elevenModelId)}
                      </>
                    ) : (
                      'No voice yet'
                    )}
                  </span>
                </div>
                {c.elevenVoiceId ? <Badge tone="success" dot>Ready</Badge> : <Badge tone="warning" dot>Needs a voice</Badge>}
                <Button size="sm" variant={isOpen ? 'secondary' : c.elevenVoiceId ? 'ghost' : 'primary'} disabled={!hasKey} loading={busy === c.id} onClick={() => setOpen(isOpen ? null : c.id)}>
                  {isOpen ? 'Close' : c.elevenVoiceId ? 'Change' : 'Choose voice'}
                </Button>
              </div>
              {isOpen && hasKey && (
                <div className="wizard-channel-picker">
                  <VoicePicker
                    compact
                    value={c.elevenVoiceId}
                    onChange={(voice) => {
                      void patch(c, { elevenVoiceId: voice?.voiceId ?? null, elevenVoiceName: voice?.name ?? null })
                      if (voice) setOpen(null)
                    }}
                  />
                  <div style={{ maxWidth: 420 }}>
                    <ElevenModelSelect value={c.elevenModelId} onChange={(id) => void patch(c, { elevenModelId: id })} models={models} />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="wizard-note">
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="strong small">Default model: {prettyModelName(defaultModel)}</span>
          {note && <Badge tone="accent">{MODEL_BADGE_LABEL[note.badge] ?? note.badge}</Badge>}
          {!allOnDefault && (
            <Button size="sm" variant="ghost" loading={busy === 'all'} onClick={applyModelToAll}>
              Use it for every channel
            </Button>
          )}
        </div>
        {note && <div className="xs subtle">{note.note}</div>}
      </div>
    </>
  )
}

function OutputStep({ current, fallback }: { current: string | null; fallback: string | null }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      const dir = await api.invoke('app:selectFolder', { title: 'Choose the output root folder', defaultPath: current ?? fallback ?? undefined })
      if (dir) await useApp.getState().updateSettings({ general: { outputRoot: dir } })
    } catch (err) {
      toast.error('Could not pick a folder', err)
    } finally {
      setBusy(false)
    }
  }
  const reset = async (): Promise<void> => {
    try {
      await useApp.getState().updateSettings({ general: { outputRoot: null } })
    } catch (err) {
      toast.error('Could not reset the folder', err)
    }
  }
  const shown = current ?? fallback ?? 'Documents\\VoiceForge Studio'
  return (
    <>
      <StepHeader icon={<FolderOpen size={20} />} title="Where should files go?" lead="Each channel gets a folder here, and each title a subfolder with Script.txt, Voice.mp3 and Research.json. A folder inside Documents is a good default." />
      <div className="row">
        <Input value={shown} readOnly className="mono" />
        <Button icon={<FolderOpen size={14} />} loading={busy} onClick={pick}>
          Browse
        </Button>
        {current && (
          <Button variant="ghost" onClick={reset}>
            Use default
          </Button>
        )}
      </div>
      <pre className="wizard-tree">{`${shown.split(/[\\/]/).filter(Boolean).pop() ?? 'VoiceForge Studio'}/
  Game Vault/
    Emberward/
      Script.txt
      Voice.mp3
      Research.json
  RENVO/
    …`}</pre>
    </>
  )
}

function DoneStep({ channels }: { channels: Channel[] }): JSX.Element {
  const ready = channels.filter((c) => c.elevenVoiceId).length
  const secrets = useApp((s) => s.secrets)
  return (
    <>
      <StepHeader icon={<Sparkles size={20} />} title="You're set" lead="From now on a batch is three moves. Everything you just set up is remembered per channel." />
      <ol className="wizard-overview numbered">
        <li>
          <span className="wizard-num">1</span>
          <div>
            <div className="strong">Select a channel</div>
            <div className="small muted">Its template, voice and folder come with it.</div>
          </div>
        </li>
        <li>
          <span className="wizard-num">2</span>
          <div>
            <div className="strong">Paste the titles</div>
            <div className="small muted">One per line, or import a .txt, .csv or .xlsx file.</div>
          </div>
        </li>
        <li>
          <span className="wizard-num">3</span>
          <div>
            <div className="strong">Click Generate All</div>
            <div className="small muted">Research → script → checks → voice → files. Open the channel folder when it finishes.</div>
          </div>
        </li>
      </ol>
      <div className="wizard-summary">
        <span className={secrets.openai ? 'ok' : ''}>{secrets.openai ? <Check size={13} /> : '–'} OpenAI {secrets.openai ? 'connected' : 'not connected'}</span>
        <span className={secrets.elevenlabs ? 'ok' : ''}>{secrets.elevenlabs ? <Check size={13} /> : '–'} ElevenLabs {secrets.elevenlabs ? 'connected' : 'not connected'}</span>
        <span className={ready > 0 ? 'ok' : ''}>{ready > 0 ? <Check size={13} /> : '–'} {ready} of {channels.length} channels have a voice</span>
      </div>
      {channels.some((c) => !c.elevenVoiceId) || !secrets.openai || !secrets.elevenlabs ? (
        <p className="small subtle">Anything still missing is listed on the dashboard, with a fix button next to it.</p>
      ) : null}
    </>
  )
}
