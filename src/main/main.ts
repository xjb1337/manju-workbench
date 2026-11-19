import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, screen, session, shell } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { RenderProgress, RenderResult, Reply } from '../shared/api'
import { extensions, folderNameSchema, idSchema, mediaTargetSchema } from '../shared/model'
import { detailKindSchema, detailTextSchema, frameSpec, generationKindSchema, generationPresets, generationToolUrl } from '../shared/creative'
import { aiGatewayConfigSchema, aiInstructionSchema, magpieModelSchema, magpieScriptSchema } from '../shared/plan'
import { magpiePlanningPrompt, scriptAiPrompt, shotDetailAiPrompt } from '../shared/prompts'
import { generateAiTextDraft, generateMagpiePlan, testAiGateway } from './magpie'
import { mediaResponse } from './media-protocol'
import { exportDestination, renderEpisode } from './render'
import { fillSample, fillVerticalSample } from './sample'
import { RecentProjects, themeSchema, type WindowBounds } from './recent-projects'
import { WorkbenchSession } from './session'
import { findEpisode, findShot, ProjectStore } from './storage'
import { cleanupStaleTempDirs, staleTempAgeMs, staleTempPrefixes } from './temp-cleanup'
import { createProductionUpdater } from './update-system'
import { InvalidUpdatePackageError, type Updater } from './updater'
import { resolveInitialBounds, themeBackground } from './window-state'

protocol.registerSchemesAsPrivileged([{ scheme: 'manju-media', privileges: { standard: true, secure: true, stream: true } }])
const html = path.join(__dirname, '../renderer/index.html')
const rendererUrl = pathToFileURL(html).href
const resources = path.join(app.getAppPath(), 'resources', 'sample')
const appIcon = path.join(app.getAppPath(), 'resources', 'icon.png')
const toolSchema = z.union([generationKindSchema, z.literal('planning')])

let window: BrowserWindow | null = null
let updater: Updater
let recent: RecentProjects
let boundsSave: Promise<void> = Promise.resolve()
const workbench = new WorkbenchSession({ rememberProject: entry => recent.remember(entry) })
class UpgradeCanceled extends Error {}
let upgradeChoice: { id: string; resolve: (approved: boolean) => void } | undefined

async function writableProject(win: BrowserWindow, key: unknown) {
  const store = workbench.getStore(key)
  if (!store.needsUpgrade) return store
  const copy = await store.upgradeCopy(async () => {
    if (win.isDestroyed()) return false
    const id = randomUUID()
    const closed = () => upgradeChoice?.resolve(false)
    const approved = await new Promise<boolean>(resolve => {
      upgradeChoice = { id, resolve }
      win.once('closed', closed)
      win.webContents.send('project:upgrade-required', id)
    }).finally(() => {
      win.removeListener('closed', closed)
      upgradeChoice = undefined
    })
    return approved && !win.isDestroyed()
  })
  if (!copy) throw new UpgradeCanceled()
  const mediaKey = key as string
  workbench.current = { store: copy, key: mediaKey }
  const project = copy.snapshot
  if (!win.isDestroyed()) win.webContents.send('project:upgraded', { project, mediaKey, directory: copy.root })
  await recent.remember({ directory: copy.root, title: project.title, fictional: project.fictional })
  return copy
}

function diagnose(error: unknown) {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0]
    return issue && /[\u3400-\u9fff]/.test(issue.message) ? issue.message : '项目数据或输入格式无效'
  }
  if (error instanceof SyntaxError) return '项目文件不是有效的 JSON'
  const err = error as NodeJS.ErrnoException
  if (err.code === 'ENOENT') return '找不到项目或素材文件'
  if (err.code === 'EEXIST') return '同名作品目录已存在'
  if (err.code === 'EACCES' || err.code === 'EPERM') return '文件访问失败，请检查权限或关闭占用文件的程序'
  if (err.code === 'ENOSPC') return '磁盘空间不足'
  if (err.code === 'EBUSY') return '文件正在使用'
  if (err.name === 'TimeoutError') return '媒体校验超时'
  return error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : '操作失败'
}

