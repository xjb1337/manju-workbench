import { activeVersion, kinds, shotMedia, type Episode, type MediaKind, type Project, type Shot } from './model'

export const productionSteps = [
  { id: 'script', label: '剧本' },
  { id: 'references', label: '角色与场景' },
  { id: 'shots', label: '分镜' },
  { id: 'image', label: 'ChatGPT 生图' },
  { id: 'video', label: 'Flow 视频' },
  { id: 'audio', label: '配音字幕' },
  { id: 'export', label: '导出' },
] as const

export type StepId = typeof productionSteps[number]['id']
export type StepStatus = 'complete' | 'partial' | 'incomplete' | 'stale'

export function productionProgress(project: Project, episodeId?: string) {
  const episode = project.episodes.find(item => item.id === episodeId)
  const shots = episode?.shots ?? []
  const missingReferences = (['characters', 'scenes'] as const).filter(category => !project[category].length)
  const mediaStatus = (kind: MediaKind) => {
    const items = shots.map((shot, index) => ({
      id: shot.id, title: shot.title, index,
      state: shot.omittedMedia?.[kind] ? 'omitted' : activeVersion(shot.media[kind]) ? 'ready' : 'missing',
    } as const))
    const missing = items.filter(item => item.state === 'missing').length
    const omitted = items.filter(item => item.state === 'omitted').length
    const ready = items.length - missing - omitted
    const status: StepStatus = !items.length ? 'incomplete' : !missing ? 'complete' : ready + omitted ? 'partial' : 'incomplete'
    return { items, missing, omitted, ready, status }
  }
  const media = { image: mediaStatus('image'), video: mediaStatus('video'), audio: mediaStatus('audio') }
  const statuses: Record<StepId, StepStatus> = {
    script: project.script.trim() || episode?.script.trim() ? 'complete' : 'incomplete',
    references: !missingReferences.length ? 'complete' : missingReferences.length === 1 ? 'partial' : 'incomplete',
    shots: shots.some(shot => Number.isFinite(shot.frames) && shot.frames > 0) ? 'complete' : 'incomplete',
    image: media.image.status,
    video: media.video.status,
    audio: media.audio.status,
    export: episode?.exportRecord ? episode.exportRecord.stale ? 'stale' : 'complete' : 'incomplete',
  }
  const recommended = productionSteps.find(({ id }) => statuses[id] !== 'complete')?.id
  return { statuses, recommended, missingReferences, media, dialogueCount: shots.filter(shot => shot.dialogue.trim()).length }
}

export function exportInputsChanged(before: Episode, after: Episode) {
  function inputs(shot: Shot) {
    return [shot.id, shot.frames, shot.dialogue, ...kinds.map(kind => [shot.media[kind].activeId, shotMedia(shot, kind)?.id])]
  }
  return JSON.stringify(before.shots.map(inputs)) !== JSON.stringify(after.shots.map(inputs))
}
