import { z } from 'zod'
import {
  briefSchema, detailKindSchema, detailSchema, detailTextSchema, methodSchema, planNotesSchema, usesTrack, workTypeSchema,
  type ShotMethod,
} from './creative'

export const kinds = ['image', 'video', 'audio'] as const
export const statuses = ['待制作', '待审核', '已通过'] as const
export const kindSchema = z.enum(kinds)
export const projectSchemaVersion = 2
export type MediaKind = z.infer<typeof kindSchema>
export const idSchema = z.uuid()
export const titleSchema = z.string().trim().min(1, '名称不能为空').max(100, '名称最多 100 个字符')
export const folderNameSchema = titleSchema.refine(
  value => !/[<>:"/\\|?*\x00-\x1f. ]$/.test(value) && !/[<>:"/\\|?*\x00-\x1f]/.test(value)
    && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\.|$)/i.test(value)
    && !/[\uD800-\uDFFF]/u.test(value),
  '名称包含 Windows 文件名禁用字符或保留名称',
)
const notes = detailTextSchema
const finiteSeconds = z.number().finite().positive().max(86_400)
export const versionSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(255),
  extension: z.enum(['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov', 'webm', 'wav', 'mp3', 'm4a', 'ogg', 'flac']),
  createdAt: z.iso.datetime(),
  seconds: finiteSeconds.optional(),
  hasAudio: z.boolean().optional(),
  needsUpdate: z.literal(true).optional(),
})
export type Version = z.infer<typeof versionSchema>
const trackSchema = z.object({
  activeId: idSchema.nullable(),
  versions: z.array(versionSchema).max(500),
}).refine(track => track.activeId === null
  ? track.versions.length === 0
  : track.versions.some(version => version.id === track.activeId), '活动版本不存在')
export type Track = z.infer<typeof trackSchema>

export const shotDialogueSchema = z.string().max(1000, '台词最多 1,000 个字符')
export const shotFields = z.object({
  title: titleSchema,
  // Whole 1/30-second frames keep timeline, picture and audio boundaries aligned.
  frames: z.number().int().min(1).max(18_000),
  dialogue: shotDialogueSchema,
  prompt: notes,
  videoPrompt: notes.optional(),
  method: methodSchema.optional(),
  status: z.enum(statuses),
})
export type ShotFields = z.infer<typeof shotFields>
const shotSchema = shotFields.extend({
  id: idSchema,
  media: z.object({ image: trackSchema, video: trackSchema, audio: trackSchema }),
  omittedMedia: z.partialRecord(kindSchema, z.literal(true)).optional(),
  details: z.partialRecord(detailKindSchema, detailSchema).optional(),
  legacyPromptReview: z.partialRecord(z.enum(['image', 'flow']), z.literal(true)).optional(),
})
export type Shot = z.infer<typeof shotSchema>
const episodeSchema = z.object({
  id: idSchema, title: titleSchema, script: notes, shots: z.array(shotSchema).max(500),
  exportRecord: z.object({ exportedAt: z.iso.datetime(), stale: z.boolean() }).optional(),
})
export type Episode = z.infer<typeof episodeSchema>
export const categorySchema = z.enum(['characters', 'scenes'])
export type Category = z.infer<typeof categorySchema>
const referenceSchema = z.object({ id: idSchema, title: titleSchema, notes, image: trackSchema })
export type Reference = z.infer<typeof referenceSchema>

export const projectSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(projectSchemaVersion)]),
  id: idSchema,
  title: titleSchema,
  fictional: z.boolean(),
  workType: workTypeSchema.optional(),
  brief: briefSchema.optional(),
  plan: planNotesSchema.optional(),
  script: notes,
  episodes: z.array(episodeSchema).max(500),
  characters: z.array(referenceSchema).max(500),
  scenes: z.array(referenceSchema).max(500),
}).superRefine((project, ctx) => {
  const seen = new Set<string>()
  function add(id: string) {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', message: '项目包含重复的记录标识' })
    seen.add(id)
  }
  function checkTrack(track: Track, kind: MediaKind) {
    for (const version of track.versions) {
      add(version.id)
      if (!extensions[kind].includes(version.extension) || (kind !== 'image' && !version.seconds)) {
        ctx.addIssue({ code: 'custom', message: '项目素材类型无效' })
      }
    }
  }
  add(project.id)
  for (const episode of project.episodes) {
    add(episode.id)
    for (const shot of episode.shots) {
      add(shot.id)
      for (const kind of kinds) checkTrack(shot.media[kind], kind)
    }
  }
  for (const reference of [...project.characters, ...project.scenes]) {
    add(reference.id)
    checkTrack(reference.image, 'image')
  }
})
export type Project = z.infer<typeof projectSchema>

