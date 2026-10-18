import type { JSX } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { useToasts } from '@/store/toasts'

export function ToastStack(): JSX.Element {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.level === 'success' ? CircleCheck : t.level === 'warning' ? TriangleAlert : t.level === 'error' ? CircleAlert : Info
        return (
          <div key={t.id} className={`toast toast-${t.level}`} role="status">
            <Icon size={16} className="toast-icon" />
            <div className="grow">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="toast-msg">{t.message}</div>}
              {t.action && <div className="toast-action">{t.action}</div>}
              {t.button && (
                <div className="toast-buttons">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      t.button?.onClick()
                      dismiss(t.id)
                    }}
                  >
                    {t.button.label}
                  </button>
                </div>
              )}
            </div>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
