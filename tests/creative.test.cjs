const assert = require('node:assert/strict')
const { lstat, mkdtemp, readdir, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { briefSchema, detailKinds, frameSpec, generationToolUrl, shotMethod } = require('../dist/shared/creative')
const { productionProgress } = require('../dist/shared/production')
const { planningPrompt, savedShotPrompt, shotPromptBody, shotPromptText } = require('../dist/shared/prompts')
const { renderEpisode, subtitles } = require('../dist/main/render')
const { probe } = require('../dist/main/process')
const { ProjectStore } = require('../dist/main/storage')

async function setup(context) {
  const dir = await mkdtemp(path.join(tmpdir(), '虚构视频 工作台-'))
  context.after(() => rm(dir, { recursive: true, force: true }))
  const store = await ProjectStore.create(dir, '虚构验收', true)
  const episodeId = (await store.edit({ type: 'episode.add', title: '信号观测' })).episodes[0].id
  const shot = (await store.edit({ type: 'shot.add', episodeId, title: '波形' })).episodes[0].shots[0]
  await store.edit({ type: 'shot.edit', episodeId, shotId: shot.id, fields: {
    title: shot.title, frames: 24, dialogue: '示例 / 虚构', prompt: '手改旧生图', status: '待审核',
  } })
  return { store, episodeId, shotId: shot.id, file: path.join(store.root, 'project.json') }
}

test('旧版 JSON 打开后保留原字段，预览与导出共享横竖画布、字幕 PlayRes 和实际 MP4 尺寸', async context => {
  const { store, file } = await setup(context)
  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.schemaVersion, 2)
  raw.schemaVersion = 1
  await writeFile(file, JSON.stringify(raw))
  assert.equal(raw.schemaVersion, 1)
  for (const key of ['workType', 'brief', 'plan']) assert.ok(!(key in raw))
  for (const key of ['method', 'details']) assert.ok(!(key in raw.episodes[0].shots[0]))
  let opened = await ProjectStore.open(store.root)
  assert.deepEqual(opened.snapshot, raw)
  let renderedLandscape
  for (const [index, [ratio, width, height]] of [['16:9', 1280, 720], ['9:16', 720, 1280]].entries()) {
    if (index) {
      await opened.edit({ type: 'project.brief', workType: 'story', brief: { ratio } })
      assert.equal(opened.snapshot.episodes[0].exportRecord.stale, true)
      await assert.rejects(opened.recordExport(renderedLandscape, '16:9'), /成片内容已变更/)
    }
    const snapshot = opened.snapshot
    const spec = frameSpec(snapshot)
    const episode = snapshot.episodes[0]
    const signal = AbortSignal.timeout(25_000)
    assert.deepEqual([spec.ratio, spec.width, spec.height], [ratio, width, height])
    assert.match(subtitles(episode.shots[0], spec), new RegExp(`PlayResX: ${width}\\nPlayResY: ${height}`))
    const sizes = []
    for (const mode of ['preview', 'export']) {
      const output = path.join(opened.root, `${index}-${mode}.mp4`)
      await renderEpisode(opened, episode, output, { signal, project: snapshot })
      const stream = (await probe(output, 'mp4', signal)).streams.find(item => item.codec_type === 'video')
      sizes.push([stream.width, stream.height])
    }
    assert.deepEqual(sizes, [[width, height], [width, height]])
    if (!index) opened = await opened.upgradeCopy(async () => true)
    await opened.recordExport(episode, ratio, snapshot)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 1)
    assert.equal(opened.snapshot.schemaVersion, 2)
    if (!index) renderedLandscape = episode
  }
})

