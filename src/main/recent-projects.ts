import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { RecentProject } from '../shared/api'
import { idSchema, titleSchema } from '../shared/model'
import { aiGatewayConfigSchema, defaultAiGatewayConfig, type AiGatewayConfig } from '../shared/plan'
import { describeAiGateway, type GatewayLookup } from './ai-gateway'
import { atomicJson } from './storage'

const recentLimit = 5

/** Rejects relative paths, UNC network shares, and Windows device namespaces. */
export function isLocalAbsolutePath(filePath: string) {
  if (!filePath || filePath.includes('\0')) return false
  if (/^[\\/]{2}/.test(filePath)) return false
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(filePath) && path.isAbsolute(filePath)
  return path.isAbsolute(filePath)
}

const absolutePath = z.string().refine(isLocalAbsolutePath)
export const themeSchema = z.enum(['light', 'dark'])
export type Theme = z.infer<typeof themeSchema>
export const windowBoundsSchema = z.object({
  width: z.number().int().min(940).max(10000),
  height: z.number().int().min(650).max(10000),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  maximized: z.boolean().optional(),
})
export type WindowBounds = z.infer<typeof windowBoundsSchema>
const recentEntrySchema = z.object({ id: idSchema, title: titleSchema, directory: absolutePath, fictional: z.boolean() })
const preferencesSchema = z.object({
  recent: z.array(recentEntrySchema).max(recentLimit).catch([]),
  mediaDirectory: absolutePath.optional().catch(undefined),
  theme: themeSchema.optional().catch(undefined),
  windowBounds: windowBoundsSchema.optional().catch(undefined),
  aiGateway: aiGatewayConfigSchema.optional().catch(undefined),
  ffmpegDirectory: absolutePath.optional().catch(undefined),
})

function sameDirectory(a: string, b: string) {
  const left = path.normalize(a)
  const right = path.normalize(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export class RecentProjects {
  private saveTail: Promise<void> = Promise.resolve()

  private constructor(private file: string, private preferences: z.infer<typeof preferencesSchema>) {}

  static async open(userData: string) {
    const file = path.join(userData, 'workbench-preferences.json')
    const saved = await readFile(file, 'utf8').then(json => preferencesSchema.parse(JSON.parse(json))).catch(() => undefined)
    return new RecentProjects(file, saved ?? { recent: [] })
  }

  get entries(): RecentProject[] {
    return this.preferences.recent
  }

  get theme(): Theme | undefined {
    return this.preferences.theme
  }

  get windowBounds(): WindowBounds | undefined {
    return this.preferences.windowBounds ? { ...this.preferences.windowBounds } : undefined
  }

  get aiGateway(): AiGatewayConfig {
    return this.preferences.aiGateway ? { ...this.preferences.aiGateway } : { ...defaultAiGatewayConfig }
  }

  get ffmpegDirectory() {
    return this.preferences.ffmpegDirectory ?? null
  }

  async setFfmpegDirectory(directory: string | null) {
    const next = directory === null ? undefined : absolutePath.parse(directory)
    await this.queueSave(async () => {
      await atomicJson(this.file, { ...this.preferences, ffmpegDirectory: next })
      this.preferences.ffmpegDirectory = next
    })
  }

  async setAiGateway(config: AiGatewayConfig, resolve?: GatewayLookup) {
    const next = aiGatewayConfigSchema.parse(config)
    await describeAiGateway(next.baseUrl, resolve)
    await this.queueSave(async () => {
      const prev = this.preferences.aiGateway
      if (prev && prev.preset === next.preset && prev.baseUrl === next.baseUrl && prev.model === next.model) return
      await atomicJson(this.file, { ...this.preferences, aiGateway: next })
      this.preferences.aiGateway = next
    })
    return { ...next }
  }

  async setTheme(theme: Theme) {
    const next = themeSchema.parse(theme)
    await this.queueSave(async () => {
      if (this.preferences.theme === next) return
      await atomicJson(this.file, { ...this.preferences, theme: next })
      this.preferences.theme = next
    })
  }

  async setWindowBounds(bounds: WindowBounds) {
    const next = windowBoundsSchema.parse(bounds)
    await this.queueSave(async () => {
      const prev = this.preferences.windowBounds
      if (
        prev
        && prev.width === next.width
        && prev.height === next.height
        && prev.x === next.x
        && prev.y === next.y
        && prev.maximized === next.maximized
      ) {
        return
      }
      await atomicJson(this.file, { ...this.preferences, windowBounds: next })
      this.preferences.windowBounds = next
    })
  }

  async remember(project: Omit<RecentProject, 'id'>) {
    await this.queueSave(async () => {
      const previous = this.entries.find(item => sameDirectory(item.directory, project.directory))
      if (previous === this.entries[0] && previous?.title === project.title && previous.fictional === project.fictional) return
      const next = [{ ...project, id: previous?.id ?? randomUUID() },
        ...this.entries.filter(item => !sameDirectory(item.directory, project.directory))].slice(0, recentLimit)
      await atomicJson(this.file, { ...this.preferences, recent: next })
      this.preferences.recent = next
    })
  }

  async rememberMedia(file: string) {
    const directory = path.dirname(file)
    await this.queueSave(async () => {
      if (this.preferences.mediaDirectory && sameDirectory(directory, this.preferences.mediaDirectory)) return
      await atomicJson(this.file, { ...this.preferences, mediaDirectory: directory })
      this.preferences.mediaDirectory = directory
    })
  }

  async defaultDirectory(kind: 'project' | 'media', fallback?: string) {
    const recent = this.entries[0]?.directory
    const lastUsed = kind === 'media' ? this.preferences.mediaDirectory : recent && path.dirname(recent)
    for (const directory of [lastUsed, fallback]) {
      if (directory && await stat(directory).then(info => info.isDirectory()).catch(() => false)) return directory
    }
  }

  private queueSave(write: () => Promise<void>) {
    const run = this.saveTail.then(write)
    this.saveTail = run.catch(error => console.error('preferences:save', error))
    return run
  }
}
