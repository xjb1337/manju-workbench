import type { MediaTarget, Mutation, Project } from './model'
import type { GenerationKind } from './creative'

import type { PlanPreview } from './plan'

export interface OpenProject {
  project: Project
  mediaKey: string
  directory: string
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string; code?: 'update-package-invalid' }
export type RecentProject = { id: string; title: string; directory: string; fictional: boolean }
export type Tool = GenerationKind | 'planning'
export type RenderProgress = { mode: 'preview' | 'export'; percent: number }
export type RenderResult =
  | { status: 'canceled' }
  | { status: 'completed'; mode: 'preview'; location: string }
  | { status: 'completed'; mode: 'export'; location: string; project: Project }
  | { status: 'record-failed'; location: string }
export type UpdateKind = 'setup' | 'portable'
export type UpdateCheck = { currentVersion: string } & (
  | { status: 'none' }
  | { status: 'latest'; version: string; notes: string }
  | { status: 'available'; version: string; notes: string; kind: UpdateKind | null; unavailable?: string }
)
export type UpdateProgress = { received: number; total: number }
export type UpdateDownload = { status: 'canceled' } | { status: 'ready'; fileName: string }
export type OrphanMediaReport = { count: number; bytes: number }
export interface Workbench {
  open(): Promise<Reply<OpenProject | null>>
  recentProjects(): Promise<Reply<RecentProject[]>>
  openRecent(id: string): Promise<Reply<OpenProject | null>>
  create(title: string, sample: boolean | 'vertical'): Promise<Reply<OpenProject | null>>
  close(): Promise<Reply<null>>
  edit(key: string, change: Mutation): Promise<Reply<Project>>
  previewPlan(key: string, episodeId: string | null, text: string): Promise<Reply<PlanPreview>>
  generateMagpiePlan(key: string, episodeId: string | null, model: string, script: string): Promise<Reply<PlanPreview | null>>
  cancelPlanGeneration(key: string): Promise<Reply<null>>
  mergePlan(key: string, token: string, replacements: string[]): Promise<Reply<Project>>
  importMedia(key: string, target: MediaTarget): Promise<Reply<Project | null>>
  importDroppedMedia(key: string, target: MediaTarget, file: File): Promise<Reply<Project | null>>
  inspectOrphanMedia(key: string): Promise<Reply<OrphanMediaReport>>
  cleanOrphanMedia(key: string): Promise<Reply<OrphanMediaReport>>
  copy(text: string): Promise<Reply<null>>
  openTool(key: string, tool: Tool): Promise<Reply<null>>
  render(key: string, episodeId: string, mode: RenderProgress['mode']): Promise<Reply<RenderResult>>
  cancelRender(): Promise<Reply<boolean>>
  onProgress(listener: (event: RenderProgress) => void): () => void
  checkUpdate(): Promise<Reply<UpdateCheck>>
  downloadUpdate(): Promise<Reply<UpdateDownload>>
  cancelUpdate(): Promise<Reply<boolean>>
  installUpdate(): Promise<Reply<'started' | 'canceled'>>
  openUpdateFolder(): Promise<Reply<null>>
  onUpdateProgress(listener: (event: UpdateProgress) => void): () => void
  setEditorDirty(dirty: boolean): Promise<Reply<null>>
  setTheme(theme: 'light' | 'dark'): Promise<Reply<null>>
}
