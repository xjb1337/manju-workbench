import { detailKindSchema, shotMethod } from '../shared/creative'
import { kinds, type Episode, type Project, type Shot } from '../shared/model'
import { legacyDetail, sharedSettingsKey } from '../shared/prompts'

export function noteCreativeChanges(previous: Project, next: Project) {
  const sharedChanged = sharedSettingsKey(previous) !== sharedSettingsKey(next)
  const oldEpisodes = new Map(previous.episodes.map(episode => [episode.id, episode]))
  function positions(episode?: Episode) {
    let start = 0
    return new Map(episode?.shots.map(shot => {
      const entry = { shot, start }
      start += shot.frames
      return [shot.id, entry]
    }))
  }
  const referenceId = (shot: Shot) => shot.omittedMedia?.image ? undefined : shot.media.image.activeId
  for (const episode of next.episodes) {
    const oldPositions = positions(oldEpisodes.get(episode.id))
    for (const { shot, start } of positions(episode).values()) {
      const old = oldPositions.get(shot.id)
      if (!old) continue
      const oldMethod = shotMethod(previous, old.shot)
      const method = shotMethod(next, shot)
      const shotChanged = old.shot.frames !== shot.frames || old.shot.title !== shot.title || oldMethod !== method || old.start !== start
      const referenceChanged = referenceId(old.shot) !== referenceId(shot)
      for (const kind of detailKindSchema.options) {
        const legacy = legacyDetail(shot, kind)
        const legacyChanged = legacyDetail(old.shot, kind) !== legacy
        const affected = sharedChanged || shotChanged || legacyChanged || (kind !== 'voice' && referenceChanged)
          || (kind === 'voice' && (old.shot.dialogue !== shot.dialogue || old.shot.omittedMedia?.audio !== shot.omittedMedia?.audio))
        const detail = shot.details?.[kind]
        const before = old.shot.details?.[kind]
        if (affected && detail && before?.body === detail.body && before.source === detail.source) detail.needsUpdate = true
        if ((kind === 'image' || kind === 'flow') && legacyChanged && shot.legacyPromptReview) delete shot.legacyPromptReview[kind]
        if (sharedChanged && !legacyChanged && legacy.trim() && (kind === 'image' || kind === 'flow')) {
          (shot.legacyPromptReview ??= {})[kind] = true
        }
      }
      if (sharedChanged) for (const kind of kinds) {
        for (const version of shot.media[kind].versions) version.needsUpdate = true
      }
    }
  }
  if (sharedChanged) for (const category of ['characters', 'scenes'] as const) {
    const old = new Map(previous[category].map(reference => [reference.id, new Set(reference.image.versions.map(version => version.id))]))
    for (const reference of next[category]) for (const version of reference.image.versions) {
      if (old.get(reference.id)?.has(version.id)) version.needsUpdate = true
    }
  }
}
