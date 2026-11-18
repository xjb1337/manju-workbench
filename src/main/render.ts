import { lstat, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { activeVersion, folderNameSchema, totalFrames, type Episode, type Shot } from '../shared/model'
import { mediaInput, probe, runTool } from './process'
import { checkedFile, type ProjectStore } from './storage'

const width = 1280
const height = 720
const fps = 30
const sampleRate = 48_000

export function subtitleText(value: string) {
  // ASS override delimiters and backslash escapes are reserved markup.
  const punctuation: Record<string, string> = { '\\': '＼', '{': '｛', '}': '｝' }
  return value.trim().replace(/[\\{}]/g, char => punctuation[char])
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '').replace(/\r\n|\r|\n/g, '\\N')
}

function assTime(frames: number) {
  const centiseconds = Math.ceil(frames * 100 / fps)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${Math.floor(centiseconds / 360_000)}:${pad(Math.floor(centiseconds / 6000) % 60)}:${pad(Math.floor(centiseconds / 100) % 60)}.${pad(centiseconds % 100)}`
}

function subtitles(shot: Shot) {
  const font = process.platform === 'win32' ? 'Microsoft YaHei' : 'Noto Sans CJK SC'
  return `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Chinese,${font},38,&H00FFFFFF,&H00FFFFFF,&H00141020,&H00141020,0,0,0,0,100,100,0,0,1,3,1,2,62,62,45,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,${assTime(shot.frames)},Chinese,,0,0,0,,${subtitleText(shot.dialogue)}
`
}

function seconds(frames: number) {
  return (frames / fps).toFixed(9)
}

async function encodeShot(store: ProjectStore, shot: Shot, filename: string, cwd: string, signal: AbortSignal) {
  const visual = activeVersion(shot.media.video) ?? activeVersion(shot.media.image)
  const voice = activeVersion(shot.media.audio)
  const visualArgs = visual ? mediaInput(await store.assetPath(visual), visual.extension)
    : ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`]
  const audioArgs = voice ? mediaInput(await store.assetPath(voice), voice.extension)
    : ['-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=mono`]
  const caption = subtitleText(shot.dialogue)
  if (caption) await writeFile(path.join(cwd, 'caption.ass'), subtitles(shot), 'utf8')
  const videoFilter = [
    'setpts=PTS-STARTPTS',
    `fps=${fps}:eof_action=pass`,
    `scale=w='max(2,trunc(min(${width},${height}*dar)/2)*2)':h='max(2,trunc(min(${height},${width}/dar)/2)*2)'`,
    'setsar=1',
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    ...(visual ? ['tpad=stop_mode=clone:stop=-1'] : []),
    `trim=end_frame=${shot.frames}`,
    ...(caption ? ['subtitles=caption.ass'] : []),
  ].join(',')
  const audioFilter = `aresample=${sampleRate}:first_pts=0,asetpts=N/SR/TB,apad,atrim=end_sample=${shot.frames * (sampleRate / fps)}`
  await runTool('ffmpeg', [
    '-nostdin', '-v', 'error', '-xerror', '-filter_threads', '2', ...visualArgs, ...audioArgs,
    '-map', '0:V:0', '-map', '1:a:0', '-vf', videoFilter, '-af', audioFilter,
    '-c:v', 'libx264', '-threads:v', '3', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-bf', '0', '-video_track_timescale', '30000', '-color_range', 'tv', '-colorspace', 'bt709',
    '-c:a', 'pcm_s16le', '-ar', String(sampleRate), '-ac', '2', '-map_metadata', '-1', '-map_chapters', '-1',
    '-f', 'mov', filename,
  ], { cwd, signal })
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
  options: { signal: AbortSignal; progress?: (percent: number) => void; publish?: () => void },
) {
  if (!episode.shots.length) throw new Error('请先新建镜头')
  const temp = await mkdtemp(path.join(path.dirname(destination), '.manju-render-'))
  try {
    const manifest: string[] = ['ffconcat version 1.0']
    const total = totalFrames(episode)
    let processed = 0
    for (const [i, shot] of episode.shots.entries()) {
      options.signal.throwIfAborted()
      const file = `shot-${i}.mov`
      try {
        await encodeShot(store, shot, file, temp, options.signal)
      } catch (error) {
        options.signal.throwIfAborted()
        const detail = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '素材文件不存在' : (error as Error).message
        throw new Error(`镜头 ${i + 1} · ${detail}`, { cause: error })
      }
      manifest.push(`file '${file}'`, `duration ${seconds(shot.frames)}`)
      processed += shot.frames
      options.progress?.(Math.floor(94 * processed / total))
    }
    await writeFile(path.join(temp, 'episode.ffconcat'), manifest.join('\n') + '\n')
    await runTool('ffmpeg', [
      '-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-f', 'concat', '-safe', '1', '-i', 'episode.ffconcat',
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', 'complete.mp4',
    ], { cwd: temp, signal: options.signal })
    const complete = path.join(temp, 'complete.mp4')
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
    await rename(complete, destination)
    options.progress?.(100)
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}
