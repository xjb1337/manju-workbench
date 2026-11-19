import { createHash } from 'node:crypto'
import { lstat, mkdtemp, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { UpdateCheck, UpdateDownload, UpdateKind, UpdateProgress } from '../shared/api'
import { downloadResponse, findRelease, hasPackage, packageFor, responseBytes } from './update-release'
import type { PackageAsset, Release, UpdateRequest } from './update-release'

export type UpdateOptions = {
  version: string
  kind: () => Promise<UpdateKind | null>
  temp: string
  request: UpdateRequest
  launch: (file: string) => Promise<void>
}
type Downloaded = { asset: PackageAsset; directory: string; file: string }

async function isPe(file: FileHandle, size: number) {
  const dos = Buffer.alloc(64)
  if ((await file.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') return false
  const offset = dos.readUInt32LE(60)
  const pe = Buffer.alloc(26)
  if (offset < dos.length || offset + pe.length > size
    || (await file.read(pe, 0, pe.length, offset)).bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x4550) return false
  const machine = pe.readUInt16LE(4)
  const characteristics = pe.readUInt16LE(22)
  const magic = pe.readUInt16LE(24)
  const optionalSize = pe.readUInt16LE(20)
  return ((machine === 0x14c && magic === 0x10b) || (machine === 0x8664 && magic === 0x20b))
    && (characteristics & 0x2002) === 0x0002 && pe.readUInt16LE(6) > 0
    && optionalSize >= 96 && offset + 24 + optionalSize <= size
}

async function isZip(file: FileHandle, size: number) {
  if (size < 26) return false
  const start = Buffer.alloc(4)
  await file.read(start, 0, 4, 0)
  if (start.readUInt32LE(0) !== 0x04034b50) return false
  const tail = Buffer.alloc(Math.min(size, 22 + 0xffff))
  await file.read(tail, 0, tail.length, size - tail.length)
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) !== 0x06054b50 || offset + 22 + tail.readUInt16LE(offset + 20) !== tail.length) continue
    const centralOffset = tail.readUInt32LE(offset + 16)
    return tail.readUInt16LE(offset + 4) === 0 && tail.readUInt16LE(offset + 6) === 0
      && tail.readUInt16LE(offset + 10) > 0
      && centralOffset + tail.readUInt32LE(offset + 12) === size - tail.length + offset
  }
  return false
}

async function verifyFile(file: string, asset: PackageAsset, signal?: AbortSignal) {
  const before = await lstat(file)
  if (!before.isFile()) throw new Error('更新包不是普通文件')
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    if (stat.ino !== before.ino || stat.dev !== before.dev || !stat.isFile()) throw new Error('更新包文件已变化')
    if (stat.size !== asset.size) throw new Error('更新包大小校验失败')
    const correctType = asset.name.endsWith('.zip') ? await isZip(handle, stat.size) : await isPe(handle, stat.size)
    if (!correctType) throw new Error('更新包文件类型校验失败')
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, signal })) {
      size += chunk.length
      if (size > asset.size) throw new Error('更新包大小校验失败')
      hash.update(chunk)
    }
    if (size !== asset.size) throw new Error('更新包大小校验失败')
    if (hash.digest('hex') !== asset.sha256) throw new Error('更新包 SHA-256 校验失败')
  } finally {
    await handle.close()
  }
}

export class Updater {
  readonly #options: UpdateOptions
  #checking?: AbortController
  #transfer?: AbortController
  #downloadTask?: Promise<UpdateDownload>
  #usingReady = false
  #offer?: { release: Release; kind: UpdateKind }
  #ready?: Downloaded
  #launched = false

  constructor(options: UpdateOptions) {
    this.#options = options
  }

  #requireIdle() {
    if (this.#checking || this.#transfer || this.#usingReady || this.#launched) throw new Error('更新操作正在进行')
  }

