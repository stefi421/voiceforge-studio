import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { Channel, Project } from '@shared/types'
import type { Services } from './container'
import { ensureDir, safeSegment, uniqueFolderName } from './files'
import { normalizeTitle } from '../util/common'

/**
 * On-disk layout (1.3.0+).
 *
 * Output folder (what the user sends on) — only finished files, written when a job completes:
 *   folders: <root>/<Channel>/<Title>/Script.txt + Voice.mp3   (Voice_v2.mp3 on explicit regeneration)
 *   flat:    <root>/<Channel>/<Title>.txt + <Title>.mp3        (<Title>_v2.mp3)
 *
 * Work folder (app data, never shown as output): drafts, chunk parts, Research.json,
 * project.json and Narration.txt live in <userData>/projects/<projectId>/.
 *
 * Projects created before 1.3.0 keep their files and their folder layout.
 */
export class ProjectService {
  constructor(private s: Services) {}

  channelRoot(channel: Channel): string {
    const root = channel.outputFolder?.trim() ? channel.outputFolder : this.s.paths.outputRoot()
    return path.join(root, safeSegment(channel.name))
  }

  /** Find or create the project for a title in a channel. Creates no folders in the output root. */
  getOrCreate(channel: Channel, title: string): { project: Project; created: boolean } {
    const normalized = normalizeTitle(title)
    const existing = this.s.projects.findByTitle(channel.id, normalized)
    if (existing) return { project: existing, created: false }
    const parent = this.channelRoot(channel)
    const shortId = Math.random().toString(36).slice(2, 7)
    const layout = this.s.settings.get().storage.outputLayout === 'flat' ? 'flat' : 'folders'
    const folderName = uniqueFolderName(parent, title, shortId, (name) => this.s.projects.folderNameExists(channel.id, name) || (layout === 'flat' && (fs.existsSync(path.join(parent, `${name}.txt`)) || fs.existsSync(path.join(parent, `${name}.mp3`)))))
    const folderPath = layout === 'flat' ? parent : path.join(parent, folderName)
    const project = this.s.projects.create({ channelId: channel.id, title, titleNormalized: normalized, folderName, folderPath, layout })
    return { project, created: true }
  }

  /** App-data folder for drafts, chunk parts and metadata. */
  workDir(project: Project): string {
    const dir = path.join(this.s.paths.userData, 'projects', project.id)
    ensureDir(dir)
    return dir
  }

  /** Folder that receives the finished files (the channel folder for the flat layout). */
  publishDir(project: Project): string {
    return this.folderFor(project)
  }

  /** Creates (if needed) and returns the folder the user opens for this project. */
  ensureFolder(project: Project): string {
    const dir = this.folderFor(project)
    ensureDir(dir)
    if (project.folderPath !== dir) this.s.projects.update(project.id, { folderPath: dir })
    return dir
  }

  folderFor(project: Project): string {
    if (project.folderPath) return project.folderPath
    const channel = this.s.channels.get(project.channelId)
    const parent = channel ? this.channelRoot(channel) : path.join(this.s.paths.outputRoot(), 'Unknown Channel')
    return project.layout === 'flat' ? parent : path.join(parent, project.folderName)
  }

  /** Published script file name for the project's layout. */
  publishedScriptName(project: Project): string {
    return project.layout === 'flat' ? `${project.folderName}.txt` : 'Script.txt'
  }

  /** Published audio file name for the project's layout (versions > 1 only after an explicit regeneration). */
  publishedAudioName(project: Project, version: number, outputFormat: string): string {
    const ext = audioExt(outputFormat)
    const base = project.layout === 'flat' ? project.folderName : 'Voice'
    return version <= 1 ? `${base}.${ext}` : `${base}_v${version}.${ext}`
  }

  /** True when `file` is one of this project's published files (used to limit deletes for the flat layout). */
  isPublishedFile(project: Project, file: string): boolean {
    const dir = this.publishDir(project)
    return path.dirname(path.resolve(file)) === path.resolve(dir)
  }

  rename(projectId: string, newTitle: string): Project {
    const project = this.s.projects.get(projectId)
    if (!project) throw new Error('Project not found')
    const parent = project.layout === 'flat' ? this.folderFor(project) : path.dirname(this.folderFor(project))
    const shortId = Math.random().toString(36).slice(2, 7)
    const folderName = uniqueFolderName(parent, newTitle, shortId, (name) => name.toLowerCase() !== project.folderName.toLowerCase() && this.s.projects.folderNameExists(project.channelId, name))
    if (project.layout === 'flat') {
      // Rename only this project's published files; the channel folder is shared.
      const rewrite = (file: string): string => {
        const base = path.basename(file)
        if (!base.startsWith(project.folderName)) return file
        const next = path.join(parent, folderName + base.slice(project.folderName.length))
        if (fs.existsSync(file) && file !== next) fs.renameSync(file, next)
        return next
      }
      for (const script of this.s.scripts.versions(projectId)) if (script.filePath && this.isPublishedFile(project, script.filePath)) this.s.scripts.update(script.id, { filePath: rewrite(script.filePath) })
      for (const audio of this.s.audio.versions(projectId)) if (this.isPublishedFile(project, audio.filePath)) this.s.audio.update(audio.id, { filePath: rewrite(audio.filePath) })
      return this.s.projects.update(projectId, { title: newTitle, titleNormalized: normalizeTitle(newTitle), folderName })
    }
    const oldDir = this.folderFor(project)
    const newDir = path.join(parent, folderName)
    if (fs.existsSync(oldDir) && oldDir !== newDir) fs.renameSync(oldDir, newDir)
    const updated = this.s.projects.update(projectId, { title: newTitle, titleNormalized: normalizeTitle(newTitle), folderName, folderPath: newDir })
    for (const script of this.s.scripts.versions(projectId)) {
      if (script.filePath && script.filePath.startsWith(oldDir)) this.s.scripts.update(script.id, { filePath: path.join(newDir, path.relative(oldDir, script.filePath)) })
    }
    for (const audio of this.s.audio.versions(projectId)) {
      if (audio.filePath.startsWith(oldDir)) this.s.audio.update(audio.id, { filePath: path.join(newDir, path.relative(oldDir, audio.filePath)) })
    }
    return updated
  }

  /** Draft file name inside the work folder. */
  scriptFileName(version: number): string {
    return `Script_v${version}.txt`
  }

  /** Audio file name inside the work folder (before publishing). */
  audioFileName(version: number, outputFormat: string): string {
    return `Voice_v${version}.${audioExt(outputFormat)}`
  }
}

export function audioExt(outputFormat: string): string {
  return outputFormat.startsWith('mp3') ? 'mp3' : outputFormat.startsWith('pcm') ? 'pcm' : outputFormat.startsWith('opus') ? 'opus' : 'audio'
}

/**
 * Moves a finished file into the output folder. Same volume: atomic rename (replacing an
 * existing file). Different volume (EXDEV): copy to a temp sibling, fsync, rename, then
 * delete the source.
 */
export async function moveInto(src: string, dest: string): Promise<void> {
  ensureDir(path.dirname(dest))
  try {
    await fsp.rename(src, dest)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EBUSY') throw err
  }
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  await fsp.copyFile(src, tmp)
  const fh = await fsp.open(tmp, 'r+')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fsp.rename(tmp, dest)
  await fsp.unlink(src).catch(() => undefined)
}
