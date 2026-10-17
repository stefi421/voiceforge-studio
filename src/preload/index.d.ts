import type { IpcChannelName, IpcContract } from '@shared/ipc'
import type { MainEventName, MainEvents } from '@shared/types'

export interface VoiceForgeApi {
  invoke<K extends IpcChannelName>(channel: K, payload: IpcContract[K]['req']): Promise<IpcContract[K]['res']>
  on<E extends MainEventName>(event: E, handler: (payload: MainEvents[E]) => void): () => void
  platform: string
}

declare global {
  interface Window {
    vf: VoiceForgeApi
  }
}

export {}
