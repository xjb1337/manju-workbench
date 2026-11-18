import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { checkedFile } from './storage'

const contentTypes: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', wav: 'audio/wav',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
}

export function rangeFor(header: string | null, size: number) {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end ? { start, end } : null
}

export async function mediaResponse(request: Request, file: string, extension: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const { size } = await checkedFile(file)
  const range = rangeFor(request.headers.get('Range'), size)
  const headers = new Headers({
    'Accept-Ranges': 'bytes', 'Content-Type': contentTypes[extension] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  })
  if (range === null) {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : size))
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
  const body = request.method === 'HEAD' ? null
    : Readable.toWeb(createReadStream(file, { ...range, signal: request.signal })) as ReadableStream<Uint8Array>
  return new Response(body, { status: range ? 206 : 200, headers })
}
