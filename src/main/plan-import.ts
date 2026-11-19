import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { detailKindSchema, detailLabels, methodLabels, shotMethod } from '../shared/creative'
import { emptyTrack, type Episode, type Project, type Shot } from '../shared/model'
import { externalMethod, externalPlanSchema, magpiePlanSchema, maxPlanCharacters, storedMethod, type ExternalPlan, type PlanChange } from '../shared/plan'
import { legacyDetail } from '../shared/prompts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeOldPlan(data: unknown) {
  if (!isRecord(data) || !isRecord(data.episode) || !Array.isArray(data.episode.shots)) return
  for (const shot of data.episode.shots) {
    if (!isRecord(shot)) continue
    if (shot.method === 'flow' || shot.method === 'flow-only') shot.method = externalMethod(shot.method)
    const details = shot.details
    if (isRecord(details) && Object.hasOwn(details, 'flow') && !Object.hasOwn(details, 'video')) {
      details.video = details.flow
      delete details.flow
    }
  }
}

function parsePlanningJson<T>(input: unknown, schema: z.ZodType<T>) {
  if (typeof input !== 'string' || input.length > maxPlanCharacters) throw new Error('规划 JSON 最多 1,000,000 个字符')
  let data: unknown
  try { data = JSON.parse(input.replace(/^\uFEFF/, '')) }
  catch { throw new Error('规划 JSON 无法解析，请粘贴完整的 JSON 对象') }
  normalizeOldPlan(data)
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue.path.join('.') || '根对象'
    const message = /[\u3400-\u9fff]/.test(issue.message) ? issue.message : {
      invalid_type: '类型错误或缺少必填字段',
      unrecognized_keys: '含有不支持的字段',
      invalid_format: '格式不正确',
      too_big: '超过长度或数值上限',
      too_small: '低于长度或数值下限',
      invalid_value: '值不在允许范围内',
      invalid_key: '含有无效字段名',
    }[issue.code as string] ?? '值无效'
    const keys = issue.code === 'unrecognized_keys' ? `（${issue.keys.slice(0, 5).join('、')}）` : ''
    throw new Error(`规划格式错误 · ${at} · ${message}${keys}`)
  }
  return parsed.data
}

export const parsePlan = (input: unknown) => parsePlanningJson(input, externalPlanSchema)
export const parseMagpieDraft = (input: unknown) => parsePlanningJson(input, magpiePlanSchema)

export function stagePlan(next: Project, episodeId: string | null, input: unknown, source: 'import' | 'magpie') {
  const plan: Partial<ExternalPlan> & Pick<ExternalPlan, 'episode'> = source === 'magpie' ? parseMagpieDraft(input) : parsePlan(input)
  const changes: PlanChange[] = []
  const writes: (() => void)[] = []
  function add(group: string, field: string, before: string | undefined, after: string, write: () => void, occupied = !!before?.trim()) {
    if ((before ?? '') === after) return
    changes.push({ id: String(changes.length), group, field, before: before ?? '', after, conflict: occupied })
    writes.push(write)
  }

  const work = '作品'
  if (plan.title !== undefined) add(work, '标题', next.title, plan.title, () => { next.title = plan.title! })
  if (plan.script !== undefined) add(work, '剧本', next.script, plan.script, () => { next.script = plan.script! })
  if (plan.outline !== undefined) add(work, '大纲', next.plan?.outline, plan.outline, () => { (next.plan ??= {}).outline = plan.outline })
  for (const [key, label] of [['assets', '素材清单'], ['missing', '规划待补项']] as const) {
    const list = plan[key]
    if (list === undefined) continue
    const previous = next.plan?.[key]
    if (JSON.stringify(previous ?? []) === JSON.stringify(list)) continue
    const display = (items: string[]) => items.map(item => `• ${item}`).join('\n') || '（空清单）'
    add(work, label, previous?.length ? display(previous) : undefined, display(list), () => { (next.plan ??= {})[key] = list })
  }

  let episode = next.episodes.find(item => item.id === episodeId)
  const incoming = plan.episode
  if (episodeId && !episode) throw new Error('预览目标集数不存在')
  if (!episode && (incoming.title !== undefined || incoming.script || incoming.shots.length)) {
    if (!incoming.title) throw new Error('规划格式错误 · episode.title · 新增集数必须填写标题')
    const created: Episode = { id: randomUUID(), title: incoming.title, script: '', shots: [] }
    add('集数', '新增集数', undefined, created.title, () => { next.episodes.push(created) })
    episode = created
  }
  if (episode) {
    const target = episode
    const group = `集数｜${target.title}`
    if (incoming.title !== undefined) add(group, '标题', target.title, incoming.title, () => { target.title = incoming.title! })
    if (incoming.script !== undefined) add(group, '剧本', target.script, incoming.script, () => { target.script = incoming.script! })
    const original = new Map(target.shots.map((shot, index) => [shot.id, { shot, index }]))
    const count = incoming.shots.filter(entry => !entry.shotId).length
    if (target.shots.length + count > 500) throw new Error('合并后每集最多保留 500 个镜头')
    if (!episodeId && next.episodes.length >= 500) throw new Error('合并后作品最多保留 500 集')
    let added = 0
    incoming.shots.forEach((entry, position) => {
      const previous = entry.shotId ? original.get(entry.shotId) : undefined
      if (entry.shotId && !previous) throw new Error(`规划格式错误 · episode.shots.${position}.shotId · 所选集数中没有此镜头`)
      const method = entry.method && storedMethod(entry.method)
      const shot: Shot = previous?.shot ?? {
        id: randomUUID(), title: entry.title!, frames: entry.frames!, dialogue: '', prompt: '', status: '待制作',
        method: method ?? shotMethod(next), media: { image: emptyTrack(), video: emptyTrack(), audio: emptyTrack() },
      }
      const row = (previous?.index ?? target.shots.length + added) + 1
      const label = `镜头 ${row}｜${shot.title}`
      const duration = (frames: number) => `${frames} 帧 · ${Number((frames / 30).toFixed(3))} 秒`
      if (!previous) {
        added++
        add(label, '新增镜头', undefined, shot.title, () => { target.shots.push(shot) })
        add(label, '时长', undefined, duration(shot.frames), () => {})
        add(label, '制作方式', undefined, methodLabels[shot.method!], () => {})
      } else {
        if (entry.title !== undefined) add(label, '标题', shot.title, entry.title, () => { shot.title = entry.title! })
        if (entry.frames !== undefined) add(label, '时长', duration(shot.frames), duration(entry.frames), () => { shot.frames = entry.frames! })
        if (method !== undefined) add(label, '制作方式', methodLabels[shotMethod(next, shot)], methodLabels[method], () => { shot.method = method })
      }
      if (entry.dialogue !== undefined) add(label, '台词', shot.dialogue, entry.dialogue, () => { shot.dialogue = entry.dialogue! })
      for (const kind of detailKindSchema.options) {
        const body = entry.details?.[kind === 'flow' ? 'video' : kind]
        if (body === undefined) continue
        const existing = shot.details?.[kind]
        add(label, detailLabels[kind], existing?.body ?? legacyDetail(shot, kind), body,
          () => { (shot.details ??= {})[kind] = { body, source: 'external' } })
      }
    })
  }
  return {
    changes,
    apply(replacements: string[]) {
      const selected = new Set(replacements)
      for (const id of selected) {
        if (!changes.some(change => change.id === id && change.conflict)) throw new Error('规划冲突选项无效，请重新预览')
      }
      changes.forEach((change, index) => {
        if (!change.conflict || selected.has(change.id)) writes[index]()
      })
      return next
    },
  }
}
