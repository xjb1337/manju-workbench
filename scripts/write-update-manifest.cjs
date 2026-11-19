const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { mkdtemp, rename, rm, stat, writeFile } = require('node:fs/promises')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { version } = require('../package.json')

const maxPackageSize = 2 * 1024 ** 3
const stableVersion = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const prefix = `Manju-Workbench-${version}`
const packageKinds = new Map([
  [`${prefix}-x64-Setup.exe`, 'setup'],
  [`${prefix}-x64-Portable.exe`, 'portable'],
  [`${prefix}-x64-Portable.zip`, 'portable'],
])
const usage = '用法 node scripts/write-update-manifest.cjs [--sha256] <包路径> [<包路径>]'

async function readAsset(file, fileName, kind) {
  const before = await stat(file)
  if (!before.isFile() || before.size < 1 || before.size > maxPackageSize) {
    throw new Error(`附件必须为大小在 1 字节至 2 GiB 内的普通文件 ${fileName}`)
  }

  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(file)) {
    size += chunk.length
    if (size > before.size) throw new Error(`计算 SHA-256 时附件发生变化 ${fileName}`)
    hash.update(chunk)
  }
  const after = await stat(file)
  if (size !== before.size || after.size !== size || after.dev !== before.dev
    || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error(`计算 SHA-256 时附件发生变化 ${fileName}`)
  }
  return { fileName, size, sha256: hash.digest('hex'), kind }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { sha256: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: true,
  })
  if (values.help) {
    console.log(usage)
    return
  }
  if (positionals.length < 1 || positionals.length > 2) throw new Error(usage)
  if (!stableVersion.test(version)) throw new Error(`应用版本必须为稳定三段版本 ${version}`)

  const kinds = new Set()
  const files = positionals.map(file => {
    const fileName = path.basename(file)
    const kind = packageKinds.get(fileName)
    if (!kind) throw new Error(`附件文件名无效 ${fileName}，可用名称为 ${[...packageKinds.keys()].join('、')}`)
    if (kinds.has(kind)) throw new Error(`每种附件类型最多一份 ${kind}`)
    kinds.add(kind)
    return { file: path.resolve(file), fileName, kind }
  })

  const assets = []
  for (const { file, fileName, kind } of files) assets.push(await readAsset(file, fileName, kind))

  const outputDir = path.dirname(files[0].file)
  const manifestName = `${prefix}-win-x64.manifest.json`
  const outputs = [[manifestName, JSON.stringify({ schemaVersion: 1, version, assets }, null, 2) + '\n']]
  if (values.sha256) {
    const checksums = assets.map(({ sha256, fileName }) => `${sha256}  ${fileName}\n`).join('')
    outputs.unshift([`${prefix}-win-x64.sha256.txt`, checksums])
  }

  const tempDir = await mkdtemp(path.join(outputDir, '.update-manifest-'))
  try {
    for (const [name, contents] of outputs) await writeFile(path.join(tempDir, name), contents, 'utf8')
    for (const [name] of outputs) {
      const destination = path.join(outputDir, name)
      await rename(path.join(tempDir, name), destination)
      console.log(destination)
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
