import { useEffect, useState, type JSX } from 'react'
import { Bot, Cloud, Coins, Download, HardDrive, KeyRound, Mic, Settings2, Wrench } from 'lucide-react'
import { useRouter } from '@/store/router'
import { Card, PageHeader, Tabs, type TabItem } from '@/components/ui'
import { GeneralSection, GenerationSection } from './sections/GeneralAndGeneration'
import { ElevenLabsSection, OpenAISection } from './sections/Providers'
import { SpendingSection } from './sections/Spending'
import { StorageSection } from './sections/Storage'
import { AdvancedSection, SyncSection } from './sections/AdvancedAndSync'
import { UpdatesSection } from './sections/Updates'

type SettingsTab = 'general' | 'openai' | 'elevenlabs' | 'generation' | 'spending' | 'storage' | 'updates' | 'sync' | 'advanced'

const TABS: TabItem<SettingsTab>[] = [
  { id: 'general', label: 'General', icon: <Settings2 size={14} /> },
  { id: 'openai', label: 'OpenAI', icon: <KeyRound size={14} /> },
  { id: 'elevenlabs', label: 'ElevenLabs', icon: <Mic size={14} /> },
  { id: 'generation', label: 'Generation', icon: <Bot size={14} /> },
  { id: 'spending', label: 'Spending', icon: <Coins size={14} /> },
  { id: 'storage', label: 'Storage', icon: <HardDrive size={14} /> },
  { id: 'updates', label: 'Updates', icon: <Download size={14} /> },
  { id: 'sync', label: 'Synchronization', icon: <Cloud size={14} /> },
  { id: 'advanced', label: 'Advanced', icon: <Wrench size={14} /> }
]

function isTab(v: string | undefined): v is SettingsTab {
  return TABS.some((t) => t.id === v)
}

export function SettingsPage(): JSX.Element {
  const params = useRouter((s) => s.params)
  const nonce = useRouter((s) => s.nonce)
  const [tab, setTab] = useState<SettingsTab>(isTab(params.tab) ? params.tab : 'general')
  useEffect(() => {
    if (isTab(params.tab)) setTab(params.tab)
  }, [params.tab, nonce])

  return (
    <div className="page fade-in">
      <PageHeader title="Settings" subtitle="Every change is saved as you make it." />
      <div className="settings-layout">
        <Tabs variant="vertical" tabs={TABS} value={tab} onChange={setTab} />
        <Card padded>
          {tab === 'general' && <GeneralSection />}
          {tab === 'openai' && <OpenAISection />}
          {tab === 'elevenlabs' && <ElevenLabsSection />}
          {tab === 'generation' && <GenerationSection />}
          {tab === 'spending' && <SpendingSection />}
          {tab === 'storage' && <StorageSection />}
          {tab === 'updates' && <UpdatesSection />}
          {tab === 'sync' && <SyncSection />}
          {tab === 'advanced' && <AdvancedSection />}
        </Card>
      </div>
    </div>
  )
}