test('长字幕分页且覆盖完整台词，镜头不足一帧一页时提示调整', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行字幕`)
  const shot = { dialogue: lines.join('\n'), frames: 60 }
  for (const ratio of ['9:16', '16:9']) {
    const body = subtitles(shot, frameSpec({ brief: { ratio } }))
    const events = body.split('\n').filter(line => line.startsWith('Dialogue: '))
    const pages = events.map(event => event.split(',,0,0,0,,')[1].split('\\N'))
    assert.ok(pages.every(page => page.length <= 4))
    assert.deepEqual(pages.flat(), lines)
    assert.match(events[0], /^Dialogue: 0,0:00:00\.00,/)
    assert.match(events.at(-1), /,0:00:02\.00,Chinese/)
  }
  assert.throws(() => subtitles({ ...shot, frames: 1 }, frameSpec()), /镜头时长不足/)
})

test('旧版 Flow 规划仍能提供通用视频提示词，旧稿可继续编辑', async context => {
  const { store, episodeId, shotId } = await setup(context)
  const plain = store.snapshot
  const shot = plain.episodes[0].shots[0]
  assert.equal(shot.prompt, '手改旧生图')
  assert.equal(savedShotPrompt(plain, shot, 'image'), undefined)
  const staged = await store.previewPlan(episodeId, JSON.stringify({ schemaVersion: 1, missing: [], episode: { shots: [
    { shotId, details: { image: '新生图提示词', flow: '新视频提示词' } },
  ] } }))
  const saved = await store.mergePlan(staged.token, staged.changes.filter(change => change.conflict).map(change => change.id))
  const current = saved.episodes[0].shots[0]
  assert.equal(current.prompt, '手改旧生图')
  assert.equal(savedShotPrompt(saved, current, 'image'), shotPromptText(saved, '新生图提示词'))
  assert.equal(savedShotPrompt(saved, current, 'flow'), shotPromptText(saved, '新视频提示词'))
})

test('生图和视频工具可独立配置，规划提示词使用工具名和通用字段', async context => {
  const { store, episodeId, shotId } = await setup(context)
  const generation = {
    image: { name: '本地生图软件' },
    video: { name: '示例视频服务', url: 'http://127.0.0.1:8188/' },
  }
  assert.equal(briefSchema.parse({ generation }).generation.image.url, '')
  for (const url of ['file:///C:/example.html', 'https://account@example.test/', 'https://bad\\url.example/']) {
    assert.equal(generationToolUrl.safeParse(url).success, false)
  }
  await store.edit({ type: 'project.brief', workType: 'story', brief: { generation } })
  const plan = await store.previewPlan(episodeId, JSON.stringify({ schemaVersion: 1, missing: [], episode: { shots: [
    { shotId, method: 'video-only', details: { image: '先前的绘图说明', video: '按文字生成镜头' } },
  ] } }))
  const saved = await store.mergePlan(plan.token, plan.changes.filter(change => change.conflict).map(change => change.id))
  const episode = saved.episodes[0]
  const shot = episode.shots[0]
  assert.equal(shot.method, 'flow-only')
  assert.equal(shot.details.flow.body, '按文字生成镜头')
  assert.match(shotPromptBody(saved, episode, shot, 'flow'), /按镜头文字描述制作/)
  const copied = savedShotPrompt(saved, shot, 'flow')
  assert.match(copied, /本地生图软件[\s\S]*示例视频服务[\s\S]*按文字生成镜头/)
  assert.doesNotMatch(copied, /127\.0\.0\.1/)
  const text = planningPrompt(saved, episode)
  const schema = JSON.parse(text.split('返回格式（JSON Schema）\n')[1])
  const shotSchema = schema.properties.episode.properties.shots.items.properties
  assert.deepEqual(shotSchema.method.enum, ['image-video', 'image', 'video-only', 'code', 'imported'])
  assert.ok(shotSchema.details.properties.video)
  assert.equal(shotSchema.details.properties.flow, undefined)
  assert.match(text, /"method": "video-only"/)
  assert.doesNotMatch(text, /ChatGPT|Google Flow|127\.0\.0\.1/)

  const review = await store.importMedia({ scope: 'shot', episodeId, shotId, kind: 'image' }, path.resolve('resources/sample/01.jpg'))
  // Importing a reference can flag previous details for review. Accept both before switching tools.
  for (const kind of ['image', 'flow']) await store.edit({ type: 'shot.detail', episodeId, shotId, kind, action: { type: 'keep' } })
  const changed = await store.edit({ type: 'project.brief', workType: 'story',
    brief: { generation: { ...generation, video: { name: '另一视频工具' } } } })
  const updated = changed.episodes[0].shots[0]
  assert.equal(updated.details.flow.needsUpdate, true)
  assert.equal(updated.details.image.needsUpdate, undefined)
  assert.deepEqual(updated.media, review.episodes[0].shots[0].media)
  const reopened = await ProjectStore.open(store.root)
  assert.equal(reopened.snapshot.brief.generation.video.name, '另一视频工具')
})

test('知识、代码和混合流程按实际逐镜方式、素材、任务书与 omit 判定', async context => {
  const { store, episodeId, shotId } = await setup(context)
  const steps = () => productionProgress(store.snapshot, episodeId).steps.map(step => step.id)
  await store.edit({ type: 'project.brief', workType: 'knowledge', brief: {} })
  assert.deepEqual(steps(), ['script', 'shots', 'image', 'audio', 'export'])
  await store.edit({ type: 'project.brief', workType: 'code', brief: {} })
  assert.deepEqual(steps(), ['script', 'shots', 'code', 'finished', 'audio', 'export'])
  assert.equal(productionProgress(store.snapshot, episodeId).statuses.code, 'incomplete')
  const code = { type: 'shot.detail', episodeId, shotId, kind: 'code' }
  await store.edit({ ...code, action: { type: 'save', body: '虚构波形的代码任务' } })
  assert.equal(productionProgress(store.snapshot, episodeId).statuses.code, 'complete')
  assert.equal(productionProgress(store.snapshot, episodeId).statuses.finished, 'incomplete')
  await store.edit({ type: 'shot.omit-media', episodeId, shotId, kind: 'video', omitted: true })
  assert.equal(productionProgress(store.snapshot, episodeId).statuses.finished, 'complete')
  await store.edit({ type: 'project.brief', workType: 'mixed', brief: {} })
  const snapshot = store.snapshot
  const shot = snapshot.episodes[0].shots[0]
  const plan = await store.previewPlan(episodeId, JSON.stringify({
    schemaVersion: 1, missing: [], episode: { shots: [
      { shotId, method: 'code' }, { title: '固定图', frames: 29, method: 'image' },
      { title: '移动镜头', frames: 33, method: 'flow-only' }, { title: '归档成片', frames: 60, method: 'imported' },
    ] },
  }))
  await store.mergePlan(plan.token, [plan.changes.find(change => change.field === '制作方式' && change.conflict).id])
  const mixed = productionProgress(store.snapshot, episodeId)
  assert.deepEqual(steps(), ['script', 'references', 'shots', 'image', 'video', 'code', 'finished', 'audio', 'export'])
  assert.deepEqual(mixed.media.image.items.map(item => item.title), ['固定图'])
  assert.deepEqual(mixed.media.video.items.map(item => item.title), ['移动镜头'])
  assert.deepEqual(mixed.media.finished.items.map(item => item.title), [shot.title, '归档成片'])
  assert.equal(mixed.statuses.finished, 'partial')
  assert.deepEqual(detailKinds('flow', { image: true }), ['flow', 'voice'])
  assert.deepEqual(detailKinds('imported'), ['voice'])
})

test('简报目标初始化单集首镜，详细包引用统一的设定和适用参数', async context => {
  const { store, episodeId, shotId } = await setup(context)
  await store.edit({ type: 'shot.remove', episodeId, shotId })
  await store.edit({ type: 'project.brief', workType: 'mixed', brief: {
    targetSeconds: 4.2, ratio: '9:16', language: '简体中文', style: '青绿色动态图形', terms: '虚构信号',
  } })
  const project = await store.edit({ type: 'shot.add', episodeId, title: '脉冲图形' })
  const episode = project.episodes[0]
  const shot = episode.shots[0]
  assert.equal(shot.frames, 126)
  assert.equal(shot.method, 'flow')
  const sections = {
    image: ['主体', '构图与景别', '风格与光线', '参考图', '画面文字', '禁用元素'],
    flow: ['参考图', '主体动作', '镜头运动', '起止状态与时长', '不可变化'],
    code: ['实现工具', '画布', '素材', '动画安排', '字体', '音频同步', '运行与导出命令', '验收标准'],
    voice: ['逐句文案', '读音', '停顿与情绪', '时间安排'],
  }
  for (const [kind, items] of Object.entries(sections)) {
    const body = shotPromptBody(project, episode, shot, kind)
    assert.ok(items.every(item => body.includes(`\n${item}：`)), body)
    assert.match(shotPromptText(project, body), /720×1280[\s\S]*青绿色动态图形[\s\S]*简体中文[\s\S]*虚构信号/)
  }
})

test('总规划提示词包含公开的 JSON Schema、待补项和已知简报，未注入虚构细节', async context => {
  const { store } = await setup(context)
  await store.edit({ type: 'project.brief', workType: 'code', brief: { ratio: '9:16', theme: '声音频谱', targetSeconds: 12.4 } })
  const project = store.snapshot
  const text = planningPrompt(project, project.episodes[0])
  assert.match(text, /UTF-8 JSON/)
  assert.match(text, /待补项：受众、风格、语言。/)
  assert.match(text, /勿编造/)
  assert.match(text, /示例 \/ 虚构/)
  assert.match(text, /"主题": "声音频谱"/)
  assert.match(text, /"目标时长秒": 12.4/)
  assert.match(text, /"画布": "720×1280"/)
  assert.doesNotMatch(text, /"受众":|"使用工具":/)
  assert.ok(text.includes(project.episodes[0].shots[0].id))
  const schema = JSON.parse(text.split('返回格式（JSON Schema）\n')[1])
  assert.equal(schema.additionalProperties, false)
  assert.ok(schema.properties.episode.properties.shots.items.properties.details.properties.code)
})

test('规划预览无写入，按冲突选择合并并保留活动版本、导出记录与手改正文', async context => {
  const { store, episodeId, shotId, file } = await setup(context)
  const target = { scope: 'shot', episodeId, shotId, kind: 'image' }
  for (const file of ['01.jpg', '02.jpg']) await store.importMedia(target, path.resolve('resources/sample', file))
  await store.edit({ type: 'shot.detail', episodeId, shotId, kind: 'code', action: { type: 'save', body: '手改代码任务书' } })
  const original = await store.recordExport(store.snapshot.episodes[0])
  const previous = original.episodes[0].shots[0]
  const archived = await readFile(await store.assetPath(previous.media.image.versions[0]))
  const bytes = await readFile(file)
  const input = {
    schemaVersion: 1, title: '建议标题', script: '新作品剧本', outline: '虚构大纲', assets: ['观测表：屏幕用'], missing: ['音色'],
    episode: { shots: [{ shotId, title: '建议镜头', details: { image: '建议生图', code: '建议代码' } },
      { title: '附加镜头', frames: 53, method: 'imported' }] },
  }
  const preview = await store.previewPlan(episodeId, JSON.stringify(input))
  assert.deepEqual(await readFile(file), bytes)
  assert.deepEqual(preview.changes.filter(change => change.conflict).map(change => change.field),
    ['标题', '标题', '生图提示词', '代码任务书'])
  assert.ok(preview.changes.some(change => change.before === '手改代码任务书' && change.conflict))
  assert.ok(preview.changes.some(change => change.before === '手改旧生图' && change.conflict))
  const useTitle = preview.changes.find(change => change.group === '作品' && change.field === '标题').id
  const merged = await store.mergePlan(preview.token, [useTitle])
  const shot = merged.episodes[0].shots[0]
  assert.equal(merged.title, '建议标题')
  assert.equal(merged.script, '新作品剧本')
  assert.equal(merged.plan.outline, '虚构大纲')
  assert.deepEqual(shot, previous)
  assert.equal(merged.episodes[0].shots[1].frames, 53)
  assert.deepEqual(merged.episodes[0].exportRecord, { ...original.episodes[0].exportRecord, stale: true })
  assert.deepEqual(await readFile(await store.assetPath(previous.media.image.versions[0])), archived)
  assert.deepEqual((await ProjectStore.open(store.root)).snapshot, JSON.parse(await readFile(file, 'utf8')))
  await assert.rejects(store.mergePlan(preview.token, []), /预览已失效/)
})

test('非法结构、未知镜头、无效确认与过期预览均不会部分写入', async context => {
  const { store, episodeId, shotId, file } = await setup(context)
  const bytes = await readFile(file)
  const valid = { schemaVersion: 1, title: '新作', missing: [], episode: { shots: [] } }
  for (const [text, error] of [
    ['{', /JSON 无法解析/],
    [JSON.stringify({ ...valid, episode: { shots: [{ title: '缺帧' }] } }), /episode.shots.0.frames/],
    [JSON.stringify({ ...valid, episode: { shots: [{ shotId, media: {} }] } }), /不支持的字段/],
    [JSON.stringify({ ...valid, episode: { shots: [{ shotId }, { shotId }] } }), /镜头标识重复/],
    [JSON.stringify({ ...valid, episode: { shots: [{ shotId: store.snapshot.id }] } }), /没有此镜头/],
  ]) {
    await assert.rejects(store.previewPlan(episodeId, text), error)
    assert.deepEqual(await readFile(file), bytes)
  }
  const preview = await store.previewPlan(episodeId, JSON.stringify(valid))
  await assert.rejects(store.mergePlan(preview.token, ['999']), /选项无效/)
  assert.deepEqual(await readFile(file), bytes)
  await store.edit({ type: 'project.edit', title: '并发保存', script: '新内容' })
  const newer = await readFile(file)
  await assert.rejects(store.mergePlan(preview.token, ['0']), /预览已失效/)
  assert.deepEqual(await readFile(file), newer)
})

test('共享设定使提示词和素材需更新，保留手改与确认重生成各自持久化', async context => {
  const { store, episodeId, shotId } = await setup(context)
  const target = { scope: 'shot', episodeId, shotId, kind: 'image' }
  const brief = { type: 'project.brief', workType: 'mixed', brief: { ratio: '9:16', language: '简体中文', style: '蓝色网格', terms: '脉冲：信号增强' } }
  await store.edit(brief)
  await store.importMedia(target, path.resolve('resources/sample/01.jpg'))
  const detail = { type: 'shot.detail', episodeId, shotId, kind: 'code' }
  await store.edit({ ...detail, action: { type: 'save', body: '保留我的手改代码任务书' } })
  const get = () => store.snapshot.episodes[0].shots[0]
  await store.edit({ ...brief, brief: { ...brief.brief, terms: '脉冲：短时增强' } })
  assert.deepEqual(get().details.code, { body: '保留我的手改代码任务书', source: 'manual', needsUpdate: true })
  assert.equal(get().media.image.versions[0].needsUpdate, true)
  assert.equal(get().legacyPromptReview.image, true)
  await store.edit({ ...detail, action: { type: 'keep' } })
  assert.deepEqual(get().details.code, { body: '保留我的手改代码任务书', source: 'manual' })
  await store.edit({ type: 'media.keep', target, versionId: get().media.image.activeId })
  assert.equal(get().media.image.versions[0].needsUpdate, undefined)
  await store.edit({ type: 'reference.add', category: 'characters', title: '虚构观测员' })
  assert.equal(get().details.code.needsUpdate, true)
  const [episode] = store.snapshot.episodes
  const suggested = shotPromptBody(store.snapshot, episode, get(), 'code')
  await store.edit({ ...detail, action: { type: 'regenerate' } })
  assert.deepEqual(get().details.code, { body: suggested, source: 'template' })
  assert.match(shotPromptText(store.snapshot, suggested), /720×1280.*\n[\s\S]*脉冲：短时增强[\s\S]*虚构观测员/)
  assert.match(suggested, /运行与导出命令/)
  assert.equal(shotMethod(store.snapshot, get()), 'flow')
  assert.deepEqual((await ProjectStore.open(store.root)).snapshot.episodes[0].shots[0], JSON.parse(JSON.stringify(get())))
})

test('中英与代码混排字幕按视觉宽度换行、不在英文词中间硬截断且保持分页与转义契约', () => {
  const asciiFitsOneLine = 'alpha bravo charlie delta echo foxtrot'
  const landscapeSingle = subtitles({ dialogue: asciiFitsOneLine, frames: 30 }, frameSpec({ brief: { ratio: '16:9' } }))
  const singleEvents = landscapeSingle.split('\n').filter(line => line.startsWith('Dialogue: '))
  assert.equal(singleEvents.length, 1)
  assert.equal(singleEvents[0].split(',,0,0,0,,')[1], asciiFitsOneLine)

  const mixed = [
    '在 renderEpisode 中调用 calculateFrameBudget 和 parseSubtitleLine 完成 {导出} \\ 测试',
    'const outputPath = path.join(publishDir, "complete.mp4")',
    '请检查 superLongCamelCaseIdentifierNameWithoutSpaces1234567890 是否完整显示',
  ].join('\n')
  const protectedWords = ['renderEpisode', 'calculateFrameBudget', 'parseSubtitleLine', 'outputPath', 'publishDir']

  for (const [ratio, width, height] of [['16:9', 1280, 720], ['9:16', 720, 1280]]) {
    const body = subtitles({ dialogue: mixed, frames: 90 }, frameSpec({ brief: { ratio } }))
    assert.match(body, new RegExp(`WrapStyle: 2\\nPlayResX: ${width}\\nPlayResY: ${height}`))
    const events = body.split('\n').filter(line => line.startsWith('Dialogue: '))
    const pages = events.map(event => event.split(',,0,0,0,,')[1].split('\\N'))
    assert.ok(pages.every(page => page.length <= 4))
    const lines = pages.flat()
    for (const line of lines) {
      assert.equal(line, line.trim())
    }
    const joined = lines.join('\n')
    const flat = lines.join('')
    assert.ok(flat.includes('｛导出｝'))
    assert.ok(flat.includes('＼'))
    for (const word of protectedWords) {
      assert.ok(lines.some(line => line.includes(word)), `${ratio} 应保持完整单词 ${word}，实际为:\n${joined}`)
    }
    assert.equal(
      lines.join('').replace(/\s+/g, ''),
      '在renderEpisode中调用calculateFrameBudget和parseSubtitleLine完成｛导出｝＼测试constoutputPath=path.join(publishDir,"complete.mp4")请检查superLongCamelCaseIdentifierNameWithoutSpaces1234567890是否完整显示',
    )
  }
  assert.throws(() => subtitles({ dialogue: mixed, frames: 1 }, frameSpec({ brief: { ratio: '9:16' } })), /镜头时长不足/)
})

test('多镜头并发渲染输出通过尺寸时长校验、平滑上报进度，且失败时保留已有文件并带镜头序号报错', async context => {
  const { store, episodeId, shotId } = await setup(context)
  await store.importMedia({ scope: 'shot', episodeId, shotId, kind: 'image' }, path.resolve('resources/sample/01.jpg'))
  await store.edit({ type: 'shot.edit', episodeId, shotId, fields: {
    title: '镜头一', frames: 24, dialogue: '镜头一 renderEpisode 测试', prompt: '首镜', status: '待审核',
  } })
  const shot2 = (await store.edit({ type: 'shot.add', episodeId, title: '镜头二' })).episodes[0].shots[1]
  await store.edit({ type: 'shot.edit', episodeId, shotId: shot2.id, fields: {
    title: '镜头二', frames: 30, dialogue: 'Shot 2 calculateBudget 混排字幕', prompt: '次镜', status: '待审核',
  } })
  const shot3 = (await store.edit({ type: 'shot.add', episodeId, title: '镜头三' })).episodes[0].shots[2]
  await store.edit({ type: 'shot.edit', episodeId, shotId: shot3.id, fields: {
    title: '镜头三', frames: 36, dialogue: '镜头三 concat 导出校验', prompt: '末镜', status: '待审核',
  } })

  const output = path.join(store.root, 'multi-shot.mp4')
  const percents = []
  const signal = AbortSignal.timeout(30_000)
  await renderEpisode(store, store.snapshot.episodes[0], output, {
    signal,
    project: store.snapshot,
    progress: value => percents.push(value),
  })

  assert.ok(percents.length >= 2)
  assert.equal(percents.at(-1), 100)
  for (let i = 0; i < percents.length; i++) {
    if (i > 0) assert.ok(percents[i] >= percents[i - 1], `进度应单调递增: ${percents}`)
    if (i < percents.length - 1) assert.ok(percents[i] >= 0 && percents[i] <= 94)
  }

  const info = await probe(output, 'mp4', signal)
  const video = info.streams.find(stream => stream.codec_type === 'video')
  const audio = info.streams.find(stream => stream.codec_type === 'audio')
  assert.equal(video.codec_name, 'h264')
  assert.deepEqual([video.width, video.height], [1280, 720])
  assert.equal(audio.codec_name, 'aac')
  assert.ok(Math.abs(Number(info.format.duration) - (24 + 30 + 36) / 30) <= 0.10)

  const existingBytes = await readFile(output)
  await store.edit({ type: 'shot.edit', episodeId, shotId: shot2.id, fields: {
    title: '镜头二', frames: 1, dialogue: Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行`).join('\n'), prompt: '次镜', status: '待审核',
  } })
  await assert.rejects(
    renderEpisode(store, store.snapshot.episodes[0], output, { signal, project: store.snapshot }),
    /镜头 2 · 镜头时长不足/,
  )
  assert.deepEqual(await readFile(output), existingBytes)
})

