import { useCallback, useEffect, useRef, useState } from 'react'
import { toIpcError, type IpcErrorLike } from './api'

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: IpcErrorLike | null
  reload: () => Promise<void>
  setData: (updater: T | ((prev: T | null) => T | null)) => void
}

/**
 * Loads data from an async function on mount and whenever `deps` change.
 * Ignores stale responses, exposes a manual reload and lets callers patch data
 * locally (e.g. after a live event).
 */
export function useAsync<T>(fn: () => Promise<T>, deps: ReadonlyArray<unknown>, opts: { enabled?: boolean } = {}): AsyncState<T> {
  const [data, setDataState] = useState<T | null>(null)
  const [loading, setLoading] = useState<boolean>(opts.enabled !== false)
  const [error, setError] = useState<IpcErrorLike | null>(null)
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const enabled = opts.enabled !== false

  const reload = useCallback(async () => {
    if (!enabled) return
    const id = ++seq.current
    setLoading(true)
    try {
      const result = await fnRef.current()
      if (id === seq.current) {
        setDataState(result)
        setError(null)
      }
    } catch (err) {
      if (id === seq.current) setError(toIpcError(err))
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps])

  const setData = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setDataState((prev) => (typeof updater === 'function' ? (updater as (p: T | null) => T | null)(prev) : updater))
  }, [])

  return { data, loading, error, reload, setData }
}

export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delay)
    return () => window.clearTimeout(t)
  }, [value, delay])
  return v
}

/** Returns a stable callback that runs `fn` and tracks a busy flag. */
export function useBusy(): [boolean, <T>(p: Promise<T>) => Promise<T>] {
  const [busy, setBusy] = useState(false)
  const count = useRef(0)
  const run = useCallback(async <T,>(p: Promise<T>): Promise<T> => {
    count.current++
    setBusy(true)
    try {
      return await p
    } finally {
      count.current--
      if (count.current === 0) setBusy(false)
    }
  }, [])
  return [busy, run]
}

export function useInterval(cb: () => void, ms: number | null): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    if (ms == null) return
    const t = window.setInterval(() => ref.current(), ms)
    return () => window.clearInterval(t)
  }, [ms])
}

/** Re-renders every `ms` so relative timestamps stay fresh. */
export function useNow(ms = 30000): number {
  const [now, setNow] = useState(Date.now())
  useInterval(() => setNow(Date.now()), ms)
  return now
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (v: T) => {
      setValue(v)
      try {
        localStorage.setItem(key, JSON.stringify(v))
      } catch {
        /* ignore */
      }
    },
    [key]
  )
  return [value, set]
}
