import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { OpenProject } from '../shared/api'
import type { Project } from '../shared/model'
import type { ProjectStore } from './storage'

export type SessionStore = Pick<ProjectStore, 'root' | 'snapshot'>

export type RememberProject = (project: {
  directory: string
  title: string
  fictional: boolean
}) => Promise<void> | void

export type WorkbenchSessionOptions = {
  rememberProject?: RememberProject
  tempRoot?: string
}

export type SessionCurrent<TStore extends SessionStore = ProjectStore> = {
  store: TStore
  key: string
}

export type SessionPreview = {
  directory: string
  file: string
  id: string
}

export type SessionRenderJob = {
  controller: AbortController
  publishing: boolean
}

export type SessionPlanGeneration = {
  key: unknown
  controller: AbortController
}

/** Encapsulates mutable main-process workbench session state outside Electron. */
export class WorkbenchSession<TStore extends SessionStore = ProjectStore> {
  current: SessionCurrent<TStore> | null = null
  preview: SessionPreview | null = null
  shotCacheDir: string | null = null
  operation: Promise<unknown> | undefined
  job: SessionRenderJob | null = null
  planGeneration: SessionPlanGeneration | null = null
  editorDirty = false
  quitting = false
  confirmingInstall = false
  installerStarted = false

  private readonly rememberProject?: RememberProject
  private readonly tempRoot: string

  constructor(options: WorkbenchSessionOptions = {}) {
    this.rememberProject = options.rememberProject
    this.tempRoot = options.tempRoot ?? tmpdir()
  }

  canAcceptIpc(): boolean {
    return !this.quitting && !this.installerStarted
  }

  async serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.operation) throw new Error('已有操作在进行')
    const pending = Promise.resolve().then(fn)
    this.operation = pending
    try {
      return await pending
    } finally {
      this.operation = undefined
    }
  }

  getStore(key: unknown): TStore {
    if (!this.current || key !== this.current.key) throw new Error('作品已关闭或切换')
    return this.current.store
  }

  async ensureShotCache(): Promise<string> {
    if (this.shotCacheDir) return this.shotCacheDir
    const dir = await mkdtemp(path.join(this.tempRoot, 'manju-shot-cache-'))
    this.shotCacheDir = dir
    return dir
  }

  async dropPreview(): Promise<void> {
    const previous = this.preview
    this.preview = null
    if (previous) await rm(previous.directory, { recursive: true, force: true }).catch(() => {})
  }

  async setPreview(directory: string, file: string): Promise<string> {
    await this.dropPreview()
    const id = randomUUID()
    this.preview = { directory, file, id }
    return id
  }

  async dropShotCache(): Promise<void> {
    const previous = this.shotCacheDir
    this.shotCacheDir = null
    if (previous) await rm(previous, { recursive: true, force: true }).catch(() => {})
  }

  private async safeRemember(store: TStore, project?: Project): Promise<void> {
    if (!this.rememberProject) return
    try {
      const { title, fictional } = project ?? store.snapshot
      await this.rememberProject({ directory: store.root, title, fictional })
    } catch {
      // Best-effort recent project persistence; do not block switching or closing.
    }
  }

  async switchProject(store: TStore | null): Promise<OpenProject | null> {
    await this.dropPreview()
    await this.dropShotCache()
    const previous = this.current
    if (!store) {
      this.current = null
      if (previous) await this.safeRemember(previous.store)
      return null
    }
    const project: Project = store.snapshot
    const key = randomUUID()
    this.current = { store, key }
    if (previous) await this.safeRemember(previous.store)
    await this.safeRemember(store, project)
    return { project, mediaKey: key, directory: store.root }
  }

  cancelRender(): boolean {
    if (!this.job || this.job.publishing) return false
    this.job.controller.abort()
    return true
  }

  cancelPlanGeneration(key: unknown): boolean {
    if (!this.planGeneration || this.planGeneration.key !== key) return false
    this.planGeneration.controller.abort()
    return true
  }

  abortActiveWork(): void {
    this.planGeneration?.controller.abort()
    if (this.job && !this.job.publishing) this.job.controller.abort()
  }

  async dispose(): Promise<void> {
    this.quitting = true
    this.abortActiveWork()
    await Promise.resolve(this.operation).catch(() => {})
    await this.dropPreview()
    await this.dropShotCache()
  }
}
