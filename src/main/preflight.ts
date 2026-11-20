import { createHash } from 'node:crypto'
import type { PreflightIssue, PreflightReport } from '../shared/api'
import { frameSpec, usesTrack } from '../shared/creative'
import { audibleMusic, totalFrames, type Episode, type Project, type Version } from '../shared/model'
import { ffmpegTools, mediaInput, probe, runTool } from './process'
import { shotSources, subtitleCues } from './render'
import type { ProjectStore } from './storage'

type MediaCheck = { error: 'missing-file' | 'unreadable' } | { embeddedAudio: boolean }

export async function inspectEpisode(store: ProjectStore, project: Project, episode: Episode, signal: AbortSignal): Promise<PreflightReport> {
  await store.assertDiskCurrent()
  if (episode.shots.length) await ffmpegTools.requireReady()
  const spec = frameSpec(project)
  const checks = new Map<string, Promise<MediaCheck>>()
  function checkMedia(version: Version, kind: 'video' | 'image' | 'audio', frames: number, checkVideoAudio = false) {
    const key = [version.id, kind, frames, checkVideoAudio].join('/')
    let check = checks.get(key)
    if (!check) {
      check = (async (): Promise<MediaCheck> => {
        signal.throwIfAborted()
        try {
          const file = await store.assetPath(version)
          const validation = AbortSignal.any([signal, AbortSignal.timeout(Math.max(60_000, frames / 30 * 2000))])
          const embeddedAudio = checkVideoAudio && (await probe(file, version.extension, validation))
            .streams.some(stream => stream.codec_type === 'audio')
          await runTool('ffmpeg', [
            '-nostdin', '-v', 'error', '-xerror', '-abort_on', 'empty_output_stream', '-threads', '2',
            ...mediaInput(file, version.extension),
            '-map', kind === 'audio' ? '0:a:0' : '0:V:0', ...(embeddedAudio ? ['-map', '0:a:0'] : []),
            ...(kind === 'image' ? ['-frames:v', '1'] : ['-t', (frames / 30).toFixed(9)]),
            '-f', 'null', '-',
          ], { signal: validation })
          return { embeddedAudio }
        } catch (error) {
          signal.throwIfAborted()
          return { error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-file' : 'unreadable' }
        }
      })()
      checks.set(key, check)
    }
    return check
  }

  async function checkShot(index: number) {
    const shot = episode.shots[index]
    const issues: PreflightIssue[] = []
    const add = (code: PreflightIssue['code'], target: PreflightIssue['target'], severity: PreflightIssue['severity'] = 'warning') => {
      issues.push({ code, target, severity, shot: { id: shot.id, index, title: shot.title } })
    }
    const { method, visual, voice, checkVideoAudio } = shotSources(project, shot)
    let embeddedAudio = false
    let visualBroken = false
    if (visual) {
      const actual = await checkMedia(visual.version, visual.kind, visual.kind === 'image' ? 1 : shot.frames, checkVideoAudio)
      if ('error' in actual) {
        visualBroken = true
        add(actual.error, visual.kind, 'error')
      } else {
        embeddedAudio = actual.embeddedAudio
        if (visual.kind === 'image' && usesTrack(method, 'video') && !shot.omittedMedia?.video) add('still', 'video')
        if (visual.version.needsUpdate) add('stale', visual.kind)
      }
    } else {
      const expected = (['video', 'image'] as const).filter(kind => usesTrack(method, kind))
      const missing = expected.find(kind => !shot.omittedMedia?.[kind])
      add(missing ? 'missing-visual' : 'black', missing ?? expected[0] ?? 'video')
    }
    if (voice) {
      const actual = await checkMedia(voice, 'audio', shot.frames)
      if ('error' in actual) add(actual.error, 'audio', 'error')
      else if (voice.needsUpdate) add('stale', 'audio')
    } else if (!shot.omittedMedia?.audio && !embeddedAudio && !(checkVideoAudio && visualBroken) && shot.dialogue.trim()) {
      add('no-voice', 'audio')
    }
    try {
      const dense = subtitleCues(shot, spec).some(cue => {
        const units = Array.from(cue.lines.join('').replace(/\s/g, ''))
          .reduce((total, char) => total + (/^[\x21-\x7e]$/.test(char) ? 0.5 : 1), 0)
        return units * 30 > (cue.end - cue.start) * 12
      })
      if (dense) add('dense', 'dialogue')
    } catch {
      add('subtitle-overflow', 'dialogue', 'error')
    }
    return issues
  }

  const shotIssues: PreflightIssue[][] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(3, episode.shots.length) }, async () => {
    while (next < episode.shots.length) {
      signal.throwIfAborted()
      const index = next++
      shotIssues[index] = await checkShot(index)
    }
  }))
  const issues = shotIssues.flat()
  if (!episode.shots.length) issues.push({ code: 'no-shots', target: 'shots', severity: 'error' })
  const music = audibleMusic(episode)
  if (music && episode.shots.length) {
    const actual = await checkMedia(music.version, 'audio', totalFrames(episode))
    if ('error' in actual) issues.push({ code: actual.error, target: 'music', severity: 'error' })
    else if (music.version.needsUpdate) issues.push({ code: 'stale', target: 'music', severity: 'warning' })
  }
  await store.assertDiskCurrent()
  signal.throwIfAborted()
  const review = createHash('sha256').update(JSON.stringify([episode.id, issues])).digest('hex')
  return { episodeId: episode.id, title: episode.title, issues, review }
}

export function preflightAllows(report: PreflightReport, reviewed?: string) {
  return !report.issues.some(issue => issue.severity === 'error')
    && (!report.issues.length || report.review === reviewed)
}
