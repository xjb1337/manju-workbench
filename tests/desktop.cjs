const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { copyFile, mkdir, mkdtemp, readFile, rename, stat, writeFile, readdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')
const { notes: updateNotes, futureVersion, releaseFixture, startUpdateFixture } = require('./update-fixture.cjs')

const version = require('../package.json').version
const toolExamples = {
  image: { name: '示例生图服务', url: 'https://image.example.test/generate' },
  video: { name: '本地视频工具', url: 'http://127.0.0.1:8188/' },
}
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

async function launch(profile, entry = repository, env = process.env) {
  const app = await electron.launch({ executablePath: require('electron'), args: [entry, `--user-data-dir=${profile}`], env, timeout: 20_000 })
  app.process().stderr.on('data', data => {
    const message = data.toString().trim()
    if (message.includes('project:import') || message.includes('episode:render') || message.includes('project:create')) console.error(message)
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => console.error('Renderer error:', error))
  await app.evaluate(({ clipboard, dialog, shell }) => {
    globalThis.openChoices = []
    globalThis.openDefaults = []
    globalThis.saveChoices = []
    globalThis.openedUrls = []
    let copiedText = ''
    clipboard.writeText = text => { copiedText = text }
    clipboard.readText = () => copiedText
    dialog.showOpenDialog = async (_window, options) => {
      if (!globalThis.openChoices.length) throw new Error('Unexpected open dialog')
      globalThis.openDefaults.push(options.defaultPath)
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
const guide = page => page.getByRole('region', { name: '制作步骤', exact: true })
const guideStep = (page, step) => guide(page).locator(`[data-step="${step}"]`)
const stage = page => page.locator('main.stage')
const directory = page => page.getByRole('navigation', { name: '作品目录', exact: true })
const selectStep = (page, step) => guideStep(page, step).click()
const guideStatus = (page, step, text) => guideStep(page, step).locator('.guide-status').getByText(text, { exact: true }).waitFor()
const guideNext = (page, step) => guideStep(page, step).getByText('建议下一步', { exact: true }).waitFor()
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

async function named(page, initiator, title, confirm = '新建', scope = page) {
  await button(scope, initiator).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称').fill(title)
  await button(dialog, confirm).click()
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
  await footerSaved(page)
}

async function addAsset(app, page, label, input, scope = page) {
  await choose(app, input)
  await button(scope, `导入${label}`).last().click()
  await page.getByLabel(`${label}活动版本`).waitFor({ timeout: 20_000 })
  await footerSaved(page)
}

async function verifyMagpieDraft(app, page, file, first) {
  const before = await documentAt(file)
  await app.evaluate((_electron, shotId) => {
    const original = globalThis.fetch
    globalThis.restoreMagpieFetch = () => { globalThis.fetch = original }
    globalThis.magpieRequests = []
    globalThis.magpieMode = 'pending'
    globalThis.fetch = async (url, init) => {
      if (url !== 'http://127.0.0.1:3425/v1/chat/completions') return original(url, init)
      globalThis.magpieRequests.push(JSON.parse(init.body))
      if (globalThis.magpieMode === 'pending') return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
      if (globalThis.magpieMode === 'limited') return new Response(null, { status: 429 })
      const plan = {
        schemaVersion: 1, title: '作品级标题提议',
        episode: { title: '集数标题提议', script: '集数剧本提议', shots: [{ shotId, title: '虚构试验镜头' }] },
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(plan) + '\n```' } }] })
    }
  }, first.id)
  try {
    await button(stage(page), 'AI 生成分镜草案').click()
    const dialog = page.getByRole('dialog', { name: 'AI 生成分镜草案', exact: true })
    const script = '虚构剧本片段：画面出现一束信号。'
    assert.equal(await dialog.getByLabel('Magpie 模型 ID').inputValue(), 'group/never-stuck')
    await dialog.getByLabel('剧本文本').fill(script)
    await button(dialog, '生成草案').click()
    await dialog.getByRole('status').getByText(/正在等待/).waitFor()
    await button(dialog, '停止等待').click()
    await dialog.getByRole('status').getByText('已停止等待').waitFor()
    assert.deepEqual(await documentAt(file), before)

    await app.evaluate(() => { globalThis.magpieMode = 'limited' })
    await button(dialog, '生成草案').click()
    await dialog.getByRole('alert').getByText(/HTTP 429/).waitFor()
    assert.deepEqual(await documentAt(file), before)

    await app.evaluate(() => { globalThis.magpieMode = 'success' })
    await dialog.getByLabel('Magpie 模型 ID').fill('provider/other-text-model')
    await button(dialog, '生成草案').click()
    const preview = page.getByRole('dialog', { name: 'AI 分镜草案预览', exact: true })
    await preview.getByText('虚构试验镜头', { exact: true }).waitFor()
    assert.equal(await preview.locator('.diff-row').count(), 1)
    assert.equal(await preview.getByRole('combobox').inputValue(), 'keep')
    assert.equal(await button(preview, '确认合并').isDisabled(), true)
    assert.deepEqual(await documentAt(file), before)
    await button(preview, '返回编辑').click()
    assert.equal(await dialog.getByLabel('剧本文本').inputValue(), script)
    assert.equal(await dialog.getByLabel('Magpie 模型 ID').inputValue(), 'provider/other-text-model')
    const request = await app.evaluate(() => globalThis.magpieRequests.at(-1))
    assert.equal(request.model, 'provider/other-text-model')
    assert.match(request.messages[0].content, /虚构剧本片段/)
    await button(dialog, '取消').click()
  } finally {
    await app.evaluate(() => globalThis.restoreMagpieFetch())
  }
}

async function verifyAiWorkbenchFlows(app, page, file, first) {
  const before = await documentAt(file)
  await app.evaluate(() => {
    const original = globalThis.fetch
    globalThis.restoreAiFetch = () => { globalThis.fetch = original }
    globalThis.aiRequests = []
    globalThis.fetch = async (url, init) => {
      if (url === 'http://127.0.0.1:11434/v1/models') {
        return Response.json({ data: [{ id: 'qwen2.5:14b' }, { id: 'llama3.2:latest' }] })
      }
      if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
        const body = JSON.parse(init.body)
        globalThis.aiRequests.push(body)
        const promptText = body.messages[0].content
        if (promptText.includes('编写或改写「作品总剧本」')) {
          return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'AI 剧本草案：第一场，观测站脉冲亮起。' } }] })
        }
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'AI 优化提示词：深蓝网格与高对比脉冲波形，30fps。' } }] })
      }
      return original(url, init)
    }
  })
  try {
    await button(page, 'AI 设置').click()
    const settings = page.getByRole('dialog', { name: 'AI 网关设置', exact: true })
    await settings.getByLabel('网关预设').selectOption('ollama')
    assert.equal(await settings.getByLabel('网关地址').inputValue(), 'http://127.0.0.1:11434/v1')
    await button(settings, '测试连接').click()
    await settings.getByRole('status').getByText(/已连接.*2 个模型/).waitFor()
    await settings.getByRole('button', { name: 'llama3.2:latest' }).click()
    assert.equal(await settings.getByLabel('默认模型 ID').inputValue(), 'llama3.2:latest')
    await button(settings, '保存设置').click()
    await settings.waitFor({ state: 'hidden' })

    await button(directory(page), '剧本').click()
    await button(stage(page), 'AI 辅助写剧本').click()
    const scriptAi = page.getByRole('dialog', { name: 'AI 辅助写剧本', exact: true })
    await scriptAi.getByLabel(/编写或改写要求/).fill('补充开场脉冲描述')
    await button(scriptAi, '生成剧本草案').click()
    const scriptPreview = page.getByRole('dialog', { name: 'AI 剧本草案预览', exact: true })
    await scriptPreview.getByText('AI 剧本草案：第一场，观测站脉冲亮起。').waitFor()
    await button(scriptPreview, '应用到编辑器').click()
    await scriptPreview.waitFor({ state: 'hidden' })
    assert.equal(await stage(page).getByLabel('剧本').inputValue(), 'AI 剧本草案：第一场，观测站脉冲亮起。')
    assert.deepEqual(await documentAt(file), before)
    await button(stage(page), 'AI 生成分镜草案').click()
    const seededDialog = page.getByRole('dialog', { name: 'AI 生成分镜草案', exact: true })
    assert.equal(await seededDialog.getByLabel('剧本文本').inputValue(), 'AI 剧本草案：第一场，观测站脉冲亮起。')
    assert.equal(await seededDialog.getByLabel('模型 ID').inputValue(), 'llama3.2:latest')
    await button(seededDialog, '取消').click()

    await button(directory(page), '分镜').click()
    await button(page, '放弃修改').click()
    await selectStep(page, 'shots')
    await guide(page).getByRole('button', { name: 'AI 生成分镜草案' }).waitFor()
    await button(page, `镜头 01 ${first.title}`).click()
    await page.getByRole('button', { name: /代码任务书/ }).click()
    const detail = page.getByRole('dialog', { name: /代码任务书/ })
    await detail.getByLabel('AI 优化要求').fill('强化波形对比度')
    await button(detail, 'AI 优化提示词').click()
    await detail.getByText('AI 优化提示词：深蓝网格与高对比脉冲波形，30fps。').waitFor()
    await button(detail, '放弃建议').click()
    await button(detail, '关闭').click()

    await button(page, 'AI 设置').click()
    const resetSettings = page.getByRole('dialog', { name: 'AI 网关设置', exact: true })
    await resetSettings.getByLabel('网关预设').selectOption('magpie')
    await button(resetSettings, '保存设置').click()
    await resetSettings.waitFor({ state: 'hidden' })
    await button(directory(page), '制作简报').click()
  } finally {
    await app.evaluate(() => globalThis.restoreAiFetch())
  }
}

