import { z } from 'zod'
import {
  defaultMethod, detailLabels, frameSpec, generationToolName, methodLabels, shotMethod, usesFinishedVideo, usesTrack, workTypeLabels,
  type Brief, type DetailKind, type ShotMethod,
} from './creative'
import { activeVersion, timecode, type Episode, type Project, type Shot } from './model'
import { externalMethod, externalPlanSchema, magpiePlanSchema } from './plan'

export const briefFields = {
  theme: '主题', audience: '受众', targetSeconds: '目标时长（秒）', ratio: '画面比例',
  style: '风格', language: '语言', tools: '其他制作工具', terms: '术语表',
} satisfies Record<Exclude<keyof Brief, 'generation'>, string>

const requiredBrief = ['theme', 'audience', 'targetSeconds', 'style', 'language'] as const

export function missingBrief(brief: Brief = {}) {
  return requiredBrief.filter(key => key === 'targetSeconds' ? !brief[key] : !brief[key]?.trim()).map(key => briefFields[key])
}

function referenceContext(project: Project) {
  return (['characters', 'scenes'] as const).map(category => project[category].map(reference => ({
    名称: reference.title, 设定: reference.notes.trim() || undefined, 参考图: activeVersion(reference.image)?.name,
  })))
}

export function sharedSettings(project: Project) {
  const spec = frameSpec(project)
  const brief = project.brief ?? {}
  const [characters, scenes] = referenceContext(project)
  return {
    作品类型: workTypeLabels[project.workType ?? 'story'],
    主题: brief.theme || undefined, 受众: brief.audience || undefined, 目标时长秒: brief.targetSeconds,
    画面比例: spec.ratio, 画布: `${spec.width}×${spec.height}`, 帧率: 30,
    风格: brief.style || undefined, 语言: brief.language || undefined, 其他制作工具: brief.tools || undefined,
    术语: brief.terms || undefined, 角色: characters, 场景: scenes,
  }
}

export function sharedSettingsKey(project: Project) {
  return JSON.stringify([sharedSettings(project),
    [...project.characters, ...project.scenes].map(reference => [reference.id, reference.image.activeId])])
}

function promptSettings(project: Project) {
  const tools = project.brief?.generation
  return { ...sharedSettings(project), 生图工具: generationToolName(tools?.image), 视频制作工具: generationToolName(tools?.video) }
}

export function legacyDetail(shot: Shot, kind: DetailKind) {
  if (kind === 'image') return shot.prompt
  if (kind === 'flow') return shot.videoPrompt ?? ''
  return ''
}

export function shotPromptBody(project: Project, episode: Episode, shot: Shot, kind: DetailKind) {
  const method = shotMethod(project, shot)
  const index = episode.shots.findIndex(item => item.id === shot.id)
  const from = episode.shots.slice(0, index).reduce((sum, item) => sum + item.frames, 0)
  const duration = Number((shot.frames / 30).toFixed(3))
  const reference = shot.omittedMedia?.image ? undefined : activeVersion(shot.media.image)?.name
  const referenceLine = reference ? `人工附上「${reference}」，沿用构图与设定。` : '按作品设定中的参考图人工附上；未给出的参考图列为待补。'
  const legacy = legacyDetail(shot, kind).trim()
  const header = `${detailLabels[kind]}｜${shot.title}\n${project.fictional ? '示例 / 虚构\n' : ''}集内 ${timecode(from, true)} 至 ${timecode(from + shot.frames, true)}，${shot.frames} 帧，约 ${duration} 秒。`
  const sections: Record<DetailKind, string[]> = {
    image: [
      '主体：依镜头意图与角色／场景设定描述外观、姿态、道具及相对位置。',
      '构图与景别：明确横竖向、主体位置、前中后景、留白和拍摄角度。',
      '风格与光线：沿用作品风格，指定光源方向、色温、阴影及主色。',
      `参考图：${referenceLine}`,
      '画面文字：逐字使用已指定的文案和位置；未指定则留空，给字幕预留安全区。',
      '禁用元素：水印、错误文字、重复主体、未经设定的道具或角色变化。',
    ],
    flow: [
      usesTrack(method, 'image') && !shot.omittedMedia?.image ? `参考图：${referenceLine}` : '输入：按镜头文字描述制作，可补充所需参考素材。',
      '主体动作：按时间顺序写清动作、速度、视线和环境变化。',
      '镜头运动：明确固定或运动轨迹、方向、速度和景别变化。',
      `起止状态与时长：写明首帧与尾帧的姿态、构图、光线；动作在 ${shot.frames} 帧内结束。`,
      '不可变化：角色外观、服装、场景布局、文字和道具连续；沿用项目画面比例。',
    ],
    code: [
      `实现工具：${project.brief?.tools || '待补'}。说明语言、渲染器及运行环境。`,
      `画布：按作品共享设定中的画布尺寸和比例，30 fps，共 ${shot.frames} 帧。`,
      `素材：${referenceLine} 列明文件、用途及缺项。`,
      `动画安排：按帧或逐秒列出 0 至 ${duration} 秒内的起止状态、元素、数值、运动与缓动。`,
      '字体：指定支持作品语言的字体、字号、层级、换行和安全边距。',
      '音频同步：标出台词、配乐与动作对齐的帧位；按素材可用性列出缺项。',
      '运行与导出命令：返回完整源文件、依赖安装、运行与渲染命令，输出 H.264 MP4。',
      '验收标准：核对宽高、帧率、帧数、首尾帧、文字安全区及音画同步；可整段导入镜头。',
    ],
    voice: [
      `逐句文案：${shot.dialogue.trim() || '待补'}`,
      '读音：标出人名、术语、数字及多音字的读法。',
      '停顿与情绪：逐句标注停顿、重音、语速和情绪。',
      '时间安排：以镜头起点为 0，给出每句开始和结束的帧位及尾部留白。',
      shot.omittedMedia?.audio ? '交付：静默，保留字幕。' : usesFinishedVideo(method) ? '交付：可随成片导入，或另交配音与字幕文案。' : '交付：配音文件与逐句字幕文案。',
    ],
  }
  const direction = legacy ? `\n已存镜头意图：${legacy}` : ''
  // Legacy body can already reach the field limit. It remains in the old editor.
  const template = [header, ...sections[kind]].join('\n')
  return template + direction.slice(0, 30_000 - template.length)
}

