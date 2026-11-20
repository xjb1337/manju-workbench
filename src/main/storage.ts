import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { lock } from 'proper-lockfile'
import {
  emptyTrack, extensions, folderNameSchema, idSchema, mediaTargetSchema, mutationSchema, projectSchema, projectSchemaVersion,
  versionSchema, type Episode, type MediaKind, type MediaTarget, type Mutation, type Project, type Shot, type Version,
} from '../shared/model'
import { frameSpec, shotMethod, type Ratio } from '../shared/creative'
import { shotPromptBody } from '../shared/prompts'
import type { PlanPreview } from '../shared/plan'
import { z } from 'zod'
import { noteCreativeChanges } from './creative-review'
import { stagePlan } from './plan-import'
import { exportInputsChanged } from '../shared/production'
import { mediaInput, probe, runTool } from './process'

export const projectFilename = 'project.json'
const directoryName = 'media'
const maxProjectBytes = 32 * 1024 * 1024
const maxMediaBytes = 4 * 1024 ** 3

export class ProjectConflictError extends Error {}

export async function safeRename(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 30 * 2 ** attempt))
    }
  }
}

export async function atomicJson(file: string, value: unknown, beforePublish?: () => Promise<void>) {
  const temp = path.join(path.dirname(file), `.${randomUUID()}.tmp`)
  const json = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(json) > maxProjectBytes) throw new Error('项目文件超过 32 MiB')
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(json, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await beforePublish?.()
    await safeRename(temp, file)
    // POSIX directory sync also persists the renamed entry when available.
    if (process.platform !== 'win32') {
      const parent = await open(path.dirname(file), 'r').catch(() => undefined)
      if (parent) {
        await parent.sync().catch(() => {})
        await parent.close().catch(() => {})
      }
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
  return json
}

async function checkedDirectory(file: string) {
  if (!(await lstat(file)).isDirectory()) throw new Error('项目媒体目录无效')
  return file
}

export async function checkedFile(file: string) {
  const stats = await lstat(file)
  if (!stats.isFile()) throw new Error('文件无效')
  return stats
}

async function readProjectFile(file: string) {
  const stats = await checkedFile(file)
  if (stats.size > maxProjectBytes) throw new Error('项目文件超过 32 MiB')
  return readFile(file, 'utf8')
}

export function findEpisode(project: Project, id: string) {
  const episode = project.episodes.find(item => item.id === id)
  if (!episode) throw new Error('集数不存在')
  return episode
}

function parseDuration(raw?: string) {
  if (!raw?.trim()) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function findShot(project: Project, episodeId: string, shotId: string) {
  const shot = findEpisode(project, episodeId).shots.find(item => item.id === shotId)
  if (!shot) throw new Error('镜头不存在')
  return shot
}

function findReference(project: Project, category: 'characters' | 'scenes', id: string) {
  const reference = project[category].find(item => item.id === id)
  if (!reference) throw new Error('参考资料不存在')
  return reference
}

function trackFor(project: Project, target: MediaTarget) {
  return target.scope === 'shot' ? findShot(project, target.episodeId, target.shotId).media[target.kind]
    : findReference(project, target.category, target.referenceId).image
}

function setOmitted(shot: Shot, kind: MediaKind, omitted: boolean) {
  if (omitted) shot.omittedMedia = { ...shot.omittedMedia, [kind]: true }
  else if (shot.omittedMedia) {
    delete shot.omittedMedia[kind]
    if (!Object.keys(shot.omittedMedia).length) delete shot.omittedMedia
  }
}

function resumeMedia(project: Project, target: MediaTarget) {
  if (target.scope === 'shot') setOmitted(findShot(project, target.episodeId, target.shotId), target.kind, false)
}

function duplicateShotTitle(raw: string) {
  const suffix = ' 副本'
  const base = raw.trim()
  if (`${base}${suffix}`.length <= 100) return `${base}${suffix}`
  let trimmed = ''
  for (const char of base) {
    if (trimmed.length + char.length + suffix.length > 100) break
    trimmed += char
  }
  return `${trimmed.trimEnd()}${suffix}`
}

function cloneShotDetails(source: Shot['details']): Shot['details'] | undefined {
  if (!source) return undefined
  const cloned: NonNullable<Shot['details']> = {}
  for (const [kind, detail] of Object.entries(source) as [keyof NonNullable<Shot['details']>, NonNullable<Shot['details']>[keyof NonNullable<Shot['details']>]][]) {
    if (!detail) continue
    const { needsUpdate: _ignored, ...rest } = detail
    cloned[kind] = { ...rest }
  }
  return Object.keys(cloned).length ? cloned : undefined
}

function mutate(project: Project, change: Mutation) {
  switch (change.type) {
    case 'project.brief':
      project.workType = change.workType
      project.brief = change.brief
      break
    case 'shot.detail': {
      const episode = findEpisode(project, change.episodeId)
      const shot = findShot(project, change.episodeId, change.shotId)
      const details = shot.details ??= {}
      const existing = details[change.kind]
      if (change.action.type === 'keep') {
        if (!existing) throw new Error('请先保存提示词')
        delete existing.needsUpdate
      } else if (change.action.type === 'save') {
        if (!change.action.body.trim()) throw new Error('提示词不能为空')
        details[change.kind] = { body: change.action.body, source: 'manual' }
      } else {
        details[change.kind] = { body: shotPromptBody(project, episode, shot, change.kind), source: 'template' }
      }
      break
    }
    case 'shot.apply-voice': {
      const shot = findShot(project, change.episodeId, change.shotId)
      if (shot.dialogue !== change.before || shot.details?.voice?.body !== change.voiceBody) {
        throw new Error('台词或配音稿已变更，请重新预览差异')
      }
      shot.dialogue = change.dialogue
      break
    }
    case 'media.keep': {
      const version = trackFor(project, change.target).versions.find(item => item.id === change.versionId)
      if (!version) throw new Error('素材版本不存在')
      delete version.needsUpdate
      break
    }
    case 'project.edit':
      project.title = change.title
      project.script = change.script
      break
    case 'episode.add':
      project.episodes.push({ id: randomUUID(), title: change.title, script: '', shots: [] })
      break
    case 'episode.edit':
      Object.assign(findEpisode(project, change.episodeId), { title: change.title, script: change.script })
      break
    case 'episode.remove':
      project.episodes = project.episodes.filter(episode => episode.id !== change.episodeId)
      break
    case 'shot.add': {
      const episode = findEpisode(project, change.episodeId)
      const target = project.brief?.targetSeconds
      const frames = target && project.episodes.length === 1 && !episode.shots.length
        ? Math.min(18_000, Math.max(1, Math.round(target * 30))) : 225
      episode.shots.push({
        id: randomUUID(), title: change.title, frames, dialogue: '', prompt: '', status: '待制作',
        ...(project.workType && { method: shotMethod(project) }),
        media: { image: emptyTrack(), video: emptyTrack(), audio: emptyTrack() },
      })
      break
    }
    case 'shot.duplicate': {
      const episode = findEpisode(project, change.episodeId)
      if (episode.shots.length >= 500) throw new Error('每集最多保留 500 个镜头')
      const index = episode.shots.findIndex(shot => shot.id === change.shotId)
      if (index < 0) throw new Error('镜头不存在')
      const source = episode.shots[index]
      const details = cloneShotDetails(source.details)
      const duplicate: Shot = {
        id: randomUUID(),
        title: duplicateShotTitle(source.title),
        frames: source.frames,
        dialogue: source.dialogue,
        prompt: source.prompt,
        ...(source.videoPrompt !== undefined && { videoPrompt: source.videoPrompt }),
        ...(source.method !== undefined && { method: source.method }),
        status: '待制作',
        media: { image: emptyTrack(), video: emptyTrack(), audio: emptyTrack() },
        ...(source.omittedMedia && { omittedMedia: { ...source.omittedMedia } }),
        ...(details && { details }),
      }
      episode.shots.splice(index + 1, 0, duplicate)
      break
    }
    case 'shot.edit':
      Object.assign(findShot(project, change.episodeId, change.shotId), change.fields)
      break
    case 'shot.omit-media':
      setOmitted(findShot(project, change.episodeId, change.shotId), change.kind, change.omitted)
      break
    case 'shot.remove': {
      const episode = findEpisode(project, change.episodeId)
      episode.shots = episode.shots.filter(shot => shot.id !== change.shotId)
      break
    }
    case 'shot.move': {
      const shots = findEpisode(project, change.episodeId).shots
      const index = shots.findIndex(shot => shot.id === change.shotId)
      const neighbor = index + change.direction
      if (index < 0 || neighbor < 0 || neighbor >= shots.length) throw new Error('镜头顺序无效')
      const selected = shots[index]
      shots[index] = shots[neighbor]
      shots[neighbor] = selected
      break
    }
    case 'reference.add':
      project[change.category].push({ id: randomUUID(), title: change.title, notes: '', image: emptyTrack() })
      break
    case 'reference.edit':
      Object.assign(findReference(project, change.category, change.referenceId), { title: change.title, notes: change.notes })
      break
    case 'reference.remove':
      project[change.category] = project[change.category].filter(reference => reference.id !== change.referenceId)
      break
    case 'media.activate': {
      const track = trackFor(project, change.target)
      if (!track.versions.some(version => version.id === change.versionId)) throw new Error('素材版本不存在')
      track.activeId = change.versionId
      resumeMedia(project, change.target)
      break
    }
    case 'media.remove': {
      const track = trackFor(project, change.target)
      const index = track.versions.findIndex(version => version.id === change.versionId)
      if (index < 0) throw new Error('素材版本不存在')
      track.versions.splice(index, 1)
      if (track.activeId === change.versionId) {
        track.activeId = track.versions.at(-1)?.id ?? null
      }
      break
    }
  }
}

export function allVersions(project: Project) {
  const media = project.episodes.flatMap(episode => episode.shots.flatMap(shot =>
    Object.values(shot.media).flatMap(track => track.versions)))
  return media.concat([...project.characters, ...project.scenes].flatMap(reference => reference.image.versions))
}

export class ProjectStore {
  private tail: Promise<unknown> = Promise.resolve()
  private pendingPlan?: { token: string; base: Project; staged: ReturnType<typeof stagePlan> }
  private versionIndex = new Map<string, Version>()

  private constructor(readonly root: string, private document: Project, private savedJson: string) {
    this.rebuildVersionIndex()
  }

  private rebuildVersionIndex() {
    this.versionIndex = new Map(allVersions(this.document).map(version => [version.id, version]))
  }

  findVersion(id: string): Version | undefined {
    const version = this.versionIndex.get(id)
    return version ? { ...version } : undefined
  }

  static async create(parent: string, titleInput: string, fictional = false) {
    const title = folderNameSchema.parse(titleInput)
    const root = path.join(await realpath(parent), title)
    await mkdir(root)
    const document = projectSchema.parse({
      schemaVersion: projectSchemaVersion, id: randomUUID(), title, fictional, script: '', episodes: [], characters: [], scenes: [],
    })
    let mediaCreated = false
    try {
      await mkdir(path.join(root, directoryName))
      mediaCreated = true
      const json = await atomicJson(path.join(root, projectFilename), document)
      return new ProjectStore(root, document, json)
    } catch (error) {
      if (mediaCreated) await rmdir(path.join(root, directoryName)).catch(() => {})
      await rmdir(root).catch(() => {})
      throw error
    }
  }

  static async open(folder: string) {
    const root = await realpath(folder)
    const file = path.join(root, projectFilename)
    const json = await readProjectFile(file)
    const document = projectSchema.parse(JSON.parse(json))
    await checkedDirectory(path.join(root, directoryName))
    return new ProjectStore(root, document, json)
  }

  get needsUpgrade() {
    return this.document.schemaVersion !== projectSchemaVersion
  }

  upgradeCopy(confirm: () => Promise<boolean>) {
    return this.queue(async () => {
      if (!this.needsUpgrade) return this
      if (!await confirm()) return null
      const source = path.join(this.root, projectFilename)
      const assertUnchanged = async () => {
        if (await readProjectFile(source) !== this.savedJson) {
          throw new Error('磁盘上的作品已变更，请重新打开作品后再升级')
        }
      }
      await assertUnchanged()
      const parent = path.dirname(this.root)
      const staging = await mkdtemp(path.join(parent, '.manju-upgrade-'))
      const safeTitle = Array.from(this.document.title).slice(0, 30).join('').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      const name = folderNameSchema.safeParse(`${safeTitle.trim()} - 格式 2 副本`)
      const target = path.join(parent, `${name.success ? name.data : '格式 2 副本'} - ${randomUUID()}`)
      try {
        const sourceMedia = await checkedDirectory(path.join(this.root, directoryName))
        await cp(sourceMedia, path.join(staging, directoryName), {
          recursive: true, force: false, errorOnExist: true,
          filter: async entry => {
            const info = await lstat(entry)
            if (!info.isFile() && !info.isDirectory()) throw new Error('媒体目录包含链接或特殊文件，无法安全复制')
            return true
          },
        })
        for (const version of this.versionIndex.values()) {
          await checkedFile(path.join(staging, directoryName, `${version.id}.${version.extension}`))
        }
        const document = projectSchema.parse({ ...this.document, schemaVersion: projectSchemaVersion })
        const json = await atomicJson(path.join(staging, projectFilename), document)
        await assertUnchanged()
        await safeRename(staging, target)
        const copy = new ProjectStore(target, document, json)
        if (this.pendingPlan?.base === this.document) {
          copy.pendingPlan = { ...this.pendingPlan, base: document }
        }
        return copy
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  private assertWritable() {
    if (this.needsUpgrade) throw new Error('请先保留原件并升级副本')
  }

  get snapshot() {
    return structuredClone(this.document)
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }

  private async commit(next: Project) {
    this.assertWritable()
    noteCreativeChanges(this.document, next)
    const ratioChanged = frameSpec(this.document).ratio !== frameSpec(next).ratio
    const previous = new Map(this.document.episodes.map(episode => [episode.id, episode]))
    for (const episode of next.episodes) {
      if (!episode.exportRecord || episode.exportRecord.stale) continue
      const before = previous.get(episode.id)
      if (before && (ratioChanged || exportInputsChanged(before, episode, this.document, next))) episode.exportRecord.stale = true
    }
    const valid = projectSchema.parse({ ...next, schemaVersion: projectSchemaVersion })
    const file = path.join(this.root, projectFilename)
    let compromised = false
    const release = await lock(file, {
      realpath: false, retries: { retries: 3, minTimeout: 50 },
      onCompromised: () => { compromised = true },
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ELOCKED') throw new Error('其他窗口正在保存此作品，请稍后重试')
      throw error
    })
    try {
      this.savedJson = await atomicJson(file, valid, async () => {
        if (await readProjectFile(file) !== this.savedJson || compromised) {
          throw new ProjectConflictError('磁盘上的作品已变更，请重新打开作品后再保存')
        }
      })
      this.document = valid
      this.rebuildVersionIndex()
      return this.snapshot
    } finally {
      await release().catch(error => console.error('project:release-lock', error))
    }
  }

  edit(input: unknown) {
    const change = mutationSchema.parse(input)
    return this.queue(async () => {
      const next = this.snapshot
      const removedVersion = change.type === 'media.remove' ? this.findVersion(change.versionId) : undefined
      mutate(next, change)
      const committed = await this.commit(next)
      if (removedVersion && !this.versionIndex.has(removedVersion.id)) {
        await this.removeMediaFile(removedVersion)
      }
      return committed
    })
  }

  private async removeMediaFile(version: Version) {
    try {
      const directory = await checkedDirectory(path.join(this.root, directoryName))
      const file = path.join(directory, `${version.id}.${version.extension}`)
      const stats = await lstat(file).catch(() => undefined)
      if (stats?.isFile()) await rm(file, { force: true })
    } catch {
      // Best-effort cleanup after project metadata has been committed.
    }
  }

  private async scanOrphanMedia(remove: boolean): Promise<{ count: number; bytes: number }> {
    const directory = await checkedDirectory(path.join(this.root, directoryName))
    const normalizeName = (name: string) => (process.platform === 'win32' ? name.toLowerCase() : name)
    const referenced = new Set(
      Array.from(this.versionIndex.values(), version => normalizeName(`${version.id}.${version.extension}`)),
    )
    const entries = await readdir(directory, { withFileTypes: true })
    let count = 0
    let bytes = 0
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (referenced.has(normalizeName(entry.name))) continue
      const file = path.join(directory, entry.name)
      const stats = await lstat(file).catch(() => undefined)
      if (!stats?.isFile()) continue
      if (remove) {
        try {
          await rm(file)
        } catch {
          continue
        }
      }
      count += 1
      bytes += stats.size
    }
    return { count, bytes }
  }

  inspectOrphanMedia() {
    return this.queue(() => this.scanOrphanMedia(false))
  }

  cleanOrphanMedia() {
    return this.queue(() => {
      this.assertWritable()
      return this.scanOrphanMedia(true)
    })
  }

  previewPlan(episodeInput: unknown, input: unknown, source: 'import' | 'magpie' = 'import'): Promise<PlanPreview> {
    const episodeId = idSchema.nullable().parse(episodeInput)
    return this.queue(async () => {
      this.pendingPlan = undefined
      const staged = stagePlan(this.snapshot, episodeId, input, source)
      const token = randomUUID()
      this.pendingPlan = { token, base: this.document, staged }
      return { token, changes: staged.changes }
    })
  }

  mergePlan(tokenInput: unknown, choicesInput: unknown) {
    const token = idSchema.parse(tokenInput)
    const choices = z.array(z.string().regex(/^\d+$/)).max(5000).parse(choicesInput)
    return this.queue(async () => {
      this.assertWritable()
      const pending = this.pendingPlan
      if (!pending || pending.token !== token || pending.base !== this.document) {
        throw new Error('规划预览已失效，请重新预览')
      }
      if (!pending.staged.changes.length) throw new Error('没有可合并的变更')
      const next = pending.staged.apply(choices)
      this.pendingPlan = undefined
      return this.commit(next)
    })
  }

  recordExport(rendered: Episode, ratio: Ratio = frameSpec(this.document).ratio, renderedProject = this.document) {
    return this.queue(async () => {
      const next = this.snapshot
      const episode = findEpisode(next, rendered.id)
      if (frameSpec(next).ratio !== ratio || exportInputsChanged(rendered, episode, renderedProject, next)) throw new Error('成片内容已变更')
      episode.exportRecord = { exportedAt: new Date().toISOString(), stale: false }
      return this.commit(next)
    })
  }

  async assetPath(version: Version) {
    const directory = await checkedDirectory(path.join(this.root, directoryName))
    const checked = versionSchema.parse(version)
    const file = path.join(directory, `${checked.id}.${checked.extension}`)
    await checkedFile(file)
    return file
  }

  importMedia(input: unknown, source: string) {
    const target = mediaTargetSchema.parse(input)
    const kind: MediaKind = target.scope === 'shot' ? target.kind : 'image'
    return this.queue(async () => {
      this.assertWritable()
      const project = this.snapshot
      const track = trackFor(project, target)
      const extension = path.extname(source).slice(1).toLowerCase()
      if (!extensions[kind].includes(extension)) throw new Error('文件扩展名与素材类型不匹配')
      const stat = await checkedFile(source)
      if (stat.size < 1 || stat.size > maxMediaBytes) throw new Error('素材大小须在 1 字节至 4 GiB 之间')
      const id = randomUUID()
      const directory = await checkedDirectory(path.join(this.root, directoryName))
      const temp = path.join(directory, `.${id}.tmp`)
      const file = path.join(directory, `${id}.${extension}`)
      let archived = false
      try {
        await copyFile(source, temp, constants.COPYFILE_EXCL)
        const copied = await checkedFile(temp)
        if (copied.size < 1 || copied.size > maxMediaBytes) throw new Error('素材大小须在 1 字节至 4 GiB 之间')
        const signal = AbortSignal.timeout(60_000)
        const info = await probe(temp, extension, signal)
        const video = info.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
        const audio = info.streams.find(stream => stream.codec_type === 'audio')
        const stream = kind === 'audio' ? audio : video
        if (!stream || (kind === 'audio' && video)) throw new Error('文件内容与素材类型不匹配')
        if (kind !== 'audio' && (!video?.width || !video.height || video.width * video.height > 50_000_000)) {
          throw new Error('素材图像尺寸无效或超过 5,000 万像素')
        }
        const imageCodec = ({ jpg: 'mjpeg', jpeg: 'mjpeg', png: 'png', webp: 'webp' } as Record<string, string>)[extension]
        if (kind === 'image' && stream.codec_name !== imageCodec) throw new Error('文件内容与素材类型不匹配')
        const seconds = kind === 'image' ? undefined : (parseDuration(stream.duration) ?? parseDuration(info.format.duration))
        if (kind !== 'image' && (seconds === undefined || seconds > 86_400)) {
          throw new Error('素材时长须大于 0 且不超过 24 小时')
        }
        await runTool('ffmpeg', [
          '-nostdin', '-v', 'error', '-xerror', ...mediaInput(temp, extension),
          ...(kind === 'audio' ? ['-map', '0:a:0', '-t', '0.1'] : ['-map', '0:V:0', '-frames:v', '1']),
          '-f', 'null', '-',
        ], { signal })
        const handle = await open(temp, 'r+')
        try { await handle.sync() } finally { await handle.close() }
        await safeRename(temp, file)
        archived = true
        const version = versionSchema.parse({
          id, name: path.basename(source), extension, createdAt: new Date().toISOString(),
          ...(seconds !== undefined && { seconds }),
          ...(kind === 'video' && { hasAudio: !!audio }),
        })
        track.versions.push(version)
        track.activeId = id
        resumeMedia(project, target)
        return await this.commit(project)
      } catch (error) {
        if (archived) await rm(file, { force: true }).catch(() => {})
        throw error
      } finally {
        await rm(temp, { force: true }).catch(() => {})
      }
    })
  }
}
