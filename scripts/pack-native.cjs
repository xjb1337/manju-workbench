const { spawnSync } = require('node:child_process')
const { existsSync, mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { version } = require('../package.json')

const [compiler, unpacked, destination] = process.argv.slice(2)
if (!compiler || !unpacked || !destination) {
  throw new Error('用法 npm run pack:win:native -- <makensis> <win-unpacked> <Setup.exe>')
}

const source = path.resolve(unpacked)
const output = path.resolve(destination)
if (!existsSync(path.join(source, '漫剧工作台.exe')) || !existsSync(path.join(source, 'resources', 'app.asar'))) {
  throw new Error('缺少 Windows 应用归档')
}

function uninstallFiles(directory, prefix = '') {
  const commands = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (/[<>:"/\\|?*$\x00-\x1f]/.test(entry.name)) throw new Error(`NSIS 文件名无效 ${entry.name}`)
    const relative = prefix + '\\' + entry.name
    const target = '"$INSTDIR' + relative + '"'
    if (entry.isDirectory()) {
      commands.push(...uninstallFiles(path.join(directory, entry.name), relative), `RMDir ${target}`)
    } else if (entry.isFile()) {
      commands.push(`Delete ${target}`)
    } else {
      throw new Error(`NSIS 包含非普通文件 ${entry.name}`)
    }
  }
  return commands
}

mkdirSync(path.dirname(output), { recursive: true })
const temp = mkdtempSync(path.join(path.dirname(output), '.nsis-'))
try {
  const manifest = path.join(temp, 'uninstall.nsh')
  const candidate = path.join(temp, path.basename(output))
  writeFileSync(manifest, '\uFEFF' + uninstallFiles(source).join('\n') + '\n')
  const env = { ...process.env }
  const bundledRoot = path.dirname(path.dirname(path.resolve(compiler)))
  if (!env.NSISDIR && existsSync(path.join(bundledRoot, 'Include', 'MUI2.nsh'))) env.NSISDIR = bundledRoot
  const result = spawnSync(compiler, [
    '-INPUTCHARSET', 'UTF8', '-V2', `-DAPP_SOURCE=${source}`, `-DSETUP_EXE=${candidate}`,
    `-DAPP_VERSION=${version}`, `-DUNINSTALL_FILES=${manifest}`, path.join(__dirname, 'installer.nsi'),
  ], { env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`makensis 退出码 ${result.status}`)
  renameSync(candidate, output)
  console.log(output)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
