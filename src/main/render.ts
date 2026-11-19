import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import { shotMedia, shotVisual, folderNameSchema, totalFrames, type Episode, type Shot } from '../shared/model'
import { frameSpec, shotMethod, usesFinishedVideo, type FrameSpec, type ShotMethod } from '../shared/creative'
import type { Project } from '../shared/model'
import { mediaInput, probe, runTool } from './process'
import { checkedFile, type ProjectStore } from './storage'

const fps = 30
const sampleRate = 48_000
const cjkUnit = 100
const asciiUnit = 55
const shotCacheVersion = 'shot-cache-v2'

export function subtitleText(value: string) {
  // ASS override delimiters and backslash escapes are reserved markup.
  const punctuation: Record<string, string> = { '\\': '＼', '{': '｛', '}': '｝' }
  return value.trim().replace(/[\\{}]/g, char => punctuation[char])
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '').replace(/\r\n|\r|\n/g, '\\N')
}

function assTime(frames: number) {
  const centiseconds = Math.floor(frames * 100 / fps)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${Math.floor(centiseconds / 360_000)}:${pad(Math.floor(centiseconds / 6000) % 60)}:${pad(Math.floor(centiseconds / 100) % 60)}.${pad(centiseconds % 100)}`
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function wrapLine(line: string, maxUnits: number) {
  const segments = Array.from(graphemes.segment(line), item => item.segment)
  if (!segments.length) return ['']
  const tokens: { text: string; width: number; isSpace: boolean }[] = []
  let asciiRun = ''
  let asciiWidth = 0
  const flushAscii = () => {
    if (!asciiRun) return
    tokens.push({ text: asciiRun, width: asciiWidth, isSpace: false })
    asciiRun = ''
    asciiWidth = 0
  }
  for (const segment of segments) {
    if (segment === ' ') {
      flushAscii()
      tokens.push({ text: segment, width: asciiUnit, isSpace: true })
    } else if (/^[\x21-\x7e]$/.test(segment)) {
      asciiRun += segment
      asciiWidth += asciiUnit
    } else {
      flushAscii()
      tokens.push({ text: segment, width: /^[\x20-\x7e]$/.test(segment) ? asciiUnit : cjkUnit, isSpace: false })
    }
  }
  flushAscii()

  const wrapped: string[] = []
  let current = ''
  let currentWidth = 0
  let justWrapped = false

  const pushCurrent = () => {
    const trimmed = current.replace(/ +$/, '')
    if (trimmed || !justWrapped) wrapped.push(trimmed)
    current = ''
    currentWidth = 0
    justWrapped = true
  }

  for (const token of tokens) {
    if (token.isSpace) {
      if (justWrapped && !current) continue
      if (currentWidth + token.width <= maxUnits) {
        current += token.text
        currentWidth += token.width
      } else {
        pushCurrent()
      }
      continue
    }
    justWrapped = false
    if (currentWidth + token.width <= maxUnits) {
      current += token.text
      currentWidth += token.width
      continue
    }
    if (current.trimEnd()) pushCurrent()
    else {
      current = ''
      currentWidth = 0
    }
    if (token.width <= maxUnits) {
      current = token.text
      currentWidth = token.width
      justWrapped = false
      continue
    }
    // Single ASCII/code token wider than a line: fall back to grapheme wrapping.
    for (const ch of token.text) {
      if (currentWidth + asciiUnit > maxUnits && current) {
        wrapped.push(current)
        current = ch
        currentWidth = asciiUnit
      } else {
        current += ch
        currentWidth += asciiUnit
      }
    }
    justWrapped = false
  }
  if (current || !wrapped.length) {
    const finalLine = justWrapped ? current.replace(/ +$/, '') : current
    if (finalLine || !wrapped.length) wrapped.push(finalLine)
  }
  return wrapped
}

export function subtitles(shot: Shot, { width, height, subtitle }: FrameSpec) {
  const maxColumns = Math.floor((width - subtitle.horizontal * 2) / (subtitle.size * 1.15))
  const maxUnits = Math.max(cjkUnit, maxColumns * cjkUnit)
  const lines = subtitleText(shot.dialogue).split('\\N').flatMap(line => wrapLine(line, maxUnits))
  const linesPerPage = 4
  const pages = Math.ceil(lines.length / linesPerPage)
  if (pages > shot.frames) throw new Error('镜头时长不足以显示全部字幕，请缩短台词或延长镜头')
  const events = Array.from({ length: pages }, (_, index) => {
    const start = Math.floor(index * shot.frames / pages)
    const end = Math.floor((index + 1) * shot.frames / pages)
    const text = lines.slice(index * linesPerPage, (index + 1) * linesPerPage).join('\\N')
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Chinese,,0,0,0,,${text}`
  }).join('\n')
  const font = process.platform === 'win32' ? 'Microsoft YaHei' : 'Noto Sans CJK SC'
  return `[Script Info]
ScriptType: v4.00+
WrapStyle: 2
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Chinese,${font},${subtitle.size},&H00FFFFFF,&H00FFFFFF,&H00141020,&H00141020,0,0,0,0,100,100,0,0,1,3,1,2,${subtitle.horizontal},${subtitle.horizontal},${subtitle.bottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`
}