async function verifyUpdates(folder, project) {
  const fixture = releaseFixture()
  const temp = path.join(folder, '更新临时目录')
  await mkdir(temp)
  const server = await startUpdateFixture()
  let desktop
  try {
    desktop = await launch(path.join(folder, '更新验收配置'), path.join(__dirname, 'desktop-update-entry.cjs'), {
      ...process.env, MANJU_UPDATE_FIXTURE_ORIGIN: server.origin, MANJU_UPDATE_FIXTURE_TEMP: temp,
    })
    const { app, page } = desktop
    const panel = page.getByRole('dialog', { name: '应用更新', exact: true })
    await app.evaluate(({ dialog }) => {
      globalThis.updateConfirmations = 0
      dialog.showMessageBox = async (_window, options) => {
        if (options.title !== '安装更新' || options.defaultId !== 0 || options.cancelId !== 0) throw new Error('Unexpected confirmation')
        globalThis.updateConfirmations++
        return { response: 0 }
      }
    })
    await choose(app, project)
    await button(page, '打开作品').first().click()
    await guide(page).waitFor()
    await button(page, '检查更新').waitFor()
    assert.deepEqual(server.state.requests, [])
    await screenshot(page, 'update-01-entry.png')
    await button(page, '检查更新').click()
    await panel.getByText('暂无发布', { exact: true }).waitFor()
    await panel.getByText(version, { exact: true }).waitFor()
    assert.equal(await button(panel, '下载').count(), 0)
    await screenshot(page, 'update-02-no-release.png')
    await button(panel, '关闭').click()

    Object.assign(server.state, { releases: [fixture.release], paths: fixture.paths, stalledPath: fixture.assetPath })
    async function checkNewVersion() {
      await button(page, '检查更新').click()
      await panel.getByText(`发现新版本 ${futureVersion}`, { exact: true }).waitFor()
      assert.equal(await panel.locator('.update-notes p').textContent(), updateNotes)
      assert.equal(await panel.locator('.update-notes p strong').count(), 0)
      await panel.getByText('应用未签名。SHA-256 仅验证文件完整性，无法证明发布者身份。', { exact: true }).waitFor()
      assert.equal(await button(panel, '下载').isEnabled(), true)
      assert.equal(await button(panel, '安装').isDisabled(), true)
    }
    await checkNewVersion()
    await screenshot(page, 'update-03-available-light.png')
    await button(panel, '关闭').click()
    await button(page, '切换深色').click()
    await checkNewVersion()
    await screenshot(page, 'update-04-available-dark.png')

    await button(panel, '下载').click()
    const progress = panel.getByRole('progressbar', { name: '下载进度' })
    await progress.waitFor()
    await page.waitForFunction(() => document.querySelector('dialog progress')?.value === 25)
    await screenshot(page, 'update-05-progress-dark.png')
    await button(panel, '取消下载').click()
    await panel.getByText('已取消下载', { exact: true }).waitFor()
    assert.deepEqual(await readdir(temp), [])
    assert.equal(await button(panel, '安装').isDisabled(), true)

    server.state.stalledPath = ''
    await button(panel, '下载').click()
    await panel.getByText('已通过完整性校验', { exact: false }).waitFor()
    assert.equal(await button(panel, '安装').isEnabled(), true)
    await screenshot(page, 'update-06-verified-dark.png')
    await button(panel, '安装').click()
    await button(panel, '安装').waitFor()
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('dialog button')).find(button => button.textContent === '安装')?.disabled)
    assert.equal(await app.evaluate(() => globalThis.updateConfirmations), 1)
    assert.deepEqual(await app.evaluate(() => globalThis.updateLaunches), [])
    await button(panel, '关闭').click()

    await button(directory(page), '剧本').click()
    const script = stage(page).locator('form.text-editor textarea')
    const before = await script.inputValue()
    const requests = server.state.requests.length
    await script.fill('虚构验收 · 尚未保存')
    await page.locator('footer').getByText('有未保存修改', { exact: true }).waitFor()
    await button(page, '检查更新').click()
    await button(panel, '安装').click()
    await panel.getByRole('alert').getByText('请先保存修改，再安装更新。', { exact: true }).waitFor()
    await screenshot(page, 'update-07-unsaved-dark.png')
    assert.deepEqual(await page.evaluate(() => window.workbench.installUpdate()), { ok: false, error: '请先保存修改，再安装更新' })
    assert.equal(await app.evaluate(() => globalThis.updateConfirmations), 1)
    assert.deepEqual(await app.evaluate(() => globalThis.updateLaunches), [])
    assert.equal(server.state.requests.length, requests)
    await button(panel, '返回保存').click()
    assert.equal(await script.inputValue(), '虚构验收 · 尚未保存')
    await script.fill(before)
    await footerSaved(page)
    await guide(page).waitFor()
    const [packageDirectory] = await readdir(temp)
    await rename(path.join(temp, packageDirectory, fixture.fileName), path.join(folder, '移走的测试更新包.exe'))
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
    await button(page, '检查更新').click()
    await button(panel, '安装').click()
    await panel.getByRole('alert').getByText('已下载的安装包不存在，请重新下载', { exact: true }).waitFor()
    assert.equal(await button(panel, '安装').isEnabled(), false)
    await button(panel, '下载').click()
    await panel.getByText('已通过完整性校验', { exact: false }).waitFor()
    assert.deepEqual(await app.evaluate(() => globalThis.updateLaunches), [])
    console.log('更新夹具验收通过：无后台检查，暂无发布，发现新版本，纯文本说明，下载取消及校验，安装确认取消，未保存修改保护')
  } catch (error) {
    await desktop?.page.screenshot({ path: path.join(folder, 'diagnostic-update-failure.png'), timeout: 3000 }).catch(() => {})
    throw error
  } finally {
    await desktop?.app.close().catch(() => {})
    await server.close()
  }
}

