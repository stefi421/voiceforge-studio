import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ZodError, type ZodType, type z } from 'zod'
import type { IpcChannelName, IpcContract, IpcErrorPayload } from '@shared/ipc'
import { AppError, toAppError } from '../util/errors'
import type { Logger } from '../services/logger'

/**
 * Every IPC handler is registered through `handle()` so that:
 * 1. the payload is validated with zod before any code runs,
 * 2. the sender is checked to be our own renderer frame,
 * 3. errors are normalised into a serialisable { code, message, action } shape
 *    and never leak stack traces or secrets to the UI.
 */
export class IpcRegistry {
  private registered = new Set<string>()
  private allowedOrigins: Set<string>

  constructor(
    private logger: Logger,
    allowedOrigins: string[]
  ) {
    this.allowedOrigins = new Set(allowedOrigins)
  }

  allowOrigin(origin: string): void {
    this.allowedOrigins.add(origin)
  }

  private senderAllowed(event: IpcMainInvokeEvent): boolean {
    const url = event.senderFrame?.url ?? ''
    if (!url) return false
    try {
      const u = new URL(url)
      const origin = u.protocol === 'file:' ? 'file://' : u.origin
      return this.allowedOrigins.has(origin)
    } catch {
      return false
    }
  }

  handle<K extends IpcChannelName, S extends ZodType | null>(
    channel: K,
    schema: S,
    fn: (payload: S extends ZodType ? z.output<S> : IpcContract[K]['req'], event: IpcMainInvokeEvent) => Promise<IpcContract[K]['res']> | IpcContract[K]['res']
  ): void {
    if (this.registered.has(channel)) throw new Error(`IPC handler already registered: ${channel}`)
    this.registered.add(channel)
    ipcMain.handle(channel, async (event, rawPayload: unknown) => {
      if (!this.senderAllowed(event)) {
        this.logger.log('warn', 'ipc', 'Rejected IPC call from unexpected sender', { channel, url: event.senderFrame?.url })
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Request rejected.' } satisfies IpcErrorPayload }
      }
      try {
        const payload = (schema ? schema.parse(rawPayload) : rawPayload) as S extends ZodType ? z.output<S> : IpcContract[K]['req']
        const data = await fn(payload, event)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: this.toPayload(channel, err) }
      }
    })
  }

  private toPayload(channel: string, err: unknown): IpcErrorPayload {
    if (err instanceof ZodError) {
      const first = err.issues[0]
      const msg = first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input'
      return { code: 'INVALID_INPUT', message: `Invalid request — ${msg}`, action: 'Check the form values and try again.' }
    }
    const e = err instanceof AppError ? err : toAppError(err)
    this.logger.log(e.kind === 'config' || e.kind === 'validation' ? 'info' : 'warn', 'ipc', `${channel} failed: ${e.message}`, { kind: e.kind })
    return { code: e.code, message: e.message, action: e.action, details: e.details?.slice(0, 2000) }
  }
}