function seconds(frames: number) {
  return (frames / fps).toFixed(9)
}

async function renameWithRetry(from: string, to: string) {
  const delays = [30, 60, 120, 240, 480]
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY') || attempt >= delays.length) throw error
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
}

type ShotInputs = {
  method: ShotMethod
  visual: ReturnType<typeof shotVisual>
  voice: ReturnType<typeof shotMedia>
  embeddedAudio: boolean
  visualPath?: string
  voicePath?: string
}

/** Resolves shot media tracks, validates source files on disk, and probes legacy video audio once. */
async function resolveShotInputs(store: ProjectStore, project: Project, shot: Shot, signal: AbortSignal): Promise<ShotInputs> {
  const method = shotMethod(project, shot)
  const visual = shotVisual(shot, method)
  const video = visual?.kind === 'video' ? visual.version : undefined
  const voice = shotMedia(shot, 'audio', method)
  const visualPath = visual && await store.assetPath(visual.version)
  const voicePath = voice && await store.assetPath(voice)
  let embeddedAudio = false
  // Probe earlier manifests that predate the embedded-audio marker.
  if (!voice && !shot.omittedMedia?.audio && video && usesFinishedVideo(method)) {
    if (video.hasAudio !== undefined) {
      embeddedAudio = video.hasAudio
    } else {
      embeddedAudio = (await probe(visualPath!, video.extension, signal)).streams.some(stream => stream.codec_type === 'audio')
    }
  }
  return { method, visual, voice, embeddedAudio, visualPath, voicePath }
}

/** Computes a deterministic SHA-256 key covering all inputs that affect a shot's rendered output. */
async function shotCacheKey(spec: FrameSpec, shot: Shot, inputs: ShotInputs, signal: AbortSignal) {
  const { method, visual, voice, embeddedAudio, visualPath, voicePath } = inputs
  const visualHash = visualPath && await fileFingerprint(visualPath, signal)
  const voiceHash = voicePath && await fileFingerprint(voicePath, signal)
  return createHash('sha256').update(JSON.stringify({
    version: shotCacheVersion,
    spec: {
      ratio: spec.ratio,
      width: spec.width,
      height: spec.height,
      subtitle: {
        size: spec.subtitle.size,
        horizontal: spec.subtitle.horizontal,
        bottom: spec.subtitle.bottom,
      },
    },
    frames: shot.frames,
    dialogue: shot.dialogue,
    method,
    visual: visual ? {
      kind: visual.kind,
      id: visual.version.id,
      extension: visual.version.extension,
      hash: visualHash,
    } : null,
    voice: voice ? {
      id: voice.id,
      extension: voice.extension,
      hash: voiceHash,
    } : null,
    embeddedAudio,
  })).digest('hex')
}

async function fileFingerprint(file: string, signal: AbortSignal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  signal.throwIfAborted()
  return hash.digest('hex')
}

async function linkOrCopy(source: string, target: string) {
  try {
    await link(source, target)
  } catch {
    await copyFile(source, target)
  }
}

async function tryUseShotCache(entry: string, workFile: string, signal: AbortSignal) {
  try {
    const expected = await readFile(path.join(entry, 'sha256'), 'utf8')
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('缓存校验值无效')
    await linkOrCopy(path.join(entry, 'fragment.mov'), workFile)
    if (await fileFingerprint(workFile, signal) === expected) return true
  } catch {
    signal.throwIfAborted()
  }
  await rm(workFile, { force: true }).catch(() => {})
  await rm(entry, { recursive: true, force: true }).catch(() => {})
  return false
}

