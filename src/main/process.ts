import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FfmpegStatus, FfmpegToolName, FfmpegToolStatus } from '../shared/api'

type ToolOptions = { cwd?: string; signal?: AbortSignal; input?: Readable; onStdoutLine?: (line: string) => void }

export function runExecutable(
  executable: string,
  command: FfmpegToolName,
  args: string[],
  options: ToolOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, signal: options.signal, shell: false, windowsHide: true,
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let lineBuffer = ''
    let startError: Error | undefined
    let inputDone: Promise<void> | undefined
    if (options.input && child.stdin) {
      inputDone = pipeline(options.input, child.stdin, { signal: options.signal }).catch((error: NodeJS.ErrnoException) => {
        if (options.signal?.aborted || error.code === 'EPIPE' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') return
        startError ??= error
        child.kill()
      })
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-2_000_000)
      if (!options.onStdoutLine) return
      lineBuffer += chunk
      let newline = lineBuffer.indexOf('\n')
      while (newline !== -1) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, '')
        lineBuffer = lineBuffer.slice(newline + 1)
        options.onStdoutLine(line)
        newline = lineBuffer.indexOf('\n')
      }
    })
    child.stdout?.on('end', () => {
      if (options.onStdoutLine && lineBuffer) {
        options.onStdoutLine(lineBuffer.replace(/\r$/, ''))
        lineBuffer = ''
      }
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      startError = error.code === 'ENOENT' ? new Error(`找不到 ${command}，请重新检测 FFmpeg 工具`) : error
    })
    child.on('close', async code => {
      await inputDone
      if (options.signal?.aborted) reject(options.signal.reason)
      else if (startError) reject(startError)
      else if (code === 0) resolve(stdout)
      else reject(new Error(`${command} 执行失败（${code ?? '中断'}）`, { cause: stderr.trim() }))
    })
  })
}

type Tool = FfmpegToolStatus & { executable?: string; fingerprint?: string }
const toolNames = ['ffmpeg', 'ffprobe'] as const
const setupLabel = 'FFmpeg 设置'

async function executableFingerprint(executable: string) {
  const stat = await lstat(executable, { bigint: true })
  if (!stat.isFile()) return undefined
  await access(executable, constants.X_OK)
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

function toolError(tool: FfmpegToolStatus) {
  const details = {
    ready: '',
    missing: '未找到',
    outdated: '需要 7.1 或更高版本',
    'unknown-version': '版本无法识别',
    unavailable: '无法运行',
  }[tool.status]
  return new Error(`${tool.name} · ${details}，请检查「${setupLabel}」`)
}

export class FfmpegTools {
  #directory: string | null = null
  #tools?: Promise<Tool[]>

  constructor(
    private readonly pathValue = () => process.env.PATH ?? '',
    private readonly execute = runExecutable,
  ) {}

  configure(directory: string | null) {
    if (directory !== null && !path.isAbsolute(directory)) throw new Error('FFmpeg 工具目录无效')
    this.#directory = directory
    this.#tools = undefined
  }

  private async locate(name: FfmpegToolName, directories: string[]): Promise<Tool> {
    const file = process.platform === 'win32' ? `${name}.exe` : name
    let inaccessible = false
    for (const directory of directories) {
      const executable = await realpath(path.join(directory, file)).catch(() => undefined)
      if (!executable) continue
      const fingerprint = await executableFingerprint(executable).catch(() => undefined)
      if (!fingerprint) {
        inaccessible = true
        continue
      }
      try {
        const output = await this.execute(executable, name, ['-version'], { signal: AbortSignal.timeout(5000) })
        const version = output.match(new RegExp(`^${name} version ([^\\s]{1,120})(?:\\s|$)`))?.[1]
        const release = version?.match(/^n?(\d{1,3})\.(\d{1,3})(?:\.\d{1,4})?(?:[-+~_]|$)/i)
        if (!version || !release || /[-_+~](?:dev|alpha|beta|rc)(?:[^a-z]|$)/i.test(version)) return { name, version, status: 'unknown-version' }
        const approved = Number(release[1]) > 7 || (Number(release[1]) === 7 && Number(release[2]) >= 1)
        return approved ? { name, version, status: 'ready', executable, fingerprint } : { name, version, status: 'outdated' }
      } catch {
        return { name, status: 'unavailable' }
      }
    }
    return { name, status: inaccessible ? 'unavailable' : 'missing' }
  }

  private detect() {
    const directories = this.#directory ? [this.#directory]
      : this.pathValue().split(path.delimiter).map(entry => entry.replace(/^"(.*)"$/, '$1')).filter(entry => path.isAbsolute(entry))
    return this.#tools ??= Promise.all(toolNames.map(name => this.locate(name, directories)))
  }

  async refresh(): Promise<FfmpegStatus> {
    const directory = this.#directory
    this.#tools = undefined
    const tools = await this.detect()
    return { directory, tools: tools.map(({ name, version, status }) => ({ name, version, status })) }
  }

  async requireReady() {
    await Promise.all((await this.detect()).map(tool => this.requireExecutable(tool)))
  }

  private async requireExecutable(tool: Tool) {
    if (!tool.executable || !tool.fingerprint) throw toolError(tool)
    const fingerprint = await executableFingerprint(tool.executable).catch(() => undefined)
    if (fingerprint !== tool.fingerprint) throw new Error(`${tool.name} 工具文件已变化，请在「${setupLabel}」中重新检测`)
    return tool.executable
  }

  async run(command: FfmpegToolName, args: string[], options: ToolOptions = {}) {
    options.signal?.throwIfAborted()
    const tool = (await this.detect())[toolNames.indexOf(command)]
    options.signal?.throwIfAborted()
    return this.execute(await this.requireExecutable(tool), command, args, options)
  }
}

export const ffmpegTools = new FfmpegTools()

export function runTool(command: FfmpegToolName, args: string[], options?: ToolOptions) {
  return ffmpegTools.run(command, args, options)
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
  nb_frames?: string
  disposition?: { attached_pic?: number }
}
export async function probe(file: string, extension: string, signal?: AbortSignal) {
  const out = await runTool('ffprobe', [
    '-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,duration,nb_frames:stream_disposition=attached_pic:format=duration',
    '-of', 'json', ...mediaInput(file, extension),
  ], { signal })
  return JSON.parse(out) as { streams: ProbeStream[]; format: { duration?: string } }
}
