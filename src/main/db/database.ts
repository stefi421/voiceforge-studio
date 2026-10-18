import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { MIGRATIONS } from './schema'

/**
 * Thin wrapper around the SQLite engine built into Electron's Node runtime
 * (`node:sqlite`). Using the built-in engine means no native module has to be
 * compiled for the Electron ABI, which keeps the portable build and the
 * installer identical and removes a whole class of "module was compiled
 * against a different Node.js version" failures.
 */
export type Row = Record<string, SQLInputValue | undefined>

/** Thrown when something touches the database after `close()` (only during shutdown). */
export class DatabaseClosedError extends Error {
  constructor() {
    super('The database is closed because the application is shutting down.')
    this.name = 'DatabaseClosedError'
  }
}

export class Database {
  readonly db: DatabaseSync
  private closed = false
  readonly path: string
  private stmtCache = new Map<string, StatementSync>()

  constructor(filePath: string) {
    this.path = filePath
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`)
    const applied = new Set(
      (this.db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map((r) => r.id)
    )
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue
      this.transaction(() => {
        this.db.exec(m.sql)
        this.db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString())
      })
    }
  }

  get isOpen(): boolean {
    return !this.closed
  }

  prepare(sql: string): StatementSync {
    if (this.closed) throw new DatabaseClosedError()
    let s = this.stmtCache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmtCache.set(sql, s)
    }
    return s
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.prepare(sql).run(...params)
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prepare(sql).all(...params) as T[]
  }

  exec(sql: string): void {
    if (this.closed) throw new DatabaseClosedError()
    this.db.exec(sql)
  }

  private txDepth = 0

  /** Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++
      try {
        return fn()
      } finally {
        this.txDepth--
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.txDepth = 1
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    } finally {
      this.txDepth = 0
    }
  }

  integrityCheck(): { ok: boolean; details: string } {
    const rows = this.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
    const details = rows.map((r) => r.integrity_check).join('\n')
    return { ok: details.trim() === 'ok', details }
  }

  /** Consistent online backup using SQLite's VACUUM INTO (works while WAL is active). */
  backupTo(destPath: string): void {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
    const escaped = destPath.replace(/'/g, "''")
    this.db.exec(`VACUUM INTO '${escaped}'`)
  }

  checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* ignore */
    }
  }

  close(): void {
    if (this.closed) return
    try {
      this.checkpoint()
      this.db.close()
    } catch {
      /* ignore */
    } finally {
      this.closed = true
      this.stmtCache.clear()
    }
  }
}