async function writeShotCache(workFile: string, cacheDir: string, hash: string, signal: AbortSignal) {
  let staging: string | undefined
  try {
    const digest = await fileFingerprint(workFile, signal)
    staging = await mkdtemp(path.join(cacheDir, '.fragment-'))
    await linkOrCopy(workFile, path.join(staging, 'fragment.mov'))
    await writeFile(path.join(staging, 'sha256'), digest, 'utf8')
    signal.throwIfAborted()
    // Publish the fragment and its checksum together. An identical concurrent shot can win the rename.
    await renameWithRetry(staging, path.join(cacheDir, hash))
  } catch {
    // Cache writes are best-effort and must not fail the main render.
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

async function encodeShot(
  store: ProjectStore,
  shot: Shot,
  index: number,
  file: string,
  cwd: string,
  spec: FrameSpec,
  inputs: ShotInputs,
  signal: AbortSignal,
  onProgress?: (ratio: number) => void,
) {
  const { width, height } = spec
  const { visual, voice, embeddedAudio } = inputs
  const visualPath = inputs.visualPath ?? (visual && await store.assetPath(visual.version))
  const visualArgs = visual && visualPath ? mediaInput(visualPath, visual.version.extension)
    : ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`]
  const voicePath = inputs.voicePath ?? (voice && await store.assetPath(voice))
  const audioArgs = embeddedAudio ? [] : voice && voicePath ? mediaInput(voicePath, voice.extension)
    : ['-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=mono`]
  const captionFile = `caption-${index}.ass`
  const caption = subtitleText(shot.dialogue)
  if (caption) await writeFile(path.join(cwd, captionFile), subtitles(shot, spec), 'utf8')
  const videoFilter = [
    'setpts=PTS-STARTPTS',
    `fps=${fps}:eof_action=pass`,
    `scale=w='max(2,trunc(min(${width},${height}*dar)/2)*2)':h='max(2,trunc(min(${height},${width}/dar)/2)*2)'`,
    'setsar=1',
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    ...(visual ? ['tpad=stop_mode=clone:stop=-1'] : []),
    `trim=end_frame=${shot.frames}`,
    ...(caption ? [`subtitles=${captionFile}`] : []),
  ].join(',')
  const audioFilter = `aresample=${sampleRate}:first_pts=0,asetpts=N/SR/TB,apad,atrim=end_sample=${shot.frames * (sampleRate / fps)}`
  const totalUs = (shot.frames / fps) * 1_000_000
  await runTool('ffmpeg', [
    '-nostdin', '-v', 'error', '-xerror', '-progress', 'pipe:1', '-filter_threads', '2', ...visualArgs, ...audioArgs,
    '-map', '0:V:0', '-map', embeddedAudio ? '0:a:0' : '1:a:0', '-vf', videoFilter, '-af', audioFilter,
    '-c:v', 'libx264', '-threads:v', '3', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-bf', '0', '-video_track_timescale', '30000', '-color_range', 'tv', '-colorspace', 'bt709',
    '-c:a', 'pcm_s16le', '-ar', String(sampleRate), '-ac', '2', '-map_metadata', '-1', '-map_chapters', '-1',
    '-f', 'mov', file,
  ], {
    cwd,
    signal,
    onStdoutLine: onProgress ? line => {
      if (line.startsWith('out_time_us=')) {
        const us = Number(line.slice('out_time_us='.length))
        if (Number.isFinite(us) && us >= 0) onProgress(Math.min(1, us / totalUs))
      } else if (line === 'progress=end') {
        onProgress(1)
      }
    } : undefined,
  })
}

export async function exportDestination(requested: string, projectRoot: string) {
  if (path.extname(requested).toLowerCase() !== '.mp4') throw new Error('导出文件名必须以 .mp4 结尾')
  const basename = path.basename(requested)
  const name = folderNameSchema.parse(basename)
  if (name !== basename) throw new Error('导出文件名首尾不能包含空白字符')
  const target = path.join(await realpath(path.dirname(requested)), name)
  const relative = path.relative(path.join(projectRoot, 'media'), target)
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('不能导出到项目媒体目录')
  }
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (existing && !existing.isFile()) throw new Error('导出目标必须是普通文件')
  return target
}

