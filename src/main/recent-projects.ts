import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { RecentProject } from '../shared/api'
import { idSchema, titleSchema } from '../shared/model'
import { atomicJson } from './storage'

const recentLimit = 5
const absolutePath = z.string().refine(path.isAbsolute)
const preferencesSchema = z.object({
  recent: z.array(z.object({ id: idSchema, title: titleSchema, directory: absolutePath, fictional: z.boolean() })).max(recentLimit),
  mediaDirectory: absolutePath.optional(),
})

export class RecentProjects {
  private constructor(private file: string, private preferences: z.infer<typeof preferencesSchema>) {}

  static async open(userData: string) {
    const file = path.join(userData, 'workbench-preferences.json')
    const saved = await readFile(file, 'utf8').then(json => preferencesSchema.parse(JSON.parse(json))).catch(() => undefined)
    return new RecentProjects(file, saved ?? { recent: [] })
  }

  get entries(): RecentProject[] {
    return this.preferences.recent
  }

  async remember(project: Omit<RecentProject, 'id'>) {
    const previous = this.entries.find(item => item.directory === project.directory)
    if (previous === this.entries[0] && previous?.title === project.title && previous.fictional === project.fictional) return
    this.preferences.recent = [{ ...project, id: previous?.id ?? randomUUID() },
      ...this.entries.filter(item => item !== previous)].slice(0, recentLimit)
    await this.save()
  }

  async rememberMedia(file: string) {
    const directory = path.dirname(file)
    if (directory === this.preferences.mediaDirectory) return
    this.preferences.mediaDirectory = directory
    await this.save()
  }

  async defaultDirectory(kind: 'project' | 'media', fallback?: string) {
    const recent = this.entries[0]?.directory
    const lastUsed = kind === 'media' ? this.preferences.mediaDirectory : recent && path.dirname(recent)
    for (const directory of [lastUsed, fallback]) {
      if (directory && await stat(directory).then(info => info.isDirectory()).catch(() => false)) return directory
    }
  }

  private async save() {
    await atomicJson(this.file, this.preferences).catch(error => console.error('preferences:save', error))
  }
}
