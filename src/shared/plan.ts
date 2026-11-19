import { z } from 'zod'
import { detailTextSchema, methodSchema, planNotesSchema } from './creative'
import { idSchema, shotFields, titleSchema } from './model'

const packageBody = detailTextSchema.trim().min(1).optional()

const plannedShot = z.strictObject({
  shotId: idSchema.optional().describe('更新已有镜头时填写工作台给出的标识；新增时省略'),
  title: titleSchema.optional(),
  frames: shotFields.shape.frames.optional().describe('30 fps 总帧数，1 至 18000'),
  method: methodSchema.optional(),
  dialogue: shotFields.shape.dialogue.optional(),
  details: z.strictObject({
    image: packageBody.describe('生图提示词'),
    flow: packageBody.describe('Flow 视频提示词'),
    code: packageBody.describe('代码生成任务书'),
    voice: packageBody.describe('配音与字幕稿'),
  }).optional(),
}).superRefine((shot, ctx) => {
  if (shot.shotId) return
  for (const field of ['title', 'frames'] as const) {
    if (shot[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: '新增镜头必须填写此项' })
  }
})

export const externalPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: titleSchema.optional(),
  outline: planNotesSchema.shape.outline,
  script: detailTextSchema.optional(),
  assets: planNotesSchema.shape.assets.describe('所需素材清单，每项写明用途与来源；未知来源列为待补'),
  missing: planNotesSchema.shape.missing.unwrap().describe('待补项；没有时使用空数组'),
  episode: z.strictObject({
    title: titleSchema.optional(),
    script: detailTextSchema.optional(),
    shots: z.array(plannedShot).max(500),
  }),
}).superRefine((plan, ctx) => {
  const seen = new Set<string>()
  plan.episode.shots.forEach(({ shotId }, index) => {
    if (!shotId) return
    if (seen.has(shotId)) ctx.addIssue({ code: 'custom', path: ['episode', 'shots', index, 'shotId'], message: '镜头标识重复' })
    seen.add(shotId)
  })
})
export type ExternalPlan = z.infer<typeof externalPlanSchema>
export const maxPlanCharacters = 1_000_000

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