export async function renderEpisode(
  store: ProjectStore,
  episode: Episode,
  destination: string,
  options: { signal: AbortSignal; progress?: (percent: number) => void; publish?: () => void; project?: Project; cacheDir?: string },
) {
  const project = options.project ?? store.snapshot
  const spec = frameSpec(project)
  const { width, height } = spec
  if (!episode.shots.length) throw new Error('请先新建镜头')
  let workDir: string | undefined
  let publishDir: string | undefined
  try {
    workDir = await mkdtemp(path.join(tmpdir(), 'manju-render-work-'))
    publishDir = await mkdtemp(path.join(path.dirname(destination), '.manju-render-'))
    const total = totalFrames(episode)
    const files = episode.shots.map((_, i) => `shot-${i}.mov`)
    const shotProgress = new Array<number>(episode.shots.length).fill(0)
    const batchController = new AbortController()
    const batchSignal = AbortSignal.any([options.signal, batchController.signal])
    let lastPercent = -1
    const reportProgress = () => {
      if (!options.progress || batchSignal.aborted) return
      let completedFrames = 0
      for (let i = 0; i < episode.shots.length; i++) completedFrames += episode.shots[i].frames * shotProgress[i]
      const percent = Math.min(94, Math.max(0, Math.floor(94 * completedFrames / total)))
      if (percent > lastPercent) {
        lastPercent = percent
        options.progress(percent)
      }
    }
    const shotCacheFills = new Map<string, Promise<void>>()
    let next = 0
    let firstError: Error | undefined
    const worker = async () => {
      while (next < episode.shots.length) {
        if (batchSignal.aborted) return
        const i = next++
        const shot = episode.shots[i]
        try {
          batchSignal.throwIfAborted()
          const inputs = await resolveShotInputs(store, project, shot, batchSignal)
          const cacheDir = options.cacheDir
          const hash = cacheDir && await shotCacheKey(spec, shot, inputs, batchSignal)
          const workFile = path.join(workDir!, files[i])
          const encode = () => encodeShot(store, shot, i, files[i], workDir!, spec, inputs, batchSignal, ratio => {
            shotProgress[i] = Math.max(shotProgress[i], ratio)
            reportProgress()
          })
          if (cacheDir && hash) {
            while (shotCacheFills.has(hash)) await shotCacheFills.get(hash)
            const useOrFill = async () => {
              if (await tryUseShotCache(path.join(cacheDir, hash), workFile, batchSignal)) return
              await encode()
              const afterEncode = await shotCacheKey(spec, shot, inputs, batchSignal).catch(() => undefined)
              if (afterEncode === hash) await writeShotCache(workFile, cacheDir, hash, batchSignal)
            }
            const fill = useOrFill()
            shotCacheFills.set(hash, fill)
            try {
              await fill
            } finally {
              if (shotCacheFills.get(hash) === fill) shotCacheFills.delete(hash)
            }
          } else {
            await encode()
          }
          shotProgress[i] = 1
          reportProgress()
        } catch (error) {
          options.signal.throwIfAborted()
          if (batchController.signal.aborted) return
          const detail = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '素材文件不存在' : (error as Error).message
          const wrapped = new Error(`镜头 ${i + 1} · ${detail}`, { cause: error })
          firstError ??= wrapped
          batchController.abort(wrapped)
          return
        }
      }
    }
    const concurrency = Math.min(3, Math.max(1, Math.floor(availableParallelism() / 3)), episode.shots.length)
    await Promise.all(Array.from({ length: concurrency }, worker))
    options.signal.throwIfAborted()
    if (firstError) throw firstError
    const manifest = ['ffconcat version 1.0', ...episode.shots.flatMap((shot, i) => [
      `file '${files[i]}'`,
      `duration ${seconds(shot.frames)}`,
    ])]
    await writeFile(path.join(workDir, 'episode.ffconcat'), manifest.join('\n') + '\n')
    const complete = path.join(publishDir, 'complete.mp4')
    await runTool('ffmpeg', [
      '-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-f', 'concat', '-safe', '1', '-i', 'episode.ffconcat',
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', complete,
    ], { cwd: workDir, signal: options.signal })
    const info = await probe(complete, 'mp4', options.signal)
    const video = info.streams.find(stream => stream.codec_type === 'video')
    const audio = info.streams.find(stream => stream.codec_type === 'audio')
    if (video?.codec_name !== 'h264' || video.width !== width || video.height !== height
      || audio?.codec_name !== 'aac' || Math.abs(Number(info.format.duration ?? 0) - total / fps) > 0.10) {
      throw new Error('成片的音视频轨或时长校验失败')
    }
    await checkedFile(complete)
    const handle = await open(complete, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    options.signal.throwIfAborted()
    options.publish?.()
    await renameWithRetry(complete, destination)
    options.progress?.(100)
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    if (publishDir) await rm(publishDir, { recursive: true, force: true }).catch(() => {})
  }
}
