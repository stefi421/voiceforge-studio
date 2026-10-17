import path from 'node:path'
import fs from 'node:fs'
import type { Channel, Project } from '@shared/types'
import type { Services } from './container'
import { ensureDir, safeSegment, uniqueFolderName } from './files'
import { normalizeTitle } from '../util/common'

/** Resolves/creates the on-disk folder layout: <root>/<Channel>/<Title>/ */
export class ProjectService {
  constructor(private s: Services) {}

  channelRoot(channel: Channel): string {
    const root = channel.outputFolder?.trim() ? channel.outputFolder : this.s.paths.outputRoot()
    return path.join(root, safeSegment(channel.name))
  }

  /** Find or create the project for a title in a channel. */
  getOrCreate(channel: Channel, title: string): { project: Project; created: boolean } {
    const normalized = normalizeTitle(title)
    const existing = this.s.projects.findByTitle(channel.id, normalized)
    if (existing) {
      this.ensureFolder(existing)
      return { project: existing, created: false }
    }
    const parent = this.channelRoot(channel)
    const shortId = Math.random().toString(36).slice(2, 7)
    const folderName = uniqueFolderName(parent, title, shortId, (name) => this.s.projects.folderNameExists(channel.id, name))
    const folderPath = path.join(parent, folderName)
    const project = this.s.projects.create({ channelId: channel.id, title, titleNormalized: normalized, folderName, folderPath })
    this.ensureFolder(project)
    return { project, created: true }
  }

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
    return path.join(parent, project.folderName)
  }

  rename(projectId: string, newTitle: string): Project {
    const project = this.s.projects.get(projectId)
    if (!project) throw new Error('Project not found')
    const channel = this.s.channels.get(project.channelId)
    const oldDir = this.folderFor(project)
    const parent = path.dirname(oldDir)
    const shortId = Math.random().toString(36).slice(2, 7)
    const folderName = uniqueFolderName(parent, newTitle, shortId, (name) => name.toLowerCase() !== project.folderName.toLowerCase() && this.s.projects.folderNameExists(project.channelId, name))
    const newDir = path.join(parent, folderName)
    if (fs.existsSync(oldDir) && oldDir !== newDir) fs.renameSync(oldDir, newDir)
    const updated = this.s.projects.update(projectId, { title: newTitle, titleNormalized: normalizeTitle(newTitle), folderName, folderPath: newDir })
    // Update stored file paths of scripts/audio under the renamed folder.
    for (const script of this.s.scripts.versions(projectId)) {
      if (script.filePath && script.filePath.startsWith(oldDir)) this.s.scripts.update(script.id, { filePath: path.join(newDir, path.relative(oldDir, script.filePath)) })
    }
    for (const audio of this.s.audio.versions(projectId)) {
      if (audio.filePath.startsWith(oldDir)) this.s.audio.update(audio.id, { filePath: path.join(newDir, path.relative(oldDir, audio.filePath)) })
    }
    void channel
    return updated
  }

  scriptFileName(version: number): string {
    return version <= 1 ? 'Script.txt' : `Script_v${version}.txt`
  }

  audioFileName(version: number, outputFormat: string): string {
    const ext = outputFormat.startsWith('mp3') ? 'mp3' : outputFormat.startsWith('pcm') ? 'pcm' : outputFormat.startsWith('opus') ? 'opus' : 'audio'
    return version <= 1 ? `Voice.${ext}` : `Voice_v${version}.${ext}`
  }
}