test('cacheDir 复用镜头分片缓存，修改单镜台词或时长仅重编码变更镜头', async context => {
  const { store, episodeId, shotId } = await setup(context)
  await store.importMedia({ scope: 'shot', episodeId, shotId, kind: 'image' }, path.resolve('resources/sample/01.jpg'))
  await store.edit({ type: 'shot.edit', episodeId, shotId, fields: {
    title: '缓存镜头一', frames: 24, dialogue: '镜头一初始台词', prompt: '首镜', status: '待审核',
  } })
  const shot2 = (await store.edit({ type: 'shot.add', episodeId, title: '缓存镜头二' })).episodes[0].shots[1]
  await store.edit({ type: 'shot.edit', episodeId, shotId: shot2.id, fields: {
    title: '缓存镜头二', frames: 30, dialogue: '镜头二初始台词', prompt: '次镜', status: '待审核',
  } })

  const cacheDir = await mkdtemp(path.join(tmpdir(), 'manju-shot-cache-test-'))
  context.after(() => rm(cacheDir, { recursive: true, force: true }))
  const signal = AbortSignal.timeout(30_000)

  const previewOutput = path.join(store.root, 'preview-cached.mp4')
  await renderEpisode(store, store.snapshot.episodes[0], previewOutput, {
    signal,
    project: store.snapshot,
    cacheDir,
  })
  const firstEntries = (await readdir(cacheDir)).sort()
  assert.equal(firstEntries.length, 2)
  assert.ok(firstEntries.every(name => /^[0-9a-f]{64}\.mov$/.test(name)))
  const firstStats = new Map()
  for (const name of firstEntries) {
    const info = await lstat(path.join(cacheDir, name))
    assert.ok(info.isFile() && info.size > 0)
    firstStats.set(name, { ino: info.ino, mtimeMs: info.mtimeMs })
  }

  const exportOutput = path.join(store.root, 'export-cached.mp4')
  const exportPercents = []
  await renderEpisode(store, store.snapshot.episodes[0], exportOutput, {
    signal,
    project: store.snapshot,
    cacheDir,
    progress: value => exportPercents.push(value),
  })
  assert.equal(exportPercents.at(-1), 100)
  assert.deepEqual((await readdir(cacheDir)).sort(), firstEntries)
  for (const name of firstEntries) {
    const info = await lstat(path.join(cacheDir, name))
    assert.equal(info.ino, firstStats.get(name).ino)
    assert.equal(info.mtimeMs, firstStats.get(name).mtimeMs)
  }

  for (const [file, expectedDuration] of [[previewOutput, (24 + 30) / 30], [exportOutput, (24 + 30) / 30]]) {
    const probeInfo = await probe(file, 'mp4', signal)
    const video = probeInfo.streams.find(stream => stream.codec_type === 'video')
    const audio = probeInfo.streams.find(stream => stream.codec_type === 'audio')
    assert.equal(video.codec_name, 'h264')
    assert.deepEqual([video.width, video.height], [1280, 720])
    assert.equal(audio.codec_name, 'aac')
    assert.ok(Math.abs(Number(probeInfo.format.duration) - expectedDuration) <= 0.10)
  }

  await store.edit({ type: 'shot.edit', episodeId, shotId: shot2.id, fields: {
    title: '缓存镜头二', frames: 45, dialogue: '镜头二台词已修改', prompt: '次镜', status: '待审核',
  } })
  const updatedOutput = path.join(store.root, 'updated-cached.mp4')
  await renderEpisode(store, store.snapshot.episodes[0], updatedOutput, {
    signal,
    project: store.snapshot,
    cacheDir,
  })
  const updatedEntries = (await readdir(cacheDir)).sort()
  assert.equal(updatedEntries.length, 3)
  assert.ok(updatedEntries.every(name => /^[0-9a-f]{64}\.mov$/.test(name)))
  for (const name of firstEntries) {
    assert.ok(updatedEntries.includes(name))
    const info = await lstat(path.join(cacheDir, name))
    assert.equal(info.ino, firstStats.get(name).ino)
    assert.equal(info.mtimeMs, firstStats.get(name).mtimeMs)
  }

  const updatedProbe = await probe(updatedOutput, 'mp4', signal)
  const updatedVideo = updatedProbe.streams.find(stream => stream.codec_type === 'video')
  assert.deepEqual([updatedVideo.width, updatedVideo.height], [1280, 720])
  assert.ok(Math.abs(Number(updatedProbe.format.duration) - (24 + 45) / 30) <= 0.10)
})

