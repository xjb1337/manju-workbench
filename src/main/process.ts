import { spawn } from 'node:child_process'

export function runTool(
  command: 'ffmpeg' | 'ffprobe',
  args: string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, signal: options.signal, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let startError: Error | undefined
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-2_000_000)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      startError = error.code === 'ENOENT' ? new Error(`找不到 ${command}，请将 FFmpeg 和 ffprobe 加入 PATH`) : error
    })
    child.on('close', code => {
      if (options.signal?.aborted) reject(options.signal.reason)
      else if (startError) reject(startError)
      else if (code === 0) resolve(stdout)
      else reject(new Error(`${command} 执行失败（${code ?? '中断'}）`, { cause: stderr.trim() }))
    })
  })
}

const demuxers: Record<string, string> = {
  jpg: 'jpeg_pipe', jpeg: 'jpeg_pipe', png: 'png_pipe', webp: 'webp_pipe',
  mp4: 'mov', mov: 'mov', webm: 'matroska', wav: 'wav', mp3: 'mp3',
  m4a: 'mov', ogg: 'ogg', flac: 'flac',
}
export function mediaInput(file: string, extension: string) {
  const format = demuxers[extension]
  if (!format) throw new Error('素材格式无效')
  return ['-protocol_whitelist', 'file,pipe', '-f', format, '-i', file]
}
type ProbeStream = {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string
  disposition?: { attached_pic?: number }
}
export async function probe(file: string, extension: string, signal?: AbortSignal) {
  const out = await runTool('ffprobe', [
    '-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic:format=duration',
    '-of', 'json', ...mediaInput(file, extension),
  ], { signal })
  return JSON.parse(out) as { streams: ProbeStream[]; format: { duration?: string } }
}
