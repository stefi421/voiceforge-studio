import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Filesystem helpers: safe Windows names, path containment, atomic writes.
 * Pure Node — no Electron imports, so everything here is unit-testable.
 */

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
])

export const MAX_SEGMENT_LENGTH = 80
/** Keep well under MAX_PATH (260) so Script.txt / Voice_v12.mp3 still fit. */
export const MAX_FULL_PATH_LENGTH = 220

/** Turn an arbitrary title into a safe folder/file segment. */
export function safeSegment(input: string, fallback = 'untitled'): string {
  let s = input
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '') // Windows strips trailing dots/spaces
    .split(' ')
    .filter((t) => !/^\.+$/.test(t)) // drop "." / ".." tokens left over from path separators
    .join(' ')
    .replace(/^\.+/, '')
  if (s.length > MAX_SEGMENT_LENGTH) s = s.slice(0, MAX_SEGMENT_LENGTH).trim()
  if (!s || s === '.' || s === '..') s = fallback
  const base = s.split('.')[0]?.toUpperCase() ?? ''
  if (WINDOWS_RESERVED.has(s.toUpperCase()) || WINDOWS_RESERVED.has(base)) s = `_${s}`
  return s
}

/** True if `child` resolves inside `parent` (no traversal). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function assertInside(parent: string, child: string): void {
  if (!isInside(parent, child)) throw new Error(`Path escapes its root: ${child}`)
}

/** Pick a unique folder name under `parentDir`, appending a short id on collision. */
export function uniqueFolderName(parentDir: string, desired: string, shortId: string, existsFn: (name: string) => boolean): string {
  let name = safeSegment(desired)
  const fits = (n: string): boolean => path.join(parentDir, n).length <= MAX_FULL_PATH_LENGTH
  if (!fits(name)) name = name.slice(0, Math.max(10, name.length - (path.join(parentDir, name).length - MAX_FULL_PATH_LENGTH))).trim()
  if (!existsFn(name) && !fs.existsSync(path.join(parentDir, name))) return name
  const suffixed = `${name} (${shortId})`
  return suffixed
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** Atomic write: write to a temp sibling, fsync, rename over the destination. */
export async function atomicWriteFile(dest: string, data: Buffer | string): Promise<void> {
  ensureDir(path.dirname(dest))
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  const handle = await fsp.open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(tmp, dest)
  } catch (err) {
    // On Windows a rename over an open file fails; retry a few times, then surface the error.
    let lastErr: unknown = err
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 100 * (i + 1)))
      try {
        await fsp.rename(tmp, dest)
        lastErr = null
        break
      } catch (e) {
        lastErr = e
      }
    }
    if (lastErr) {
      await fsp.unlink(tmp).catch(() => undefined)
      throw lastErr
    }
  }
}

export function atomicWriteFileSync(dest: string, data: Buffer | string): void {
  ensureDir(path.dirname(dest))
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, dest)
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const s = fs.createReadStream(filePath)
    s.on('data', (d) => hash.update(d))
    s.on('end', () => resolve())
    s.on('error', reject)
  })
  return hash.digest('hex')
}

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Remove stale *.tmp files left by interrupted atomic writes (older than `olderThanMs`). */
export async function cleanupTempFiles(rootDir: string, olderThanMs = 60 * 60 * 1000): Promise<number> {
  let removed = 0
  if (!fs.existsSync(rootDir)) return 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let entries: fs.Dirent[] = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full, depth + 1)
      else if (/\.\d+\.\d+\.tmp$/.test(e.name) || /\.chunk\d+\.part$/.test(e.name)) {
        try {
          const st = await fsp.stat(full)
          if (Date.now() - st.mtimeMs > olderThanMs) {
            await fsp.unlink(full)
            removed++
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(rootDir, 0)
  return removed
}

export function describeFsError(err: unknown, context: string): { message: string; action: string } {
  const code = (err as NodeJS.ErrnoException)?.code
  switch (code) {
    case 'ENOSPC':
      return { message: `The disk is full while ${context}.`, action: 'Free up disk space or choose another output folder in Settings → Storage, then retry the job.' }
    case 'EACCES':
    case 'EPERM':
      return { message: `Windows denied permission while ${context}.`, action: 'Check the folder permissions (or antivirus/controlled folder access) and retry, or pick a different output folder.' }
    case 'ENOENT':
      return { message: `A folder was missing while ${context}.`, action: 'The output folder was moved or deleted. Re-select it in Settings → Storage; missing folders are recreated automatically.' }
    case 'EBUSY':
      return { message: `A file was locked by another program while ${context}.`, action: 'Close any program that has the file open (media player, Explorer preview) and retry.' }
    case 'ENAMETOOLONG':
      return { message: `The output path is too long while ${context}.`, action: 'Choose a shorter output root folder (e.g. C:\\VoiceForge).' }
    default:
      return { message: `${(err as Error)?.message ?? 'Unknown filesystem error'} (${context})`, action: 'Check the output folder and retry the job.' }
  }
}
