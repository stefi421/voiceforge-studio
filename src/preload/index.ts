import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannelName, IpcContract, IpcErrorPayload } from '@shared/ipc'
import type { MainEventName, MainEvents } from '@shared/types'

/**
 * The only bridge between the sandboxed renderer and the main process.
 * - No Node APIs are exposed.
 * - Every call goes through `invoke`, which main validates with zod.
 * - Events are a fixed allow-list; the renderer cannot subscribe to arbitrary channels.
 */

const EVENT_NAMES: MainEventName[] = [
  'job:changed',
  'queue:stats',
  'batch:completed',
  'notification',
  'settings:changed',
  'secrets:changed',
  'update:status'
]

class IpcError extends Error {
  code: string
  action?: string
  details?: string
  constructor(payload: IpcErrorPayload) {
    super(payload.message)
    this.name = 'IpcError'
    this.code = payload.code
    this.action = payload.action
    this.details = payload.details
  }
}

async function invoke<K extends IpcChannelName>(channel: K, payload: IpcContract[K]['req']): Promise<IpcContract[K]['res']> {
  const result = (await ipcRenderer.invoke(channel, payload)) as
    | { ok: true; data: IpcContract[K]['res'] }
    | { ok: false; error: IpcErrorPayload }
  if (result && typeof result === 'object' && 'ok' in result) {
    if (result.ok) return result.data
    throw new IpcError(result.error)
  }
  throw new IpcError({ code: 'IPC_PROTOCOL', message: `Malformed IPC response for ${channel}` })
}

function on<E extends MainEventName>(event: E, handler: (payload: MainEvents[E]) => void): () => void {
  if (!EVENT_NAMES.includes(event)) {
    throw new Error(`Unknown event: ${String(event)}`)
  }
  const listener = (_e: Electron.IpcRendererEvent, payload: MainEvents[E]): void => handler(payload)
  ipcRenderer.on(event, listener)
  return () => ipcRenderer.removeListener(event, listener)
}

const api = {
  invoke,
  on,
  platform: process.platform
}

export type VoiceForgeApi = typeof api

contextBridge.exposeInMainWorld('vf', api)
