const path = require('node:path')
const { readFile, writeFile } = require('node:fs/promises')
const { ProjectStore } = require('../dist/main/storage')

async function legacyFixture(parent) {
  const store = await ProjectStore.create(parent, '虚构格式 1 作品', true)
  const [{ id: episodeId }] = (await store.edit({ type: 'episode.add', title: '观测记录' })).episodes
  const [{ id: shotId }] = (await store.edit({ type: 'shot.add', episodeId, title: '港口' })).episodes[0].shots
  const target = { scope: 'shot', episodeId, shotId, kind: 'image' }
  for (const name of ['01.jpg', '02.jpg']) {
    await store.importMedia(target, path.resolve(__dirname, '../resources/sample', name))
  }
  const root = store.root
  const snapshot = { ...store.snapshot, schemaVersion: 1 }
  const file = path.join(root, 'project.json')
  await writeFile(file, JSON.stringify(snapshot, null, 2) + '\n')
  const media = path.join(root, 'media')
  const orphan = '未引用 素材.txt'
  await writeFile(path.join(media, orphan), '示例 / 虚构')
  const names = [orphan, ...snapshot.episodes[0].shots[0].media.image.versions.map(item => `${item.id}.${item.extension}`)]
  const bytes = await readFile(file)
  const mediaBytes = await Promise.all(names.map(name => readFile(path.join(media, name))))
  return { root, file, snapshot, target, names, bytes, mediaBytes }
}
module.exports = { legacyFixture }
