import type { MediaTarget, Mutation, Project } from './model'

export interface OpenProject {
  project: Project
  mediaKey: string
  directory: string
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type Tool = 'chatgpt' | 'flow'
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
export interface Workbench {
  open(): Promise<Reply<OpenProject | null>>
  create(title: string, sample: boolean): Promise<Reply<OpenProject | null>>
  close(): Promise<Reply<null>>
  edit(key: string, change: Mutation): Promise<Reply<Project>>
  importMedia(key: string, target: MediaTarget): Promise<Reply<Project | null>>
  copy(text: string): Promise<Reply<null>>
  openTool(tool: Tool): Promise<Reply<null>>
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
}
