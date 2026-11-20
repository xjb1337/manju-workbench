import { z } from 'zod'
import type { MediaKind, Project, Shot } from './model'

export const workTypeLabels = { story: '漫剧／故事', knowledge: '知识讲解', code: '代码视频', mixed: '混合' } as const
export const methodLabels = {
  flow: '生图 + 视频制作', image: '仅生图', 'flow-only': '仅视频制作', code: '仅代码成片', imported: '仅导入成片',
} as const
export const detailLabels = { image: '生图提示词', flow: '视频制作提示词', code: '代码任务书', voice: '配音与字幕稿' } as const
export const workTypeSchema = z.enum(['story', 'knowledge', 'code', 'mixed'], '作品类型无效')
export const methodSchema = z.enum(['flow', 'image', 'flow-only', 'code', 'imported'], '制作方式无效')
export const detailKindSchema = z.enum(['image', 'flow', 'code', 'voice'], '提示词类型无效')
export const ratioSchema = z.enum(['16:9', '9:16'], '画面比例必须是 16:9 或 9:16')
export type WorkType = z.infer<typeof workTypeSchema>
export type ShotMethod = z.infer<typeof methodSchema>
export type DetailKind = z.infer<typeof detailKindSchema>
export type Ratio = z.infer<typeof ratioSchema>

export const generationKindSchema = z.enum(['image', 'video'], '生成工具类型无效')
export type GenerationKind = z.infer<typeof generationKindSchema>
export const generationLabels = { image: '生图', video: '视频制作' } as const

const detailToGeneration: Partial<Record<DetailKind, GenerationKind>> = {
  image: 'image',
  flow: 'video',
}

const generationToDetail: Record<GenerationKind, 'image' | 'flow'> = {
  image: 'image',
  video: 'flow',
}

/** Maps internal detail keys (`flow` in v1/v2 projects) to external plan keys (`video`). */
export function externalDetailKey(kind: DetailKind): 'image' | 'video' | 'code' | 'voice' {
  return kind === 'flow' ? 'video' : kind
}

/** Maps a generation tool kind (`image` / `video`) to its internal detail/review key (`image` / `flow`). */
export function generationDetailKind(kind: GenerationKind): 'image' | 'flow' {
  return generationToDetail[kind]
}

