const assert = require('node:assert/strict')
const { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { folderNameSchema, totalFrames, timecode } = require('../dist/shared/model')
const { ProjectStore } = require('../dist/main/storage')
const { RecentProjects } = require('../dist/main/recent-projects')
const { exportDestination, subtitleText } = require('../dist/main/render')
const { mediaResponse, rangeFor } = require('../dist/main/media-protocol')

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), '项目 测试-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('Windows 名称校验保留中文、内嵌空格与 Unicode 代理对', () => {
  for (const title of ['漫剧 一', '第 1 集', '海港 🌊']) assert.equal(folderNameSchema.parse(title), title)
  for (const title of ['../漫剧', 'C:作品', 'COM1.文件', 'NUL', '漫剧.', '坏\u0008名', 'x\\y', '场景 | 港口']) {
    assert.equal(folderNameSchema.safeParse(title).success, false, title)
  }
})

test('并行编辑串行提交，打开迁移目录后保留 30 帧时基及排序', async context => {
  const root = await workspace(context)
  const store = await ProjectStore.create(root, '漫剧 一')
  const projectFile = path.join(store.root, 'project.json')
  await assert.rejects(ProjectStore.create(root, '漫剧 一'), { code: 'EEXIST' })
  const episodeId = (await store.edit({ type: 'episode.add', title: '第一集' })).episodes[0].id
  await Promise.all(['一', '二', '三', '四'].map(title => store.edit({ type: 'shot.add', episodeId, title })))
  const first = store.snapshot.episodes[0].shots[0]
  await assert.rejects(store.edit({ type: 'shot.move', episodeId, shotId: first.id, direction: -1 }), /顺序/)
  await store.edit({ type: 'shot.move', episodeId, shotId: first.id, direction: 1 })
  const persisted = JSON.parse(await readFile(projectFile, 'utf8'))
  const moved = path.join(root, '新位置')
  await rename(store.root, moved)
  const loaded = await ProjectStore.open(moved)
  assert.deepEqual(loaded.snapshot, persisted)
  assert.deepEqual(loaded.snapshot.episodes[0].shots.map(shot => shot.title), ['二', '一', '三', '四'])
  assert.equal(totalFrames(loaded.snapshot.episodes[0]), 900)
  assert.equal(timecode(225, true), '00:07:15')
})

