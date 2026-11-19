import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { UpdateKind } from '../shared/api'

const repository = '/xjb1337/manju-workbench'
const releasesUrl = `https://api.github.com/repos${repository}/releases`
const assetHosts = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const stableVersion = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const maxPackageSize = 2 * 1024 ** 3
const maxManifestSize = 64 * 1024
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/)
const releaseSchema = z.object({ tag_name: z.string().max(256), draft: z.boolean(), prerelease: z.boolean() })
const releaseDetails = z.object({
  body: z.string().max(262_144).nullish(),
  assets: z.array(z.object({ name: z.string() }).loose()).max(1000),
})
const githubAsset = z.object({
  name: z.string(),
  state: z.literal('uploaded'),
  size: z.number().int().positive().max(maxPackageSize),
  digest: z.string().regex(/^sha256:[a-fA-F0-9]{64}$/).nullish(),
  browser_download_url: z.string().max(2048),
})
const manifest = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.string().regex(stableVersion),
  assets: z.array(z.strictObject({
    fileName: z.string().max(90),
    size: z.number().int().positive().max(maxPackageSize),
    sha256,
    kind: z.enum(['setup', 'portable']),
  })).min(1).max(2),
})

type GitHubAsset = { name: string; size: number; url: URL; digest?: string }
export type PackageAsset = GitHubAsset & { kind: UpdateKind; sha256: string }
export type Release = { version: string; notes: string; manifest: GitHubAsset | null; packages: Map<string, GitHubAsset> }
export type UpdateRequest = (url: URL, init: RequestInit) => Promise<Response>

function versionOrder(left: string, right: string) {
  const [major, minor, patch] = left.split('.').map(Number)
  const [otherMajor, otherMinor, otherPatch] = right.split('.').map(Number)
  return major - otherMajor || minor - otherMinor || patch - otherPatch
}

function packageNames(version: string, kind: UpdateKind) {
  const base = `Manju-Workbench-${version}-x64`
  return kind === 'setup' ? [`${base}-Setup.exe`] : [`${base}-Portable.exe`, `${base}-Portable.zip`]
}

function trustedAssetUrl(url: URL, original: URL) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash
    && assetHosts.has(url.hostname) && (url.hostname !== 'github.com' || url.href === original.href)
}

function assetMetadata(raw: unknown, tag: string, name: string): GitHubAsset {
  const record = githubAsset.safeParse(raw)
  if (!record.success) throw new Error('GitHub 发布附件信息无效')
  const asset = record.data
  const expected = new URL(`https://github.com${repository}/releases/download/${tag}/${name}`)
  if (asset.browser_download_url !== expected.href) throw new Error('发布附件地址不属于指定 GitHub 仓库')
  return { name, size: asset.size, url: expected, digest: asset.digest?.slice(7).toLowerCase() }
}

async function get(request: UpdateRequest, url: URL, signal: AbortSignal, asset?: GitHubAsset) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    let response: Response
    try {
      response = await request(url, {
        redirect: 'manual', credentials: 'omit', signal,
        headers: { 'User-Agent': 'Manju-Workbench', Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json' },
      })
    } catch (cause) {
      throw new Error('更新网络连接失败，请检查网络后重试', { cause })
    }
    if (response.redirected || response.url !== url.href) {
      await response.body?.cancel().catch(() => {})
      throw new Error('更新响应来自未经校验的地址')
    }
    if (response.status === 200) return response
    await response.body?.cancel().catch(() => {})
    if (asset && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      let next: URL | undefined
      try { if (location) next = new URL(location, url) } catch { /* Reject invalid locations below. */ }
      if (!next || !trustedAssetUrl(next, asset.url)) throw new Error('更新下载重定向到不受信任的地址')
      url = next
    } else {
      throw new Error(`GitHub 更新请求失败（HTTP ${response.status}）`)
    }
  }
  throw new Error('更新下载重定向次数过多')
}

