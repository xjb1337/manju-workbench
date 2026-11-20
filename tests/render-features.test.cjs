const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtemp, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { ProjectStore, ProjectConflictError } = require('../dist/main/storage')
const { renderEpisode, validateRenderedMedia } = require('../dist/main/render')

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

function sampledLuma(file) {
  const raw = ffmpeg('-i', file, '-an', '-vf', "select='eq(n,0)+eq(n,14)+eq(n,29)',scale=48:48,format=gray",
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-')
  const area = 48 * 48
  assert.equal(raw.length, area * 3)
  return [0, 1, 2].map(index => raw.subarray(index * area, (index + 1) * area))
}

for (const [ratio, width, height] of [['16:9', 1280, 720], ['9:16', 720, 1280]]) {
  test(`静图运动 ${ratio} 覆盖画幅并平稳移动，切换模式重编缓存`, async context => {
    const { store, root, episodeId } = await fixture(context, [30])
    if (ratio === '9:16') await store.edit({ type: 'project.brief', workType: 'story', brief: { ratio } })
    const shot = store.snapshot.episodes[0].shots[0]
    const image = path.join(root, '虚构灰阶图.png')
    ffmpeg('-f', 'lavfi', '-i', "nullsrc=s=320x320,geq=lum='60+110*X/W+35*Y/H':cb=128:cr=128",
      '-frames:v', '1', '-threads', '1', image)
    await store.importMedia({ scope: 'shot', episodeId, shotId: shot.id, kind: 'image' }, image)
    const cacheDir = await mkdtemp(path.join(root, 'cache-'))
    const destination = path.join(root, '运动.mp4')
    const episode = () => store.snapshot.episodes[0]
    const render = () => renderEpisode(store, episode(), destination, { signal: new AbortController().signal, cacheDir })
    assert.equal(episode().shots[0].motion, undefined)
    await render()
    const unchanged = await readFile(destination)
    const staticFrames = sampledLuma(destination)
    assert.ok(staticFrames.every(frame => frame[0] < 12), '默认仍使用原有静图适配')

    const editMotion = motion => {
      const shot = episode().shots[0]
      return store.edit({ type: 'shot.edit', episodeId, shotId: shot.id, fields: { ...shot, motion } })
    }
    await editMotion('off')
    await render()
    assert.deepEqual(await readFile(destination), unchanged)
    assert.equal((await readdir(cacheDir)).length, 1)
    await store.recordExport(episode())

    for (const [index, motion] of ['zoom-in', 'zoom-out', 'pan'].entries()) {
      await editMotion(motion)
      assert.equal(episode().exportRecord.stale, true)
      await render()
      assert.equal((await readdir(cacheDir)).length, index + 2)
      const [stream] = streamInfo(destination)
      assert.deepEqual([stream.width, stream.height, stream.nb_frames], [width, height, '30'])
      const frames = sampledLuma(destination)
      assert.ok(frames.every(frame => [0, 47, 48 * 47, 48 * 48 - 1].every(corner => frame[corner] > 35)), '运动期间全画幅无黑边')
      const samples = frames.map(frame => frame[4 * 48 + 4])
      const [start, middle, end] = motion === 'zoom-out' ? samples.toReversed() : samples
      assert.ok(start < middle && middle < end && end - start >= 5, `${motion} 亮度位移 ${samples}`)
    }

    await render()
    assert.equal((await readdir(cacheDir)).length, 4, '相同运动复用镜头缓存')
    if (ratio === '16:9') {
      const video = path.join(root, '虚构固定视频.mp4')
      ffmpeg('-f', 'lavfi', '-i', 'color=orange:s=320x180:r=30:d=1', '-c:v', 'libx264', '-threads', '2', video)
      await store.importMedia({ scope: 'shot', episodeId, shotId: shot.id, kind: 'video' }, video)
      await render()
      const original = await readFile(destination)
      await store.recordExport(episode())
      await editMotion('zoom-out')
      await render()
      assert.equal(episode().exportRecord.stale, false)
      assert.equal((await readdir(cacheDir)).length, 5)
      assert.deepEqual(await readFile(destination), original)
    }
  })
}

test('格式 1 升级副本不写入旧镜头运动，字段缺失时保持关闭', async context => {
  const { store, root } = await fixture(context, [1])
  const project = store.snapshot
  const file = path.join(store.root, 'project.json')
  await writeFile(file, JSON.stringify({ ...project, schemaVersion: 1 }))
  const legacy = await ProjectStore.open(store.root)
  const upgraded = await legacy.upgradeCopy(async () => true)
  assert.equal(upgraded.snapshot.schemaVersion, 2)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 1)
  for (const version of [legacy, upgraded]) {
    const episode = version.snapshot.episodes[0]
    assert.equal(episode.shots[0].motion, undefined)
    await renderEpisode(version, episode, path.join(root, `格式 ${version.snapshot.schemaVersion}.mp4`),
      { signal: new AbortController().signal })
  }
  assert.deepEqual(await readFile(path.join(root, '格式 1.mp4')), await readFile(path.join(root, '格式 2.mp4')))
})

