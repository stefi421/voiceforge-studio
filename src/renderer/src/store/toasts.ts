import { create } from 'zustand'
import { toIpcError } from '@/lib/api'

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  level: ToastLevel
  title: string
  message?: string
  action?: string
  /** Optional button shown in the toast (e.g. "View" → open the queue). */
  button?: { label: string; onClick: () => void }
  /** ms; 0 = sticky */
  duration: number
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => string
  dismiss: (id: string) => void
  clear: () => void
}

let counter = 0

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = `t${Date.now()}_${counter++}`
    const duration = t.duration ?? (t.level === 'error' ? 9000 : t.level === 'warning' ? 7000 : 4500)
    const toast: Toast = { id, level: t.level, title: t.title, message: t.message, action: t.action, button: t.button, duration }
    set((s) => ({ toasts: [...s.toasts.slice(-5), toast] }))
    if (duration > 0) {
      window.setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
      }, duration)
    }
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  clear: () => set({ toasts: [] })
}))

export const toast = {
  info: (title: string, message?: string) => useToasts.getState().push({ level: 'info', title, message }),
  success: (title: string, message?: string) => useToasts.getState().push({ level: 'success', title, message }),
  warning: (title: string, message?: string) => useToasts.getState().push({ level: 'warning', title, message }),
  /** Toast with a single action button. */
  withAction: (level: ToastLevel, title: string, message: string | undefined, button: { label: string; onClick: () => void }) =>
    useToasts.getState().push({ level, title, message, button, duration: 8000 }),
  error: (title: string, err?: unknown) => {
    if (err === undefined) return useToasts.getState().push({ level: 'error', title })
    const e = toIpcError(err)
    return useToasts.getState().push({ level: 'error', title, message: e.message, action: e.action })
  }
}