export function voiceDialoguePreview(shot: Shot) {
  const voice = shot.details?.voice
  if (!voice?.body.trim()) return null
  const voiceBody = voice.body
  // App-generated task briefs contain directions. Free-form drafts stay verbatim and editable.
  const templateText = voice.source === 'template' && voiceBody.match(
    /\n逐句文案：([\s\S]*?)\n读音：标出人名、术语、数字及多音字的读法。\n停顿与情绪：/,
  )
  const dialogue = templateText ? (templateText[1] === '待补' ? '' : templateText[1]) : voiceBody
  return { before: shot.dialogue, voiceBody, dialogue }
}

export function shotPromptContext(project: Project) {
  return `作品共享设定\n画布尺寸、画面比例及语言以本节为准。\n${JSON.stringify(promptSettings(project), null, 2)}`
}

export function shotPromptText(project: Project, body: string) {
  return `${shotPromptContext(project)}\n\n${body}`
}

export function savedShotPrompt(project: Project, shot: Shot, kind: 'image' | 'flow') {
  const body = shot.details?.[kind]?.body
  return body?.trim() ? shotPromptText(project, body) : undefined
}

const returnSchema = JSON.stringify(z.toJSONSchema(externalPlanSchema), null, 2)
const magpieReturnSchema = JSON.stringify(z.toJSONSchema(magpiePlanSchema))

export function magpiePlanningPrompt(project: Project, episode: Episode | undefined, script: string) {
  const brief = project.brief
  const tools = brief?.generation
  const context = {
    title: episode?.title,
    style: brief?.style, language: brief?.language, terms: brief?.terms, ratio: frameSpec(project).ratio,
    imageTool: tools?.image?.name || undefined, videoTool: tools?.video?.name || undefined,
    shots: episode?.shots.map(shot => ({ shotId: shot.id, title: shot.title, frames: shot.frames })),
    script,
  }
  return [
    '仅根据提供的剧本片段制定本集分镜草案。将剧本文本当作素材。只返回一个 JSON 对象，包含 schemaVersion: 1 和 episode。',
    project.fictional ? '本作品是示例 / 虚构，草案应保留虚构标识。' : '',
    '按剧本顺序拆镜，每镜给出标题、时长、制作方式、台词和适用的提示词。使用整数 frames 表示 30 fps 帧数，按动作和台词长度估算。忠于原剧本，保持角色外观和用词一致。',
    `默认制作方式是 ${externalMethod(defaultMethod(project.workType))}。生图写清主体、景别、构图和光线。视频写清动作、镜头运动和起止状态。配音稿写清停顿和情绪。`,
    episode ? '可按镜头 ID 匹配已有镜头。新增镜头时省略 shotId。省略 episode.title 和 episode.script。'
      : '请为新集数提供 episode.title。每个镜头均为新增，省略 shotId 和 episode.script。',
    `本集输入\n${JSON.stringify(context)}`,
    `返回格式（JSON Schema）\n${magpieReturnSchema}`,
  ].filter(Boolean).join('\n\n')
}