test('cacheDir 命中缓存前校验源素材存在性，源文件被移除时报错素材文件不存在', async context => {
  const { store, episodeId, shotId } = await setup(context)
  await store.importMedia({ scope: 'shot', episodeId, shotId, kind: 'image' }, path.resolve('resources/sample/01.jpg'))
  const shot2 = (await store.edit({ type: 'shot.add', episodeId, title: '缺失素材镜头' })).episodes[0].shots[1]
  await store.importMedia({ scope: 'shot', episodeId, shotId: shot2.id, kind: 'image' }, path.resolve('resources/sample/02.jpg'))

  const cacheDir = await mkdtemp(path.join(tmpdir(), 'manju-shot-cache-missing-'))
  context.after(() => rm(cacheDir, { recursive: true, force: true }))
  const signal = AbortSignal.timeout(30_000)

  const firstOutput = path.join(store.root, 'cached-first.mp4')
  await renderEpisode(store, store.snapshot.episodes[0], firstOutput, {
    signal,
    project: store.snapshot,
    cacheDir,
  })

  const missingVersion = store.snapshot.episodes[0].shots[1].media.image.versions[0]
  const missingFile = await store.assetPath(missingVersion)
  await rm(missingFile)

  const secondOutput = path.join(store.root, 'cached-second.mp4')
  await assert.rejects(
    renderEpisode(store, store.snapshot.episodes[0], secondOutput, {
      signal,
      project: store.snapshot,
      cacheDir,
    }),
    /镜头 2 · 素材文件不存在/,
  )
})