function handle<T>(channel: string, fn: (win: BrowserWindow, ...args: unknown[]) => T | Promise<T>) {
  ipcMain.handle(channel, async (event, ...args): Promise<Reply<T>> => {
    const win = window
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
      || event.senderFrame?.url !== rendererUrl || !workbench.canAcceptIpc()) return { ok: false, error: '操作不可用' }
    try {
      return { ok: true, value: await fn(win, ...args) }
    } catch (error) {
      if (error instanceof UpgradeCanceled) return { ok: false, error: '已取消升级', code: 'upgrade-canceled' }
      console.error(channel, error)
      if (error instanceof InvalidUpdatePackageError) return { ok: false, error: error.message, code: 'update-package-invalid' }
      return { ok: false, error: diagnose(error) }
    }
  })
}

function wire() {
  handle('app:editor-dirty', (_win, value) => { workbench.editorDirty = z.boolean().parse(value); return null })
  handle('app:set-theme', async (win, value) => {
    const theme = themeSchema.parse(value)
    if (!win.isDestroyed()) win.setBackgroundColor(themeBackground(theme))
    await recent.setTheme(theme)
    return null
  })
  handle('update:check', () => updater.check())
  handle('update:download', win => updater.download(value => {
    if (!win.isDestroyed()) win.webContents.send('update:progress', value)
  }))
  handle('update:cancel', () => updater.cancel())
  handle('update:open-folder', async () => {
    await updater.openPortable(async directory => {
      if (await shell.openPath(directory)) throw new Error('无法打开更新包所在目录')
    })
    return null
  })
  handle('update:install', win => workbench.serial(async () => {
    if (workbench.editorDirty) throw new Error('请先保存修改，再安装更新')
    workbench.confirmingInstall = true
    try {
      const started = await updater.install(async () => {
        const response = await dialog.showMessageBox(win, {
          type: 'warning', title: '安装更新', message: '关闭工作台并启动安装程序？',
          detail: '应用未签名。SHA-256 仅验证文件完整性，无法证明发布者身份。',
          buttons: ['取消', '关闭并安装'], defaultId: 0, cancelId: 0, noLink: true,
        })
        if (workbench.editorDirty) throw new Error('请先保存修改，再安装更新')
        return response.response === 1
      })
      if (!started) return 'canceled' as const
      workbench.installerStarted = true
      setImmediate(() => { if (!win.isDestroyed()) win.close() })
      return 'started' as const
    } finally {
      workbench.confirmingInstall = false
    }
  }))
  handle('project:create', (win, title, sample) => workbench.serial(async () => {
    const name = folderNameSchema.parse(title)
    const source = z.union([z.boolean(), z.literal('vertical')]).parse(sample)
    const selected = await dialog.showOpenDialog(win, { title: '选择保存位置', properties: ['openDirectory', 'createDirectory'],
      defaultPath: await recent.defaultDirectory('project') })
    if (selected.canceled || !selected.filePaths[0]) return null
    const store = await ProjectStore.create(selected.filePaths[0], name, !!source)
    try {
      if (source === 'vertical') await fillVerticalSample(store)
      else if (source) await fillSample(store, resources)
      return await workbench.switchProject(store)
    } catch (error) {
      // Keep the valid partial project. Its directory may already contain user files.
      throw new Error(`示例创建失败 · ${diagnose(error)} · ${store.root}`, { cause: error })
    }
  }))
  handle('project:open', win => workbench.serial(async () => {
    const selected = await dialog.showOpenDialog(win, { title: '打开作品', properties: ['openDirectory'],
      defaultPath: await recent.defaultDirectory('project') })
    if (selected.canceled || !selected.filePaths[0]) return null
    return workbench.switchProject(await ProjectStore.open(selected.filePaths[0]))
  }))
  handle('project:recent', () => recent.entries)
  handle('project:open-recent', (_win, input) => workbench.serial(async () => {
    const id = idSchema.parse(input)
    const entry = recent.entries.find(item => item.id === id)
    if (!entry) throw new Error('最近作品记录已失效，请使用「打开作品」重新选择')
    return workbench.switchProject(await ProjectStore.open(entry.directory))
  }))
  handle('project:close', () => workbench.serial(async () => { await workbench.switchProject(null); return null }))
  handle('project:answer-upgrade', (_win, input, choice) => {
    const id = idSchema.parse(input)
    const approved = z.boolean().parse(choice)
    if (upgradeChoice?.id === id) upgradeChoice.resolve(approved)
    return null
  })
  handle('project:edit', (win, key, change) => workbench.serial(async () => {
    const store = await writableProject(win, key)
    const project = await store.edit(change)
    if (change && typeof change === 'object' && (change as { type?: unknown }).type === 'project.edit') {
      await recent.remember({ directory: store.root, title: project.title, fictional: project.fictional })
    }
    return project
  }))
  handle('plan:preview', (_win, key, episode, input) => workbench.serial(() => workbench.getStore(key).previewPlan(episode, input)))
  const runCancellableAi = async <T>(key: unknown, fn: (signal: AbortSignal) => Promise<T | null>): Promise<T | null> => {
    const controller = new AbortController()
    workbench.planGeneration = { key, controller }
    try {
      const result = await fn(controller.signal)
      return controller.signal.aborted ? null : result
    } finally {
      workbench.planGeneration = null
    }
  }
  handle('ai:get-config', () => recent.aiGateway)
  handle('ai:set-config', (_win, input) => recent.setAiGateway(aiGatewayConfigSchema.parse(input)))
  handle('ai:test-connection', (_win, input) => workbench.serial(async () => {
    const config = aiGatewayConfigSchema.parse(input)
    return testAiGateway(config.baseUrl, config.model, new AbortController().signal)
  }))
  handle('plan:generate-magpie', (_win, key, episodeInput, modelInput, scriptInput) => workbench.serial(async () => {
    const store = workbench.getStore(key)
    const episodeId = idSchema.nullable().parse(episodeInput)
    const model = magpieModelSchema.parse(modelInput)
    const script = magpieScriptSchema.parse(scriptInput)
    const project = store.snapshot
    const episode = episodeId ? findEpisode(project, episodeId) : undefined
    if (!episode && project.episodes.length) throw new Error('请先选择要生成分镜的集数')
    return runCancellableAi(key, async signal => {
      const draft = await generateMagpiePlan(model, magpiePlanningPrompt(project, episode, script), signal, recent.aiGateway.baseUrl)
      if (!draft || signal.aborted) return null
      const staged = episode ? { shots: draft.shots } : { title: draft.title, shots: draft.shots, script }
      return await store.previewPlan(episodeId, JSON.stringify({ schemaVersion: 1, episode: staged }), 'magpie')
    })
  }))
  handle('ai:generate-shot-detail', (_win, key, episodeInput, shotInput, kindInput, bodyInput, instructionInput) => workbench.serial(async () => {
    const store = workbench.getStore(key)
    const episodeId = idSchema.parse(episodeInput)
    const shotId = idSchema.parse(shotInput)
    const kind = detailKindSchema.parse(kindInput)
    const body = detailTextSchema.parse(bodyInput)
    const instruction = aiInstructionSchema.parse(instructionInput)
    const project = store.snapshot
    const episode = findEpisode(project, episodeId)
    const shot = findShot(project, episodeId, shotId)
    const { baseUrl, model } = recent.aiGateway
    return runCancellableAi(key, signal => generateAiTextDraft(
      model, shotDetailAiPrompt(project, episode, shot, kind, body, instruction), signal, baseUrl,
    ))
  }))
  handle('ai:generate-script', (_win, key, scopeInput, episodeInput, scriptInput, instructionInput) => workbench.serial(async () => {
    const store = workbench.getStore(key)
    const scope = z.enum(['project', 'episode']).parse(scopeInput)
    const episodeId = idSchema.nullable().parse(episodeInput)
    const script = detailTextSchema.parse(scriptInput)
    const instruction = aiInstructionSchema.parse(instructionInput)
    const project = store.snapshot
    const episode = scope === 'episode' ? (episodeId ? findEpisode(project, episodeId) : undefined) : undefined
    if (scope === 'episode' && !episode) throw new Error('请先选择要辅助编写的集数')
    const { baseUrl, model } = recent.aiGateway
    return runCancellableAi(key, signal => generateAiTextDraft(
      model, scriptAiPrompt(project, scope, episode, script, instruction), signal, baseUrl,
    ))
  }))
  handle('plan:cancel-generation', (_win, key) => {
    workbench.cancelPlanGeneration(key)
    return null
  })
  handle('plan:merge', (win, key, token, replacements) => workbench.serial(async () => (await writableProject(win, key)).mergePlan(token, replacements)))
  handle('project:import', (win, key, input) => workbench.serial(async () => {
    const store = workbench.getStore(key)
    const target = mediaTargetSchema.parse(input)
    const kind = target.scope === 'shot' ? target.kind : 'image'
    const label = { image: '参考图', video: '视频', audio: '配音' }[kind]
    const selected = await dialog.showOpenDialog(win, { title: `导入${label}`, properties: ['openFile'],
      defaultPath: await recent.defaultDirectory('media', store.root), filters: [{ name: label, extensions: extensions[kind] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    const project = await (await writableProject(win, key)).importMedia(target, selected.filePaths[0])
    await recent.rememberMedia(selected.filePaths[0])
    return project
  }))
  handle('project:import-dropped', (win, key, input, sourceInput) => workbench.serial(async () => {
    const target = mediaTargetSchema.parse(input)
    const source = z.string().min(1).refine(path.isAbsolute, '拖入的文件路径无效').parse(sourceInput)
    const project = await (await writableProject(win, key)).importMedia(target, source)
    await recent.rememberMedia(source)
    return project
  }))
  handle('media:inspect-orphans', (_win, key) => workbench.serial(() => workbench.getStore(key).inspectOrphanMedia()))
  handle('media:clean-orphans', (win, key) => workbench.serial(async () => (await writableProject(win, key)).cleanOrphanMedia()))
  handle('app:copy', (_win, text) => {
    clipboard.writeText(z.string().max(64 * 1024 * 1024).parse(text))
    return null
  })
  handle('app:open-tool', async (_win, key, tool) => {
    const project = workbench.getStore(key).snapshot
    const kind = toolSchema.parse(tool)
    const url = kind === 'planning' ? generationPresets.image.url : project.brief?.generation?.[kind]?.url
    if (!url) throw new Error('请在制作简报中填写工具网址')
    await shell.openExternal(new URL(generationToolUrl.parse(url)).href)
    return null
  })
  handle('episode:cancel', () => workbench.cancelRender())
  handle('episode:render', (win, key, id, value, rebuildInput) => workbench.serial(async (): Promise<RenderResult> => {
    const mode = z.enum(['preview', 'export']).parse(value)
    const rebuild = z.boolean().default(false).parse(rebuildInput)
    const store = mode === 'export' ? await writableProject(win, key) : workbench.getStore(key)
    const projectSnapshot = store.snapshot
    const episode = findEpisode(projectSnapshot, idSchema.parse(id))
    const state = { controller: new AbortController(), publishing: false }
    workbench.job = state
    const signal = state.controller.signal
    let previewDir: string | undefined
    try {
      let target: string
      if (mode === 'preview') {
        previewDir = await mkdtemp(path.join(tmpdir(), 'manju-preview-'))
        target = path.join(previewDir, 'preview.mp4')
      } else {
        const label = episode.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/[. ]+$/, '').slice(0, 80)
        const selected = await dialog.showSaveDialog(win, { title: '导出 MP4', defaultPath: path.join(store.root, `成片 - ${label}.mp4`),
          filters: [{ name: 'MP4', extensions: ['mp4'] }] })
        if (selected.canceled || !selected.filePath) return { status: 'canceled' } as const
        signal.throwIfAborted()
        target = await exportDestination(selected.filePath, store.root)
      }
      const progress = (percent: number) => {
        if (!win.isDestroyed()) {
          const value: RenderProgress = { mode, percent }
          win.webContents.send('episode:progress', value)
        }
      }
      if (mode === 'preview' && rebuild) await workbench.dropShotCache()
      const cacheDir = await workbench.ensureShotCache()
      await renderEpisode(store, episode, target, {
        signal, progress, project: projectSnapshot, cacheDir, publish: () => { state.publishing = true },
      })
      if (!previewDir) {
        try {
          const project = await store.recordExport(episode, frameSpec(projectSnapshot).ratio, projectSnapshot)
          return { status: 'completed', mode: 'export', location: target, project }
        } catch (error) {
          // The validated MP4 has been published. Report the separate project write failure.
          console.error('episode:export-record', error)
          return { status: 'record-failed', location: target }
        }
      }
      const id = await workbench.setPreview(previewDir, target)
      previewDir = undefined
      return { status: 'completed', mode: 'preview', location: `manju-media://preview/${key}/${id}` }
    } catch (error) {
      if (signal.aborted) return { status: 'canceled' } as const
      throw error
    } finally {
      workbench.job = null
      if (previewDir) await rm(previewDir, { recursive: true, force: true }).catch(() => {})
    }
  }))
  protocol.handle('manju-media', async request => {
    try {
      const url = new URL(request.url)
      const parts = url.pathname.split('/')
      const opened = workbench.current
      const preview = workbench.preview
      if (!opened || parts.length !== 3 || parts[1] !== opened.key) return new Response(null, { status: 404 })
      if (url.hostname === 'preview' && preview && parts[2] === preview.id) return await mediaResponse(request, preview.file, 'mp4')
      if (url.hostname === 'project' && idSchema.safeParse(parts[2]).success) {
        const version = opened.store.findVersion(parts[2])
        if (version) {
          return await mediaResponse(request, await opened.store.assetPath(version), version.extension, {
            cacheControl: 'private, max-age=3600, immutable',
          })
        }
      }
    } catch {
      // Unavailable or removed local media has the same protocol response as an unknown ID.
    }
    return new Response(null, { status: 404 })
  })
}

function createWindow() {
  const initialBounds = resolveInitialBounds(recent.windowBounds, screen.getAllDisplays())
  const win = new BrowserWindow({
    title: 'AI 视频制作工作台',
    icon: appIcon,
    width: initialBounds.width,
    height: initialBounds.height,
    ...(initialBounds.x !== undefined && initialBounds.y !== undefined ? { x: initialBounds.x, y: initialBounds.y } : {}),
    minWidth: 940,
    minHeight: 650,
    backgroundColor: themeBackground(recent.theme),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    },
  })
  window = win
  if (initialBounds.maximized) win.maximize()
  let boundsTimer: NodeJS.Timeout | undefined
  let latestBounds: WindowBounds | undefined
  const captureBounds = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const rect = win.getNormalBounds()
    if (rect.width < 940 || rect.height < 650) return
    latestBounds = {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      maximized: win.isMaximized(),
    }
  }
  const scheduleSaveBounds = () => {
    captureBounds()
    if (!latestBounds) return
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = undefined
      if (latestBounds) boundsSave = recent.setWindowBounds(latestBounds)
    }, 300)
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.webContents.on('will-prevent-unload', event => {
    if (workbench.installerStarted) return
    const response = dialog.showMessageBoxSync(win, {
      type: 'warning', title: '退出工作台', message: '退出会放弃未保存的修改或中断当前操作。',
      buttons: ['返回', '退出'], defaultId: 0, cancelId: 0,
    })
    if (response === 1) event.preventDefault()
  })
  win.on('resize', scheduleSaveBounds)
  win.on('move', scheduleSaveBounds)
  win.on('maximize', scheduleSaveBounds)
  win.on('unmaximize', scheduleSaveBounds)
  win.on('close', event => {
    if (workbench.confirmingInstall) {
      event.preventDefault()
      return
    }
    clearTimeout(boundsTimer)
    boundsTimer = undefined
    captureBounds()
    if (latestBounds) boundsSave = recent.setWindowBounds(latestBounds)
  })
  win.on('closed', () => {
    clearTimeout(boundsTimer)
    boundsTimer = undefined
    window = null
  })
  void win.loadFile(html)
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => { window?.restore(); window?.focus() })
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    updater = createProductionUpdater()
    recent = await RecentProjects.open(app.getPath('userData'))
    wire()
    createWindow()
    void cleanupStaleTempDirs(tmpdir(), staleTempPrefixes, staleTempAgeMs)
  })
  app.on('window-all-closed', () => {
    void Promise.allSettled([
      workbench.dispose(),
      boundsSave,
      updater.dispose(),
    ]).finally(() => app.quit())
  })
} else app.quit()
