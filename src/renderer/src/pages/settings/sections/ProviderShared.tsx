import { useEffect, useState, type JSX } from 'react'
import { KeyRound, PlugZap } from 'lucide-react'
import type { ConnectionTestResult } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { toast } from '@/store/toasts'
import { Alert, Badge, Button, Field, Input, NumberInput } from '@/components/ui'

/** Immediate-save number input: edits locally, commits on blur / Enter. */
export function DeferredNumber({
  value,
  onCommit,
  min,
  max,
  step,
  integer = true,
  allowEmpty = false,
  suffix
}: {
  value: number | null
  onCommit: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  integer?: boolean
  allowEmpty?: boolean
  suffix?: string
}): JSX.Element {
  const [local, setLocal] = useState<number | null>(value)
  useEffect(() => setLocal(value), [value])
  const commit = (): void => {
    if (local !== value) onCommit(local)
  }
  return (
    <div className="row">
      <NumberInput value={local} onChange={setLocal} min={min} max={max} step={step} integer={integer} allowEmpty={allowEmpty} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} />
      {suffix && <span className="xs muted" style={{ whiteSpace: 'nowrap' }}>{suffix}</span>}
    </div>
  )
}

export function ApiKeyCard({ provider, label, testChannel }: { provider: 'openai' | 'elevenlabs'; label: string; testChannel: 'openai:test' | 'eleven:test' }): JSX.Element {
  const secrets = useApp((s) => s.secrets)
  const has = secrets[provider]
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [test, setTest] = useState<ConnectionTestResult | null>(null)

  const save = async (): Promise<void> => {
    if (key.trim().length < 8) {
      toast.warning('Key looks too short')
      return
    }
    setBusy('save')
    try {
      const st = await api.invoke('secrets:set', { provider, value: key.trim() })
      useApp.setState({ secrets: st })
      setKey('')
      setTest(null)
      toast.success(`${label} key saved`, `Stored with ${st.backend}${st.encryptionAvailable ? ' (encrypted)' : ''}.`)
    } catch (err) {
      toast.error('Could not save key', err)
    } finally {
      setBusy(null)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy('clear')
    try {
      const st = await api.invoke('secrets:clear', { provider })
      useApp.setState({ secrets: st })
      setTest(null)
      toast.info(`${label} key removed`)
    } catch (err) {
      toast.error('Could not clear key', err)
    } finally {
      setBusy(null)
    }
  }

  const runTest = async (): Promise<void> => {
    setBusy('test')
    try {
      const r = await api.invoke(testChannel, undefined)
      setTest(r)
      toast[r.ok ? 'success' : 'error'](r.ok ? `${label} connection OK` : `${label} connection failed`, r.message)
    } catch (err) {
      toast.error('Connection test failed', err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings-group">
      <div className="row-between">
        <div className="settings-group-title row">
          <KeyRound size={15} /> API key
        </div>
        <Badge tone={has ? 'success' : 'warning'} dot>
          {has ? 'configured' : 'missing'}
        </Badge>
      </div>
      {!secrets.encryptionAvailable && <Alert tone="warning">OS-level encryption is not available on this machine; keys are stored with the fallback backend ({secrets.backend}).</Alert>}
      <Field label={has ? 'Replace key' : 'Enter key'} hint="Keys are stored locally in the OS credential store and never leave this computer except to call the provider.">
        <div className="row">
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={has ? '•••••••••••••••• (saved)' : provider === 'openai' ? 'sk-…' : 'ElevenLabs API key'} autoComplete="off" onKeyDown={(e) => { if (e.key === 'Enter') void save() }} />
          <Button variant="primary" loading={busy === 'save'} disabled={!key.trim()} onClick={save}>
            Save
          </Button>
          {has && (
            <Button variant="ghost" loading={busy === 'clear'} onClick={clear}>
              Clear
            </Button>
          )}
        </div>
      </Field>
      <div className="row">
        <Button icon={<PlugZap size={14} />} loading={busy === 'test'} disabled={!has} onClick={runTest}>
          Test connection
        </Button>
        {test && (
          <span className={`small ${test.ok ? 'text-success' : 'text-danger'}`}>
            {test.message}
            {test.details ? <span className="muted"> · {test.details}</span> : null}
          </span>
        )}
      </div>
    </div>
  )
}