async function verifyGuideTools(app, page) {
  await selectStep(page, 'image')
  await button(guide(page), '设置生图工具').click()
  const imageName = page.getByLabel('生图工具名称', { exact: true })
  const imageUrl = page.getByLabel('生图工具网址', { exact: true })
  assert.equal(await imageName.evaluate(field => field === document.activeElement), true)
  await button(stage(page), '使用 ChatGPT').click()
  assert.equal(await imageUrl.inputValue(), 'https://chatgpt.com/')
  await imageName.fill(toolExamples.image.name)
  await imageUrl.fill('file:///C:/example.html')
  await button(stage(page), '保存简报').click()
  await page.getByRole('alert').getByText(/请输入完整的 HTTP 或 HTTPS 网址/).waitFor()
  await imageUrl.fill(toolExamples.image.url)
  await page.getByLabel('视频制作工具名称').fill(toolExamples.video.name)
  await button(stage(page), '保存简报').click()
  await footerSaved(page)
  assert.deepEqual(await app.evaluate(() => globalThis.openedUrls), [])
  await selectStep(page, 'video')
  await button(guide(page), '设置视频制作工具').click()
  const videoName = page.getByLabel('视频制作工具名称')
  const videoUrl = page.getByLabel('视频制作工具网址')
  assert.equal(await videoName.evaluate(field => field === document.activeElement), true)
  assert.equal(await videoName.inputValue(), toolExamples.video.name)
  assert.equal(await videoUrl.inputValue(), '')
  assert.deepEqual(await app.evaluate(() => globalThis.openedUrls), [])
  await videoUrl.fill(toolExamples.video.url)
  await button(stage(page), '保存简报').click()
  await footerSaved(page)
  await screenshot(page, 'generation-tools.png')
  await selectStep(page, 'image')
  await button(guide(page), '编辑提示词').click()
  assert.equal(await page.locator('#shot-prompt').evaluate(field => field === document.activeElement), true)
  await button(guide(page), '复制生图提示词').click()
  await page.getByText('提示词已复制', { exact: true }).waitFor()
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), shotPlan[0][3])
  await button(guide(page), `打开 ${toolExamples.image.name}`).click()
  await footerSaved(page)
  await guideStatus(page, 'image', '待完成')

  await selectStep(page, 'video')
  assert.equal(await button(guide(page), '复制视频提示词').isDisabled(), true)
  await button(guide(page), '编辑提示词').click()
  const prompt = page.getByLabel('视频提示词', { exact: true })
  assert.equal(await prompt.evaluate(field => field === document.activeElement), true)
  await prompt.fill('镜头缓慢推进，保持灯塔在画面中。')
  await button(page, '保存镜头').click()
  await footerSaved(page)
  await button(guide(page), '复制视频提示词').click()
  await page.getByText('提示词已复制', { exact: true }).waitFor()
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '镜头缓慢推进，保持灯塔在画面中。')
  await button(guide(page), `打开 ${toolExamples.video.name}`).click()
  await footerSaved(page)
  await guideStatus(page, 'video', '待完成')
  assert.deepEqual(await app.evaluate(() => globalThis.openedUrls), [toolExamples.image.url, toolExamples.video.url])
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

