const assert = require('node:assert/strict')
const { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { folderNameSchema, totalFrames, timecode } = require('../dist/shared/model')
const { ProjectStore } = require('../dist/main/storage')
const { RecentProjects } = require('../dist/main/recent-projects')
const { exportDestination, subtitleText } = require('../dist/main/render')
const { rangeFor } = require('../dist/main/media-protocol')

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
