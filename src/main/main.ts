import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { OpenProject, RenderProgress, RenderResult, Reply } from '../shared/api'
import { extensions, folderNameSchema, idSchema, mediaTargetSchema } from '../shared/model'
import { frameSpec, generationKindSchema, generationPresets, generationToolUrl } from '../shared/creative'
import { magpieModelSchema, magpieScriptSchema } from '../shared/plan'
import { magpiePlanningPrompt } from '../shared/prompts'
import { generateMagpiePlan } from './magpie'
import { mediaResponse } from './media-protocol'
import { exportDestination, renderEpisode } from './render'
import { fillSample, fillVerticalSample } from './sample'
import { RecentProjects } from './recent-projects'
import { allVersions, findEpisode, ProjectStore } from './storage'
import { createProductionUpdater } from './update-system'
import { InvalidUpdatePackageError, type Updater } from './updater'

protocol.registerSchemesAsPrivileged([{ scheme: 'manju-media', privileges: { standard: true, secure: true, stream: true } }])
const html = path.join(__dirname, '../renderer/index.html')
const rendererUrl = pathToFileURL(html).href
const resources = path.join(app.getAppPath(), 'resources', 'sample')
const toolSchema = z.union([generationKindSchema, z.literal('planning')])

let window: BrowserWindow | null = null
let current: { store: ProjectStore; key: string } | null = null
let preview: { directory: string; file: string; id: string } | null = null
let operation: Promise<unknown> | undefined
let job: { controller: AbortController; publishing: boolean } | null = null
let planGeneration: { key: unknown; controller: AbortController } | null = null
let quitting = false
let updater: Updater
let recent: RecentProjects
let editorDirty = false
let confirmingInstall = false
let installerStarted = false

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
      || event.senderFrame?.url !== rendererUrl || quitting || installerStarted) return { ok: false, error: '操作不可用' }
    try {
      return { ok: true, value: await fn(win, ...args) }
    } catch (error) {
      console.error(channel, error)
      if (error instanceof InvalidUpdatePackageError) return { ok: false, error: error.message, code: 'update-package-invalid' }
      return { ok: false, error: diagnose(error) }
    }
  })
}

async function serial<T>(fn: () => Promise<T>) {
  if (operation) throw new Error('已有操作在进行')
  const pending = Promise.resolve().then(fn)
  operation = pending
  try { return await pending }
  finally { operation = undefined }
}

async function dropPreview() {
  const previous = preview
  preview = null
  if (previous) await rm(previous.directory, { recursive: true, force: true }).catch(() => {})
}

async function switchProject(store: ProjectStore | null): Promise<OpenProject | null> {
  await dropPreview()
  if (current) {
    const { title, fictional } = current.store.snapshot
    await recent.remember({ directory: current.store.root, title, fictional })
  }
  if (!store) { current = null; return null }
  const project = store.snapshot
  await recent.remember({ directory: store.root, title: project.title, fictional: project.fictional })
  const key = randomUUID()
  current = { store, key }
  return { project, mediaKey: key, directory: store.root }
}

function getStore(key: unknown) {
  if (!current || key !== current.key) throw new Error('作品已关闭或切换')
  return current.store
}

