import { z } from 'zod'
import type { MediaKind, Project, Shot } from './model'

export const workTypeLabels = { story: '漫剧／故事', knowledge: '知识讲解', code: '代码视频', mixed: '混合' } as const
export const methodLabels = {
  flow: '生图 + Flow', image: '仅生图', 'flow-only': '仅 Flow（跳过生图）', code: '仅代码成片', imported: '仅导入成片',
} as const
export const detailLabels = { image: '生图提示词', flow: 'Flow 视频提示词', code: '代码任务书', voice: '配音与字幕稿' } as const
export const workTypeSchema = z.enum(['story', 'knowledge', 'code', 'mixed'])
export const methodSchema = z.enum(['flow', 'image', 'flow-only', 'code', 'imported'])
export const detailKindSchema = z.enum(['image', 'flow', 'code', 'voice'])
export const ratioSchema = z.enum(['16:9', '9:16'])
export type WorkType = z.infer<typeof workTypeSchema>
export type ShotMethod = z.infer<typeof methodSchema>
export type DetailKind = z.infer<typeof detailKindSchema>
export type Ratio = z.infer<typeof ratioSchema>

const shortText = z.string().trim().max(1000, '简报字段最多 1,000 个字符')
export const briefSchema = z.object({
  theme: shortText.optional(),
  audience: shortText.optional(),
  targetSeconds: z.number().finite().positive().max(86_400).optional(),
  ratio: ratioSchema.optional(),
  style: shortText.optional(),
  language: shortText.optional(),
  tools: shortText.optional(),
  terms: z.string().trim().max(5000, '术语表最多 5,000 个字符').optional(),
})
export type Brief = z.infer<typeof briefSchema>

export const detailTextSchema = z.string().max(30_000, '提示词最多 30,000 个字符')
export const detailSchema = z.object({
  body: detailTextSchema,
  source: z.enum(['manual', 'external', 'template']),
  needsUpdate: z.literal(true).optional(),
})
export const planNotesSchema = z.object({
  outline: detailTextSchema.optional(),
  assets: z.array(z.string().trim().min(1).max(1000)).max(500).optional(),
  missing: z.array(z.string().trim().min(1).max(1000)).max(500).optional(),
})

export function frameSpec(project?: Pick<Project, 'brief'>) {
  const ratio = project?.brief?.ratio ?? '16:9'
  return ratio === '9:16'
    ? { ratio, width: 720, height: 1280, subtitle: { size: 38, horizontal: 44, bottom: 76 } }
    : { ratio, width: 1280, height: 720, subtitle: { size: 38, horizontal: 62, bottom: 45 } }
}
export type FrameSpec = ReturnType<typeof frameSpec>

export function defaultMethod(type?: WorkType): ShotMethod {
  if (type === 'code') return 'code'
  if (type === 'knowledge') return 'image'
  return 'flow'
}

export function shotMethod(project: Pick<Project, 'workType'>, shot?: Pick<Shot, 'method'>): ShotMethod {
  return shot?.method ?? defaultMethod(project.workType)
}

export function usesTrack(method: ShotMethod, kind: MediaKind) {
  if (kind === 'image') return method === 'flow' || method === 'image'
  if (kind === 'video') return method !== 'image'
  return true
}

export function usesFinishedVideo(method: ShotMethod) {
  return method === 'code' || method === 'imported'
}

export function detailKinds(method: ShotMethod, omitted?: Shot['omittedMedia']): DetailKind[] {
  const result: DetailKind[] = []
  if (usesTrack(method, 'image') && !omitted?.image) result.push('image')
  if ((method === 'flow' || method === 'flow-only') && !omitted?.video) result.push('flow')
  if (method === 'code') result.push('code')
  result.push('voice')
  return result
}
