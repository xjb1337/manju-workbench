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
export const magpieModelSchema = z.string().trim().min(1, '请输入模型 ID').max(200, '模型 ID 最多 200 个字符')
  .refine(value => !/[\x00-\x1f\x7f]/.test(value), '模型 ID 不能包含控制字符')
export const magpieScriptSchema = detailTextSchema.trim().min(1, '请输入要拆分的剧本文本')

export const aiPresetSchema = z.enum(['magpie', 'ollama', 'lmstudio', 'custom'])
export type AiPreset = z.infer<typeof aiPresetSchema>
export const aiGatewayPresets: Record<AiPreset, { label: string; baseUrl: string; defaultModel: string }> = {
  magpie: { label: 'Magpie 本机网关', baseUrl: magpieBaseUrl, defaultModel: magpieDefaultModel },
  ollama: { label: 'Ollama 本机服务', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen2.5:14b' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'local-model' },
  custom: { label: '自定义兼容网关', baseUrl: magpieBaseUrl, defaultModel: magpieDefaultModel },
}

const aiNetworkSchema = z.enum(['loopback', 'lan'])
export type AiNetwork = z.infer<typeof aiNetworkSchema>

// WHATWG URL canonicalizes IP literals before this check, including short IPv4 forms.
export function aiIpNetwork(host: string): AiNetwork | 'blocked' | undefined {
  if (host.startsWith('[')) {
    if (host === '[::1]') return 'loopback'
    return /^\[f[cd][0-9a-f]{2}:/.test(host) ? 'lan' : 'blocked'
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return
  const [first, second] = host.split('.').map(Number)
  if (first === 127) return 'loopback'
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return 'lan'
  return 'blocked'
}

const aiUrlFormatError = '请输入 HTTP 或 HTTPS 网关地址（不含凭据、查询串或片段）'
const aiUrlLengthError = '网关地址最多 500 个字符'
export const aiBaseUrlSchema = z.string().trim().min(1, '请输入网关地址').max(500, aiUrlLengthError)
  .refine(value => !/[\x00-\x1f\x7f]/.test(value), '网关地址不能包含控制字符')
  .regex(/^https?:\/\/[^/@\\?#]+(?:\/[^\\?#]*)?$/i, aiUrlFormatError)
  .transform((value, context) => {
    try {
      const url = new URL(value)
      if (aiIpNetwork(url.hostname) === 'blocked') {
        context.addIssue({ code: 'custom', message: 'AI 网关仅允许本机或局域网地址' })
        return z.NEVER
      }
      return url.href.replace(/\/+$/, '')
    } catch {
      context.addIssue({ code: 'custom', message: aiUrlFormatError })
      return z.NEVER
    }
  })
  .pipe(z.string().max(500, aiUrlLengthError))
export const aiGatewayConfigSchema = z.object({
  preset: aiPresetSchema,
  baseUrl: aiBaseUrlSchema,
  model: magpieModelSchema,
})
export type AiGatewayConfig = z.infer<typeof aiGatewayConfigSchema>
export const aiRequestTargetSchema = aiGatewayConfigSchema.pick({ baseUrl: true, model: true }).extend({ network: aiNetworkSchema })
export type AiRequestTarget = z.infer<typeof aiRequestTargetSchema>
export const aiCompletionUrl = (baseUrl: string) => `${baseUrl}/chat/completions`
export const defaultAiGatewayConfig: AiGatewayConfig = {
  preset: 'magpie',
  baseUrl: magpieBaseUrl,
  model: magpieDefaultModel,
}
export const aiInstructionSchema = z.string().trim().max(2000, '补充要求最多 2,000 个字符')

export interface AiConnectionTestResult {
  models: string[]
  latencyMs: number
  modelList: 'valid' | 'invalid' | 'unavailable'
  issue?: string
}

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