function wire() {
  handle('app:editor-dirty', (_win, value) => { editorDirty = z.boolean().parse(value); return null })
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
  handle('update:install', win => serial(async () => {
    if (editorDirty) throw new Error('请先保存修改，再安装更新')
    confirmingInstall = true
    try {
      const started = await updater.install(async () => {
        const response = await dialog.showMessageBox(win, {
          type: 'warning', title: '安装更新', message: '关闭工作台并启动安装程序？',
          detail: '应用未签名。SHA-256 仅验证文件完整性，无法证明发布者身份。',
          buttons: ['取消', '关闭并安装'], defaultId: 0, cancelId: 0, noLink: true,
        })
        if (editorDirty) throw new Error('请先保存修改，再安装更新')
        return response.response === 1
      })
      if (!started) return 'canceled' as const
      installerStarted = true
      setImmediate(() => { if (!win.isDestroyed()) win.close() })
      return 'started' as const
    } finally {
      confirmingInstall = false
    }
  }))
  handle('project:create', (win, title, sample) => serial(async () => {
    const name = folderNameSchema.parse(title)
    const source = z.union([z.boolean(), z.literal('vertical')]).parse(sample)
    const selected = await dialog.showOpenDialog(win, { title: '选择保存位置', properties: ['openDirectory', 'createDirectory'],
      defaultPath: await recent.defaultDirectory('project') })
    if (selected.canceled || !selected.filePaths[0]) return null
    const store = await ProjectStore.create(selected.filePaths[0], name, !!source)
    try {
      if (source === 'vertical') await fillVerticalSample(store)
      else if (source) await fillSample(store, resources)
      return await switchProject(store)
    } catch (error) {
      // Keep the valid partial project. Its directory may already contain user files.
      throw new Error(`示例创建失败 · ${diagnose(error)} · ${store.root}`, { cause: error })
    }
  }))
  handle('project:open', win => serial(async () => {
    const selected = await dialog.showOpenDialog(win, { title: '打开作品', properties: ['openDirectory'],
      defaultPath: await recent.defaultDirectory('project') })
    if (selected.canceled || !selected.filePaths[0]) return null
    return switchProject(await ProjectStore.open(selected.filePaths[0]))
  }))
  handle('project:recent', () => recent.entries)
  handle('project:open-recent', (_win, input) => serial(async () => {
    const id = idSchema.parse(input)
    const entry = recent.entries.find(item => item.id === id)
    if (!entry) throw new Error('最近作品记录已失效，请使用「打开作品」重新选择')
    return switchProject(await ProjectStore.open(entry.directory))
  }))
  handle('project:close', () => serial(async () => { await switchProject(null); return null }))
  handle('project:edit', (_win, key, change) => serial(() => getStore(key).edit(change)))
  handle('plan:preview', (_win, key, episode, input) => serial(() => getStore(key).previewPlan(episode, input)))
  handle('plan:generate-magpie', (_win, key, episodeInput, modelInput, scriptInput) => serial(async () => {
    const store = getStore(key)
    const episodeId = idSchema.nullable().parse(episodeInput)
    const model = magpieModelSchema.parse(modelInput)
    const script = magpieScriptSchema.parse(scriptInput)
    const project = store.snapshot
    const episode = episodeId ? findEpisode(project, episodeId) : undefined
    if (!episode && project.episodes.length) throw new Error('请先选择要生成分镜的集数')
    const controller = new AbortController()
    planGeneration = { key, controller }
    try {
      const draft = await generateMagpiePlan(model, magpiePlanningPrompt(project, episode, script), controller.signal)
      if (!draft || controller.signal.aborted) return null
      const staged = episode ? { shots: draft.shots } : { title: draft.title, shots: draft.shots, script }
      return await store.previewPlan(episodeId, JSON.stringify({ schemaVersion: 1, episode: staged }), 'magpie')
    } finally {
      planGeneration = null
    }
  }))
  handle('plan:cancel-generation', (_win, key) => {
    if (planGeneration && planGeneration.key === key) planGeneration.controller.abort()
    return null
  })
  handle('plan:merge', (_win, key, token, replacements) => serial(() => getStore(key).mergePlan(token, replacements)))
  handle('project:import', (win, key, input) => serial(async () => {
    const store = getStore(key)
    const target = mediaTargetSchema.parse(input)
    const kind = target.scope === 'shot' ? target.kind : 'image'
    const label = { image: '参考图', video: '视频', audio: '配音' }[kind]
    const selected = await dialog.showOpenDialog(win, { title: `导入${label}`, properties: ['openFile'],
      defaultPath: await recent.defaultDirectory('media', store.root), filters: [{ name: label, extensions: extensions[kind] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    const project = await store.importMedia(target, selected.filePaths[0])
    await recent.rememberMedia(selected.filePaths[0])
    return project
  }))
  handle('app:copy', (_win, text) => {
    clipboard.writeText(z.string().max(64 * 1024 * 1024).parse(text))
    return null
  })
  handle('app:open-tool', async (_win, key, tool) => {
    const project = getStore(key).snapshot
    const kind = toolSchema.parse(tool)
    const url = kind === 'planning' ? generationPresets.image.url : project.brief?.generation?.[kind]?.url
    if (!url) throw new Error('请在制作简报中填写工具网址')
    await shell.openExternal(new URL(generationToolUrl.parse(url)).href)
    return null
  })
  handle('episode:cancel', () => {
    if (!job || job.publishing) return false
    job.controller.abort()
    return true
  })
  handle('episode:render', (win, key, id, value) => serial(async (): Promise<RenderResult> => {
    const store = getStore(key)
    const projectSnapshot = store.snapshot
    const episode = findEpisode(projectSnapshot, idSchema.parse(id))
    const mode = z.enum(['preview', 'export']).parse(value)
    const state = { controller: new AbortController(), publishing: false }
    job = state
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
      await renderEpisode(store, episode, target, { signal, progress, project: projectSnapshot, publish: () => { state.publishing = true } })
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
      await dropPreview()
      const id = randomUUID()
      preview = { directory: previewDir, file: target, id }
      previewDir = undefined
      return { status: 'completed', mode: 'preview', location: `manju-media://preview/${key}/${id}` }
    } catch (error) {
      if (signal.aborted) return { status: 'canceled' } as const
      throw error
    } finally {
      job = null
      if (previewDir) await rm(previewDir, { recursive: true, force: true }).catch(() => {})
    }
  }))
  protocol.handle('manju-media', async request => {
    try {
      const url = new URL(request.url)
      const parts = url.pathname.split('/')
      const opened = current
      if (!opened || parts.length !== 3 || parts[1] !== opened.key) return new Response(null, { status: 404 })
      if (url.hostname === 'preview' && preview && parts[2] === preview.id) return await mediaResponse(request, preview.file, 'mp4')
      if (url.hostname === 'project' && idSchema.safeParse(parts[2]).success) {
        const version = allVersions(opened.store.snapshot).find(item => item.id === parts[2])
        if (version) return await mediaResponse(request, await opened.store.assetPath(version), version.extension)
      }
    } catch {
      // Unavailable or removed local media has the same protocol response as an unknown ID.
    }
    return new Response(null, { status: 404 })
  })
}

function createWindow() {
  const win = new BrowserWindow({
    title: 'AI 视频制作工作台', width: 1480, height: 970, minWidth: 940, minHeight: 650, backgroundColor: '#f3f2f7',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    },
  })
  window = win
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.webContents.on('will-prevent-unload', event => {
    if (installerStarted) return
    const response = dialog.showMessageBoxSync(win, {
      type: 'warning', title: '退出工作台', message: '退出会放弃未保存的修改或中断当前操作。',
      buttons: ['返回', '退出'], defaultId: 0, cancelId: 0,
    })
    if (response === 1) event.preventDefault()
  })
  win.on('close', event => { if (confirmingInstall) event.preventDefault() })
  win.on('closed', () => { window = null })
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
  })
  app.on('window-all-closed', () => {
    quitting = true
    planGeneration?.controller.abort()
    if (!job?.publishing) job?.controller.abort()
    void Promise.allSettled([Promise.resolve(operation).catch(() => {}).then(dropPreview), updater.dispose()])
      .finally(() => app.quit())
  })
} else app.quit()
