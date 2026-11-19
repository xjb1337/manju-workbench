import { z } from 'zod'
import { detailTextSchema, planNotesSchema, type ShotMethod } from './creative'
import { idSchema, shotFields, titleSchema } from './model'

const packageBody = detailTextSchema.trim().min(1).optional()
// External plans use neutral `image-video` / `video-only` / `details.video` keys;
// v1/v2 stored projects retain historical `flow` / `flow-only` / `details.flow` keys for compatibility.
const planMethod = z.enum(['image-video', 'image', 'video-only', 'code', 'imported'])
type PlanMethod = z.infer<typeof planMethod>

/** Translates internal `ShotMethod` (`flow` / `flow-only`) to external plan method names. */
export function externalMethod(method: ShotMethod): PlanMethod {
  return method === 'flow' ? 'image-video' : method === 'flow-only' ? 'video-only' : method
}

/** Translates external plan method names back to internal `ShotMethod` (`flow` / `flow-only`). */
export function storedMethod(method: PlanMethod): ShotMethod {
  return method === 'image-video' ? 'flow' : method === 'video-only' ? 'flow-only' : method
}

const plannedShot = z.strictObject({
  shotId: idSchema.optional().describe('更新已有镜头时填写工作台给出的标识；新增时省略'),
  title: titleSchema.optional(),
  frames: shotFields.shape.frames.optional().describe('30 fps 总帧数，1 至 18000'),
  method: planMethod.optional(),
  dialogue: shotFields.shape.dialogue.optional(),
  details: z.strictObject({
    image: packageBody.describe('生图提示词'),
    video: packageBody.describe('视频制作提示词'),
    code: packageBody.describe('代码生成任务书'),
    voice: packageBody.describe('配音与字幕稿'),
  }).optional(),
}).superRefine((shot, ctx) => {
  if (shot.shotId) return
  for (const field of ['title', 'frames'] as const) {
    if (shot[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: '新增镜头必须填写此项' })
  }
})

const plannedEpisode = z.strictObject({
  title: titleSchema.optional(),
  script: detailTextSchema.optional(),
  shots: z.array(plannedShot).max(500),
}).superRefine((episode, ctx) => {
  const seen = new Set<string>()
  episode.shots.forEach(({ shotId }, index) => {
    if (!shotId) return
    if (seen.has(shotId)) ctx.addIssue({ code: 'custom', path: ['shots', index, 'shotId'], message: '镜头标识重复' })
    seen.add(shotId)
  })
})

export const externalPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: titleSchema.optional(),
  outline: planNotesSchema.shape.outline,
  script: detailTextSchema.optional(),
  assets: planNotesSchema.shape.assets.describe('所需素材清单，每项写明用途与来源；未知来源列为待补'),
  missing: planNotesSchema.shape.missing.unwrap().describe('待补项；没有时使用空数组'),
  episode: plannedEpisode,
})
export const magpiePlanSchema = z.object({ schemaVersion: z.literal(1), episode: plannedEpisode })
export type ExternalPlan = z.infer<typeof externalPlanSchema>
export const maxPlanCharacters = 1_000_000
export const magpieBaseUrl = 'http://127.0.0.1:3425/v1'
export const magpieDefaultModel = 'group/never-stuck'
export const magpieModelSchema = z.string().trim().min(1, '请输入 Magpie 模型 ID').max(200, '模型 ID 最多 200 个字符')
  .refine(value => !/[\x00-\x1f\x7f]/.test(value), '模型 ID 不能包含控制字符')
export const magpieScriptSchema = detailTextSchema.trim().min(1, '请输入要拆分的剧本文本')

export interface PlanChange {
  id: string
  group: string
  field: string
  before: string
  after: string
  conflict: boolean
}

export interface PlanPreview {
  token: string
  changes: PlanChange[]
}
