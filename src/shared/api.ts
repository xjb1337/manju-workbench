import type { ImportTarget, MediaKind, MediaTarget, Mutation, Project } from './model'
import type { DetailKind, GenerationKind } from './creative'

import type { AiConnectionTestResult, AiGatewayConfig, AiNetwork, AiRequestTarget, PlanPreview } from './plan'

export interface OpenProject {
  project: Project
  mediaKey: string
  directory: string
}

export type ReplyError = { ok: false; error: string; code?:
  'update-package-invalid' | 'update-manual-required' | 'upgrade-canceled' | 'project-conflict' | 'orphan-preview-stale' }
export type Reply<T> = { ok: true; value: T } | ReplyError
export type RecentProject = { id: string; title: string; directory: string; fictional: boolean }
export type Tool = GenerationKind | 'planning'
export type RenderProgress = { mode: 'preview' | 'export'; percent: number }
export type PreflightIssue = {
  severity: 'error' | 'warning'
  code: 'no-shots' | 'missing-file' | 'unreadable' | 'missing-visual' | 'black' | 'still'
    | 'no-voice' | 'dense' | 'subtitle-overflow' | 'stale'
  target: MediaKind | 'dialogue' | 'music' | 'shots'
  shot?: { id: string; index: number; title: string }
}
export type PreflightReport = { episodeId: string; title: string; issues: PreflightIssue[]; review: string }
export type RenderResult =
  | { status: 'canceled' }
  | { status: 'preflight'; report: PreflightReport }
  | { status: 'completed'; mode: 'preview'; location: string }
  | { status: 'completed'; mode: 'export'; location: string; project: Project }
  | { status: 'record-failed'; location: string }
export type UpdateKind = 'setup' | 'portable'
export type UpdateCheck = { currentVersion: string } & (
  | { status: 'none' }
  | { status: 'latest'; version: string; notes: string }
  | { status: 'available'; version: string; notes: string; kind: UpdateKind | null; unavailable?: string; manual?: true; directory?: string }
)
export type UpdateProgress = { received: number; total: number }
export type UpdateDownload = { status: 'canceled' } | { status: 'ready'; fileName: string }
export type OrphanMediaReport = { count: number; bytes: number }
export type OrphanMediaPreview = OrphanMediaReport & { token: string; files: string[] }
export interface Workbench {
  open(): Promise<Reply<OpenProject | null>>
  recentProjects(): Promise<Reply<RecentProject[]>>
  openRecent(id: string): Promise<Reply<OpenProject | null>>
  create(title: string, sample: boolean | 'vertical'): Promise<Reply<OpenProject | null>>
  onUpgradeRequired(listener: (id: string) => void): () => void
  answerUpgrade(id: string, approved: boolean): Promise<Reply<null>>
  onUpgraded(listener: (opened: OpenProject) => void): () => void
  close(): Promise<Reply<null>>
  edit(key: string, change: Mutation): Promise<Reply<Project>>
  previewPlan(key: string, episodeId: string | null, text: string): Promise<Reply<PlanPreview>>
  generateMagpiePlan(key: string, episodeId: string | null, target: AiRequestTarget, script: string): Promise<Reply<PlanPreview | null>>
  generateShotDetailDraft(
    key: string, episodeId: string, shotId: string, kind: DetailKind, target: AiRequestTarget, body: string, instruction: string,
  ): Promise<Reply<string | null>>
  generateScriptDraft(
    key: string, scope: 'project' | 'episode', episodeId: string | null, target: AiRequestTarget, script: string, instruction: string,
  ): Promise<Reply<string | null>>
  cancelPlanGeneration(key: string): Promise<Reply<null>>
  getAiConfig(): Promise<Reply<AiGatewayConfig>>
  setAiConfig(config: AiGatewayConfig): Promise<Reply<AiGatewayConfig>>
  describeAiTarget(baseUrl: string): Promise<Reply<AiNetwork>>
  testAiConnection(config: AiGatewayConfig): Promise<Reply<AiConnectionTestResult>>
  mergePlan(key: string, token: string, replacements: string[]): Promise<Reply<Project>>
  importMedia(key: string, target: ImportTarget): Promise<Reply<Project | null>>
  importDroppedMedia(key: string, target: MediaTarget, file: File): Promise<Reply<Project | null>>
  inspectOrphanMedia(key: string): Promise<Reply<OrphanMediaPreview>>
  cancelOrphanMedia(key: string, token: string): Promise<Reply<null>>
  cleanOrphanMedia(key: string, token: string): Promise<Reply<OrphanMediaReport>>
  copy(text: string): Promise<Reply<null>>
  openTool(key: string, tool: Tool): Promise<Reply<null>>
  inspectEpisode(key: string, episodeId: string): Promise<Reply<PreflightReport | null>>
  render(key: string, episodeId: string, mode: RenderProgress['mode'], rebuild?: boolean, review?: string): Promise<Reply<RenderResult>>
  exportSrt(key: string, episodeId: string): Promise<Reply<string | null>>
  cancelRender(): Promise<Reply<boolean>>
  onProgress(listener: (event: RenderProgress) => void): () => void
  checkUpdate(): Promise<Reply<UpdateCheck>>
  downloadUpdate(): Promise<Reply<UpdateDownload>>
  cancelUpdate(): Promise<Reply<boolean>>
  installUpdate(): Promise<Reply<'started' | 'canceled'>>
  openUpdateReleasePage(): Promise<Reply<null>>
  openUpdateFolder(): Promise<Reply<null>>
  onUpdateProgress(listener: (event: UpdateProgress) => void): () => void
  setEditorDirty(dirty: boolean): Promise<Reply<null>>
  setTheme(theme: 'light' | 'dark'): Promise<Reply<null>>
}