async function verifyCreative(folder, parent, profile) {
  let desktop = await launch(profile)
  try {
    let { app, page } = desktop
    await choose(app, parent)
    await named(page, '创建竖屏代码示例', '观测站信号', '选择保存位置')
    const project = path.join(parent, '观测站信号')
    const file = path.join(project, 'project.json')
    await page.getByText('示例 / 虚构', { exact: true }).waitFor()
    const initial = await documentAt(file)
    const episode = initial.episodes[0]
    const [first, second] = episode.shots
    assert.equal(initial.fictional, true)
    assert.equal(initial.workType, 'code')
    assert.deepEqual(await guide(page).locator('[data-step]').evaluateAll(steps => steps.map(step => step.dataset.step)),
      ['script', 'shots', 'code', 'finished', 'audio', 'export'])
    await guideStatus(page, 'code', '已完成')
    await guideStatus(page, 'finished', '已完成')

    await selectStep(page, 'finished')
    const source = path.join(folder, '手工导入 竖屏成片.mp4')
    const version = first.media.video.versions[0]
    await copyFile(path.join(project, 'media', `${version.id}.${version.extension}`), source)
    await choose(app, source)
    await button(guide(page), '导入成片').click()
    await page.getByLabel('视频活动版本').locator('option').getByText(/手工导入 竖屏成片/).waitFor({ state: 'attached' })
    await footerSaved(page)

    await selectStep(page, 'code')
    await button(guide(page), '编辑代码任务书').click()
    let task = page.getByRole('dialog', { name: /代码任务书/ })
    const body = dialog => dialog.getByLabel('提示词正文')
    const manual = '手改：沿网格底线依次点亮矩形，强调第一个虚构脉冲。'
    const generated = await body(task).inputValue()
    await task.getByText('9:16 · 720 × 1280 · 30 fps', { exact: true }).waitFor()
    await body(task).fill(`${generated}\n\n${manual}`)
    await button(task, '保存提示词').click()
    await task.getByRole('status').getByText('已保存').waitFor()
    const manualBody = await body(task).inputValue()
    await button(task, '关闭').click()

    await button(directory(page), '制作简报').click()
    await page.getByLabel('作品类型').selectOption('mixed')
    await page.getByLabel('主题').fill('虚构观测站的节拍与信号')
    await page.getByLabel('受众').fill('动态图形入门观众')
    await page.getByLabel('风格', { exact: true }).fill('深蓝网格、青绿脉冲、细线图表')
    await page.getByLabel('术语表').fill('脉冲：观测值的短时升高。')
    await page.getByLabel('目标时长（秒）').fill('6.250')
    await page.getByLabel('画面比例').selectOption('16:9')
    await page.getByLabel('画面比例').selectOption('9:16')
    await button(stage(page), '保存简报').click()
    await footerSaved(page)
    await screenshot(page, 'creative-01-brief-light.png')
    await button(page, '切换深色').click()
    await screenshot(page, 'creative-02-brief-dark.png')
    await button(page, '切换浅色').click()

    await button(stage(page), '总规划提示词').click()
    const planner = page.getByRole('dialog', { name: '总规划提示词', exact: true })
    await button(planner, '复制总规划提示词').click()
    await planner.getByRole('status').getByText('已复制').waitFor()
    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
    const total = await clipboard()
    assert.match(total, /UTF-8 JSON/)
    assert.match(total, /"画布": "720×1280"/)
    assert.match(total, /"目标时长秒": 6.25/)
    assert.match(total, /示例 \/ 虚构/)
    assert.ok(total.includes(first.id))
    await screenshot(page, 'creative-03-planning-prompt.png')
    await button(planner, '关闭').click()
    await verifyMagpieDraft(app, page, file, first)
    await verifyAiWorkbenchFlows(app, page, file, first)

    const before = await documentAt(file)
    await button(stage(page), '导入外部规划').click()
    const paste = page.getByRole('dialog', { name: '导入外部规划', exact: true })
    await paste.getByLabel('规划 JSON').fill('{"schemaVersion": 1}')
    await button(paste, '预览差异').click()
    await paste.getByRole('alert').getByText(/规划格式错误/).waitFor()
    assert.deepEqual(await documentAt(file), before)
    await paste.getByLabel('规划 JSON').fill(JSON.stringify({
      schemaVersion: 1,
      title: '虚构观测站的信号',
      script: '虚构观测员按照节拍记录两组脉冲。',
      outline: '示例 / 虚构。第一组脉冲出现，随后两组信号交替。',
      assets: ['信号网格：由本地代码绘制'], missing: [],
      episode: {
        title: '观测记录',
        script: '第一束信号亮起，第二束错开半拍。',
        shots: [
          { shotId: first.id, details: { code: '规划建议：用蓝白波形替换所有矩形。' } },
          { shotId: second.id, method: 'imported', dialogue: '两组虚构脉冲交替出现。' },
        ],
      },
    }))
    await button(paste, '预览差异').click()
    const preview = page.getByRole('dialog', { name: '规划导入预览', exact: true })
    await preview.waitFor()
    const codeConflict = preview.getByRole('combobox', { name: /代码任务书处理方式/ })
    assert.equal(await codeConflict.inputValue(), 'keep')
    await preview.getByRole('combobox', { name: /^集数.*标题处理方式$/ }).selectOption('update')
    await preview.getByRole('combobox', { name: /双脉冲.*制作方式处理方式$/ }).selectOption('update')
    assert.deepEqual(await documentAt(file), before)
    await preview.locator('.plan-diff').evaluate(diff => { diff.scrollTop = 0 })
    await screenshot(page, 'creative-04-plan-diff.png')
    await button(preview, '确认合并').click()
    await preview.waitFor({ state: 'hidden' })
    await footerSaved(page)
    const merged = await documentAt(file)
    assert.equal(merged.title, before.title)
    assert.equal(merged.episodes[0].title, '观测记录')
    assert.equal(merged.episodes[0].shots[1].method, 'imported')
    assert.equal(merged.episodes[0].shots[0].details.code.body, manualBody)
    assert.equal(merged.episodes[0].shots[0].details.code.needsUpdate, true)
    assert.deepEqual(merged.episodes[0].shots[0].media, before.episodes[0].shots[0].media)
    assert.equal(merged.episodes[0].shots[0].media.video.versions.length, 2)
    await stage(page).getByRole('region', { name: '规划成果' }).waitFor()

    await selectStep(page, 'code')
    await guideStatus(page, 'code', '需更新')
    await button(guide(page), '编辑代码任务书').click()
    task = page.getByRole('dialog', { name: /代码任务书/ })
    await task.getByText('需更新', { exact: true }).waitFor()
    await button(task, '按设定重新生成提示词').click()
    await task.getByText('重新生成会替换本条提示词正文。').waitFor()
    assert.equal(await body(task).inputValue(), manualBody)
    await button(task, '继续编辑').click()
    await button(task, '保留手改').click()
    await task.getByRole('status').getByText('已保留').waitFor()
    assert.equal(await body(task).inputValue(), manualBody)
    await button(task, '复制代码任务书').click()
    await task.getByRole('status').getByText('已复制').waitFor()
    const copied = await clipboard()
    assert.match(copied, /作品共享设定[\s\S]*720×1280[\s\S]*观测值的短时升高/)
    assert.ok(copied.endsWith(manualBody))
    await screenshot(page, 'creative-05-code-task.png')
    await button(task, '关闭').click()
    await guideStatus(page, 'code', '已完成')
    await guideStatus(page, 'finished', '需更新')
    for (const [index, savedShot] of merged.episodes[0].shots.entries()) {
      await button(page, `镜头 0${index + 1} ${savedShot.title}`).click()
      await button(page, '保留此版本 · 视频').click()
      await footerSaved(page)
    }
    await guideStatus(page, 'finished', '已完成')
    await button(page, `镜头 01 ${first.title}`).click()

    const monitorVideo = page.locator('.monitor-body video')
    await monitorVideo.waitFor()
    await monitorVideo.evaluate(video => { video.currentTime = 1.7 })
    await page.waitForFunction(() => document.querySelector('.monitor-body video')?.readyState >= 2
      && !document.querySelector('.monitor-body video').seeking)
    assert.equal(await page.locator('.monitor').getAttribute('data-ratio'), '9:16')
    const direction = await page.locator('.monitor-body').boundingBox()
    assert.ok(Math.abs(direction.width / direction.height - 9 / 16) < .02)
    const thumbnail = await page.locator('.clip-image').first().boundingBox()
    assert.ok(thumbnail.height > thumbnail.width)
    await screenshot(page, 'creative-06-portrait-timeline.png')

    await app.close()
    desktop = await launch(profile)
    ;({ app, page } = desktop)
    await choose(app, project)
    await button(page, '打开作品').first().click()
    await page.getByRole('heading', { name: '观测站信号', exact: true }).waitFor()
    await button(directory(page), '制作简报').click()
    assert.equal(await page.getByLabel('作品类型').inputValue(), 'mixed')
    assert.equal(await page.getByLabel('画面比例').inputValue(), '9:16')
    assert.equal(await page.getByLabel('目标时长（秒）').inputValue(), '6.25')
    assert.equal(await page.getByLabel('主题').inputValue(), '虚构观测站的节拍与信号')
    await selectStep(page, 'code')
    await button(guide(page), '编辑代码任务书').click()
    task = page.getByRole('dialog', { name: /代码任务书/ })
    assert.equal(await body(task).inputValue(), manualBody)
    await button(task, '关闭').click()

    await button(stage(page), '顺序预览').click()
    const player = page.locator('video.episode-player')
    await player.waitFor({ timeout: 45_000 })
    await page.waitForFunction(() => document.querySelector('.episode-player')?.readyState >= 2)
    const videoBox = await player.boundingBox()
    const controlBox = await page.getByRole('group', { name: '预览播放控制' }).boundingBox()
    assert.ok(videoBox.y + videoBox.height <= controlBox.y)
    const measured = await player.evaluate(video => {
      video.currentTime = 1.7
      video.pause()
      return [video.videoWidth, video.videoHeight, video.duration]
    })
    assert.deepEqual(measured.slice(0, 2), [720, 1280])
    assert.ok(Math.abs(measured[2] - 6) < .08)
    await page.waitForFunction(() => !document.querySelector('.episode-player').seeking)
    await screenshot(page, 'creative-07-portrait-preview.png')
    await button(page, '关闭预览').click()

    const destination = path.join(project, '观测站 竖屏成片.mp4')
    await selectStep(page, 'export')
    await choose(app, destination, 'saveChoices')
    await button(guide(page), '导出 MP4').click()
    await page.getByText(/导出完成/).waitFor({ timeout: 45_000 })
    await guideStatus(page, 'export', '已完成')
    assert.match(await stage(page).locator('.export-size').textContent(), /720 × 1280/)
    await screenshot(page, 'creative-08-portrait-export.png')
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', destination]))
    const [video, audio] = probe.streams
    assert.deepEqual([video.width, video.height, video.avg_frame_rate, video.nb_frames], [720, 1280, '30/1', '180'])
    assert.equal(video.codec_name, 'h264')
    assert.equal(audio.codec_name, 'aac')
    const frame = ffmpeg('-ss', '1', '-i', destination, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-')
    assert.equal(frame.length, 720 * 1280)
    assert.ok(frame.subarray(720 * 1100, 720 * 1230).some(value => value > 225), '竖屏底部安全区应保留硬字幕')
    const pcm = ffmpeg('-i', destination, '-vn', '-ac', '1', '-f', 's16le', '-')
    assert.ok(toneAmplitude(pcm, .3, 220) > 500, '整段导入的成片应保留其自带音频')
    assert.ok(toneAmplitude(pcm, 3, 330) > 500, '混合方式中的仅导入成片应保留原声')
    await writeFile(path.join(folder, 'ffprobe-portrait.json'), JSON.stringify(probe, null, 2))
    const exportHash = await hash(destination)

    await button(directory(page), '制作简报').click()
    await page.getByLabel('画面比例').selectOption('16:9')
    await button(stage(page), '保存简报').click()
    await footerSaved(page)
    await guideStatus(page, 'export', '已过期')
    assert.equal(await hash(destination), exportHash)
    await selectStep(page, 'code')
    await button(guide(page), '编辑代码任务书').click()
    task = page.getByRole('dialog', { name: /代码任务书/ })
    assert.equal(await body(task).inputValue(), manualBody)
    await button(task, '按设定重新生成提示词').click()
    await button(task, '确认替换').click()
    await task.getByRole('status').getByText('已重新生成').waitFor()
    await task.getByText('16:9 · 1280 × 720 · 30 fps', { exact: true }).waitFor()
    assert.match(await body(task).inputValue(), /按作品共享设定中的画布尺寸/)
    assert.doesNotMatch(await body(task).inputValue(), /手改：/)
    await button(task, '关闭').click()

    // Keep the final acceptance project at its original portrait specification.
    await button(directory(page), '制作简报').click()
    await page.getByLabel('画面比例').selectOption('9:16')
    await button(stage(page), '保存简报').click()
    await footerSaved(page)
    await selectStep(page, 'export')
    await choose(app, destination, 'saveChoices')
    await button(guide(page), '导出 MP4').click()
    await page.getByText(/导出完成/).waitFor({ timeout: 45_000 })
    await guideStatus(page, 'export', '已完成')
    console.log('竖屏验收成片', destination, '720 × 1280 / 180 帧')
    return { project, destination, ffprobe: path.join(folder, 'ffprobe-portrait.json') }
  } finally {
    await desktop.app.close().catch(() => {})
  }
}

async function verifyLegacyUpgrade(folder) {
  const { legacyFixture } = require('./legacy-fixture.cjs')
  const parent = path.join(folder, '格式升级夹具')
  await mkdir(parent)
  const fixture = await legacyFixture(parent)
  const { app, page } = await launch(path.join(folder, '格式升级 Electron Profile'))
  try {
    await choose(app, fixture.root)
    await button(page, '打开作品').click()
    await page.locator('footer').getByText('格式 1', { exact: true }).waitFor()
    await button(directory(page), '制作简报').click()
    await page.getByLabel('主题').fill('虚构升级验收')
    await button(page, '总规划提示词').click()
    const dialog = page.getByRole('dialog', { name: '升级格式 1 作品' })
    await dialog.getByText(/旧版无法打开升级后的格式 2/).waitFor()
    await screenshot(page, 'feature-format-1-upgrade-confirmation.png')
    await button(dialog, '取消').click()
    await dialog.waitFor({ state: 'hidden' })
    await page.locator('footer').getByText('有未保存修改', { exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.deepEqual(await readdir(parent), [path.basename(fixture.root)])
    assert.deepEqual(await readFile(fixture.file), fixture.bytes)
    await button(page, '总规划提示词').click()
    await button(dialog, '保留原件并升级副本').click()
    await page.getByRole('dialog', { name: '总规划提示词' }).waitFor()
    const [copy] = (await readdir(parent)).filter(name => name !== path.basename(fixture.root))
    const upgraded = await documentAt(path.join(parent, copy, 'project.json'))
    assert.equal(upgraded.schemaVersion, 2)
    assert.equal(upgraded.brief.theme, '虚构升级验收')
    assert.deepEqual(await readFile(fixture.file), fixture.bytes)
    for (const [index, name] of fixture.names.entries()) {
      assert.deepEqual(await readFile(path.join(fixture.root, 'media', name)), fixture.mediaBytes[index])
      assert.deepEqual(await readFile(path.join(parent, copy, 'media', name)), fixture.mediaBytes[index])
    }
    await button(page.getByRole('dialog', { name: '总规划提示词' }), '关闭').click()
    await button(directory(page), '分镜').click()
    const dialogue = page.getByLabel('本镜烧录台词', { exact: true })
    await dialogue.fill('港口原台词')
    await button(page, '保存镜头').click()
    await footerSaved(page)
    await page.getByRole('button', { name: /^配音与字幕稿/ }).last().click()
    const voice = page.getByRole('dialog', { name: /配音与字幕稿/ })
    const draftBody = '让灯塔指路。\n第二行 <示例> & {虚构}'
    await voice.getByLabel('提示词正文').fill(draftBody)
    assert.equal(await button(voice, '预览台词差异').isEnabled(), false)
    await button(voice, '保存提示词').click()
    await button(voice, '预览台词差异').click()
    const diff = page.getByRole('dialog', { name: /应用配音稿 · 镜头 01 · 港口/ })
    await diff.getByText('港口原台词', { exact: true }).waitFor()
    assert.equal(await diff.getByLabel('拟应用台词').inputValue(), draftBody)
    await screenshot(page, 'feature-voice-dialogue-diff.png')
    assert.equal((await documentAt(path.join(parent, copy, 'project.json'))).episodes[0].shots[0].dialogue, '港口原台词')
    await button(diff, '确认应用台词').click()
    await diff.waitFor({ state: 'hidden' })
    assert.equal(await dialogue.inputValue(), draftBody)
    const srt = path.join(parent, '虚构字幕 验收.srt')
    await choose(app, srt, 'saveChoices')
    await button(stage(page), '导出 SRT').click()
    await page.getByText(/字幕已导出/).waitFor()
    assert.match(await readFile(srt, 'utf8'), /00:00:00,000 --> 00:00:07,500\n让灯塔指路。\n第二行 &lt;示例&gt; &amp; ｛虚构｝/)
    await button(stage(page), '重新生成预览').waitFor()
    await screenshot(page, 'feature-preview-rebuild.png')
    await button(stage(page), '顺序预览').click()
    await page.locator('video.episode-player').waitFor({ timeout: 45_000 })
    await button(page, '关闭预览').click()
    const before = (await readdir(tmpdir())).filter(name => name.startsWith('manju-shot-cache-'))
    await button(stage(page), '重新生成预览').click()
    await page.locator('video.episode-player').waitFor({ timeout: 45_000 })
    await page.waitForFunction(() => document.querySelector('.episode-player')?.readyState >= 2)
    const after = (await readdir(tmpdir())).filter(name => name.startsWith('manju-shot-cache-'))
    assert.equal(before.length, after.length)
    assert.equal(after.filter(name => !before.includes(name)).length, 1)
    await button(page, '关闭预览').click()
  } finally {
    await app.close()
  }
}

async function main() {
  await mkdir(screenshots, { recursive: true })
  const verify = path.join(run, 'verification')
  await mkdir(verify, { recursive: true })
  const folder = await mkdtemp(path.join(verify, 'run-'))
  console.log('验收目录', folder)
  const parent = path.join(folder, '项目 测试')
  const projectTitle = '漫剧 一（虚构验收）'
  const project = path.join(parent, projectTitle)
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
    const sampleFile = path.join(parent, '雾港来信', 'project.json')
    const sample = await documentAt(sampleFile)
    assert.equal(sample.episodes[0].shots.length, 4)
    assert.equal(sample.episodes[0].exportRecord, undefined)
    await guideStatus(page, 'image', '已完成')
    await guideStatus(page, 'video', '待完成')
    await guideStatus(page, 'export', '待完成')
    await page.locator('.monitor-body img').evaluate(image => image.decode())
    await screenshot(page, '02-sample-light.png')
    await button(page, '切换深色').click()
    await screenshot(page, '03-sample-dark.png')
    await button(page, '切换浅色').click()
    await button(page, '顺序预览').click()
    await page.locator('video.episode-player').waitFor({ timeout: 45_000 })
    await page.waitForFunction(() => document.querySelector('.episode-player')?.readyState >= 2)
    await button(page, '关闭预览').click()
    await guideStatus(page, 'export', '待完成')
    assert.deepEqual(await documentAt(sampleFile), sample)
    await button(stage(page), '导出 MP4').click()
    const fallback = page.getByRole('dialog', { name: '确认导出替代画面' })
    await fallback.waitFor()
    assert.equal(await fallback.getByText('静态参考图', { exact: true }).count(), 4)
    await button(fallback, '返回补素材').click()
    assert.deepEqual(await documentAt(sampleFile), sample)
    await button(page, '关闭作品').click()
    await page.locator('.welcome-card').waitFor()
    await page.locator('.recent-projects').getByRole('button', { name: /雾港来信/ }).click()
    await guide(page).waitFor()
    await button(page, '关闭作品').click()

    await choose(app, parent)
    await named(page, '新建作品', projectTitle, '选择保存位置')
    assert.equal(await app.evaluate(() => globalThis.openDefaults.at(-1)), parent)
    assert.deepEqual(await guide(page).locator('[data-step]').evaluateAll(steps => steps.map(step => step.dataset.step)),
      ['script', 'references', 'shots', 'image', 'video', 'audio', 'export'])
    for (const step of ['script', 'references', 'shots', 'image', 'video', 'audio', 'export']) await guideStatus(page, step, '待完成')
    await guideNext(page, 'script')
    await guide(page).getByText('缺作品剧本', { exact: true }).waitFor()
    await screenshot(page, 'guide-01-empty-light.png')
    await button(page, '切换深色').click()
    await screenshot(page, 'guide-02-empty-dark.png')
    await button(page, '切换浅色').click()
    const resize = (width, height) => app.evaluate(({ BrowserWindow }, dimensions) => {
      BrowserWindow.getAllWindows()[0].setSize(...dimensions)
    }, [width, height])
    await resize(940, 650)
    await page.waitForFunction(() => window.innerWidth <= 940)
    await guideNext(page, 'script')
    assert.ok(await guide(page).locator('.guide-steps').evaluate(steps => steps.scrollWidth === steps.clientWidth))
    await resize(1480, 970)
    await page.waitForFunction(() => window.innerWidth > 940)
    await selectStep(page, 'export')
    await guide(page).getByText('缺集数', { exact: true }).waitFor()
    assert.equal(await button(guide(page), '新建集数').isEnabled(), true)
    await selectStep(page, 'script')
    await stage(page).getByRole('heading', { name: '剧本', exact: true }).waitFor()
    await button(guide(page), '作品剧本').click()
    await page.getByLabel('剧本', { exact: true }).fill('海港守夜人收到一封信。')
    await button(page, '保存').click()
    await footerSaved(page)
    await guideStatus(page, 'script', '已完成')
    await selectStep(page, 'references')
    await guide(page).getByText('缺角色参考', { exact: true }).waitFor()
    await button(guide(page), '角色参考').click()
    await stage(page).getByRole('heading', { name: '角色参考', exact: true }).waitFor()
    await named(page, '新建参考', '守夜人', '新建', guide(page))
    await page.getByLabel('备注').fill('深色外套')
    await button(page, '保存').click()
    await footerSaved(page)
    await addAsset(app, page, '参考图', inputs.files[1].image, guide(page))
    await guideStatus(page, 'references', '部分完成')
    await guide(page).getByText('缺场景参考', { exact: true }).waitFor()
    await selectStep(page, 'shots')
    await named(page, '新建集数', '第 1 集', '新建', guide(page))
    await guide(page).getByText('缺镜头', { exact: true }).waitFor()
    for (const [index, [title, seconds, dialogue, prompt, status]] of shotPlan.entries()) {
      await named(page, '新建镜头', title, '新建', index === 0 ? guide(page) : stage(page))
      await page.getByLabel('时长（秒）').fill(String(seconds))
      await page.locator('#shot-dialogue').fill(dialogue)
      await page.getByLabel('提示词', { exact: true }).fill(prompt)
      await page.getByLabel('状态', { exact: true }).selectOption(status)
      await button(page, '保存镜头').click()
      await page.getByText('镜头已保存', { exact: true }).waitFor()
      await footerSaved(page)
      const imported = inputs.files[index]
      if (index === 0) {
        await guideStatus(page, 'shots', '已完成')
        await verifyGuideTools(app, page)
        await addAsset(app, page, '视频', imported.video, guide(page))
        await selectStep(page, 'image')
        await addAsset(app, page, '参考图', imported.image, guide(page))
        await selectStep(page, 'audio')
        await button(guide(page), '编辑台词').click()
        assert.equal(await page.locator('#shot-dialogue').evaluate(field => field === document.activeElement), true)
        await addAsset(app, page, '配音', imported.audio, guide(page))
      } else {
        if (index === 1) {
          await selectStep(page, 'image')
          await guideStatus(page, 'image', '部分完成')
          await guideNext(page, 'references')
          await guide(page).getByText('缺参考图 1 镜', { exact: true }).waitFor()
          await button(page, '关闭提示').click()
          await screenshot(page, 'guide-03-partial-light.png')
          const selector = guide(page).getByRole('combobox', { name: '镜头', exact: true })
          await selector.selectOption({ label: '01 雾港远眺 · 已有参考图' })
          assert.equal(await page.getByLabel('镜头名称').inputValue(), shotPlan[0][0])
          await selector.selectOption({ label: '02 一封来信 · 缺参考图' })
        }
        await addAsset(app, page, '参考图', imported.image)
        await addAsset(app, page, '视频', imported.video)
        await addAsset(app, page, '配音', imported.audio)
      }
    }
    const before = await documentAt(projectFile)
    await button(page, '镜头 02 一封来信').click()
    await addAsset(app, page, '视频', inputs.replacement)
    const after = await documentAt(projectFile)
    assert.equal(await app.evaluate(() => globalThis.openDefaults.at(-1)), base)
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
    await page.locator('.shot-details button').filter({ hasText: '生图提示词' }).click()
    const detailed = page.getByRole('dialog', { name: /生图提示词/ })
    const newPrompt = '使用新版虚构灯塔构图'
    await detailed.getByLabel('提示词正文').fill(newPrompt)
    await button(detailed, '保存提示词').click()
    await detailed.getByRole('status').getByText('已保存').waitFor()
    await button(detailed, '复制生图提示词').click()
    await detailed.getByRole('status').getByText('已复制').waitFor()
    const detailedCopy = await app.evaluate(({ clipboard }) => clipboard.readText())
    assert.ok(detailedCopy.endsWith(newPrompt))
    assert.ok(detailedCopy.includes(toolExamples.image.name))
    assert.ok(!detailedCopy.includes(toolExamples.image.url))
    await button(detailed, '关闭').click()
    await button(page, '复制详细提示词').click()
    await page.getByText('提示词已复制', { exact: true }).waitFor()
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), detailedCopy)
    assert.ok(await page.locator('.monitor-body video').count())
    assert.ok(await page.locator('.clip-image video').count())
    await button(page, toolExamples.image.name).click()
    await footerSaved(page)
    await button(page, toolExamples.video.name).click()
    await footerSaved(page)
    assert.deepEqual(await app.evaluate(() => globalThis.openedUrls), [
      toolExamples.image.url, toolExamples.video.url, toolExamples.image.url, toolExamples.video.url,
    ])

    await button(directory(page), '剧本').click()
    await button(stage(page), '集数剧本').click()
    await page.getByLabel('剧本', { exact: true }).fill(shotPlan.map(shot => shot[2]).join('\n'))
    await button(page, '保存').click()
    await footerSaved(page)
    await selectStep(page, 'references')
    await button(guide(page), '场景参考').click()
    await stage(page).getByRole('heading', { name: '场景参考', exact: true }).waitFor()
    await named(page, '新建参考', '港口灯塔', '新建', guide(page))
    await addAsset(app, page, '参考图', inputs.files[2].image, guide(page))
    for (const step of ['image', 'video', 'audio']) await guideStatus(page, step, '需更新')
    await selectStep(page, 'shots')
    for (const [index, [title]] of shotPlan.entries()) {
      await button(page, `镜头 0${index + 1} ${title}`).click()
      for (const kind of ['参考图', '视频', '配音']) {
        await button(page, `保留此版本 · ${kind}`).click()
        await footerSaved(page)
      }
    }
    for (const step of ['script', 'references', 'shots', 'image', 'video', 'audio']) await guideStatus(page, step, '已完成')
    await guideNext(page, 'export')
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
    await page.getByRole('heading', { name: projectTitle, exact: true }).waitFor()
    await footerSaved(page)
    await guideStatus(page, 'image', '已完成')
    await guideStatus(page, 'video', '已完成')
    await guideStatus(page, 'audio', '已完成')
    await guideStatus(page, 'export', '待完成')
    await button(page, '镜头 02 一封来信').click()
    assert.equal(await page.getByLabel('视频活动版本').inputValue(), track.versions[1].id)
    assert.deepEqual(await documentAt(projectFile), saved)
    assert.deepEqual(saved.brief.generation, toolExamples)
    const activeMonitor = page.locator('.monitor-body video')
    assert.ok((await activeMonitor.getAttribute('src')).endsWith(track.versions[1].id))
    await page.waitForFunction(() => document.querySelector('.monitor-body video')?.readyState >= 1)

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
    await screenshot(page, 'creative-00-landscape-preview.png')
    await button(page, '关闭预览').click()

    const destination = path.join(project, '成片 验收.mp4')
    await writeFile(destination, Buffer.from('pre-existing output'))
    await choose(app, destination, 'saveChoices')
    await selectStep(page, 'export')
    await button(guide(page), '导出 MP4').click()
    await page.getByText(/导出完成/).waitFor({ timeout: 45_000 })
    await guideStatus(page, 'export', '已完成')
    assert.equal(await guide(page).getByText('建议下一步', { exact: true }).count(), 0)
    const published = (await documentAt(projectFile)).episodes[0].exportRecord
    assert.equal(published.stale, false)
    assert.ok(Number.isFinite(Date.parse(published.exportedAt)))
    await button(page, '关闭提示').click()
    await screenshot(page, 'guide-04-exported-light.png')
    await button(page, '切换深色').click()
    await screenshot(page, 'guide-05-exported-dark.png')
    await button(page, '切换浅色').click()
    await verifyMedia(destination, folder, inputs)
    const sha = await hash(destination)

    await choose(app, null, 'saveChoices')
    await button(stage(page), '导出 MP4').click()
    await page.getByText('已取消导出', { exact: true }).waitFor()
    assert.equal(await hash(destination), sha)

    await choose(app, destination, 'saveChoices')
    await button(stage(page), '导出 MP4').click()
    await page.waitForFunction(() => !!document.querySelector('progress') && document.querySelector('progress').value > 0)
    await button(page, '取消导出').click()
    await page.getByText('已取消导出', { exact: true }).waitFor()
    assert.equal(await hash(destination), sha)

    const last = saved.episodes[0].shots.at(-1).media.video.versions[0]
    const missing = path.join(project, 'media', `${last.id}.${last.extension}`)
    await rename(missing, `${missing}.test-backup`)
    try {
      await choose(app, destination, 'saveChoices')
      await button(stage(page), '导出 MP4').click()
      await page.getByRole('alert').filter({ hasText: '镜头 4 · 素材文件不存在' }).waitFor({ timeout: 45_000 })
      assert.equal(await hash(destination), sha)
    } finally {
      await rename(`${missing}.test-backup`, missing)
    }
    assert.deepEqual((await documentAt(projectFile)).episodes[0].exportRecord, published)
    await guideStatus(page, 'export', '已完成')
    const reopenedVersion = page.getByLabel('视频活动版本')
    await reopenedVersion.selectOption(track.versions[0].id)
    await footerSaved(page)
    await guideStatus(page, 'export', '已过期')
    await guideStatus(page, 'video', '需更新')
    await guideNext(page, 'video')
    await guide(page).getByText('需重新导出', { exact: true }).waitFor()
    assert.equal(await hash(destination), sha)
    await reopenedVersion.selectOption(track.versions[1].id)
    await footerSaved(page)
    await guideStatus(page, 'export', '已过期')
    await guideNext(page, 'export')

    await named(page, '新建集数', '第 2 集', '新建', page.locator('.sidebar'))
    await guideStatus(page, 'export', '待完成')
    assert.equal((await documentAt(projectFile)).episodes[1].exportRecord, undefined)
    await named(page, '新建镜头', '静默灯塔', '新建', guide(page))
    await page.getByLabel('时长（秒）').fill('1')
    await page.locator('#shot-dialogue').fill('静默字幕')
    await button(page, '保存镜头').click()
    await footerSaved(page)
    await selectStep(page, 'image')
    await button(guide(page), '跳过生图').click()
    await guide(page).getByText('已跳过 1 镜', { exact: true }).waitFor()
    await guideStatus(page, 'image', '已完成')
    await button(guide(page), '取消跳过').click()
    await guideStatus(page, 'image', '待完成')
    await button(guide(page), '跳过生图').click()
    await guideStatus(page, 'image', '已完成')
    await selectStep(page, 'video')
    await addAsset(app, page, '视频', inputs.files[0].video, guide(page))
    await button(guide(page), '跳过视频').click()
    await guide(page).getByText('已跳过 1 镜', { exact: true }).waitFor()
    await selectStep(page, 'audio')
    await addAsset(app, page, '配音', inputs.files[0].audio, guide(page))
    await button(guide(page), '标为静默').click()
    await guide(page).getByText('静默 1 镜', { exact: true }).waitFor()
    await guide(page).getByText('有台词 1 镜', { exact: true }).waitFor()
    await guideStatus(page, 'audio', '已完成')
    await selectStep(page, 'export')
    const silent = path.join(project, '静默 成片.mp4')
    await choose(app, silent, 'saveChoices')
    await button(guide(page), '导出 MP4').click()
    await page.getByRole('dialog', { name: '确认导出替代画面' }).getByText('黑底', { exact: true }).waitFor()
    await button(page, '继续导出').click()
    await page.getByText(/导出完成/).waitFor({ timeout: 45_000 })
    await guideStatus(page, 'export', '已完成')
    const silentWav = ffmpeg('-i', silent, '-vn', '-ac', '1', '-f', 's16le', '-')
    assert.ok(silentWav.length > 0 && silentWav.every(value => value === 0), '静默镜头应忽略已归档的活动配音')
    const gray = ffmpeg('-i', silent, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-')
    assert.ok(gray.length === 1280 * 720 && gray.subarray(0, 1280 * 500).every(value => value < 25), '跳过视频与生图应使用黑画面')
    assert.ok(gray.subarray(1280 * 500).some(value => value > 230), '静默镜头保留硬字幕')

    const finalManifest = await documentAt(projectFile)
    assert.equal(finalManifest.episodes[0].exportRecord.stale, true)
    assert.equal(finalManifest.episodes[1].exportRecord.stale, false)
    await app.close()
    desktop = await launch(profile)
    ;({ app, page } = desktop)
    await page.locator('.recent-projects').getByRole('button', { name: new RegExp(projectTitle) }).click()
    await guideStatus(page, 'export', '已过期')
    await page.getByRole('navigation', { name: '集数', exact: true }).getByRole('button', { name: /第 2 集/ }).click()
    await guideStatus(page, 'export', '已完成')
    await selectStep(page, 'audio')
    await guide(page).getByText('静默 1 镜', { exact: true }).waitFor()
    assert.deepEqual(await documentAt(projectFile), finalManifest)
    assert.ok((await readdir(project)).every(name => !name.startsWith('.manju-render-')))
    await app.close()
    const portrait = await verifyCreative(folder, parent, path.join(folder, '竖屏 Electron Profile'))
    await verifyLegacyUpgrade(folder)
    await verifyUpdates(folder, project)
    assert.deepEqual(await documentAt(projectFile), finalManifest)
    await writeFile(path.join(folder, 'acceptance.json'), JSON.stringify({
      project, destination, portrait, sha256: sha, restartedElectron: true, replacementStillActive: track.versions[1].id,
      dialogCanceledPreservedHash: true, renderCanceledPreservedHash: true, missingAssetPreservedHash: true,
      temporaryDirectoriesCleaned: true, guideEmptyPartialComplete: true, guideExternalStubAndClipboard: true,
      guidePerEpisodeAndStaleAfterRestart: true, skippedVideoAndAudioRetainCaptions: true,
      updateFixtureNoReleaseAndNewVersion: true, updateFixtureCanceledAndVerified: true,
      updateFixtureNativeConfirmationCanceledAndDirtyBlocked: true,
      magpieDraftCancellationErrorAndConflictReview: true,
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
