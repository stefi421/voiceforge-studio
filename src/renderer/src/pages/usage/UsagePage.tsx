import { useMemo, useState, type JSX } from 'react'
import { ChartColumn, RefreshCw, Settings } from 'lucide-react'
import { api } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { navigate } from '@/store/router'
import { formatCompact, formatCost, formatNumber, isoDay } from '@/lib/format'
import { Alert, Badge, Button, Card, CostLabel, EmptyState, Field, Input, PageHeader, ProgressBar, SkeletonRows, Tabs } from '@/components/ui'
import { BarChart } from './BarChart'

type Preset = 'today' | '7d' | '30d' | 'month' | 'custom'

function rangeFor(p: Preset, custom: { from: string; to: string }): { from?: string; to?: string } {
  const now = new Date()
  const today = isoDay(now)
  const daysAgo = (n: number): string => {
    const d = new Date(now)
    d.setDate(d.getDate() - n)
    return isoDay(d)
  }
  switch (p) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: daysAgo(6), to: today }
    case '30d':
      return { from: daysAgo(29), to: today }
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today }
    case 'custom':
      return { from: custom.from || undefined, to: custom.to || undefined }
  }
}

export function UsagePage(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const [preset, setPreset] = useState<Preset>('30d')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom])
  const usage = useAsync(() => api.invoke('usage:summary', range), [range.from, range.to])
  const u = usage.data

  const daily = useMemo(() => (Array.isArray(u?.daily) ? u.daily : []).map((d) => ({ label: d.day.slice(5), a: d.openaiCost, b: d.elevenCost })), [u])
  const monthly = useMemo(() => (Array.isArray(u?.monthly) ? u.monthly : []).map((m) => ({ label: m.month, a: m.openaiCost, b: m.elevenCost })), [u])
  const daily_ = settings.spending.dailyLimitUsd
  const monthly_ = settings.spending.monthlyLimitUsd

  return (
    <div className="page fade-in">
      <PageHeader
        title="Usage & costs"
        subtitle="All amounts are estimates computed locally from your pricing table. Check the provider dashboards for billing."
        actions={
          <>
            <Button icon={<Settings size={14} />} onClick={() => navigate('settings', { tab: 'spending' })}>
              Pricing & limits
            </Button>
            <Button icon={<RefreshCw size={14} />} loading={usage.loading} onClick={() => void usage.reload()}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <Tabs
          variant="pill"
          value={preset}
          onChange={setPreset}
          tabs={[
            { id: 'today', label: 'Today' },
            { id: '7d', label: '7 days' },
            { id: '30d', label: '30 days' },
            { id: 'month', label: 'This month' },
            { id: 'custom', label: 'Custom' }
          ]}
        />
        {preset === 'custom' && (
          <>
            <Field label="From">
              <Input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} inputSize="sm" />
            </Field>
            <Field label="To">
              <Input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} inputSize="sm" />
            </Field>
          </>
        )}
        <span className="spacer" />
        {u?.range && (
          <span className="xs muted">
            {u.range.from} → {u.range.to} · {u.estimatesLabel ?? 'estimates'}
          </span>
        )}
      </div>

      {usage.error && <Alert tone="danger" title="Could not load usage">{usage.error.message}</Alert>}

      <div className="grid grid-2">
        <Card title="OpenAI" actions={<Badge>estimate</Badge>}>
          <div className="card-body">
            {!u?.openai ? (
              <SkeletonRows rows={3} />
            ) : (
              <div className="grid grid-4" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
                <Mini label="Requests" value={formatNumber(u.openai.requests)} />
                <Mini label="Input tokens" value={formatCompact(u.openai.inputTokens)} />
                <Mini label="Output tokens" value={formatCompact(u.openai.outputTokens)} />
                <Mini label="Est. cost" value={<CostLabel usd={u.openai.estimatedCost} />} />
              </div>
            )}
          </div>
        </Card>
        <Card title="ElevenLabs" actions={<Badge>estimate</Badge>}>
          <div className="card-body">
            {!u?.elevenlabs ? (
              <SkeletonRows rows={3} />
            ) : (
              <div className="grid grid-3" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
                <Mini label="Requests" value={formatNumber(u.elevenlabs.requests)} />
                <Mini label="Characters" value={formatNumber(u.elevenlabs.characters)} />
                <Mini label="Est. cost" value={<CostLabel usd={u.elevenlabs.estimatedCost} />} />
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card title="Spend vs. local limits" actions={<Badge>estimate</Badge>}>
        <div className="card-body col gap-4">
          <LimitRow label="Today" spend={u?.todaySpend ?? 0} limit={daily_} />
          <LimitRow label="This month" spend={u?.monthSpend ?? 0} limit={monthly_} />
          <div className="xs subtle">Local limits are safeguards inside this app only: when reached, the queue pauses. They are not provider-side caps and do not stop usage from other tools.</div>
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="Daily (estimated USD)">
          <div className="card-body">{u ? <BarChart data={daily} aLabel="OpenAI" bLabel="ElevenLabs" /> : <SkeletonRows rows={4} />}</div>
        </Card>
        <Card title="Monthly (estimated USD)">
          <div className="card-body">{u ? <BarChart data={monthly} aLabel="OpenAI" bLabel="ElevenLabs" /> : <SkeletonRows rows={4} />}</div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="By channel">
          <div className="card-body-flush">
            {!u || !Array.isArray(u.byChannel) || u.byChannel.length === 0 ? (
              <EmptyState compact icon={<ChartColumn size={18} />} title="No usage in range" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th className="num">Jobs</th>
                    <th className="num">OpenAI</th>
                    <th className="num">ElevenLabs</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {u.byChannel.map((c) => (
                    <tr key={c.channelId}>
                      <td className="strong">{c.channelName}</td>
                      <td className="num">{c.jobs}</td>
                      <td className="num mono">{formatCost(c.openaiCost, { estimate: false })}</td>
                      <td className="num mono">{formatCost(c.elevenCost, { estimate: false })}</td>
                      <td className="num mono strong">{formatCost(c.openaiCost + c.elevenCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
        <Card title="By project">
          <div className="card-body-flush" style={{ maxHeight: 420, overflow: 'auto' }}>
            {!u || !Array.isArray(u.byProject) || u.byProject.length === 0 ? (
              <EmptyState compact icon={<ChartColumn size={18} />} title="No usage in range" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Channel</th>
                    <th className="num">OpenAI</th>
                    <th className="num">ElevenLabs</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {u.byProject.map((p) => (
                    <tr key={p.projectId}>
                      <td className="strong truncate" style={{ maxWidth: 220 }} title={p.title}>{p.title}</td>
                      <td className="xs muted">{p.channelName}</td>
                      <td className="num mono">{formatCost(p.openaiCost, { estimate: false })}</td>
                      <td className="num mono">{formatCost(p.elevenCost, { estimate: false })}</td>
                      <td className="num mono strong">{formatCost(p.openaiCost + p.elevenCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

function Mini({ label, value }: { label: string; value: JSX.Element | string }): JSX.Element {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className="stat-label">{label}</span>
      <span className="strong" style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

function LimitRow({ label, spend, limit }: { label: string; spend: number; limit: number | null }): JSX.Element {
  const frac = limit && limit > 0 ? spend / limit : 0
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row-between small">
        <span className="strong">{label}</span>
        <span className="mono">
          {formatCost(spend)} {limit != null && limit > 0 ? `of ${formatCost(limit, { estimate: false })} limit` : '· no limit set'}
        </span>
      </div>
      <ProgressBar value={limit && limit > 0 ? frac * 100 : 0} tone={frac >= 1 ? 'danger' : frac >= 0.8 ? 'warning' : 'accent'} />
    </div>
  )
}
