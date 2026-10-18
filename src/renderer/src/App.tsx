import { Component, useEffect, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { DASHBOARD_PAGES, type PageId } from '@shared/ipc'
import { useApp } from '@/store/app'
import { navigate, useRouter } from '@/store/router'
import { Sidebar } from '@/components/layout/Sidebar'
import { useShortcuts } from '@/components/layout/useShortcuts'
import { useTheme } from '@/components/layout/useTheme'
import { CommandPalette, ShortcutsDialog, useOverlays } from '@/components/layout/CommandPalette'
import { Alert, Button, ToastStack } from '@/components/ui'
import { DashboardPage } from '@/pages/Dashboard'
import { GeneratePage } from '@/pages/generate/GeneratePage'
import { ChannelsPage } from '@/pages/channels/ChannelsPage'
import { QueuePage } from '@/pages/queue/QueuePage'
import { ScriptsPage } from '@/pages/scripts/ScriptsPage'
import { AudioPage } from '@/pages/audio/AudioPage'
import { ProjectsPage } from '@/pages/projects/ProjectsPage'
import { HistoryPage } from '@/pages/history/HistoryPage'
import { UsagePage } from '@/pages/usage/UsagePage'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { OnboardingWizard } from '@/pages/onboarding/OnboardingWizard'
import { api } from '@/lib/api'

const PAGES: Record<PageId, () => JSX.Element> = {
  dashboard: DashboardPage,
  generate: GeneratePage,
  channels: ChannelsPage,
  queue: QueuePage,
  scripts: ScriptsPage,
  audio: AudioPage,
  projects: ProjectsPage,
  history: HistoryPage,
  usage: UsagePage,
  settings: SettingsPage
}

class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Page crashed', error, info.componentStack)
  }
  override componentDidUpdate(prev: { resetKey: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="page">
          <Alert tone="danger" title="This page hit an unexpected error" actions={<Button size="sm" onClick={() => this.setState({ error: null })}>Try again</Button>}>
            <span className="mono xs">{this.state.error.message}</span>
          </Alert>
        </div>
      )
    }
    return this.props.children
  }
}

export function App(): JSX.Element {
  const booted = useApp((s) => s.booted)
  const bootError = useApp((s) => s.bootError)
  const boot = useApp((s) => s.boot)
  const page = useRouter((s) => s.page)
  const nonce = useRouter((s) => s.nonce)
  const onboardingCompleted = useApp((s) => s.settings.general.onboardingCompleted)
  const wizardForced = useApp((s) => s.wizardForced)
  useTheme()
  useShortcuts()

  useEffect(() => {
    void boot()
  }, [boot])

  // External navigation hook used by the main process (e.g. the VF_SMOKE_TEST screenshot run):
  // window.dispatchEvent(new CustomEvent('vf:navigate', { detail: 'queue' }))
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<unknown>).detail
      if (typeof detail !== 'string') return
      if (detail.startsWith('__settings:')) {
        // Smoke-test helper: apply a settings patch, e.g. '__settings:{"general":{"theme":"light"}}'.
        try {
          const patch = JSON.parse(detail.slice('__settings:'.length)) as Record<string, Record<string, unknown>>
          void useApp.getState().updateSettings(patch).catch(() => undefined)
        } catch {
          /* ignore malformed */
        }
        return
      }
      if (detail === '__palette' || detail === '__shortcuts') {
        // Smoke-test helpers to capture the overlays.
        if (detail === '__palette') useOverlays.getState().setPalette(true)
        else useOverlays.getState().setShortcuts(true)
        return
      }
      if (detail === '__closeOverlays') {
        useOverlays.getState().setPalette(false)
        useOverlays.getState().setShortcuts(false)
        return
      }
      if (detail === '__skipOnboarding') {
        // Smoke-test helper: mark setup as done so the regular pages can be captured.
        void api.invoke('settings:update', { general: { onboardingCompleted: true } }).then((s) => useApp.getState().setSettings(s)).catch(() => undefined)
        return
      }
      // "settings?tab=updates" → navigate('settings', { tab: 'updates' })
      const [pageId, query] = detail.split('?')
      if (pageId && (DASHBOARD_PAGES as readonly string[]).includes(pageId)) {
        const params: Record<string, string> = {}
        if (query) for (const [k, v] of new URLSearchParams(query)) params[k] = v
        navigate(pageId as PageId, params)
      }
    }
    window.addEventListener('vf:navigate', handler)
    return () => window.removeEventListener('vf:navigate', handler)
  }, [])

  const Page = PAGES[page]

  if (booted && !bootError && (!onboardingCompleted || wizardForced)) {
    return (
      <>
        <OnboardingWizard />
        <ToastStack />
      </>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-area">
        {!booted ? (
          <div className="empty" style={{ flex: 1 }}>
            <div className="brand-mark" style={{ width: 40, height: 40, marginBottom: 8 }} />
            <div className="empty-title">Starting VoiceForge Studio…</div>
          </div>
        ) : bootError ? (
          <div className="page">
            <Alert tone="danger" title={<span className="row"><TriangleAlert size={14} /> Could not connect to the application backend</span>} actions={<Button size="sm" onClick={() => void boot()}>Retry</Button>}>
              {bootError}
            </Alert>
          </div>
        ) : (
          <PageErrorBoundary resetKey={`${page}:${nonce}`}>
            <Page key={page} />
          </PageErrorBoundary>
        )}
      </main>
      <CommandPalette />
      <ShortcutsDialog />
      <ToastStack />
    </div>
  )
}
