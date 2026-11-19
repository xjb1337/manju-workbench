import { contextBridge, ipcRenderer } from 'electron'
import type { RenderProgress, UpdateProgress, Workbench } from '../shared/api'

const bridge: Workbench = {
  open: () => ipcRenderer.invoke('project:open'),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  openRecent: id => ipcRenderer.invoke('project:open-recent', id),
  create: (title, sample) => ipcRenderer.invoke('project:create', title, sample),
  close: () => ipcRenderer.invoke('project:close'),
  edit: (key, change) => ipcRenderer.invoke('project:edit', key, change),
  previewPlan: (key, episodeId, text) => ipcRenderer.invoke('plan:preview', key, episodeId, text),
  generateMagpiePlan: (key, episodeId, model, script) => ipcRenderer.invoke('plan:generate-magpie', key, episodeId, model, script),
  cancelPlanGeneration: key => ipcRenderer.invoke('plan:cancel-generation', key),
  mergePlan: (key, token, replacements) => ipcRenderer.invoke('plan:merge', key, token, replacements),
  importMedia: (key, target) => ipcRenderer.invoke('project:import', key, target),
  copy: text => ipcRenderer.invoke('app:copy', text),
  openTool: (key, tool) => ipcRenderer.invoke('app:open-tool', key, tool),
  render: (key, episodeId, mode) => ipcRenderer.invoke('episode:render', key, episodeId, mode),
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
}
contextBridge.exposeInMainWorld('workbench', bridge)