  async #removeReady() {
    if (!this.#ready) return
    if (this.#ready.asset.kind === 'setup') await rm(this.#ready.directory, { recursive: true, force: true })
    this.#ready = undefined
  }

  async check(): Promise<UpdateCheck> {
    this.#requireIdle()
    const controller = new AbortController()
    this.#checking = controller
    this.#offer = undefined
    const { version: currentVersion, request } = this.#options
    try {
      await this.#removeReady()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
      const result = await findRelease(request, currentVersion, signal)
      if (result.status !== 'available') return { currentVersion, ...result }
      const kind = await this.#options.kind()
      const { release } = result
      const unavailable = !kind ? '此运行环境不支持 Windows x64 更新包'
        : !release.manifest ? '此版本缺少更新清单'
        : !hasPackage(release, kind) ? (kind === 'setup' ? '此版本缺少安装包' : '此版本缺少便携包')
        : undefined
      if (kind && !unavailable) this.#offer = { release, kind }
      return { status: 'available', currentVersion, version: release.version, notes: release.notes, kind, unavailable }
    } finally {
      this.#checking = undefined
    }
  }

  download(progress: (value: UpdateProgress) => void): Promise<UpdateDownload> {
    this.#requireIdle()
    if (!this.#offer || this.#ready) throw new Error('当前没有可下载的更新')
    const controller = new AbortController()
    this.#transfer = controller
    const task = this.#download(this.#offer, controller, progress).finally(() => {
      this.#transfer = undefined
      this.#downloadTask = undefined
    })
    this.#downloadTask = task
    return task
  }

  async #download(offer: { release: Release; kind: UpdateKind }, controller: AbortController,
    progress: (value: UpdateProgress) => void): Promise<UpdateDownload> {
    const { request, temp } = this.#options
    let directory: string | undefined
    try {
      const asset = await packageFor(request, offer.release, offer.kind,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60 * 60_000)])
      signal.throwIfAborted()
      directory = await mkdtemp(path.join(temp, 'manju-update-'))
      const partial = path.join(directory, '.download')
      const file = path.join(directory, asset.name)
      let received = 0
      let lastProgress = 0
      const target = await open(partial, 'wx', 0o600)
      try {
        const response = await downloadResponse(request, asset, signal)
        for await (const chunk of responseBytes(response, asset.size, '更新包大小校验失败')) {
          signal.throwIfAborted()
          await target.writeFile(chunk)
          received += chunk.byteLength
          const now = Date.now()
          if (received === asset.size || now - lastProgress >= 100) {
            progress({ received, total: asset.size })
            lastProgress = now
          }
        }
      } finally {
        await target.close()
      }
      await verifyFile(partial, asset, signal)
      signal.throwIfAborted()
      await rename(partial, file)
      signal.throwIfAborted()
      this.#ready = { directory, file, asset }
      directory = undefined
      return { status: 'ready', fileName: asset.name }
    } catch (error) {
      if (controller.signal.aborted) return { status: 'canceled' }
      throw error
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }

  cancel() {
    if (!this.#transfer || this.#ready) return false
    this.#transfer.abort()
    return true
  }

  async install(approve: () => Promise<boolean>) {
    this.#requireIdle()
    const ready = this.#ready
    if (ready?.asset.kind !== 'setup') throw new Error('没有已校验的安装包')
    this.#usingReady = true
    try {
      if (await this.#options.kind() !== 'setup') throw new Error('当前运行方式不支持启动安装程序')
      if (!await approve()) return false
      try {
        if (!path.isAbsolute(ready.file) || path.basename(ready.file) !== ready.asset.name || !ready.file.endsWith('-Setup.exe')) {
          throw new Error('安装包路径或文件名无效')
        }
        await verifyFile(ready.file, ready.asset)
      } catch (error) {
        await this.#removeReady()
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('已下载的安装包不存在，请重新下载')
        throw error
      }
      await this.#options.launch(ready.file)
      this.#launched = true
      return true
    } finally {
      this.#usingReady = false
    }
  }

  async openPortable(openFolder: (directory: string) => Promise<void>) {
    this.#requireIdle()
    if (this.#ready?.asset.kind !== 'portable') throw new Error('没有已校验的便携包')
    this.#usingReady = true
    try {
      await openFolder(this.#ready.directory)
    } finally {
      this.#usingReady = false
    }
  }

  async dispose() {
    this.#checking?.abort()
    this.cancel()
    await this.#downloadTask?.catch(() => {})
    if (!this.#launched && this.#ready?.asset.kind === 'setup') await this.#removeReady()
  }
}
