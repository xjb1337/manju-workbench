import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { OpenProject, RenderProgress, UpdateProgress, Workbench } from '../shared/api'

const bridge: Workbench = {
  open: () => ipcRenderer.invoke('project:open'),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  openRecent: id => ipcRenderer.invoke('project:open-recent', id),
  create: (title, sample) => ipcRenderer.invoke('project:create', title, sample),
  onUpgradeRequired: listener => {
    const handler = (_event: Electron.IpcRendererEvent, id: string) => listener(id)
    ipcRenderer.on('project:upgrade-required', handler)
    return () => ipcRenderer.removeListener('project:upgrade-required', handler)
  },
  answerUpgrade: (id, approved) => ipcRenderer.invoke('project:answer-upgrade', id, approved),
  onUpgraded: listener => {
    const handler = (_event: Electron.IpcRendererEvent, opened: OpenProject) => listener(opened)
    ipcRenderer.on('project:upgraded', handler)
    return () => ipcRenderer.removeListener('project:upgraded', handler)
  },
  close: () => ipcRenderer.invoke('project:close'),
  edit: (key, change) => ipcRenderer.invoke('project:edit', key, change),
  previewPlan: (key, episodeId, text) => ipcRenderer.invoke('plan:preview', key, episodeId, text),
  generateMagpiePlan: (key, episodeId, model, script) => ipcRenderer.invoke('plan:generate-magpie', key, episodeId, model, script),
  generateShotDetailDraft: (key, episodeId, shotId, kind, body, instruction) =>
    ipcRenderer.invoke('ai:generate-shot-detail', key, episodeId, shotId, kind, body, instruction),
  generateScriptDraft: (key, scope, episodeId, script, instruction) =>
    ipcRenderer.invoke('ai:generate-script', key, scope, episodeId, script, instruction),
  cancelPlanGeneration: key => ipcRenderer.invoke('plan:cancel-generation', key),
  getAiConfig: () => ipcRenderer.invoke('ai:get-config'),
  setAiConfig: config => ipcRenderer.invoke('ai:set-config', config),
  testAiConnection: config => ipcRenderer.invoke('ai:test-connection', config),
  mergePlan: (key, token, replacements) => ipcRenderer.invoke('plan:merge', key, token, replacements),
  importMedia: (key, target) => ipcRenderer.invoke('project:import', key, target),
  importDroppedMedia: async (key, target, file) => {
    if (!(file instanceof File)) return { ok: false, error: '无法读取拖入的本地文件' }
    let filePath = ''
    try {
      filePath = webUtils.getPathForFile(file)
    } catch {
      filePath = ''
    }
    if (!filePath) return { ok: false, error: '无法读取拖入的本地文件' }
    return ipcRenderer.invoke('project:import-dropped', key, target, filePath)
  },
  inspectOrphanMedia: key => ipcRenderer.invoke('media:inspect-orphans', key),
  cleanOrphanMedia: key => ipcRenderer.invoke('media:clean-orphans', key),
  copy: text => ipcRenderer.invoke('app:copy', text),
  openTool: (key, tool) => ipcRenderer.invoke('app:open-tool', key, tool),
  render: (key, episodeId, mode, rebuild) => ipcRenderer.invoke('episode:render', key, episodeId, mode, rebuild),
  cancelRender: () => ipcRenderer.invoke('episode:cancel'),
  onProgress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: RenderProgress) => listener(value)
    ipcRenderer.on('episode:progress', handler)
    return () => ipcRenderer.removeListener('episode:progress', handler)
  },
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdateFolder: () => ipcRenderer.invoke('update:open-folder'),
  onUpdateProgress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: UpdateProgress) => listener(value)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },
  setEditorDirty: dirty => ipcRenderer.invoke('app:editor-dirty', dirty),
  setTheme: theme => ipcRenderer.invoke('app:set-theme', theme),
}
contextBridge.exposeInMainWorld('workbench', bridge)
