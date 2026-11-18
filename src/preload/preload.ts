import { contextBridge, ipcRenderer } from 'electron'
import type { RenderProgress, Workbench } from '../shared/api'

const bridge: Workbench = {
  open: () => ipcRenderer.invoke('project:open'),
  create: (title, sample) => ipcRenderer.invoke('project:create', title, sample),
  close: () => ipcRenderer.invoke('project:close'),
  edit: (key, change) => ipcRenderer.invoke('project:edit', key, change),
  importMedia: (key, target) => ipcRenderer.invoke('project:import', key, target),
  copy: text => ipcRenderer.invoke('app:copy', text),
  openTool: tool => ipcRenderer.invoke('app:open-tool', tool),
  render: (key, episodeId, mode) => ipcRenderer.invoke('episode:render', key, episodeId, mode),
  cancelRender: () => ipcRenderer.invoke('episode:cancel'),
  onProgress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: RenderProgress) => listener(value)
    ipcRenderer.on('episode:progress', handler)
    return () => ipcRenderer.removeListener('episode:progress', handler)
  },
}
contextBridge.exposeInMainWorld('workbench', bridge)
