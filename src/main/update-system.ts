import { execFile, spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { ManualUpdateRequiredError, Updater, type SetupUpdateTarget, type UpdateTarget } from './updater'

const installedExecutable = '漫剧工作台.exe'
const uninstaller = 'Uninstall.exe'
const alternateUninstaller = `Uninstall ${installedExecutable}`
const installIdentity = 'local.manju.workbench'
const registryKey = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ManjuWorkbench'
const windows = path.win32

type RegistryInstall = { directory?: string; identity?: string; displayIcon?: string; uninstallString?: string }
type UpdateEnvironment = {
  platform: NodeJS.Platform
  arch: string
  packaged: boolean
  exePath: string
  env: NodeJS.ProcessEnv
}
type InstallInspection = {
  canonical: (candidate: string) => Promise<string>
  isFile: (candidate: string) => Promise<boolean>
  registry: () => Promise<RegistryInstall | null>
}

function sameWindowsPath(left: string | undefined, right: string) {
  return left?.toLowerCase() === right.toLowerCase()
}

function canonicalInstallDirectory(directory: string) {
  return /^[a-z]:\\[^\\]/i.test(directory) && directory === windows.normalize(directory)
    && !/[<>:"/|?*\x00-\x1f]/.test(directory.slice(2)) && !/[. \\]$/.test(directory)
}

async function readInstallRegistry(env: NodeJS.ProcessEnv): Promise<RegistryInstall | null> {
  if (!env.SystemRoot || !windows.isAbsolute(env.SystemRoot)) return null
  const executable = windows.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', 'Registry32')
    $key = $base.OpenSubKey('${registryKey}')
    if ($null -ne $key) {
      [Console]::Write((@{
        directory = $key.GetValue('InstallLocation', '')
        identity = $key.GetValue('InstallIdentity', '')
        displayIcon = $key.GetValue('DisplayIcon', '')
        uninstallString = $key.GetValue('UninstallString', '')
      } | ConvertTo-Json -Compress))
    }
  `
  const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 8_000, maxBuffer: 16_384,
  })
  if (!stdout.trim()) return null
  const raw = JSON.parse(stdout) as Record<string, unknown>
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === 'string'))
}

export async function resolveUpdateTarget(options: UpdateEnvironment, inspect: InstallInspection = {
  canonical: realpath,
  isFile: candidate => lstat(candidate).then(info => info.isFile()).catch(() => false),
  registry: () => readInstallRegistry(options.env),
}): Promise<UpdateTarget> {
  if (options.platform !== 'win32' || options.arch !== 'x64' || !options.packaged) return { kind: null }
  if (options.env.PORTABLE_EXECUTABLE_FILE || options.env.PORTABLE_EXECUTABLE_DIR) return { kind: 'portable' }
  try {
    const actual = await inspect.canonical(options.exePath)
    if (!sameWindowsPath(windows.basename(actual), installedExecutable)) return { kind: 'portable' }
    const directory = windows.dirname(actual)
    const uninstallPath = windows.join(directory, uninstaller)
    const officialUninstall = await inspect.isFile(uninstallPath)
    const registry = await inspect.registry().catch(() => null)
    const registeredHere = sameWindowsPath(registry?.directory, directory)
    if (!officialUninstall && !registeredHere && !await inspect.isFile(windows.join(directory, alternateUninstaller))) {
      return { kind: 'portable' }
    }
    if (!canonicalInstallDirectory(directory) || !officialUninstall || !registeredHere
      || (registry?.identity && registry.identity !== installIdentity)
      || !sameWindowsPath(registry?.displayIcon, actual)
      || !sameWindowsPath(registry?.uninstallString, `"${uninstallPath}"`)
      || !sameWindowsPath(await inspect.canonical(uninstallPath), uninstallPath)
      || !await inspect.isFile(actual)) return { kind: 'manual' }
    return { kind: 'setup', directory, identity: installIdentity }
  } catch {
    return { kind: 'manual' }
  }
}

export function setupLaunchOptions(file: string, target: SetupUpdateTarget) {
  if (target.identity !== installIdentity || !canonicalInstallDirectory(target.directory)
    || !windows.isAbsolute(file) || /["\x00-\x1f]/.test(file)) throw new ManualUpdateRequiredError()
  const args = [`/MANJUUPDATE=${target.identity}`, `/MANJUDIR="${target.directory}"`]
  const argv0 = `"${file}"`
  // The standard Unicode NSIS build stores the command line in a 1024-character variable.
  if ([argv0, ...args].join(' ').length >= 1024) throw new ManualUpdateRequiredError()
  return {
    args,
    options: {
      // NSIS GetOptions expects quotes around the value, and libuv leaves argv[0] verbatim too.
      argv0, windowsVerbatimArguments: true, detached: true,
      stdio: 'ignore' as const, shell: false, cwd: windows.dirname(file),
    },
  }
}

export function createProductionUpdater() {
  return new Updater({
    version: app.getVersion(),
    target: () => resolveUpdateTarget({
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      exePath: app.getPath('exe'),
      env: process.env,
    }),
    temp: app.getPath('temp'),
    request: (url, init) => fetch(url, init),
    launch: (file, target) => new Promise<void>((resolve, reject) => {
      const { args, options } = setupLaunchOptions(file, target)
      const installer = spawn(file, args, options)
      installer.once('error', cause => reject(new Error('无法启动安装程序，工作台继续运行', { cause })))
      installer.once('spawn', () => { installer.unref(); resolve() })
    }),
  })
}