test('两个存储实例同时编辑时只提交一次，重开后可以继续保存', async context => {
  const root = await workspace(context)
  const first = await ProjectStore.create(root, '共享作品')
  const second = await ProjectStore.open(first.root)
  const edits = ['甲集', '乙集']
  const results = await Promise.allSettled([first, second].map((store, index) => store.edit({ type: 'episode.add', title: edits[index] })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.findIndex(result => result.status === 'rejected')
  assert.match(results[rejected].reason.message, /磁盘上的作品已变更/)
  const reopened = await ProjectStore.open(first.root)
  assert.deepEqual(reopened.snapshot.episodes.map(episode => episode.title), [edits[1 - rejected]])
  await reopened.edit({ type: 'episode.add', title: edits[rejected] })
  assert.equal(reopened.snapshot.episodes.length, 2)
  assert.deepEqual((await readdir(first.root)).sort(), ['media', 'project.json'])
})

test('最近作品和素材目录可在重启后恢复，找不到目录时回到有效位置', async context => {
  const root = await workspace(context)
  const project = await ProjectStore.create(root, '示例 项目', true)
  const media = await mkdtemp(path.join(root, '素材 目录'))
  const first = await RecentProjects.open(root)
  await first.remember({ directory: project.root, title: project.snapshot.title, fictional: true })
  await first.rememberMedia(path.join(media, '示例.mp4'))
  const reopened = await RecentProjects.open(root)
  assert.deepEqual(reopened.entries, first.entries)
  assert.equal(await reopened.defaultDirectory('project'), path.dirname(project.root))
  assert.equal(await reopened.defaultDirectory('media', project.root), media)
  await rename(media, media + '-moved')
  assert.equal(await reopened.defaultDirectory('media', project.root), project.root)
})

test('素材复制、活动版本切换、错误格式拒绝、迁移后素材可读', async context => {
  const root = await workspace(context)
  const store = await ProjectStore.create(root, '素材 项目')
  const episodeId = (await store.edit({ type: 'episode.add', title: '第一集' })).episodes[0].id
  const shotId = (await store.edit({ type: 'shot.add', episodeId, title: '一' })).episodes[0].shots[0].id
  const target = { scope: 'shot', episodeId, shotId, kind: 'image' }
  const fake = path.join(root, '伪造.png')
  await writeFile(fake, 'fake png')
  await assert.rejects(store.importMedia(target, fake))
  await store.importMedia(target, path.resolve('resources/sample/01.jpg'))
  const second = await store.importMedia(target, path.resolve('resources/sample/02.jpg'))
  const track = second.episodes[0].shots[0].media.image
  assert.equal(track.activeId, track.versions[1].id)
  await store.edit({ type: 'media.activate', target, versionId: track.versions[0].id })
  const moved = path.join(root, '新 项目')
  await rename(store.root, moved)
  const migrated = await ProjectStore.open(moved)
  const active = migrated.snapshot.episodes[0].shots[0].media.image
  assert.equal(active.activeId, track.versions[0].id)
  assert.deepEqual(await readFile(await migrated.assetPath(active.versions[0])), await readFile('resources/sample/01.jpg'))
})

test('安全导出目标、字幕标记、单段 HTTP Range', async context => {
  const root = await workspace(context)
  const project = await ProjectStore.create(root, '作品')
  const target = path.join(project.root, '成片 一.mp4')
  assert.equal(await exportDestination(target, project.root), target)
  await assert.rejects(exportDestination(path.join(project.root, 'media', '视频.mp4'), project.root), /媒体目录/)
  await assert.rejects(exportDestination(path.join(project.root, '成片.mkv'), project.root), /mp4/)
  if (process.platform !== 'win32') {
    const link = path.join(root, '链接.mp4')
    await writeFile(target, 'keep')
    await symlink(target, link)
    await assert.rejects(exportDestination(link, project.root), /普通文件/)
  }
  assert.equal(subtitleText('中文{\\b1}\n下一行'), '中文｛＼b1｝\\N下一行')
  assert.deepEqual(rangeFor('bytes=0-4', 20), { start: 0, end: 4 })
  assert.deepEqual(rangeFor('bytes=-3', 20), { start: 17, end: 19 })
  assert.deepEqual(rangeFor('bytes=9-', 20), { start: 9, end: 19 })
  assert.equal(rangeFor('bytes=22-', 20), null)
  assert.equal(rangeFor('bytes=1-5,8-10', 20), null)
})

test('ProjectStore.findVersion 索引随提交与重开保持一致', async context => {
  const root = await workspace(context)
  const store = await ProjectStore.create(root, '索引作品')
  const episodeId = (await store.edit({ type: 'episode.add', title: '第 1 集' })).episodes[0].id
  const shotId = (await store.edit({ type: 'shot.add', episodeId, title: '镜头 1' })).episodes[0].shots[0].id
  const charId = (await store.edit({ type: 'reference.add', category: 'characters', title: '主角' })).characters[0].id
  await store.importMedia({ scope: 'shot', episodeId, shotId, kind: 'image' }, path.resolve('resources/sample/01.jpg'))
  const afterRef = await store.importMedia({ scope: 'reference', category: 'characters', referenceId: charId }, path.resolve('resources/sample/02.jpg'))
  const shotVersion = afterRef.episodes[0].shots[0].media.image.versions[0]
  const refVersion = afterRef.characters[0].image.versions[0]

  const foundShot = store.findVersion(shotVersion.id)
  assert.deepEqual(foundShot, shotVersion)
  assert.deepEqual(store.findVersion(refVersion.id), refVersion)
  assert.equal(store.findVersion('00000000-0000-4000-8000-000000000000'), undefined)

  foundShot.name = 'mutated'
  assert.equal(store.findVersion(shotVersion.id).name, shotVersion.name)

  await store.edit({ type: 'episode.remove', episodeId })
  assert.equal(store.findVersion(shotVersion.id), undefined)
  assert.deepEqual(store.findVersion(refVersion.id), refVersion)

  const reopened = await ProjectStore.open(store.root)
  assert.equal(reopened.findVersion(shotVersion.id), undefined)
  assert.deepEqual(reopened.findVersion(refVersion.id), refVersion)
})

test('mediaResponse 默认 no-store 并支持自定义 immutable Cache-Control', async () => {
  const sampleFile = path.resolve('resources/sample/01.jpg')
  const defaultRes = await mediaResponse(new Request('manju-media://preview/k/v'), sampleFile, 'mp4')
  assert.equal(defaultRes.status, 200)
  assert.equal(defaultRes.headers.get('Cache-Control'), 'no-store')
  await defaultRes.body?.cancel()

  const cachedRes = await mediaResponse(
    new Request('manju-media://project/k/v'),
    sampleFile,
    'jpg',
    { cacheControl: 'private, max-age=3600, immutable' },
  )
  assert.equal(cachedRes.status, 200)
  assert.equal(cachedRes.headers.get('Content-Type'), 'image/jpeg')
  assert.equal(cachedRes.headers.get('Cache-Control'), 'private, max-age=3600, immutable')
  await cachedRes.body?.cancel()

  const rangeRes = await mediaResponse(
    new Request('manju-media://project/k/v', { headers: { Range: 'bytes=0-3' } }),
    sampleFile,
    'jpg',
    { cacheControl: 'private, max-age=3600, immutable' },
  )
  assert.equal(rangeRes.status, 206)
  assert.equal(rangeRes.headers.get('Cache-Control'), 'private, max-age=3600, immutable')
  await rangeRes.body?.cancel()
})

test('RecentProjects 并发保存串行化、标题更新与路径去重', async context => {
  const root = await workspace(context)
  const recent = await RecentProjects.open(root)
  const dirs = Array.from({ length: 6 }, (_, index) => path.join(root, `作品-${index}`))
  await Promise.all([
    ...dirs.map((directory, index) => recent.remember({ directory, title: `标题 ${index}`, fictional: index % 2 === 0 })),
    recent.rememberMedia(path.join(root, '素材目录', 'a.jpg')),
  ])

  assert.equal(recent.entries.length, 5)
  assert.equal(recent.entries[0].directory, dirs[5])

  const reopened = await RecentProjects.open(root)
  assert.deepEqual(reopened.entries, recent.entries)

  const firstId = reopened.entries[0].id
  await reopened.remember({ directory: dirs[5], title: '新标题 5', fictional: false })
  assert.equal(reopened.entries[0].id, firstId)
  assert.equal(reopened.entries[0].title, '新标题 5')
  assert.equal(reopened.entries.filter(item => item.directory === dirs[5]).length, 1)

  if (process.platform === 'win32') {
    const toggled = dirs[5].toUpperCase() === dirs[5] ? dirs[5].toLowerCase() : dirs[5].toUpperCase()
    await reopened.remember({ directory: toggled, title: '大小写去重', fictional: false })
    assert.equal(reopened.entries[0].id, firstId)
    assert.equal(reopened.entries[0].title, '大小写去重')
    assert.equal(reopened.entries.filter(item => item.directory.toLowerCase() === dirs[5].toLowerCase()).length, 1)
  }

  const persisted = await RecentProjects.open(root)
  assert.deepEqual(persisted.entries, reopened.entries)
})

test('shot.duplicate 克隆镜头内容、清空媒体轨、去除 needsUpdate 并紧邻插入', async context => {
  const root = await workspace(context)
  const store = await ProjectStore.create(root, '复制镜头作品')
  const episodeId = (await store.edit({ type: 'episode.add', title: '第一集' })).episodes[0].id
  await store.edit({ type: 'shot.add', episodeId, title: '镜头一' })
  const shot2 = (await store.edit({ type: 'shot.add', episodeId, title: '镜头二' })).episodes[0].shots[1]
  const shot1Id = store.snapshot.episodes[0].shots[0].id

  await store.edit({
    type: 'shot.detail',
    episodeId,
    shotId: shot1Id,
    kind: 'image',
    action: { type: 'save', body: '海港夜景提示词' },
  })
  await store.edit({
    type: 'shot.edit',
    episodeId,
    shotId: shot1Id,
    fields: {
      title: '镜头一',
      frames: 150,
      dialogue: '今晚出发',
      prompt: '旧提示词',
      videoPrompt: '推镜头',
      method: 'flow-only',
      status: '已通过',
    },
  })
  await store.edit({ type: 'shot.omit-media', episodeId, shotId: shot1Id, kind: 'audio', omitted: true })
  await store.importMedia({ scope: 'shot', episodeId, shotId: shot1Id, kind: 'image' }, path.resolve('resources/sample/01.jpg'))
  assert.equal(store.snapshot.episodes[0].shots[0].details.image.needsUpdate, true)

  const afterDup = await store.edit({ type: 'shot.duplicate', episodeId, shotId: shot1Id })
  const shots = afterDup.episodes[0].shots
  assert.equal(shots.length, 3)
  assert.equal(shots[0].id, shot1Id)
  assert.equal(shots[2].id, shot2.id)

  const dup = shots[1]
  assert.notEqual(dup.id, shot1Id)
  assert.equal(dup.title, '镜头一 副本')
  assert.equal(dup.frames, 150)
  assert.equal(dup.dialogue, '今晚出发')
  assert.equal(dup.prompt, '旧提示词')
  assert.equal(dup.videoPrompt, '推镜头')
  assert.equal(dup.method, 'flow-only')
  assert.equal(dup.status, '待制作')
  assert.deepEqual(dup.omittedMedia, { audio: true })
  assert.deepEqual(dup.details, { image: { body: '海港夜景提示词', source: 'manual' } })
  assert.deepEqual(dup.media, {
    image: { activeId: null, versions: [] },
    video: { activeId: null, versions: [] },
    audio: { activeId: null, versions: [] },
  })
  assert.equal(shots[0].media.image.versions.length, 1)

  const longTitle = '甲'.repeat(100)
  await store.edit({
    type: 'shot.edit',
    episodeId,
    shotId: shot1Id,
    fields: { title: longTitle, frames: 150, dialogue: '', prompt: '', status: '待制作' },
  })
  const afterLongDup = await store.edit({ type: 'shot.duplicate', episodeId, shotId: shot1Id })
  const longDup = afterLongDup.episodes[0].shots[1]
  assert.ok(longDup.title.length <= 100)
  assert.ok(longDup.title.endsWith(' 副本'))
})

test('media.remove 切换活动版本、删空置 null 并同步清理磁盘文件', async context => {
  const root = await workspace(context)
  const store = await ProjectStore.create(root, '删除版本作品')
  const episodeId = (await store.edit({ type: 'episode.add', title: '第一集' })).episodes[0].id
  const shotId = (await store.edit({ type: 'shot.add', episodeId, title: '镜头一' })).episodes[0].shots[0].id
  const target = { scope: 'shot', episodeId, shotId, kind: 'image' }

  await store.importMedia(target, path.resolve('resources/sample/01.jpg'))
  const afterSecond = await store.importMedia(target, path.resolve('resources/sample/02.jpg'))
  const [v1, v2] = afterSecond.episodes[0].shots[0].media.image.versions
  const file1 = path.join(store.root, 'media', `${v1.id}.${v1.extension}`)
  const file2 = path.join(store.root, 'media', `${v2.id}.${v2.extension}`)
  assert.ok((await lstat(file1)).isFile())
  assert.ok((await lstat(file2)).isFile())

  const afterRemoveActive = await store.edit({ type: 'media.remove', target, versionId: v2.id })
  const trackAfterFirstRemove = afterRemoveActive.episodes[0].shots[0].media.image
  assert.deepEqual(trackAfterFirstRemove.versions.map(v => v.id), [v1.id])
  assert.equal(trackAfterFirstRemove.activeId, v1.id)
  assert.equal(store.findVersion(v2.id), undefined)
  await assert.rejects(lstat(file2), { code: 'ENOENT' })
  assert.ok((await lstat(file1)).isFile())

  const afterRemoveLast = await store.edit({ type: 'media.remove', target, versionId: v1.id })
  const trackEmpty = afterRemoveLast.episodes[0].shots[0].media.image
  assert.equal(trackEmpty.versions.length, 0)
  assert.equal(trackEmpty.activeId, null)
  await assert.rejects(lstat(file1), { code: 'ENOENT' })
  await assert.rejects(store.edit({ type: 'media.remove', target, versionId: v1.id }), /素材版本不存在/)
})

test('inspectOrphanMedia 与 cleanOrphanMedia 只清理未引用普通文件并保留在用与隐藏文件', async context => {
  const root = await workspace(context)
  const store = await ProjectStore.create(root, '孤儿素材作品')
  const episodeId = (await store.edit({ type: 'episode.add', title: '第一集' })).episodes[0].id
  const shotId = (await store.edit({ type: 'shot.add', episodeId, title: '镜头一' })).episodes[0].shots[0].id
  const afterImport = await store.importMedia(
    { scope: 'shot', episodeId, shotId, kind: 'image' },
    path.resolve('resources/sample/01.jpg'),
  )
  const activeVersion = afterImport.episodes[0].shots[0].media.image.versions[0]
  const mediaDir = path.join(store.root, 'media')
  const activeFile = path.join(mediaDir, `${activeVersion.id}.${activeVersion.extension}`)
  const orphanA = path.join(mediaDir, 'orphan-a.png')
  const orphanB = path.join(mediaDir, 'orphan-b.mp4')
  const hiddenFile = path.join(mediaDir, '.keep')
  const subDir = path.join(mediaDir, 'nested')

  await writeFile(orphanA, '1234567890ab')
  await writeFile(orphanB, '12345678')
  await writeFile(hiddenFile, 'secret')
  await mkdir(subDir)

  assert.deepEqual(await store.inspectOrphanMedia(), { count: 2, bytes: 20 })
  assert.ok((await lstat(orphanA)).isFile())
  assert.ok((await lstat(orphanB)).isFile())

  assert.deepEqual(await store.cleanOrphanMedia(), { count: 2, bytes: 20 })
  assert.deepEqual(await store.inspectOrphanMedia(), { count: 0, bytes: 0 })
  await assert.rejects(lstat(orphanA), { code: 'ENOENT' })
  await assert.rejects(lstat(orphanB), { code: 'ENOENT' })
  assert.ok((await lstat(activeFile)).isFile())
  assert.ok((await lstat(hiddenFile)).isFile())
  assert.ok((await lstat(subDir)).isDirectory())
})

test('RecentProjects 支持 theme 与 windowBounds 持久化', async context => {
  const root = await workspace(context)
  const prefs = await RecentProjects.open(root)
  assert.equal(prefs.theme, undefined)
  assert.equal(prefs.windowBounds, undefined)

  const bounds = { width: 1280, height: 800, x: 120, y: 80, maximized: true }
  await Promise.all([
    prefs.setTheme('dark'),
    prefs.setWindowBounds(bounds),
  ])

  const reopened = await RecentProjects.open(root)
  assert.equal(reopened.theme, 'dark')
  assert.deepEqual(reopened.windowBounds, bounds)

  const updatedBounds = { width: 1100, height: 720, x: 40, y: 60, maximized: false }
  await Promise.all([
    reopened.setTheme('light'),
    reopened.setWindowBounds(updatedBounds),
  ])

  const persisted = await RecentProjects.open(root)
  assert.equal(persisted.theme, 'light')
  assert.deepEqual(persisted.windowBounds, updatedBounds)
})