export async function* responseBytes(response: Response, maxBytes: number, sizeError: string) {
  if (!response.body) throw new Error('更新响应为空')
  const reader = response.body.getReader()
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read().catch(cause => {
        throw new Error('更新网络连接中断，请重试', { cause })
      })
      if (chunk.done) return
      size += chunk.value.byteLength
      if (size > maxBytes) throw new Error(sizeError)
      yield chunk.value
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function readJson(response: Response, limit: number, label: string, expectedSize?: number, digest?: string) {
  const chunks: Uint8Array[] = []
  for await (const chunk of responseBytes(response, limit, `${label}大小超出限制`)) chunks.push(chunk)
  const bytes = Buffer.concat(chunks)
  if (expectedSize !== undefined && bytes.length !== expectedSize) throw new Error(`${label}大小与发布数据不符`)
  if (digest && createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error(`${label}的 SHA-256 校验失败`)
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  catch { throw new Error(`${label}不是有效的 UTF-8 JSON`) }
}

export async function findRelease(request: UpdateRequest, currentVersion: string, signal: AbortSignal) {
  if (!stableVersion.test(currentVersion)) throw new Error('当前应用版本号无效')
  let latest: { tag: string; version: string; raw: unknown } | undefined
  let invalidVersion = false
  for (let page = 1; ; page++) {
    if (page > 20) throw new Error('GitHub 发布列表超出检查范围')
    const url = new URL(releasesUrl)
    url.search = `?per_page=100&page=${page}`
    const raw = await readJson(await get(request, url, signal), 16 * 1024 ** 2, 'GitHub 发布列表')
    const list = z.array(releaseSchema).max(100).safeParse(raw)
    if (!list.success || !Array.isArray(raw)) throw new Error('GitHub 发布列表格式无效')
    for (const [index, entry] of list.data.entries()) {
      if (entry.draft || entry.prerelease) continue
      const version = entry.tag_name.replace(/^v/, '')
      if (!stableVersion.test(version)) {
        invalidVersion = true
        continue
      }
      if (!latest || versionOrder(version, latest.version) > 0) latest = { tag: entry.tag_name, version, raw: raw[index] }
    }
    if (list.data.length < 100) break
  }
  if (!latest) {
    if (invalidVersion) throw new Error('正式 Release 缺少有效版本号')
    return { status: 'none' } as const
  }
  const details = releaseDetails.safeParse(latest.raw)
  if (!details.success) throw new Error('GitHub 正式发布信息格式无效')
  const { version, tag } = latest
  const notes = details.data.body ?? ''
  if (versionOrder(version, currentVersion) <= 0) return { status: 'latest', version, notes } as const

  const manifestName = `Manju-Workbench-${version}-win-x64.manifest.json`
  const names = new Set([manifestName, ...packageNames(version, 'setup'), ...packageNames(version, 'portable')])
  const packages = new Map<string, GitHubAsset>()
  for (const asset of details.data.assets) {
    if (!names.has(asset.name)) continue
    if (packages.has(asset.name)) throw new Error('GitHub 发布包含重名附件')
    packages.set(asset.name, assetMetadata(asset, tag, asset.name))
  }
  const release: Release = { version, notes, manifest: packages.get(manifestName) ?? null, packages }
  return { status: 'available', release } as const
}

export function hasPackage(release: Release, kind: UpdateKind) {
  return packageNames(release.version, kind).some(name => release.packages.has(name))
}

export async function packageFor(request: UpdateRequest, release: Release, kind: UpdateKind, signal: AbortSignal) {
  const file = release.manifest
  if (!file || file.size > maxManifestSize) throw new Error('此版本缺少有效的更新清单')
  const raw = await readJson(await get(request, file.url, signal, file), file.size, '更新清单', file.size, file.digest)
  const list = manifest.safeParse(raw)
  if (!list.success || list.data.version !== release.version) throw new Error('更新清单格式或版本无效')
  const packages = new Map<UpdateKind, PackageAsset>()
  for (const entry of list.data.assets) {
    if (!packageNames(release.version, entry.kind).includes(entry.fileName) || packages.has(entry.kind)) {
      throw new Error('更新清单中的文件名或包类型无效')
    }
    const asset = release.packages.get(entry.fileName)
    if (!asset || asset.size !== entry.size) throw new Error('更新清单中的文件名或大小与 GitHub 发布附件不符')
    const expected = entry.sha256.toLowerCase()
    if (asset.digest && expected !== asset.digest) throw new Error('更新清单的 SHA-256 与 GitHub 发布附件不符')
    packages.set(entry.kind, { ...asset, kind: entry.kind, sha256: expected })
  }
  const selected = packages.get(kind)
  if (!selected) throw new Error(kind === 'setup' ? '更新清单中没有安装包' : '更新清单中没有便携包')
  return selected
}

export function downloadResponse(request: UpdateRequest, asset: PackageAsset, signal: AbortSignal) {
  return get(request, asset.url, signal, asset)
}
