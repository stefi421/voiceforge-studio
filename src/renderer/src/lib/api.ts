import type { IpcChannelName, IpcContract } from '@shared/ipc'
import type { MainEventName, MainEvents } from '@shared/types'

/**
 * Thin, typed wrapper around the preload bridge. Everything the renderer does
 * to reach the outside world goes through here.
 */

export interface IpcErrorLike {
  code?: string
  message: string
  action?: string
  details?: string
}

export function invoke<K extends IpcChannelName>(channel: K, payload: IpcContract[K]['req']): Promise<IpcContract[K]['res']> {
  return window.vf.invoke(channel, payload)
}

export function on<E extends MainEventName>(event: E, handler: (payload: MainEvents[E]) => void): () => void {
  return window.vf.on(event, handler)
}

export const api = { invoke, on }

/** Normalize anything thrown by invoke into a displayable shape. */
export function toIpcError(err: unknown): IpcErrorLike {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; action?: unknown; details?: unknown }
    return {
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : 'Unknown error',
      action: typeof e.action === 'string' ? e.action : undefined,
      details: typeof e.details === 'string' ? e.details : undefined
    }
  }
  return { message: typeof err === 'string' ? err : 'Unknown error' }
}

export function errorMessage(err: unknown): string {
  const e = toIpcError(err)
  return e.action ? `${e.message} — ${e.action}` : e.message
}

/** Build a vfmedia URL for a generated audio file. */
export function audioUrl(audioId: string): string {
  return `vfmedia://audio/${encodeURIComponent(audioId)}`
}

/** Build a vfmedia URL for an ElevenLabs voice preview. */
export function previewUrl(voiceId: string): string {
  return `vfmedia://preview/${encodeURIComponent(voiceId)}`
}
