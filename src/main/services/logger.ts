import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_FILE_BYTES = 5 * 1024 * 1024
const KEEP_FILES = 5

/** Patterns that look like provider secrets. Redacted before anything is written. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g, // OpenAI style keys
  /xi-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/gi,
  /(api[_-]?key|authorization|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{8,}/gi,
  /\b[a-f0-9]{32}\b/g // ElevenLabs keys are 32 hex chars
]

export function redact(input: string): string {
  let out = input
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      const head = m.slice(0, 6)
      return `${head}…[redacted]`
    })
  }
  return out
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'string') return redact(v)
      if (v instanceof Error) return { name: v.name, message: redact(v.message), stack: v.stack ? redact(v.stack) : undefined }
      return v
    })
  } catch {
    return '"[unserializable]"'
  }
}

export class Logger {
  private level: LogLevel = 'info'
  private dir: string | null = null
  private file: string | null = null
  private stream: fs.WriteStream | null = null
  private bytes = 0
  private listeners = new Set<(line: string) => void>()

  init(dir: string, level: LogLevel): void {
    this.dir = dir
    this.level = level
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'voiceforge.log')
    try {
      this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
    } catch {
      this.bytes = 0
    }
    this.openStream()
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  get logDir(): string | null {
    return this.dir
  }

  get logFile(): string | null {
    return this.file
  }

  onLine(fn: (line: string) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  child(scope: string): ScopedLogger {
    return new ScopedLogger(this, scope)
  }

  log(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return
    const entry = {
      t: new Date().toISOString(),
      level,
      scope,
      msg: redact(msg),
      ...(data ? { data: JSON.parse(safeStringify(data)) } : {})
    }
    const line = JSON.stringify(entry)
    if (process.env.NODE_ENV !== 'test') {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      fn(`[${entry.t}] ${level.toUpperCase()} ${scope}: ${entry.msg}${data ? ' ' + safeStringify(data) : ''}`)
    }
    this.write(line)
    for (const l of this.listeners) {
      try {
        l(line)
      } catch {
        /* ignore */
      }
    }
  }

  readRecent(lines: number): string[] {
    if (!this.file || !fs.existsSync(this.file)) return []
    try {
      const content = fs.readFileSync(this.file, 'utf8')
      const all = content.split('\n').filter(Boolean)
      return all.slice(-lines)
    } catch {
      return []
    }
  }

  private openStream(): void {
    if (!this.file) return
    this.stream?.end()
    this.stream = fs.createWriteStream(this.file, { flags: 'a' })
    this.stream.on('error', () => {
      /* never crash on logging */
    })
  }

  private write(line: string): void {
    if (!this.stream || !this.file) return
    const buf = line + '\n'
    this.bytes += Buffer.byteLength(buf)
    this.stream.write(buf)
    if (this.bytes > MAX_FILE_BYTES) this.rotate()
  }

  private rotate(): void {
    if (!this.file) return
    try {
      this.stream?.end()
      for (let i = KEEP_FILES - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`
        const to = `${this.file}.${i + 1}`
        if (fs.existsSync(from)) fs.renameSync(from, to)
      }
      fs.renameSync(this.file, `${this.file}.1`)
    } catch {
      /* ignore */
    }
    this.bytes = 0
    this.openStream()
  }
}

export class ScopedLogger {
  constructor(
    private parent: Logger,
    private scope: string
  ) {}
  debug(msg: string, data?: Record<string, unknown>): void {
    this.parent.log('debug', this.scope, msg, data)
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.parent.log('info', this.scope, msg, data)
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.parent.log('warn', this.scope, msg, data)
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.parent.log('error', this.scope, msg, data)
  }
}

export const logger = new Logger()