test('成片检查读取实际渲染输入，区分回退、静默、过密、过期与阻断，并复核确认', async context => {
  const { store, root, episodeId } = await fixture(context, [30, 1, 60, 30, 30, 30])
  const { inspectEpisode, preflightAllows } = require('../dist/main/preflight')
  const shots = store.snapshot.episodes[0].shots
  const target = (index, kind) => ({ scope: 'shot', episodeId, shotId: shots[index].id, kind })
  const edit = (index, fields) => store.edit({
    type: 'shot.edit', episodeId, shotId: shots[index].id, fields: { ...shots[index], ...fields },
  })
  const omit = (index, kind) => store.edit({
    type: 'shot.omit-media', episodeId, shotId: shots[index].id, kind, omitted: true,
  })
  const sample = path.resolve('resources/sample/01.jpg')
  await store.importMedia(target(0, 'image'), sample)
  await store.importMedia(target(1, 'image'), sample)
  await store.importMedia(target(2, 'image'), sample)
  await store.importMedia(target(1, 'audio'), tone(root, 550, 0.3))
  const finished = path.join(root, '虚构带原声.mp4')
  ffmpeg('-f', 'lavfi', '-i', 'color=orange:s=320x180:r=30:d=0.6',
    '-f', 'lavfi', '-i', 'sine=duration=0.6:sample_rate=48000', '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', finished)
  await edit(0, { dialogue: '需要配音' })
  await edit(1, { dialogue: '字幕太密', method: 'image' })
  await edit(2, { dialogue: '有视频原声', method: 'imported' })
  await store.importMedia(target(2, 'video'), finished)
  await edit(3, { dialogue: '有意静音' })
  await omit(1, 'audio')
  for (const kind of ['video', 'image', 'audio']) await omit(3, kind)
  await edit(5, { dialogue: '虚构一行\n'.repeat(10), frames: 1 })
  const projectFile = path.join(store.root, 'project.json')
  const document = store.snapshot
  const original = document.episodes[0].shots
  original[0].media.image.versions[0].needsUpdate = true
  delete original[2].media.video.versions[0].hasAudio
  await writeFile(projectFile, JSON.stringify(document))
  await rm(await store.assetPath(original[1].media.audio.versions[0]))
  await rm(await store.assetPath(original[2].media.image.versions[0]))
  let opened = await ProjectStore.open(store.root)
  const check = () => {
    const project = opened.snapshot
    return inspectEpisode(opened, project, project.episodes[0], new AbortController().signal)
  }
  const initial = await check()
  assert.deepEqual(initial.issues.map(issue => [issue.shot.index, issue.code, issue.target, issue.severity]), [
    [0, 'still', 'video', 'warning'], [0, 'stale', 'image', 'warning'], [0, 'no-voice', 'audio', 'warning'],
    [1, 'dense', 'dialogue', 'warning'],
    [3, 'black', 'video', 'warning'], [4, 'missing-visual', 'video', 'warning'],
    [5, 'missing-visual', 'video', 'warning'], [5, 'no-voice', 'audio', 'warning'], [5, 'subtitle-overflow', 'dialogue', 'error'],
  ])
  assert.equal(preflightAllows(initial, initial.review), false)
  document.episodes[0].shots.pop()
  await writeFile(projectFile, JSON.stringify(document))
  await assert.rejects(check(), ProjectConflictError)
  opened = await ProjectStore.open(store.root)
  const warning = await check()
  assert.equal(preflightAllows(warning), false)
  assert.equal(preflightAllows(warning, warning.review), true)
  const visible = await opened.assetPath(original[0].media.image.versions[0])
  await rename(visible, visible + '.removed')
  const missing = await check()
  assert.equal(preflightAllows(missing, warning.review), false)
  assert.ok(missing.issues.some(issue => issue.code === 'missing-file' && issue.shot.id === shots[0].id))
  await writeFile(visible, '虚构坏图')
  assert.ok((await check()).issues.some(issue => issue.code === 'unreadable' && issue.target === 'image'))
  await rm(visible)
  await rename(visible + '.removed', visible)
  const music = (await opened.importMedia({ scope: 'music', episodeId }, tone(root, 240, 0.5))).episodes[0].music
  await rm(await opened.assetPath(music.version))
  assert.ok((await check()).issues.some(issue => issue.code === 'missing-file' && issue.target === 'music' && issue.severity === 'error'))
  await opened.edit({ type: 'music.edit', episodeId, settings: { ...music, enabled: false } })
  assert.equal((await check()).issues.some(issue => issue.target === 'music'), false)
})

