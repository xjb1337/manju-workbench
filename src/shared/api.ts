import type { MediaTarget, Mutation, Project } from './model'

export interface OpenProject {
  project: Project
  mediaKey: string
  directory: string
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type Tool = 'chatgpt' | 'flow'
export type RenderProgress = { mode: 'preview' | 'export'; percent: number }
export type RenderResult = { status: 'completed'; location: string } | { status: 'canceled' }
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
}
