const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtemp, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { ProjectStore, ProjectConflictError } = require('../dist/main/storage')
const { renderEpisode } = require('../dist/main/render')

function ffmpeg(...args) {
  return execFileSync('ffmpeg', ['-nostdin', '-v', 'error', ...args])
}

function tone(root, frequency, duration) {
  const file = path.join(root, `虚构音调 ${frequency} ${duration}.wav`)
  ffmpeg('-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}:sample_rate=48000`, file)
  return file
}

async function fixture(context, frames = [30, 36]) {
  const root = await mkdtemp(path.join(tmpdir(), '制作验收-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = await ProjectStore.create(root, '虚构作品', true)
  const episodeId = (await store.edit({ type: 'episode.add', title: '虚构集' })).episodes[0].id
  for (const [index, count] of frames.entries()) {
    const { shots } = (await store.edit({ type: 'shot.add', episodeId, title: `虚构镜头 ${index + 1}` })).episodes[0]
    const shot = shots.at(-1)
    await store.edit({ type: 'shot.edit', episodeId, shotId: shot.id, fields: { ...shot, frames: count } })
  }
  return { root, store, episodeId }
}

function streamInfo(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file])).streams
}

function amplitude(samples, frequency, at, window = 0.10) {
  let sine = 0
  let cosine = 0
  const count = Math.round(48000 * window)
  const start = Math.round(48000 * at)
  for (let i = 0; i < count; i++) {
    const point = samples.readFloatLE((i + start) * 4)
    const phase = 2 * Math.PI * frequency * i / 48000
    sine += point * Math.sin(phase)
    cosine += point * Math.cos(phase)
  }
  return 2 * Math.hypot(sine, cosine) / count
}

test('背景音乐真实混音保留画面帧数，配音压低音乐且原声不断，循环、淡化、裁切生效', async context => {
  const { store, root, episodeId } = await fixture(context)
  const first = store.snapshot.episodes[0].shots[0]
  const second = store.snapshot.episodes[0].shots[1]
  const source = path.join(root, '虚构同期声.mp4')
  ffmpeg('-f', 'lavfi', '-i', 'color=orange:s=320x180:r=30:d=1.2',
    '-f', 'lavfi', '-i', 'sine=frequency=960:duration=1.2:sample_rate=48000',
    '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', source)
  await store.edit({ type: 'shot.edit', episodeId, shotId: second.id, fields: { ...second, method: 'imported' } })
  await store.importMedia({ scope: 'shot', episodeId, shotId: second.id, kind: 'video' }, source)
  await store.importMedia({ scope: 'shot', episodeId, shotId: first.id, kind: 'audio' }, tone(root, 880, 0.6))
  assert.equal(store.snapshot.episodes[0].music, undefined)
  const target = { scope: 'music', episodeId }
  const settings = { enabled: true, volume: 0.55, fadeIn: 0.35, fadeOut: 0.42 }
  await store.importMedia(target, tone(root, 420, 0.25))
  await store.edit({ type: 'music.edit', episodeId, settings })
  const destination = path.join(root, '成片.mp4')
  const render = (signal = new AbortController().signal, progress) =>
    renderEpisode(store, store.snapshot.episodes[0], destination, { signal, progress })
  const { musicHash } = await render()
  const [video, audio] = streamInfo(destination)
  assert.equal(video.nb_frames, '66')
  assert.equal(video.duration, '2.200000')
  assert.equal(audio.duration, '2.200000')
  const decoded = ffmpeg('-i', destination, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-')
  const ducked = amplitude(decoded, 420, 0.45)
  const unducked = amplitude(decoded, 420, 1.50)
  assert.ok(unducked > 0.03, `循环后仍有音乐 ${unducked}`)
  assert.ok(ducked < unducked * 0.35, `配音时压低 ${ducked} / ${unducked}`)
  assert.ok(amplitude(decoded, 880, 0.45) > 0.06, '独立配音仍在')
  assert.ok(amplitude(decoded, 960, 1.50) > 0.06, '视频原声仍在')
  const intro = amplitude(decoded, 420, 0.06, 0.08)
  assert.ok(intro < ducked * 0.5, `起始淡入 ${intro} / ${ducked}`)
  assert.ok(amplitude(decoded, 420, 2.17, 0.02) < unducked * 0.12, '结尾淡出')

  let episode = store.snapshot.episodes[0]
  const old = await store.assetPath(episode.music.version)
  await store.recordExport(episode, undefined, undefined, musicHash)
  assert.equal((await ProjectStore.open(store.root)).snapshot.episodes[0].exportRecord.stale, false)

  await store.importMedia(target, tone(root, 510, 3.10))
  episode = store.snapshot.episodes[0]
  assert.equal(episode.exportRecord.stale, true)
  assert.equal(episode.music.fadeOut, settings.fadeOut)
  await assert.rejects(readFile(old), { code: 'ENOENT' })
  const long = await render()
  assert.deepEqual(streamInfo(destination).map(stream => stream.duration), ['2.200000', '2.200000'])
  await store.recordExport(episode, undefined, undefined, long.musicHash)
  const expected = await readFile(destination)
  const cancel = new AbortController()
  await assert.rejects(render(cancel.signal, () => cancel.abort()), { name: 'AbortError' })
  assert.deepEqual(await readFile(destination), expected)
  const asset = await store.assetPath(episode.music.version)
  await writeFile(asset, '虚构损坏音频')
  assert.equal((await ProjectStore.open(store.root)).snapshot.episodes[0].exportRecord.stale, true)
  await assert.rejects(render(), /ffmpeg 执行失败/)
  assert.deepEqual(await readFile(destination), expected)

  await store.edit({ type: 'music.edit', episodeId, settings: { ...settings, enabled: false } })
  assert.equal(store.snapshot.episodes[0].exportRecord.stale, true)
  await render()
  const muted = ffmpeg('-i', destination, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-')
  assert.ok(amplitude(muted, 960, 1.50) > 0.06)
  assert.ok(amplitude(muted, 510, 1.50) < 0.001)
})

test('背景音乐随作品迁移，纳入素材索引、项目锁和清理凭证', async context => {
  const { root, store, episodeId } = await fixture(context, [])
  const target = { scope: 'music', episodeId }
  const source = tone(root, 350, 0.5)
  const stale = await ProjectStore.open(store.root)
  const preview = await stale.inspectOrphanMedia()
  const { music } = (await store.importMedia(target, source)).episodes[0]
  assert.equal(store.findVersion(music.version.id).extension, 'wav')
  assert.equal((await store.inspectOrphanMedia()).count, 0)
  await assert.rejects(stale.cleanOrphanMedia(preview.token), /重新预览/)
  await assert.rejects(stale.importMedia(target, source), ProjectConflictError)
  assert.equal((await readdir(path.join(store.root, 'media'))).length, 1)
  const moved = path.join(root, '迁移 后')
  await rename(store.root, moved)
  const loaded = await ProjectStore.open(moved)
  assert.deepEqual(loaded.snapshot.episodes[0].music, music)
  assert.deepEqual(await readFile(await loaded.assetPath(music.version)), await readFile(source))
  await loaded.edit({ type: 'music.remove', episodeId })
  assert.equal(loaded.findVersion(music.version.id), undefined)
  assert.deepEqual(await readdir(path.join(moved, 'media')), [])
})