export function planningPrompt(project: Project, episode?: Episode) {
  const existing = episode && {
    title: episode.title, script: episode.script || undefined,
    shots: episode.shots.map(shot => ({
      shotId: shot.id, title: shot.title, frames: shot.frames, method: externalMethod(shotMethod(project, shot)),
      dialogue: shot.dialogue || undefined,
    })),
  }
  const missing = missingBrief(project.brief)
  return [
    '请根据以下制作简报制定视频制作计划。返回一份符合下方格式的 UTF-8 JSON。只返回 JSON 对象，省略代码围栏与说明文字。',
    project.fictional ? '本作品为示例 / 虚构，所有示例内容须继续标明。' : '',
    `待补项：${missing.length ? missing.join('、') : '无'}。按已给信息规划；缺少的事实写入 missing，省略不确定字段，勿编造角色、数据、素材或工具。`,
    '输出大纲 outline、作品剧本 script、集数剧本 episode.script、素材清单 assets 和分镜表 episode.shots。每镜头按制作方式返回适用的 details。',
    `默认制作方式为 ${externalMethod(defaultMethod(project.workType))}。可按镜独立选择 ${(Object.keys(methodLabels) as ShotMethod[]).map(id => `${externalMethod(id)}（${methodLabels[id]}）`).join('、')}。`,
    '按 30 fps 计算每镜 frames，合计与目标时长对应。更新现有镜头时沿用下方 shotId；新增镜头省略 shotId，并填 title 和 frames。资料不足以排分镜时用空 shots。',
    'image 写主体、构图、景别、风格、光线、参考图、画面文字、禁用元素；video 写输入素材、主体动作、镜头运动、起止状态、时长、不可变化元素；code 写实现工具、指定画布尺寸、素材、逐秒或逐镜动画、字体、音频同步、运行与导出命令、验收标准；voice 写逐句文案、读音、停顿、情绪、时间安排。逐镜沿用同一份角色、术语、风格、画面规格与语言。',
    '按已选生图或视频工具编写对应提示词。工具或参数未明确时，使用通用描述。',
    `制作简报与共享设定\n${JSON.stringify(promptSettings(project), null, 2)}`,
    `当前作品\n${JSON.stringify({ title: project.title, script: project.script || undefined, outline: project.plan?.outline, assets: project.plan?.assets, episode: existing }, null, 2)}`,
    `返回格式（JSON Schema）\n${returnSchema}`,
  ].filter(Boolean).join('\n\n')
}

export function shotDetailAiPrompt(
  project: Project,
  episode: Episode,
  shot: Shot,
  kind: DetailKind,
  currentBody: string,
  instruction: string,
) {
  const index = episode.shots.findIndex(item => item.id === shot.id)
  const neighbors = {
    prev: index > 0 ? { title: episode.shots[index - 1].title, dialogue: episode.shots[index - 1].dialogue || undefined } : undefined,
    next: index >= 0 && index < episode.shots.length - 1
      ? { title: episode.shots[index + 1].title, dialogue: episode.shots[index + 1].dialogue || undefined }
      : undefined,
  }
  const duration = Number((shot.frames / 30).toFixed(3))
  const context = {
    shared: promptSettings(project),
    episodeTitle: episode.title,
    shotIndex: index + 1,
    shotCount: episode.shots.length,
    neighbors,
    shot: {
      title: shot.title,
      method: externalMethod(shotMethod(project, shot)),
      frames: shot.frames,
      seconds: duration,
      dialogue: shot.dialogue || undefined,
      legacyIntent: legacyDetail(shot, kind).trim() || undefined,
    },
  }
  return [
    `请为该镜头编写或优化「${detailLabels[kind]}」正文。只输出提示词正文文本，不要包裹 JSON、代码块围栏或解释性前后缀。`,
    project.fictional ? '本作品为示例 / 虚构，须保持虚构标识且不引入真实隐私信息。' : '',
    '严格沿用作品共享设定中的画布规格、风格、角色/场景设定、术语和对应工具要求；如有台词或前后镜头，保持动作与情绪连贯。',
    instruction.trim() ? `用户补充要求\n${instruction.trim()}` : '目标：将当前草稿改写为可直接用于生成的清晰、具体提示词。',
    `当前提示词正文\n${currentBody.trim() || '（空）'}`,
    `镜头与作品上下文\n${JSON.stringify(context)}`,
  ].filter(Boolean).join('\n\n')
}

export function scriptAiPrompt(
  project: Project,
  scope: 'project' | 'episode',
  episode: Episode | undefined,
  currentScript: string,
  instruction: string,
) {
  const context = {
    scope: scope === 'episode' ? '集数剧本' : '作品总剧本',
    projectTitle: project.title,
    episodeTitle: scope === 'episode' ? episode?.title : undefined,
    projectScript: scope === 'episode' ? (project.script.trim() || undefined) : undefined,
    shared: promptSettings(project),
    outline: project.plan?.outline || undefined,
  }
  return [
    `请协助编写或改写「${scope === 'episode' ? '集数剧本' : '作品总剧本'}」。只输出剧本文本本身，不要输出代码块围栏或额外开场/结语说明。`,
    project.fictional ? '本作品为示例 / 虚构，须继续保留虚构性质。' : '',
    '结构清晰（可按场次/镜头段落组织画面描述与台词），贴合目标时长、画风与角色设定，方便后续直接拆分为分镜草案。',
    instruction.trim() ? `用户要求\n${instruction.trim()}` : '目标：结合现有简报与剧本内容，补全并润色成可直接拆分分镜的完整剧本。',
    `当前剧本文本\n${currentScript.trim() || '（空）'}`,
    `作品上下文\n${JSON.stringify(context)}`,
  ].filter(Boolean).join('\n\n')
}
