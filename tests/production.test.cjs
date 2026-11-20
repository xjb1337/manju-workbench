const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { emptyTrack, kinds, projectSchema, shotMedia } = require('../dist/shared/model')
const {
  detailGenerationKind, detailKindSchema, externalDetailKey, generationDetailKind, generationKindSchema, methodSchema,
} = require('../dist/shared/creative')
const { externalMethod, magpiePlanSchema, storedMethod } = require('../dist/shared/plan')
const { productionProgress, productionSteps, exportInputsChanged } = require('../dist/shared/production')
const { ProjectStore } = require('../dist/main/storage')

const date = '2026-11-18T00:00:00.000Z'
const emptyProject = () => ({
  id: randomUUID(), schemaVersion: 1, title: '虚构作品', fictional: true, script: '', episodes: [], characters: [], scenes: [],
})
const episode = () => ({ id: randomUUID(), title: '第 1 集', script: '', shots: [] })
const shot = () => ({
  id: randomUUID(), title: '灯塔', frames: 225, dialogue: '', prompt: '', status: '待制作',
  media: { image: emptyTrack(), video: emptyTrack(), audio: emptyTrack() },
})
const reference = () => ({ id: randomUUID(), title: '参考', notes: '', image: emptyTrack() })

function media(track, extension) {
  const id = randomUUID()
  track.versions.push({ id, extension, name: `虚构素材.${extension}`, createdAt: date, ...(extension !== 'jpg' && { seconds: 1 }) })
  track.activeId = id
  return id
}

test('空项目七步均待完成，无镜头时素材步骤不会完成', () => {
  const project = emptyProject()
  const progress = productionProgress(project)
  assert.deepEqual(Object.keys(progress.statuses), productionSteps.map(step => step.id))
  assert.deepEqual(Object.values(progress.statuses), Array(7).fill('incomplete'))
  assert.equal(progress.recommended, 'script')
  assert.deepEqual(progress.missingReferences, ['characters', 'scenes'])
  assert.deepEqual(progress.media.image.items, [])
})

test('集数剧本、参考条目和无台词分镜独立判定部分完成', () => {
  const project = emptyProject()
  const first = episode()
  project.episodes.push(first)
  project.script = '  \n'
  first.script = '守夜人点亮灯塔。'
  project.characters.push(reference())
  first.shots.push(shot(), shot())
  media(first.shots[0].media.image, 'jpg')
  const progress = productionProgress(project, first.id)
  assert.deepEqual(progress.statuses, {
    script: 'complete', references: 'partial', shots: 'complete', image: 'partial', video: 'incomplete', audio: 'incomplete', export: 'incomplete',
  })
  assert.equal(progress.recommended, 'references')
  assert.deepEqual(progress.missingReferences, ['scenes'])
  assert.deepEqual(progress.media.image.items.map(item => item.state), ['ready', 'missing'])
  assert.equal(progress.dialogueCount, 0)
})

test('生图、视频提示词就绪及打开网页或复制均不计入素材状态', () => {
  const project = emptyProject()
  const first = episode()
  project.episodes.push(first)
  first.shots.push({ ...shot(), prompt: '灯塔远景', videoPrompt: '镜头缓推' })
  const before = productionProgress(project, first.id)
  // These events are external to production data and cannot stand in for media.
  const withToolEvents = { ...project, openedUrls: ['https://chatgpt.com/', 'https://labs.google/fx/tools/flow'], copied: ['灯塔远景', '镜头缓推'] }
  assert.deepEqual(productionProgress(withToolEvents, first.id), before)
  assert.equal(before.statuses.image, 'incomplete')
  assert.equal(before.statuses.video, 'incomplete')
})

test('旧版 JSON 素材齐备仍需真实导出，原有素材、台词和提示词完整保留', () => {
  const project = emptyProject()
  const first = episode()
  project.script = '作品剧本'
  project.characters.push(reference())
  project.scenes.push(reference())
  project.episodes.push(first)
  const entry = { ...shot(), dialogue: '海风来了。', prompt: '港湾，暮色' }
  first.shots.push(entry)
  for (const [index, extension] of ['jpg', 'mp4', 'wav'].entries()) media(entry.media[kinds[index]], extension)
  const loaded = projectSchema.parse(JSON.parse(JSON.stringify(project)))
  assert.deepEqual(loaded, project)
  const progress = productionProgress(loaded, first.id)
  assert.deepEqual(Object.values(progress.statuses), [...Array(6).fill('complete'), 'incomplete'])
  assert.equal(progress.recommended, 'export')
  assert.equal(progress.dialogueCount, 1)
})

test('跳过生图、跳过视频和静默逐镜生效，保留版本和字幕', () => {
  const project = emptyProject()
  const first = episode()
  const entry = { ...shot(), dialogue: '静默字幕', omittedMedia: { image: true, video: true, audio: true } }
  media(entry.media.video, 'mp4')
  media(entry.media.audio, 'wav')
  project.episodes.push(first)
  first.shots.push(entry)
  const progress = productionProgress(projectSchema.parse(project), first.id)
  for (const kind of kinds) {
    assert.equal(progress.statuses[kind], 'complete')
    assert.equal(progress.media[kind].items[0].state, 'omitted')
    assert.equal(progress.media[kind].omitted, 1)
    assert.equal(shotMedia(entry, kind), undefined)
  }
  assert.equal(entry.media.video.versions.length, 1)
  assert.equal(progress.dialogueCount, 1)
})