export const extensions: Record<MediaKind, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'webp'],
  video: ['mp4', 'mov', 'webm'],
  audio: ['wav', 'mp3', 'm4a', 'ogg', 'flac'],
}

export const mediaTargetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('shot'), episodeId: idSchema, shotId: idSchema, kind: kindSchema }),
  z.object({ scope: z.literal('reference'), category: categorySchema, referenceId: idSchema }),
])
export type MediaTarget = z.infer<typeof mediaTargetSchema>
export const mutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project.brief'), workType: workTypeSchema, brief: briefSchema }),
  z.object({ type: z.literal('shot.detail'), episodeId: idSchema, shotId: idSchema, kind: detailKindSchema,
    action: z.discriminatedUnion('type', [
      z.object({ type: z.literal('save'), body: detailTextSchema }),
      z.object({ type: z.literal('regenerate') }),
      z.object({ type: z.literal('keep') }),
    ]),
  }),
  z.object({ type: z.literal('shot.apply-voice'), episodeId: idSchema, shotId: idSchema,
    before: shotDialogueSchema, voiceBody: detailTextSchema, dialogue: shotDialogueSchema.refine(value => !!value.trim(), '台词不能为空'),
  }),
  z.object({ type: z.literal('media.keep'), target: mediaTargetSchema, versionId: idSchema }),
  z.object({ type: z.literal('project.edit'), title: titleSchema, script: notes }),
  z.object({ type: z.literal('episode.add'), title: titleSchema }),
  z.object({ type: z.literal('episode.edit'), episodeId: idSchema, title: titleSchema, script: notes }),
  z.object({ type: z.literal('episode.remove'), episodeId: idSchema }),
  z.object({ type: z.literal('shot.add'), episodeId: idSchema, title: titleSchema }),
  z.object({ type: z.literal('shot.duplicate'), episodeId: idSchema, shotId: idSchema }),
  z.object({ type: z.literal('shot.edit'), episodeId: idSchema, shotId: idSchema, fields: shotFields }),
  z.object({ type: z.literal('shot.omit-media'), episodeId: idSchema, shotId: idSchema, kind: kindSchema, omitted: z.boolean() }),
  z.object({ type: z.literal('shot.remove'), episodeId: idSchema, shotId: idSchema }),
  z.object({ type: z.literal('shot.move'), episodeId: idSchema, shotId: idSchema, direction: z.union([z.literal(-1), z.literal(1)]) }),
  z.object({ type: z.literal('reference.add'), category: categorySchema, title: titleSchema }),
  z.object({ type: z.literal('reference.edit'), category: categorySchema, referenceId: idSchema, title: titleSchema, notes }),
  z.object({ type: z.literal('reference.remove'), category: categorySchema, referenceId: idSchema }),
  z.object({ type: z.literal('media.activate'), target: mediaTargetSchema, versionId: idSchema }),
  z.object({ type: z.literal('media.remove'), target: mediaTargetSchema, versionId: idSchema }),
])
export type Mutation = z.infer<typeof mutationSchema>

export function emptyTrack(): Track {
  return { activeId: null, versions: [] }
}

export function activeVersion(track: Track) {
  return track.versions.find(version => version.id === track.activeId)
}

export function shotMedia(shot: Shot, kind: MediaKind, method: ShotMethod = shot.method ?? 'flow') {
  return shot.omittedMedia?.[kind] || !usesTrack(method, kind) ? undefined : activeVersion(shot.media[kind])
}

export function shotVisual(shot: Shot, method: ShotMethod) {
  const video = shotMedia(shot, 'video', method)
  if (video) return { kind: 'video', version: video } as const
  const image = shotMedia(shot, 'image', method)
  if (image) return { kind: 'image', version: image } as const
}

export function totalFrames(episode: Episode) {
  return episode.shots.reduce((total, shot) => total + shot.frames, 0)
}

export function timecode(frames: number, fraction = false) {
  const whole = Math.floor(frames / 30)
  const padded = (value: number) => String(value).padStart(2, '0')
  const clock = `${padded(Math.floor(whole / 60))}:${padded(whole % 60)}`
  return fraction ? `${clock}:${padded(frames % 30)}` : clock
}
