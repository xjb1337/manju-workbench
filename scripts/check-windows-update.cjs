const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { version, build } = require('../package.json')
const { setupLaunchOptions } = require('../dist/main/update-system')

const installer = readFileSync(path.join(__dirname, 'installer.nsi'), 'utf8').replace(/\r\n/g, '\n')
const executable = '漫剧工作台.exe'
const identity = build.appId
const directory = 'D:\\测试 空格\\漫剧工作台'
const fileName = `Manju-Workbench-${version}-x64-Setup.exe`
const file = path.win32.join('C:\\更新 缓存', fileName)
const options = setupLaunchOptions(file, { kind: 'setup', identity, directory })
assert.deepEqual(options.args, [`/MANJUUPDATE=${identity}`, `/MANJUDIR="${directory}"`])
assert.equal(options.options.argv0, `"${file}"`)
assert.equal(options.options.windowsVerbatimArguments, true)
assert.equal(options.options.shell, false)

function contains(source, ...lines) {
  for (const line of lines) assert.ok(source.includes(line), `缺少安装约定 ${line}`)
}
contains(installer,
  'Unicode true',
  `!define APP_EXE "${executable}"`,
  `!define INSTALL_IDENTITY "${identity}"`,
  '!define APP_FOLDER "$LOCALAPPDATA\\Programs\\Manju Workbench"',
  'OutFile "${SETUP_EXE}"',
  '!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUpdateDirectory\n!insertmacro MUI_PAGE_DIRECTORY',
  'StrCmp $UpdateTarget "" done\n  Abort',
)
const init = installer.split('Function .onInit\n')[1].split('FunctionEnd')[0]
contains(init, 'SetRegView 32', '${GetOptions} $0 "/MANJUUPDATE=" $1', 'StrCmp $1 "${INSTALL_IDENTITY}" 0 invalid',
  '${GetOptions} $0 "/MANJUDIR=" $UpdateTarget', 'IfErrors invalid', 'Call ConfirmUpdateTarget')
const validation = installer.split('Function ConfirmUpdateTarget\n')[1].split('FunctionEnd')[0]
contains(validation, 'HKCU "${UNINSTALL_KEY}" "InstallLocation"', 'StrCmp $1 "$UpdateTarget" 0 invalid',
  'HKCU "${UNINSTALL_KEY}" "InstallIdentity"', 'HKCU "${UNINSTALL_KEY}" "DisplayIcon"',
  'HKCU "${UNINSTALL_KEY}" "UninstallString"', 'kernel32::GetFinalPathNameByHandleW',
  'StrCpy $INSTDIR "$UpdateTarget"', 'Call RejectUpdateTarget')
const section = installer.split('SecApp\n')[1].split('SectionEnd')[0]
contains(section, 'Call ConfirmUpdateTarget', 'WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallIdentity" "${INSTALL_IDENTITY}"')
assert.ok(section.indexOf('Call ConfirmUpdateTarget') < section.indexOf('File /r "${APP_SOURCE}\\*"'))
assert.equal(build.nsis.artifactName, 'Manju-Workbench-${version}-${arch}-Setup.${ext}')
assert.equal(build.portable.artifactName, 'Manju-Workbench-${version}-${arch}-Portable.${ext}')

const fixture = mkdtempSync(path.join(tmpdir(), 'manju-manifest-check-'))
try {
  const assets = [['setup', fileName], ['portable', `Manju-Workbench-${version}-x64-Portable.exe`]].map(([kind, fileName]) => {
    const content = Buffer.from(`本地清单夹具 ${kind}`)
    writeFileSync(path.join(fixture, fileName), content)
    return { fileName, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), kind }
  })
  execFileSync(process.execPath, [path.join(__dirname, 'write-update-manifest.cjs'), ...assets.map(asset => path.join(fixture, asset.fileName))])
  const manifest = path.join(fixture, `Manju-Workbench-${version}-win-x64.manifest.json`)
  assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')), { schemaVersion: 1, version, assets })
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
console.log('安装参数、目录锁定、安装包命名及更新清单字段静态核对通过')
