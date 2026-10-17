import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from 'react'
import { Pause, Play, Volume2, VolumeX, FolderOpen, Download } from 'lucide-react'
import { Button } from './Button'
import { formatDuration } from '@/lib/format'

export interface AudioPlayerProps {
  src: string
  compact?: boolean
  /** Called for the "open folder" action; hidden when omitted. */
  onOpenFolder?: () => void
  /** Called for the "export" action; hidden when omitted. */
  onExport?: () => void
  autoPlay?: boolean
  title?: string
}

const BAR_COUNT = 96
const peaksCache = new Map<string, Float32Array>()

async function computePeaks(src: string): Promise<Float32Array> {
  const cached = peaksCache.get(src)
  if (cached) return cached
  const res = await fetch(src)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  const AC = window.AudioContext
  const ctx = new AC()
  try {
    const audio = await ctx.decodeAudioData(buf)
    const ch = audio.getChannelData(0)
    const block = Math.max(1, Math.floor(ch.length / BAR_COUNT))
    const peaks = new Float32Array(BAR_COUNT)
    let max = 0
    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0
      const start = i * block
      const end = Math.min(ch.length, start + block)
      for (let j = start; j < end; j++) {
        const v = ch[j] ?? 0
        sum += v * v
      }
      const rms = Math.sqrt(sum / Math.max(1, end - start))
      peaks[i] = rms
      if (rms > max) max = rms
    }
    if (max > 0) for (let i = 0; i < BAR_COUNT; i++) peaks[i] = (peaks[i] ?? 0) / max
    peaksCache.set(src, peaks)
    return peaks
  } finally {
    void ctx.close()
  }
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export function AudioPlayer({ src, compact, onOpenFolder, onExport, autoPlay, title }: AudioPlayerProps): JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const rafRef = useRef<number | null>(null)
  const fallbackPhase = useRef(0)

  // Reset on source change.
  useEffect(() => {
    setPlaying(false)
    setTime(0)
    setDuration(0)
    setError(null)
    setPeaks(null)
    let cancelled = false
    computePeaks(src)
      .then((p) => {
        if (!cancelled) setPeaks(p)
      })
      .catch(() => {
        /* waveform is optional; animated fallback will be used */
      })
    return () => {
      cancelled = true
    }
  }, [src])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const accent = cssVar('--accent', '#7c5cff')
    const idle = cssVar('--border-strong', 'rgba(255,255,255,0.14)')
    const progress = duration > 0 ? time / duration : 0
    const gap = 2
    const barW = Math.max(1, (w - gap * (BAR_COUNT - 1)) / BAR_COUNT)
    const audio = audioRef.current
    for (let i = 0; i < BAR_COUNT; i++) {
      let v: number
      if (peaks) {
        v = Math.max(0.06, peaks[i] ?? 0)
      } else if (audio && !audio.paused) {
        v = 0.25 + 0.55 * Math.abs(Math.sin(fallbackPhase.current * 0.9 + i * 0.37)) * Math.abs(Math.cos(fallbackPhase.current * 0.35 + i * 0.11))
      } else {
        v = 0.12
      }
      const bh = Math.max(2, v * (h - 4))
      const x = i * (barW + gap)
      const y = (h - bh) / 2
      ctx.fillStyle = i / BAR_COUNT <= progress ? accent : idle
      ctx.beginPath()
      ctx.roundRect(x, y, barW, bh, barW / 2)
      ctx.fill()
    }
  }, [peaks, time, duration])

  useEffect(() => {
    draw()
  }, [draw])

  // Animation loop while playing (keeps the fallback animated and progress smooth).
  useEffect(() => {
    if (!playing) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return
    }
    const loop = (): void => {
      fallbackPhase.current += 0.12
      const a = audioRef.current
      if (a) setTime(a.currentTime)
      draw()
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [playing, draw])

  useEffect(() => {
    const onResize = (): void => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  const toggle = (): void => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      a.play().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Playback failed'))
    } else {
      a.pause()
    }
  }

  const seekTo = (t: number): void => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.max(0, Math.min(duration || 0, t))
    setTime(a.currentTime)
  }

  const onCanvasClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width
    if (duration > 0) seekTo(frac * duration)
  }

  const volumeIcon = useMemo(() => (muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />), [muted, volume])

  return (
    <div className={`player ${compact ? 'player-compact' : ''}`} title={title}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        autoPlay={autoPlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setTime(duration)
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          if (!playing) setTime(e.currentTarget.currentTime)
        }}
        onError={() => setError('Could not load audio. The file may have been moved or deleted.')}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume)
          setMuted(e.currentTarget.muted)
        }}
      />
      <canvas ref={canvasRef} className="player-wave" onClick={onCanvasClick} aria-hidden="true" />
      <div className="player-row">
        <Button variant="primary" size="sm" iconOnly icon={playing ? <Pause size={13} /> : <Play size={13} />} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} disabled={Boolean(error)} />
        <span className="player-time">{formatDuration(time)}</span>
        <input
          type="range"
          className="player-seek"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(time, duration || 0)}
          onChange={(e) => seekTo(parseFloat(e.target.value))}
          aria-label="Seek"
        />
        <span className="player-time">{formatDuration(duration)}</span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={volumeIcon}
          aria-label="Mute"
          onClick={() => {
            const a = audioRef.current
            if (a) a.muted = !a.muted
          }}
        />
        {!compact && (
          <input
            type="range"
            className="player-volume"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const a = audioRef.current
              if (a) {
                a.volume = parseFloat(e.target.value)
                a.muted = false
              }
            }}
            aria-label="Volume"
          />
        )}
        {onOpenFolder && <Button variant="ghost" size="sm" iconOnly icon={<FolderOpen size={14} />} title="Show in folder" onClick={onOpenFolder} />}
        {onExport && <Button variant="ghost" size="sm" iconOnly icon={<Download size={14} />} title="Export MP3" onClick={onExport} />}
      </div>
      {error && <div className="player-error">{error}</div>}
    </div>
  )
}
