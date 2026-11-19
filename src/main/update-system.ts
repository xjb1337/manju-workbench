import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { UpdateKind } from '../shared/api'
import { Updater } from './updater'

async function updateKind(): Promise<UpdateKind | null> {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !app.isPackaged) return null
  const local = process.env.LOCALAPPDATA
  if (!local || !path.isAbsolute(local) || process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR) {
    return 'portable'
  }
  const installed = path.join(local, 'Programs', 'Manju Workbench')
  const executable = path.join(installed, '漫剧工作台.exe')
  // The custom NSIS always installs to this directory and writes this uninstaller.
  // Unknown unpacked and portable layouts must never run Setup to update themselves.
  try {
    const actual = app.getPath('exe')
    if (path.resolve(actual).toLowerCase() === executable.toLowerCase()
      && (await realpath(actual)).toLowerCase() === executable.toLowerCase()
      && (await lstat(path.join(installed, 'Uninstall.exe'))).isFile()) return 'setup'
  } catch {
    // A missing or inaccessible uninstaller does not authorize an in-place update.
  }
  return 'portable'
}

export function createProductionUpdater() {
  return new Updater({
    version: app.getVersion(),
    kind: updateKind,
    temp: app.getPath('temp'),
    request: (url, init) => fetch(url, init),
    launch: file => new Promise<void>((resolve, reject) => {
      const installer = spawn(file, [], { detached: true, stdio: 'ignore', shell: false, cwd: path.dirname(file) })
      installer.once('error', cause => reject(new Error('无法启动安装程序，工作台继续运行', { cause })))
      installer.once('spawn', () => { installer.unref(); resolve() })
    }),
  })
}