test('无声成片不算配音就绪，过期成片和原声仍需检查', () => {
  const project = emptyProject()
  const first = episode()
  const entry = { ...shot(), method: 'code' }
  project.episodes.push(first)
  first.shots.push(entry)
  media(entry.media.video, 'mp4')
  const [video] = entry.media.video.versions
  video.hasAudio = false
  assert.equal(productionProgress(project, first.id).statuses.audio, 'incomplete')
  video.hasAudio = true
  assert.equal(productionProgress(project, first.id).statuses.audio, 'complete')
  video.needsUpdate = true
  assert.equal(productionProgress(project, first.id).statuses.finished, 'stale')
  assert.equal(productionProgress(project, first.id).statuses.audio, 'stale')
  entry.omittedMedia = { audio: true }
  assert.equal(productionProgress(project, first.id).statuses.audio, 'complete')
})

test('成片输入只跟踪镜头顺序、时长、台词、活动素材和实际静默/跳过', () => {
  const first = episode()
  first.shots.push(shot(), shot())
  media(first.shots[0].media.audio, 'wav')
  for (const edit of [
    next => next.shots.reverse(),
    next => next.shots[0].frames++,
    next => { next.shots[0].dialogue = '台词' },
    next => { media(next.shots[0].media.video, 'mp4') },
    next => { next.shots[0].omittedMedia = { audio: true } },
  ]) {
    const changed = structuredClone(first)
    edit(changed)
    assert.equal(exportInputsChanged(first, changed), true)
  }
  const editorial = structuredClone(first)
  Object.assign(editorial.shots[0], { prompt: '提示词', status: '已通过', omittedMedia: { image: true } })
  assert.equal(exportInputsChanged(first, editorial), false)
})

test('主进程保存的 A 集导出不会影响 B 集，修改素材后过期并持久化', async context => {
  const folder = await mkdtemp(path.join(tmpdir(), '制作 步骤-'))
  context.after(() => rm(folder, { recursive: true, force: true }))
  const store = await ProjectStore.create(folder, '虚构验收')
  const first = (await store.edit({ type: 'episode.add', title: '第 A 集' })).episodes[0].id
  const second = (await store.edit({ type: 'episode.add', title: '第 B 集' })).episodes[1].id
  const episodeId = first
  const shotId = (await store.edit({ type: 'shot.add', episodeId, title: '灯塔' })).episodes[0].shots[0].id
  const target = { scope: 'shot', episodeId, shotId, kind: 'image' }
  await store.edit({ type: 'shot.omit-media', episodeId, shotId, kind: 'image', omitted: true })
  await store.importMedia(target, path.resolve('resources/sample/01.jpg'))
  const initial = store.snapshot.episodes[0].shots[0]
  assert.equal(initial.omittedMedia, undefined)
  const exported = await store.recordExport(store.snapshot.episodes[0])
  assert.equal(productionProgress(exported, first).statuses.export, 'complete')
  assert.equal(productionProgress(exported, second).statuses.export, 'incomplete')
  const changed = await store.importMedia(target, path.resolve('resources/sample/02.jpg'))
  assert.equal(productionProgress(changed, first).statuses.export, 'stale')
  await assert.rejects(store.recordExport(exported.episodes[0]), /成片内容已变更/)
  const old = await store.edit({ type: 'media.activate', target, versionId: initial.media.image.activeId })
  assert.equal(productionProgress(old, first).statuses.export, 'stale')
  assert.equal(old.episodes[0].exportRecord.exportedAt, exported.episodes[0].exportRecord.exportedAt)
  assert.deepEqual((await ProjectStore.open(store.root)).snapshot, JSON.parse(JSON.stringify(old)))
  const exportedAgain = await store.recordExport(old.episodes[0])
  assert.equal(productionProgress(exportedAgain, first).statuses.export, 'complete')
})

test('共享领域映射收敛内部 flow 与外部 video/规划命名边界并保持往返兼容', () => {
  assert.deepEqual(
    detailKindSchema.options.map(kind => [kind, externalDetailKey(kind)]),
    [['image', 'image'], ['flow', 'video'], ['code', 'code'], ['voice', 'voice']],
  )

  assert.equal(generationDetailKind('image'), 'image')
  assert.equal(generationDetailKind('video'), 'flow')
  assert.equal(generationDetailKind('unknown'), undefined)

  assert.equal(detailGenerationKind('image'), 'image')
  assert.equal(detailGenerationKind('flow'), 'video')
  assert.equal(detailGenerationKind('code'), undefined)
  assert.equal(detailGenerationKind('voice'), undefined)
  assert.equal(detailGenerationKind('unknown'), undefined)

  for (const kind of generationKindSchema.options) {
    assert.equal(detailGenerationKind(generationDetailKind(kind)), kind)
  }
  for (const kind of ['image', 'flow']) {
    assert.equal(generationDetailKind(detailGenerationKind(kind)), kind)
  }

  assert.deepEqual(
    methodSchema.options.map(method => [method, externalMethod(method)]),
    [['flow', 'image-video'], ['image', 'image'], ['flow-only', 'video-only'], ['code', 'code'], ['imported', 'imported']],
  )
  for (const method of methodSchema.options) {
    const external = externalMethod(method)
    assert.equal(storedMethod(external), method)
    assert.equal(externalMethod(storedMethod(external)), external)
  }

  assert.equal(magpiePlanSchema.safeParse({
    schemaVersion: 1,
    episode: {
      shots: [{
        title: '边界检查',
        frames: 30,
        method: externalMethod('flow'),
        details: { [externalDetailKey('flow')]: '视频提示词' },
      }],
    },
  }).success, true)
  assert.equal(magpiePlanSchema.safeParse({
    schemaVersion: 1,
    episode: { shots: [{ title: '旧键直传', frames: 30, method: 'flow' }] },
  }).success, false)
  assert.equal(magpiePlanSchema.safeParse({
    schemaVersion: 1,
    episode: { shots: [{ title: '旧详情直传', frames: 30, details: { flow: '视频提示词' } }] },
  }).success, false)
})
