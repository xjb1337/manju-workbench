import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { UpdateKind } from '../shared/api'
import { Updater } from './updater'

const installedExecutable = '漫剧工作台.exe'
const uninstallerNames = ['Uninstall.exe', `Uninstall ${installedExecutable}`]

export async function resolveUpdateKind(options: {
  platform: NodeJS.Platform
  arch: string
  packaged: boolean
  exePath: string
  env: NodeJS.ProcessEnv
}): Promise<UpdateKind | null> {
  if (options.platform !== 'win32' || options.arch !== 'x64' || !options.packaged) return null
  if (options.env.PORTABLE_EXECUTABLE_FILE || options.env.PORTABLE_EXECUTABLE_DIR) return 'portable'
  // Only installations accompanied by a valid uninstaller next to the resolved executable may invoke Setup.
  // Unknown unpacked and portable layouts must never run Setup to update themselves.
  try {
    const actual = await realpath(path.resolve(options.exePath))
    if (path.basename(actual).toLowerCase() !== installedExecutable.toLowerCase()) return 'portable'
    const installDir = path.dirname(actual)
    for (const name of uninstallerNames) {
      const info = await lstat(path.join(installDir, name)).catch(() => null)
      if (info?.isFile()) return 'setup'
    }
  } catch {
    // A missing or inaccessible uninstaller does not authorize an in-place update.
  }
  return 'portable'
}

export function createProductionUpdater() {
  return new Updater({
    version: app.getVersion(),
    kind: () => resolveUpdateKind({
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      exePath: app.getPath('exe'),
      env: process.env,
    }),
    temp: app.getPath('temp'),
    request: (url, init) => fetch(url, init),
    launch: file => new Promise<void>((resolve, reject) => {
      const installer = spawn(file, [], { detached: true, stdio: 'ignore', shell: false, cwd: path.dirname(file) })
      installer.once('error', cause => reject(new Error('无法启动安装程序，工作台继续运行', { cause })))
      installer.once('spawn', () => { installer.unref(); resolve() })
    }),
  })
}
