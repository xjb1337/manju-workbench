import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import {
  emptyTrack, extensions, folderNameSchema, mediaTargetSchema, mutationSchema, projectSchema,
  versionSchema, type Episode, type MediaKind, type MediaTarget, type Mutation, type Project, type Shot, type Version,
} from '../shared/model'
import { exportInputsChanged } from '../shared/production'
import { mediaInput, probe, runTool } from './process'

export const projectFilename = 'project.json'
const directoryName = 'media'
const maxProjectBytes = 32 * 1024 * 1024
const maxMediaBytes = 4 * 1024 ** 3

export async function atomicJson(file: string, value: unknown) {
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
    await rename(temp, file)
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

export function findEpisode(project: Project, id: string) {
  const episode = project.episodes.find(item => item.id === id)
  if (!episode) throw new Error('集数不存在')
  return episode
}

function findShot(project: Project, episodeId: string, shotId: string) {
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

function mutate(project: Project, change: Mutation) {
  switch (change.type) {
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
    case 'shot.add':
      findEpisode(project, change.episodeId).shots.push({
        id: randomUUID(), title: change.title, frames: 225, dialogue: '', prompt: '', status: '待制作',
        media: { image: emptyTrack(), video: emptyTrack(), audio: emptyTrack() },
      })
      break
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
  }
}

export function allVersions(project: Project) {
  const media = project.episodes.flatMap(episode => episode.shots.flatMap(shot =>
    Object.values(shot.media).flatMap(track => track.versions)))
  return media.concat([...project.characters, ...project.scenes].flatMap(reference => reference.image.versions))
}

export class ProjectStore {
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(readonly root: string, private document: Project) {}

  static async create(parent: string, titleInput: string, fictional = false) {
    const title = folderNameSchema.parse(titleInput)
    const root = path.join(await realpath(parent), title)
    await mkdir(root)
    const document = projectSchema.parse({
      schemaVersion: 1, id: randomUUID(), title, fictional, script: '', episodes: [], characters: [], scenes: [],
    })
    let mediaCreated = false
    try {
      await mkdir(path.join(root, directoryName))
      mediaCreated = true
      await atomicJson(path.join(root, projectFilename), document)
    } catch (error) {
      if (mediaCreated) await rmdir(path.join(root, directoryName)).catch(() => {})
      await rmdir(root).catch(() => {})
      throw error
    }
    return new ProjectStore(root, document)
  }

  static async open(folder: string) {
    const root = await realpath(folder)
    const file = path.join(root, projectFilename)
    const stat = await checkedFile(file)
    if (stat.size > maxProjectBytes) throw new Error('项目文件超过 32 MiB')
    const document = projectSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    await checkedDirectory(path.join(root, directoryName))
    return new ProjectStore(root, document)
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
    const previous = new Map(this.document.episodes.map(episode => [episode.id, episode]))
    for (const episode of next.episodes) {
      if (!episode.exportRecord || episode.exportRecord.stale) continue
      const before = previous.get(episode.id)
      if (before && exportInputsChanged(before, episode)) episode.exportRecord.stale = true
    }
    const valid = projectSchema.parse(next)
    await atomicJson(path.join(this.root, projectFilename), valid)
    this.document = valid
    return this.snapshot
  }

  edit(input: unknown) {
    const change = mutationSchema.parse(input)
    return this.queue(async () => {
      const next = this.snapshot
      mutate(next, change)
      return this.commit(next)
    })
  }

  recordExport(rendered: Episode) {
    return this.queue(async () => {
      const next = this.snapshot
      const episode = findEpisode(next, rendered.id)
      if (exportInputsChanged(rendered, episode)) throw new Error('成片内容已变更')
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
        const seconds = kind === 'image' ? undefined : Number(stream.duration ?? info.format.duration)
        if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400)) {
          throw new Error('素材时长须大于 0 且不超过 24 小时')
        }
        await runTool('ffmpeg', [
          '-nostdin', '-v', 'error', '-xerror', ...mediaInput(temp, extension),
          ...(kind === 'audio' ? ['-map', '0:a:0', '-t', '0.1'] : ['-map', '0:V:0', '-frames:v', '1']),
          '-f', 'null', '-',
        ], { signal })
        const handle = await open(temp, 'r+')
        try { await handle.sync() } finally { await handle.close() }
        await rename(temp, file)
        archived = true
        const version = versionSchema.parse({ id, name: path.basename(source), extension, createdAt: new Date().toISOString(), seconds })
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
