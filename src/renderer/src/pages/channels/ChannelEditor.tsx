import { useEffect, useMemo, useState, type JSX } from 'react'
import { ArrowLeft, Save } from 'lucide-react'
import type { Channel, ChannelInput } from '@shared/types'
import { DEFAULT_RESEARCH, DEFAULT_VALIDATION, DEFAULT_VOICE_SETTINGS } from '@shared/defaults'
import { channelInputSchema } from '@shared/schemas'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, Card, ChannelIcon, PageHeader, Tabs, type TabItem } from '@/components/ui'
import { IdentityTab, OutputTab, ResearchTab, ValidationTab, WritingTab } from './tabs/BasicTabs'
import { VoiceTab } from './tabs/VoiceTab'
import { StyleStudio } from './studio/StyleStudio'

export type EditorTab = 'identity' | 'writing' | 'voice' | 'research' | 'validation' | 'output' | 'formats'

const TABS: TabItem<EditorTab>[] = [
  { id: 'identity', label: 'Identity' },
  { id: 'writing', label: 'Writing' },
  { id: 'voice', label: 'Voice' },
  { id: 'research', label: 'Research' },
  { id: 'validation', label: 'Validation' },
  { id: 'output', label: 'Output' },
  { id: 'formats', label: 'Formats' }
]

export type FieldErrors = Record<string, string>

export function emptyChannelInput(settings: ReturnType<typeof useApp.getState>['settings']): ChannelInput {
  return {
    name: '',
    icon: '🎬',
    color: '#7C5CFF',
    description: '',
    category: 'gaming',
    language: 'en',
    writingInstructions: '',
    writingStyle: '',
    introRequirements: '',
    outroRequirements: '',
    targetDurationSec: 270,
    minChars: 3500,
    maxChars: 4700,
    pronunciationRules: [],
    elevenVoiceId: null,
    elevenVoiceName: null,
    elevenModelId: settings.elevenlabs.defaultModelId,
    elevenVoiceSettings: { ...DEFAULT_VOICE_SETTINGS },
    outputFormat: settings.elevenlabs.defaultOutputFormat,
    outputFolder: null,
    openaiModel: null,
    research: { ...DEFAULT_RESEARCH },
    validation: { ...DEFAULT_VALIDATION, forbiddenPhrases: [] },
    archived: false
  }
}

function toInput(c: Channel): ChannelInput {
  const { id: _id, slug: _slug, createdAt: _c, updatedAt: _u, position: _p, activeTemplateVersionId: _a, ...rest } = c
  return { ...rest, pronunciationRules: [...c.pronunciationRules], elevenVoiceSettings: { ...c.elevenVoiceSettings }, research: { ...c.research }, validation: { ...c.validation, forbiddenPhrases: [...c.validation.forbiddenPhrases] } }
}

function isTab(v: string | undefined): v is EditorTab {
  return TABS.some((t) => t.id === v)
}

/** Old links (and the smoke-test hooks) still say "templates". */
function initial(v: string | undefined): EditorTab {
  if (v === 'templates') return 'formats'
  return isTab(v) ? v : 'identity'
}

export interface ChannelEditorProps {
  channelId: string | null
  initialTab?: string | undefined
  /** Template id to open in the Formats tab. */
  initialFormat?: string | undefined
  onClose: () => void
}