test('反相立体声配音仍压低背景音乐，AAC 短音频可循环且保持非整数秒画面', async context => {
  const { store, root, episodeId } = await fixture(context, [1, 29, 16])
  const shot = store.snapshot.episodes[0].shots[1]
  const voice = path.join(root, '虚构反相配音.wav')
  ffmpeg('-i', tone(root, 900, 0.45), '-af', 'pan=stereo|c0=c0|c1=-1*c0', voice)
  const music = path.join(root, '虚构 AAC 音乐.m4a')
  ffmpeg('-i', tone(root, 400, 0.25), '-c:a', 'aac', music)
  await store.importMedia({ scope: 'shot', episodeId, shotId: shot.id, kind: 'audio' }, voice)
  await store.importMedia({ scope: 'music', episodeId }, music)
  await store.edit({ type: 'music.edit', episodeId, settings: { enabled: true, volume: 0.6 } })
  const output = path.join(root, '非整数秒.mp4')
  await renderEpisode(store, store.snapshot.episodes[0], output, { signal: new AbortController().signal })
  const [video, audio] = streamInfo(output)
  assert.equal(video.nb_frames, '46')
  assert.ok(Math.abs(Number(video.duration) - 46 / 30) < 0.001)
  assert.ok(Math.abs(Number(audio.duration) - 46 / 30) < 0.002)
  const left = ffmpeg('-i', output, '-map', '0:a:0', '-af', 'pan=mono|c0=FL', '-f', 'f32le', '-')
  assert.ok(amplitude(left, 900, 0.2) > 0.06)
  const recovered = amplitude(left, 400, 1.30)
  const ducked = amplitude(left, 400, 0.2)
  assert.ok(recovered > 0.03 && ducked < recovered * 0.35, `反相配音压低音乐 ${ducked} / ${recovered}`)
  assert.ok(amplitude(left, 400, 1.40) > 0.03, '音乐保留到时间线尾部')
})

test('无配乐成片同样校验视频总帧数，掉帧或增帧时拒绝发布', async context => {
  const validInfo = {
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, nb_frames: '35' },
      { codec_type: 'audio', codec_name: 'aac', duration: '1.166667' },
    ],
    format: { duration: '1.167' },
  }
  validateRenderedMedia(validInfo, 1280, 720, 35, false)
  assert.throws(
    () => validateRenderedMedia({
      ...validInfo,
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, nb_frames: '34' },
        validInfo.streams[1],
      ],
    }, 1280, 720, 35, false),
    /成片的音视频轨或时长校验失败/,
  )

  const { store, root } = await fixture(context, [15, 20])
  const output = path.join(root, '无配乐成片.mp4')
  await renderEpisode(store, store.snapshot.episodes[0], output, { signal: new AbortController().signal })
  const [video] = streamInfo(output)
  assert.equal(video.nb_frames, '35')
})
