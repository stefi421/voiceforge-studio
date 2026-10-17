import {
  forwardRef,
  useId,
  type CSSProperties,
  type InputHTMLAttributes,
  type JSX,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import { Search, X } from 'lucide-react'

/* ------------------------------------------------------------------------ */
/* Field wrapper                                                             */
/* ------------------------------------------------------------------------ */

export interface FieldProps {
  label?: ReactNode
  hint?: ReactNode
  error?: string | undefined
  children: ReactNode
  className?: string
  labelRight?: ReactNode
  htmlFor?: string
}

export function Field({ label, hint, error, children, className = '', labelRight, htmlFor }: FieldProps): JSX.Element {
  return (
    <div className={`field ${className}`}>
      {label !== undefined && (
        <label className="field-label" htmlFor={htmlFor}>
          <span>{label}</span>
          {labelRight}
        </label>
      )}
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Input                                                                     */
/* ------------------------------------------------------------------------ */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  inputSize?: 'sm' | 'md'
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid, inputSize, className = '', ...rest }, ref) {
  return <input ref={ref} className={`input ${invalid ? 'invalid' : ''} ${inputSize === 'sm' ? 'input-sm' : ''} ${className}`} {...rest} />
})

export interface NumberInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type'> {
  value: number | null
  onChange: (v: number | null) => void
  allowEmpty?: boolean
  integer?: boolean
}

export function NumberInput({ value, onChange, allowEmpty = false, integer = false, ...rest }: NumberInputProps): JSX.Element {
  return (
    <Input
      type="number"
      value={value == null ? '' : String(value)}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') {
          onChange(allowEmpty ? null : 0)
          return
        }
        const n = integer ? parseInt(raw, 10) : parseFloat(raw)
        if (!Number.isNaN(n)) onChange(n)
      }}
      step={integer ? 1 : rest.step}
      {...rest}
    />
  )
}

/* ------------------------------------------------------------------------ */
/* Textarea                                                                  */
/* ------------------------------------------------------------------------ */

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  mono?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, mono, className = '', ...rest }, ref) {
  return <textarea ref={ref} className={`textarea ${invalid ? 'invalid' : ''} ${mono ? 'mono' : ''} ${className}`} spellCheck={false} {...rest} />
})

/* ------------------------------------------------------------------------ */
/* Select                                                                    */
/* ------------------------------------------------------------------------ */

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  value: string
  onChange: (v: string) => void
  options: SelectOption[]
  placeholder?: string
  invalid?: boolean
  inputSize?: 'sm' | 'md'
}

export function Select({ value, onChange, options, placeholder, invalid, inputSize, className = '', ...rest }: SelectProps): JSX.Element {
  return (
    <select
      className={`select ${invalid ? 'invalid' : ''} ${inputSize === 'sm' ? 'input-sm' : ''} ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    >
      {placeholder !== undefined && (
        <option value="" disabled={value !== ''}>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/* ------------------------------------------------------------------------ */
/* Switch & checkbox                                                         */
/* ------------------------------------------------------------------------ */

export interface SwitchProps {
  checked: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
}

export function Switch({ checked, onChange, label, description, disabled }: SwitchProps): JSX.Element {
  const id = useId()
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`} htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
      {(label !== undefined || description !== undefined) && (
        <span className="col gap-1" style={{ gap: 1 }}>
          {label !== undefined && <span className="switch-label">{label}</span>}
          {description !== undefined && <span className="switch-desc">{description}</span>}
        </span>
      )}
    </label>
  )
}

export interface CheckboxProps {
  checked: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  disabled?: boolean
  indeterminate?: boolean
  title?: string
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate, title }: CheckboxProps): JSX.Element {
  return (
    <label className="checkbox" title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate)
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label !== undefined && <span>{label}</span>}
    </label>
  )
}

/* ------------------------------------------------------------------------ */
/* Slider                                                                    */
/* ------------------------------------------------------------------------ */

export interface SliderProps {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  label?: ReactNode
  format?: (v: number) => string
  disabled?: boolean
  hint?: ReactNode
}

export function Slider({ value, onChange, min, max, step = 0.01, label, format, disabled, hint }: SliderProps): JSX.Element {
  return (
    <div className="slider">
      {label !== undefined && (
        <div className="field-label">
          <span>{label}</span>
          <span className="slider-value">{format ? format(value) : value.toFixed(2)}</span>
        </div>
      )}
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(parseFloat(e.target.value))} />
      {hint !== undefined && <div className="field-hint">{hint}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Search input                                                              */
/* ------------------------------------------------------------------------ */

export interface SearchInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  style?: CSSProperties
  inputSize?: 'sm' | 'md'
}

export function SearchInput({ value, onChange, placeholder = 'Search…', autoFocus, style, inputSize }: SearchInputProps): JSX.Element {
  return (
    <div className="input-wrap" style={style}>
      <Search size={14} />
      <Input inputSize={inputSize} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} />
      {value && (
        <button type="button" className="btn btn-ghost btn-sm btn-icon input-clear" onClick={() => onChange('')} aria-label="Clear search">
          <X size={12} />
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* String list editor                                                        */
/* ------------------------------------------------------------------------ */

export interface StringListEditorProps {
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  addLabel?: string
}

export function StringListEditor({ values, onChange, placeholder = 'Value', addLabel = 'Add' }: StringListEditorProps): JSX.Element {
  return (
    <div className="list-editor">
      {values.map((v, i) => (
        <div key={i} className="list-editor-row">
          <Input
            value={v}
            placeholder={placeholder}
            onChange={(e) => {
              const next = [...values]
              next[i] = e.target.value
              onChange(next)
            }}
          />
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove" onClick={() => onChange(values.filter((_, j) => j !== i))}>
            <X size={14} />
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange([...values, ''])}>
          {addLabel}
        </button>
      </div>
    </div>
  )
}
