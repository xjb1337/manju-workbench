const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { copyFile, mkdir, mkdtemp, readFile, rename, stat, writeFile, readdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const repository = path.resolve(__dirname, '..')
const run = path.resolve(process.env.MANJU_RUN_DIR ?? path.join(tmpdir(), 'manju-workbench'))
const screenshots = path.join(run, 'screenshots')
const shotPlan = [
  ['雾港远眺', 7.5, '雾散之前，港口的灯不会熄灭。', '紫蓝色海面，港口远景与灯塔剪影。', '已通过', 330],
  ['一封来信', 8, '信封上没有地址，只有一枚旧邮戳。', '旧信封近景，桌面暖光与蜡封。', '待审核', 440],
  ['塔灯亮起', 7, '塔灯划过海面，像有人在远处回应。', '仰拍灯塔，暖色光束掠过暮雾。', '待制作', 550],
  ['潮声回响', 7.5, '天亮后，我们在码头见。', '黎明码头远景，水面粉色倒影。', '待制作', 660],
]
const starts = [0, 7.5, 15.5, 22.5]

function command(executable, args, options = {}) {
  return execFileSync(executable, args, { maxBuffer: 16 * 1024 * 1024, ...options })
}

function ffmpeg(...args) {
  return command('ffmpeg', ['-nostdin', '-v', 'error', ...args])
}

async function fixtureFiles(folder) {
  const files = []
  for (const [index, shot] of shotPlan.entries()) {
    const image = path.join(folder, `参考 图 ${index + 1}.jpg`)
    const video = path.join(folder, `镜头 视频 ${index + 1}.mp4`)
    const audio = path.join(folder, `手工 配音 ${index + 1}.wav`)
    await copyFile(path.join(repository, 'resources', 'sample', `0${index + 1}.jpg`), image)
    ffmpeg('-i', image, '-vf', "zoompan=z='1+on/1500':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=39:s=960x540:fps=30",
      '-an', '-threads', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video)
    ffmpeg('-f', 'lavfi', '-i', `sine=frequency=${shot[5]}:sample_rate=48000:duration=1.15`, '-c:a', 'pcm_s16le', audio)
    files.push({ image, video, audio })
  }
  const replacement = path.join(folder, '镜头 二 替换版本.mp4')
  ffmpeg('-i', files[1].video, '-vf', 'hue=h=48', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', replacement)
  return { files, replacement }
}

async function launch(profile) {
  const app = await electron.launch({ executablePath: require('electron'), args: [repository, `--user-data-dir=${profile}`], timeout: 20_000 })
  app.process().stderr.on('data', data => {
    const message = data.toString().trim()
    if (message.includes('project:import') || message.includes('episode:render') || message.includes('project:create')) console.error(message)
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => console.error('Renderer error:', error))
  await app.evaluate(({ dialog, shell }) => {
    globalThis.openChoices = []
    globalThis.saveChoices = []
    globalThis.openedUrls = []
    dialog.showOpenDialog = async () => {
      if (!globalThis.openChoices.length) throw new Error('Unexpected open dialog')
      const file = globalThis.openChoices.shift()
      return { canceled: !file, filePaths: file ? [file] : [] }
    }
    dialog.showSaveDialog = async () => {
      if (!globalThis.saveChoices.length) throw new Error('Unexpected save dialog')
      const file = globalThis.saveChoices.shift()
      return { canceled: !file, filePath: file ?? undefined }
    }
    shell.openExternal = async url => { globalThis.openedUrls.push(url) }
    dialog.showMessageBoxSync = () => 1
  })
  return { app, page }
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const choose = (app, file, type = 'openChoices') => app.evaluate((_electron, { file, type }) => {
  globalThis[type].push(file)
}, { file, type })
const documentAt = file => readFile(file, 'utf8').then(JSON.parse)
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const screenshot = (page, name) => page.screenshot({ path: path.join(screenshots, name), animations: 'disabled' })
const footerSaved = async page => {
  await page.locator('footer').getByText('已保存', { exact: true }).waitFor()
  assert.equal(await page.getByRole('alert').count(), 0)
}

async function named(page, initiator, title, confirm = '新建') {
  await button(page, initiator).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称').fill(title)
  await button(dialog, confirm).click()
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
  await footerSaved(page)
}

async function addAsset(app, page, label, input) {
  await choose(app, input)
  await button(page, `导入${label}`).last().click()
  await page.getByLabel(`${label}活动版本`).waitFor({ timeout: 20_000 })
  await footerSaved(page)
}

function toneAmplitude(wav, at, frequency, duration = .4) {
  let sine = 0
  let cosine = 0
  const rate = 48_000
  const count = Math.floor(rate * duration)
  for (let i = 0; i < count; i++) {
    const sample = wav.readInt16LE((Math.floor(at * rate) + i) * 2)
    const angle = i * frequency * 2 * Math.PI / rate
    sine += sample * Math.sin(angle)
    cosine += sample * Math.cos(angle)
  }
  return Math.round(2 * Math.hypot(sine, cosine) / count)
}

async function verifyMedia(destination, folder, inputs) {
  const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', destination]).toString())
  const [video, audio] = probe.streams
  assert.equal(probe.streams.length, 2)
  assert.equal(video.codec_name, 'h264')
  assert.equal(audio.codec_name, 'aac')
  assert.equal(video.width, 1280)
  assert.equal(video.height, 720)
  assert.equal(video.avg_frame_rate, '30/1')
  assert.equal(video.nb_frames, '900')
  assert.equal(Number(video.start_time), 0)
  assert.equal(Number(audio.start_time), 0)
  assert.ok(Math.abs(Number(probe.format.duration) - 30) < .05)
  await writeFile(path.join(folder, 'ffprobe.json'), JSON.stringify(probe, null, 2))
  await Promise.all([0, 1, 2, 3].map(async index => {
    ffmpeg('-ss', String(starts[index] + .5), '-i', destination, '-frames:v', '1', path.join(folder, `硬字幕-镜头-${index + 1}.png`))
  }))

  const layout = 'scale=32:18,format=rgb24'
  for (const [index, start] of starts.entries()) {
    const expected = index === 1 ? inputs.replacement : inputs.files[index].video
    const capture = (file, offset) => ffmpeg('-ss', String(offset), '-i', file, '-frames:v', '1', '-an', '-vf', layout, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-')
    const actualFrame = capture(destination, start + 0.5)
    const inputFrame = capture(expected, 0.5)
    let delta = 0
    const upper = 32 * 13 * 3 // Ignore baked captions at the bottom.
    for (let i = 0; i < upper; i++) delta += Math.abs(actualFrame[i] - inputFrame[i])
    assert.ok(delta / upper < 12, `画面镜头 ${index + 1} 平均差值 ${delta / upper}`)
    if (index === 1) {
      const originalFrame = capture(inputs.files[index].video, 0.5)
      let oldDelta = 0
      for (let i = 0; i < upper; i++) oldDelta += Math.abs(actualFrame[i] - originalFrame[i])
      assert.ok(oldDelta > delta * 2, '成片应使用第二镜的活动替换版本')
    }
    const roi = ffmpeg('-ss', String(start + .5), '-i', destination, '-frames:v', '1', '-vf',
      'crop=900:100:190:575,format=gray', '-pix_fmt', 'gray', '-f', 'rawvideo', '-')
    const white = roi.reduce((count, pixel) => count + (pixel > 230 ? 1 : 0), 0)
    assert.ok(white > 160, `镜头 ${index + 1} 缺少亮字幕笔画`)
  }

  const wav = ffmpeg('-i', destination, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-')
  const audioMeasurements = starts.map((start, index) => {
    const frequency = shotPlan[index][5]
    const tone = toneAmplitude(wav, start + .10, frequency)
    const silent = toneAmplitude(wav, start + 1.4, frequency)
    const preBoundary = index ? toneAmplitude(wav, start - .4, frequency, .25) : null
    assert.ok(tone > 1800 && silent < 15 && (preBoundary === null || preBoundary < 15), `镜头 ${index + 1} 音调边界错误`)
    return { start, frequency, tone, silent, preBoundary }
  })
  await writeFile(path.join(folder, 'sync.json'), JSON.stringify(audioMeasurements, null, 2))
  console.log('ffprobe', JSON.stringify({
    seconds: probe.format.duration, video: video.codec_name, frames: video.nb_frames, fps: video.avg_frame_rate,
    dimensions: [video.width, video.height], audio: audio.codec_name, rate: audio.sample_rate, channels: audio.channels,
    videoStart: video.start_time, audioStart: audio.start_time, subtitleStreams: 0,
  }))
  console.log('画面顺序、活动替换、四帧硬字幕和镜头起点音调同步通过', audioMeasurements)
}

async function main() {
  await mkdir(screenshots, { recursive: true })
  const verify = path.join(run, 'verification')
  await mkdir(verify, { recursive: true })
  const folder = await mkdtemp(path.join(verify, 'run-'))
  console.log('验收目录', folder)
  const parent = path.join(folder, '项目 测试')
  const project = path.join(parent, '漫剧 一')
  const projectFile = path.join(project, 'project.json')
  const base = path.join(folder, '手工 素材')
  const profile = path.join(folder, 'Electron Profile')
  await mkdir(parent)
  await mkdir(base)
  const inputs = await fixtureFiles(base)
  let desktop = await launch(profile)
  try {
    let { app, page } = desktop
    await page.locator('.welcome-card').waitFor()
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return [prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration, prefs.webSecurity]
    }), [true, true, false, true])
    await screenshot(page, '01-empty-light.png')
    await choose(app, parent)
    await named(page, '创建虚构示例', '雾港来信', '选择保存位置')
    await page.getByText('示例 / 虚构', { exact: true }).waitFor()
    await page.locator('.monitor-body img').evaluate(image => image.decode())
    await screenshot(page, '02-sample-light.png')
    await button(page, '切换深色').click()
    await screenshot(page, '03-sample-dark.png')
    await button(page, '切换浅色').click()
    await button(page, '顺序预览').click()
    await page.locator('video.episode-player').waitFor({ timeout: 45_000 })
    await page.waitForFunction(() => document.querySelector('.episode-player')?.readyState >= 2)
    await button(page, '关闭预览').click()
    await button(page, '关闭作品').click()
    await page.locator('.welcome-card').waitFor()

    await choose(app, parent)
    await named(page, '新建作品', '漫剧 一', '选择保存位置')
    await named(page, '新建集数', '第 1 集')
    for (const [index, [title, seconds, dialogue, prompt, status]] of shotPlan.entries()) {
      await named(page, '新建镜头', title)
      await page.getByLabel('时长（秒）').fill(String(seconds))
      await page.getByLabel('台词', { exact: true }).fill(dialogue)
      await page.getByLabel('提示词', { exact: true }).fill(prompt)
      await page.getByLabel('状态', { exact: true }).selectOption(status)
      await button(page, '保存镜头').click()
      await page.getByText('镜头已保存', { exact: true }).waitFor()
      await footerSaved(page)
      const imported = inputs.files[index]
      await addAsset(app, page, '参考图', imported.image)
      await addAsset(app, page, '视频', imported.video)
      await addAsset(app, page, '配音', imported.audio)
    }
    const before = await documentAt(projectFile)
    await button(page, '镜头 02 一封来信').click()
    await addAsset(app, page, '视频', inputs.replacement)
    const after = await documentAt(projectFile)
    const original = before.episodes[0].shots
    const revised = after.episodes[0].shots
    for (const index of [0, 2, 3]) assert.deepEqual(revised[index], original[index])
    assert.deepEqual(revised[1].media.image, original[1].media.image)
    assert.deepEqual(revised[1].media.audio, original[1].media.audio)
    assert.equal(revised[1].media.video.versions.length, 2)
    const track = revised[1].media.video
    const versionPicker = page.getByLabel('视频活动版本')
    assert.equal(track.activeId, track.versions[1].id)
    await versionPicker.selectOption(track.versions[0].id)
    await footerSaved(page)
    assert.equal((await documentAt(projectFile)).episodes[0].shots[1].media.video.activeId, track.versions[0].id)
    await versionPicker.selectOption(track.versions[1].id)
    await footerSaved(page)
    await screenshot(page, '04-edit-media-versions.png')

    await button(page, '复制提示词').click()
    await page.getByText('提示词已复制', { exact: true }).waitFor()
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), shotPlan[1][3])
    await button(page, 'ChatGPT').click()
    await footerSaved(page)
    await button(page, 'Google Flow').click()
    await footerSaved(page)
    assert.deepEqual(await app.evaluate(() => globalThis.openedUrls), ['https://chatgpt.com/', 'https://labs.google/fx/tools/flow'])

    await button(page, '剧本').click()
    await page.getByLabel('剧本', { exact: true }).fill('海港守夜人收到一封信。')
    await button(page, '保存').click()
    await footerSaved(page)
    await button(page, '集数剧本').click()
    await page.getByLabel('剧本', { exact: true }).fill(shotPlan.map(shot => shot[2]).join('\n'))
    await button(page, '保存').click()
    await footerSaved(page)
    await page.getByRole('button', { name: /^角色参考/ }).click()
    await named(page, '新建参考', '守夜人')
    await page.getByLabel('备注').fill('深色外套')
    await button(page, '保存').click()
    await footerSaved(page)
    await addAsset(app, page, '参考图', inputs.files[1].image)
    await page.getByRole('button', { name: /^场景参考/ }).click()
    await named(page, '新建参考', '港口灯塔')
    await addAsset(app, page, '参考图', inputs.files[2].image)
    await screenshot(page, '05-scene-reference.png')
    const saved = await documentAt(projectFile)
    assert.equal(saved.script, '海港守夜人收到一封信。')
    assert.equal(saved.episodes[0].script, shotPlan.map(shot => shot[2]).join('\n'))
    assert.equal(saved.characters[0].notes, '深色外套')
    assert.equal(saved.scenes[0].title, '港口灯塔')
    for (const shot of saved.episodes[0].shots) {
      for (const asset of Object.values(shot.media)) {
        for (const version of asset.versions) assert.ok((await stat(path.join(project, 'media', `${version.id}.${version.extension}`))).size > 0)
      }
    }

    await app.close()
    desktop = await launch(profile)
    ;({ app, page } = desktop)
    await choose(app, project)
    await button(page, '打开作品').first().click()
    await page.getByRole('heading', { name: '漫剧 一' }).waitFor()
    await footerSaved(page)
    await button(page, '镜头 02 一封来信').click()
    assert.equal(await page.getByLabel('视频活动版本').inputValue(), track.versions[1].id)
    assert.deepEqual(await documentAt(projectFile), saved)
    await page.locator('.monitor-body img').evaluate(image => image.decode())

    await button(page, '顺序预览').click()
    const player = page.locator('video.episode-player')
    await player.waitFor({ timeout: 45_000 })
    await page.waitForFunction(() => {
      const video = document.querySelector('.episode-player')
      return video && video.readyState >= 2 && video.currentTime > .1
    }, { timeout: 20_000 })
    const media = await player.evaluate(video => ({ duration: video.duration, width: video.videoWidth, height: video.videoHeight }))
    assert.ok(Math.abs(media.duration - 30) < .05)
    assert.deepEqual([media.width, media.height], [1280, 720])
    await player.evaluate(video => { video.currentTime = 8; video.pause() })
    await page.waitForFunction(() => !document.querySelector('.episode-player').seeking)
    await screenshot(page, '06-ordered-preview.png')
    await button(page, '关闭预览').click()

    const destination = path.join(project, '成片 验收.mp4')
    await writeFile(destination, Buffer.from('pre-existing output'))
    await choose(app, destination, 'saveChoices')
    await button(page, '导出 MP4').click()
    await page.getByText(/导出完成/).waitFor({ timeout: 45_000 })
    await verifyMedia(destination, folder, inputs)
    const sha = await hash(destination)

    await choose(app, null, 'saveChoices')
    await button(page, '导出 MP4').click()
    await page.getByText('已取消导出', { exact: true }).waitFor()
    assert.equal(await hash(destination), sha)

    await choose(app, destination, 'saveChoices')
    await button(page, '导出 MP4').click()
    await page.waitForFunction(() => !!document.querySelector('progress') && document.querySelector('progress').value > 0)
    await button(page, '取消导出').click()
    await page.getByText('已取消导出', { exact: true }).waitFor()
    assert.equal(await hash(destination), sha)

    const last = saved.episodes[0].shots.at(-1).media.video.versions[0]
    const missing = path.join(project, 'media', `${last.id}.${last.extension}`)
    await rename(missing, `${missing}.test-backup`)
    try {
      await choose(app, destination, 'saveChoices')
      await button(page, '导出 MP4').click()
      await page.getByRole('alert').filter({ hasText: '镜头 4 · 素材文件不存在' }).waitFor({ timeout: 45_000 })
      assert.equal(await hash(destination), sha)
    } finally {
      await rename(`${missing}.test-backup`, missing)
    }
    assert.ok((await readdir(project)).every(name => !name.startsWith('.manju-render-')))
    await writeFile(path.join(folder, 'acceptance.json'), JSON.stringify({
      project, destination, sha256: sha, restartedElectron: true, replacementStillActive: track.versions[1].id,
      dialogCanceledPreservedHash: true, renderCanceledPreservedHash: true, missingAssetPreservedHash: true,
      temporaryDirectoriesCleaned: true,
    }, null, 2))
    await writeFile(path.join(verify, 'latest-success.txt'), folder + '\n')
    console.log('已有 MP4 保留，取消对话框 / 编码中取消 / 第四镜缺源三条路径 SHA-256 一致：', sha)
    console.log('验收成片', destination)
  } catch (error) {
    console.error('验收中断', error)
    await desktop.page.screenshot({ path: path.join(folder, 'diagnostic-failure.png'), timeout: 3000 }).catch(() => {})
    throw error
  } finally {
    await desktop.app.close().catch(() => {})
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