export function ChannelEditor({ channelId, initialTab, initialFormat, onClose }: ChannelEditorProps): JSX.Element {
  const settings = useApp((s) => s.settings)
  const existing = useApp((s) => (channelId ? s.channels.find((c) => c.id === channelId) : undefined))
  const [tab, setTab] = useState<EditorTab>(initial(initialTab))
  const [form, setForm] = useState<ChannelInput>(() => (existing ? toInput(existing) : emptyChannelInput(settings)))
  const [saved, setSaved] = useState<ChannelInput>(form)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [saving, setSaving] = useState(false)
  const [createdId, setCreatedId] = useState<string | null>(channelId)

  // Re-sync when channel changes externally (e.g. templates:setActive returns the channel).
  useEffect(() => {
    if (existing) {
      const inp = toInput(existing)
      setForm((prev) => (JSON.stringify(prev) === JSON.stringify(saved) ? inp : prev))
      setSaved(inp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.updatedAt])

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved])
  const patch = (p: Partial<ChannelInput>): void => setForm((f) => ({ ...f, ...p }))

  const validate = (): boolean => {
    const result = channelInputSchema.safeParse(form)
    if (result.success) {
      setErrors({})
      return true
    }
    const errs: FieldErrors = {}
    for (const issue of result.error.issues) {
      const key = issue.path.map(String).join('.') || '_form'
      if (!errs[key]) errs[key] = issue.message
    }
    setErrors(errs)
    const first = Object.keys(errs)[0] ?? ''
    const tabFor: Record<string, EditorTab> = {
      name: 'identity',
      icon: 'identity',
      color: 'identity',
      description: 'identity',
      category: 'identity',
      language: 'identity',
      writingInstructions: 'writing',
      writingStyle: 'writing',
      introRequirements: 'writing',
      outroRequirements: 'writing',
      targetDurationSec: 'writing',
      minChars: 'writing',
      maxChars: 'writing',
      pronunciationRules: 'writing',
      _form: 'writing',
      elevenVoiceId: 'voice',
      elevenModelId: 'voice',
      elevenVoiceSettings: 'voice',
      outputFormat: 'voice',
      research: 'research',
      validation: 'validation',
      outputFolder: 'output',
      openaiModel: 'output'
    }
    const root = first.split('.')[0] ?? ''
    const t = tabFor[root]
    if (t) setTab(t)
    toast.warning('Please fix the highlighted fields', Object.values(errs)[0])
    return false
  }

  const save = async (): Promise<boolean> => {
    if (!validate()) return false
    setSaving(true)
    try {
      let result: Channel
      if (createdId) {
        result = await api.invoke('channels:update', { id: createdId, patch: form })
      } else {
        result = await api.invoke('channels:create', form)
        setCreatedId(result.id)
      }
      await useApp.getState().refreshChannels()
      const inp = toInput(result)
      setForm(inp)
      setSaved(inp)
      toast.success(createdId ? 'Channel saved' : 'Channel created', result.name)
      return true
    } catch (err) {
      toast.error('Could not save channel', err)
      return false
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, createdId])

  const title = createdId ? form.name || existing?.name || 'Channel' : 'New channel'

  return (
    <div className="page fade-in">
      <PageHeader
        title={
          <span className="row gap-3">
            <ChannelIcon icon={form.icon} color={form.color} />
            {title}
            {dirty && <Badge tone="accent">unsaved</Badge>}
          </span>
        }
        subtitle={createdId ? 'Changes apply to new jobs; running jobs keep the settings they started with.' : 'Define how this channel writes and sounds.'}
        actions={
          <>
            <Button icon={<ArrowLeft size={14} />} onClick={onClose}>
              Back to channels
            </Button>
            <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={!dirty && Boolean(createdId)} onClick={() => void save()}>
              {createdId ? 'Save changes' : 'Create channel'}
            </Button>
          </>
        }
      />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {errors._form && <Alert tone="danger">{errors._form}</Alert>}
      <Card padded>
        {tab === 'identity' && <IdentityTab form={form} patch={patch} errors={errors} />}
        {tab === 'writing' && <WritingTab form={form} patch={patch} errors={errors} channelId={createdId} />}
        {tab === 'voice' && <VoiceTab form={form} patch={patch} errors={errors} />}
        {tab === 'research' && <ResearchTab form={form} patch={patch} errors={errors} />}
        {tab === 'validation' && <ValidationTab form={form} patch={patch} errors={errors} />}
        {tab === 'output' && <OutputTab form={form} patch={patch} errors={errors} />}
        {tab === 'formats' &&
          (createdId ? (
            <StyleStudio key={createdId} channelId={createdId} channelName={form.name || existing?.name || 'Channel'} activeVersionId={existing?.activeTemplateVersionId ?? null} channelInstructions={form.writingInstructions} initialTemplateId={initialFormat} minChars={form.minChars} maxChars={form.maxChars} />
          ) : (
            <Alert tone="info" title="Save the channel first" actions={<Button size="sm" variant="primary" onClick={() => void save()}>Create channel</Button>}>
              Formats are stored per channel, so the channel must exist before you can add one.
            </Alert>
          ))}
      </Card>
    </div>
  )
}