/** Maps an internal detail kind to its generation tool kind, or `undefined` when none applies. */
export function detailGenerationKind(kind: DetailKind): GenerationKind | undefined {
  return detailToGeneration[kind]
}
export const generationToolUrl = z.string('工具网址必须是文本').trim().max(2048, '工具网址最多 2,048 个字符').refine(value => {
  if (!value) return true
  if (!/^https?:\/\//i.test(value) || /[\\\x00-\x1f\x7f]/.test(value)) return false
  const url = URL.parse(value)
  return !!url && !url.username && !url.password
}, '请输入完整的 HTTP 或 HTTPS 网址，网址中不要包含账号或密码')
const generationToolSchema = z.object({
  name: z.string('工具名称必须是文本').trim().max(80, '工具名称最多 80 个字符').default(''),
  url: generationToolUrl.default(''),
}, '生成工具配置无效')
export type GenerationTool = z.infer<typeof generationToolSchema>
export const generationPresets = {
  image: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  video: { name: 'Google Flow', url: 'https://labs.google/fx/tools/flow' },
} satisfies Record<GenerationKind, GenerationTool>

export function generationToolName(tool?: GenerationTool) {
  return tool?.name || (tool?.url ? URL.parse(tool.url)?.hostname : undefined)
}

const shortText = z.string('简报字段必须是文本').trim().max(1000, '简报字段最多 1,000 个字符')
export const briefSchema = z.object({
  theme: shortText.optional(),
  audience: shortText.optional(),
  targetSeconds: z.number('目标时长必须是有效数字')
    .finite('目标时长必须是有效数字')
    .positive('目标时长必须大于 0 秒')
    .max(86_400, '目标时长最多 86,400 秒')
    .optional(),
  ratio: ratioSchema.optional(),
  style: shortText.optional(),
  language: shortText.optional(),
  tools: shortText.optional(),
  generation: z.partialRecord(generationKindSchema, generationToolSchema, '生成工具配置无效').optional(),
  terms: z.string('术语表必须是文本').trim().max(5000, '术语表最多 5,000 个字符').optional(),
}, '制作简报格式无效')
export type Brief = z.infer<typeof briefSchema>

export const briefTextFields = ['theme', 'audience', 'style', 'language', 'tools', 'terms'] as const
export type BriefTextField = typeof briefTextFields[number]
export type BriefValidationErrors = {
  targetSeconds?: string
  text: Partial<Record<BriefTextField, string>>
  generation: Partial<Record<GenerationKind, { field: 'name' | 'url'; message: string }>>
  general?: string
}

/** Validates raw brief form inputs against `briefSchema` and returns field errors with the first focus target. */
export function parseBriefDraft(draft: {
  target: string
  ratio: Ratio
  text: Record<BriefTextField, string>
  generation: Record<GenerationKind, GenerationTool>
}): { ok: true; data: Brief } | { ok: false; errors: BriefValidationErrors; focusId: string } {
  const trimmedTarget = draft.target.trim()
  const targetSeconds = trimmedTarget ? Number(trimmedTarget) : undefined
  const generation: NonNullable<Brief['generation']> = {}
  for (const kind of generationKindSchema.options) {
    const tool = { name: draft.generation[kind].name.trim(), url: draft.generation[kind].url.trim() }
    if (tool.name || tool.url) generation[kind] = tool
  }
  const parsed = briefSchema.safeParse({
    ...draft.text,
    ratio: draft.ratio,
    targetSeconds,
    generation,
  })
  if (parsed.success) return { ok: true, data: parsed.data }

  const errors: BriefValidationErrors = { text: {}, generation: {} }
  for (const issue of parsed.error.issues) {
    const [head, second, third] = issue.path
    if (head === 'targetSeconds') {
      errors.targetSeconds ??= issue.message
    } else if (typeof head === 'string' && (briefTextFields as readonly string[]).includes(head)) {
      const key = head as BriefTextField
      errors.text[key] ??= issue.message
    } else if (head === 'generation' && (second === 'image' || second === 'video')) {
      const field = third === 'name' ? 'name' : 'url'
      errors.generation[second] ??= { field, message: issue.message }
    } else {
      errors.general ??= issue.message
    }
  }

  let focusId = 'brief-target-seconds'
  if (errors.targetSeconds) {
    focusId = 'brief-target-seconds'
  } else {
    const invalidText = briefTextFields.find(key => errors.text[key])
    if (invalidText) {
      focusId = `brief-${invalidText}`
    } else {
      const invalidTool = generationKindSchema.options.find(kind => errors.generation[kind])
      if (invalidTool) focusId = `generation-${invalidTool}-${errors.generation[invalidTool]!.field}`
    }
  }
  return { ok: false, errors, focusId }
}

/** Converts a 0..1 music volume ratio into a rounded percentage without IEEE-754 drift. */
export function formatVolumePercent(volume: number): number {
  if (!Number.isFinite(volume)) return 0
  return Math.round(volume * 10_000) / 100
}

export const detailTextSchema = z.string('提示词内容必须是文本').max(30_000, '提示词最多 30,000 个字符')
export const detailSchema = z.object({
  body: detailTextSchema,
  source: z.enum(['manual', 'external', 'template'], '提示词来源无效'),
  needsUpdate: z.literal(true, '待更新标记无效').optional(),
}, '提示词详情格式无效')
const planItemSchema = z.string('规划条目必须是文本').trim().min(1, '规划条目不能为空').max(1000, '规划条目最多 1,000 个字符')
export const planNotesSchema = z.object({
  outline: detailTextSchema.optional(),
  assets: z.array(planItemSchema, {
    error: issue => issue.input === undefined ? undefined : '素材清单必须是列表',
  }).max(500, '素材清单最多 500 项').optional(),
  missing: z.array(planItemSchema, {
    error: issue => issue.input === undefined ? undefined : '待补项清单必须是列表',
  }).max(500, '待补项清单最多 500 项').optional(),
}, '规划内容格式无效')

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
