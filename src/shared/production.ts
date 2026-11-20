import { shotMethod, usesFinishedVideo, usesTrack } from './creative'
import { activeVersion, audibleMusic, kinds, shotMedia, shotVisual, visualMotion, type Episode, type MediaKind, type Project, type Shot } from './model'

export const productionSteps = [
  { id: 'script', label: '剧本' },
  { id: 'references', label: '角色与场景' },
  { id: 'shots', label: '分镜' },
  { id: 'image', label: '生图' },
  { id: 'video', label: '视频制作' },
  { id: 'audio', label: '配音字幕' },
  { id: 'export', label: '导出' },
] as const

const codeStep = { id: 'code', label: '代码任务' } as const
const finishedStep = { id: 'finished', label: '成片导入' } as const
export type StepId = typeof productionSteps[number]['id'] | typeof codeStep.id | typeof finishedStep.id
export type StepStatus = 'complete' | 'partial' | 'incomplete' | 'stale'

export function productionProgress(project: Project, episodeId?: string) {
  const episode = project.episodes.find(item => item.id === episodeId)
  const shots = episode?.shots ?? []
  const missingReferences = (['characters', 'scenes'] as const).filter(category => !project[category].length)
  const available = shots.length ? shots.map(shot => shotMethod(project, shot)) : [shotMethod(project)]
  const showReferences = (project.workType ?? 'story') === 'story'
    || (project.workType === 'mixed' && available.some(method => !usesFinishedVideo(method)))
  const showImage = available.some(method => usesTrack(method, 'image'))
  const showVideo = available.some(method => usesTrack(method, 'video') && !usesFinishedVideo(method))
  const steps = [
    productionSteps[0], ...(showReferences ? [productionSteps[1]] : []), productionSteps[2],
    ...(showImage ? [productionSteps[3]] : []), ...(showVideo ? [productionSteps[4]] : []),
    ...(available.includes('code') ? [codeStep] : []), ...(available.some(usesFinishedVideo) ? [finishedStep] : []),
    productionSteps[5], productionSteps[6],
  ]
  const measure = (includes: (shot: Shot) => boolean, check: (shot: Shot) => 'omitted' | 'ready' | 'missing' | 'stale') => {
    const items = shots.flatMap((shot, index) => includes(shot)
      ? [{ id: shot.id, title: shot.title, index, state: check(shot) }] : [])
    const missing = items.filter(item => item.state === 'missing').length
    const omitted = items.filter(item => item.state === 'omitted').length
    const stale = items.filter(item => item.state === 'stale').length
    const ready = items.length - missing - omitted - stale
    const status: StepStatus = stale ? 'stale' : !items.length ? 'incomplete'
      : !missing ? 'complete' : ready + omitted ? 'partial' : 'incomplete'
    return { items, missing, omitted, ready, stale, status }
  }
  const mediaState = (shot: Shot, kind: MediaKind) => {
    if (shot.omittedMedia?.[kind]) return 'omitted'
    const method = shotMethod(project, shot)
    const video = kind === 'audio' && usesFinishedVideo(method) ? shotMedia(shot, 'video', method) : undefined
    const version = activeVersion(shot.media[kind]) ?? (video?.hasAudio ? video : undefined)
    return version?.needsUpdate ? 'stale' : version ? 'ready' : 'missing'
  }
  const media = {
    image: measure(shot => usesTrack(shotMethod(project, shot), 'image'), shot => mediaState(shot, 'image')),
    video: measure(shot => !usesFinishedVideo(shotMethod(project, shot)) && usesTrack(shotMethod(project, shot), 'video'),
      shot => mediaState(shot, 'video')),
    audio: measure(() => true, shot => mediaState(shot, 'audio')),
    finished: measure(shot => usesFinishedVideo(shotMethod(project, shot)), shot => mediaState(shot, 'video')),
    code: measure(shot => shotMethod(project, shot) === 'code', shot => {
      const detail = shot.details?.code
      return detail?.needsUpdate ? 'stale' : detail?.body.trim() ? 'ready' : 'missing'
    }),
  }

  const allStatuses: Record<StepId, StepStatus> = {
    script: project.script.trim() || episode?.script.trim() ? 'complete' : 'incomplete',
    references: !missingReferences.length ? 'complete' : missingReferences.length === 1 ? 'partial' : 'incomplete',
    shots: shots.some(shot => Number.isFinite(shot.frames) && shot.frames > 0) ? 'complete' : 'incomplete',
    image: media.image.status,
    video: media.video.status,
    audio: media.audio.status,
    finished: media.finished.status,
    code: media.code.status,
    export: episode?.exportRecord ? episode.exportRecord.stale ? 'stale' : 'complete' : 'incomplete',
  }
  const statuses = Object.fromEntries(steps.map(({ id }) => [id, allStatuses[id]])) as Partial<Record<StepId, StepStatus>>
  const recommended = steps.find(({ id }) => statuses[id] !== 'complete')?.id
  return { steps, statuses, recommended, missingReferences, media, dialogueCount: shots.filter(shot => shot.dialogue.trim()).length }
}

export function exportFallbacks(project: Pick<Project, 'workType'>, episode: Episode) {
  return episode.shots.flatMap((shot, index) => {
    const method = shotMethod(project, shot)
    const visual = shotVisual(shot, method)
    if (!visual) return [{ index, title: shot.title, label: '黑底' }]
    if (visual.kind === 'image' && usesTrack(method, 'video') && !shot.omittedMedia?.video) {
      return [{ index, title: shot.title, label: '静态参考图' }]
    }
    return []
  })
}

export function exportInputsChanged(before: Episode, after: Episode, beforeProject: Pick<Project, 'workType'> = {}, afterProject = beforeProject) {
  function inputs(shot: Shot, project: Pick<Project, 'workType'>) {
    const method = shotMethod(project, shot)
    const embeddedAudio = usesFinishedVideo(method) && !shot.omittedMedia?.audio && !shotMedia(shot, 'audio', method)
      ? shotMedia(shot, 'video', method)?.id : undefined
    return [shot.id, shot.frames, shot.dialogue, embeddedAudio, visualMotion(shot, shotVisual(shot, method)?.kind),
      ...kinds.map(kind => [shot.media[kind].activeId, shotMedia(shot, kind, method)?.id])]
  }
  return JSON.stringify(audibleMusic(before)) !== JSON.stringify(audibleMusic(after))
    || JSON.stringify(before.shots.map(shot => inputs(shot, beforeProject))) !== JSON.stringify(after.shots.map(shot => inputs(shot, afterProject)))
}
