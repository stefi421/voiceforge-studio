import { useEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from './Button'
import { Checkbox } from './Form'

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keeps focus inside `ref` while mounted and restores it afterwards. */
function useFocusTrap(ref: RefObject<HTMLElement | null>, onClose: (() => void) | undefined, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const node = ref.current
    const previouslyFocused = document.activeElement as HTMLElement | null
    if (node) {
      const first = node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? node).focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose?.()
        return
      }
      if (e.key === 'Tab' && node) {
        const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
        if (items.length === 0) {
          e.preventDefault()
          return
        }
        const first = items[0]
        const last = items[items.length - 1]
        if (!first || !last) return
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      previouslyFocused?.focus?.()
    }
  }, [ref, onClose, active])
}

/* ------------------------------------------------------------------------ */
/* Dialog                                                                    */
/* ------------------------------------------------------------------------ */

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** When false, clicking the overlay does not close the dialog. */
  dismissable?: boolean
}

export function Dialog({ open, onClose, title, description, children, footer, size = 'sm', dismissable = true }: DialogProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, dismissable ? onClose : undefined, open)
  if (!open) return null
  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={ref} className={`dialog ${size !== 'sm' ? `dialog-${size}` : ''}`} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="dialog-header">
          <div>
            <div className="dialog-title">{title}</div>
            {description && <div className="dialog-desc">{description}</div>}
          </div>
          <Button variant="ghost" iconOnly icon={<X size={16} />} onClick={onClose} aria-label="Close" />
        </div>
        {children !== undefined && <div className="dialog-body">{children}</div>}
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

/* ------------------------------------------------------------------------ */
/* Drawer                                                                    */
/* ------------------------------------------------------------------------ */

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
  headerExtra?: ReactNode
}

export function Drawer({ open, onClose, title, description, children, footer, wide, headerExtra }: DrawerProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, onClose, open)
  if (!open) return null
  return createPortal(
    <>
      <div className="drawer-overlay" onMouseDown={onClose} />
      <div ref={ref} className={`drawer ${wide ? 'drawer-wide' : ''}`} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="drawer-header">
          <div className="grow">
            <div className="dialog-title">{title}</div>
            {description && <div className="dialog-desc">{description}</div>}
          </div>
          {headerExtra}
          <Button variant="ghost" iconOnly icon={<X size={16} />} onClick={onClose} aria-label="Close" />
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </>,
    document.body
  )
}

/* ------------------------------------------------------------------------ */
/* Confirm dialog                                                            */
/* ------------------------------------------------------------------------ */

export interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: (opts: { checkbox: boolean }) => void | Promise<void>
  title: ReactNode
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  checkboxLabel?: ReactNode
  checkboxDefault?: boolean
  children?: ReactNode
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  checkboxLabel,
  checkboxDefault = false,
  children
}: ConfirmDialogProps): JSX.Element | null {
  const [checked, setChecked] = useState(checkboxDefault)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setChecked(checkboxDefault)
      setBusy(false)
    }
  }, [open, checkboxDefault])
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            data-autofocus
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm({ checkbox: checked })
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <div className="small">{message}</div>}
      {children}
      {checkboxLabel !== undefined && <Checkbox checked={checked} onChange={setChecked} label={checkboxLabel} />}
    </Dialog>
  )
}
