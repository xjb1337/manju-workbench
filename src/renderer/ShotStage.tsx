import { useEffect, useRef, useState } from 'react'
import { DownloadSimple, FileText, FilmStrip, Image as ImageIcon, Pause, Play, Plus, Sparkle, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react'
import type { OpenProject } from '../shared/api'
import { frameSpec, usesFinishedVideo, usesTrack, type ShotMethod } from '../shared/creative'
import { extensions, shotVisual, timecode, totalFrames, type Episode, type MediaKind, type MediaTarget, type Shot } from '../shared/model'
import { Timeline, mediaUrl, sequence } from './components'
import { Empty } from './WorkspaceViews'

function droppedMediaKind(file: File, method: ShotMethod, fallback: 'image' | 'video'): MediaKind {
  const mime = file.type.toLowerCase()
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (mime.startsWith('audio/') || extensions.audio.includes(ext)) return 'audio'
  if ((mime.startsWith('video/') || extensions.video.includes(ext)) && usesTrack(method, 'video')) return 'video'
  if ((mime.startsWith('image/') || extensions.image.includes(ext)) && usesTrack(method, 'image')) return 'image'
  return fallback
}

export function ShotStage({
  opened,
  episode,
  shot,
  shotIndex,
  spec,
  method,
  busy,
  canRender,
  playerOpen,
  onOpenEpisodeScript,
  onPreview,
  onRebuildPreview,
  onExport,
  onExportSrt,
  onAddPrimary,
  onMagpie,
  onImportPlan,
  onSelectShot,
  onAddShot,
  onMoveShot,
  onDuplicateShot,
  onImportMedia,
  onDropMedia,
  onPlaybackError,
}: {
  opened: OpenProject
  episode?: Episode
  shot?: Shot
  shotIndex: number
  spec: ReturnType<typeof frameSpec>
  method: ShotMethod
  busy: boolean
  canRender: boolean
  playerOpen: boolean
  onOpenEpisodeScript: () => void
  onPreview: () => void
  onRebuildPreview: () => void
  onExport: () => void
  onExportSrt: () => void
  onAddPrimary: () => void
  onMagpie: () => void
  onImportPlan: () => void
  onSelectShot: (id: string) => void
  onAddShot: () => void
  onMoveShot: (direction: -1 | 1) => void
  onDuplicateShot: () => void
  onImportMedia: (target: MediaTarget) => void
  onDropMedia: (target: MediaTarget, file: File) => void
  onPlaybackError: (message: string) => void
}) {
  const [monitorPlaying, setMonitorPlaying] = useState(false)
  const [monitorMuted, setMonitorMuted] = useState(true)
  const [monitorDropActive, setMonitorDropActive] = useState(false)
  const monitorVideoRef = useRef<HTMLVideoElement>(null)

  const start = episode?.shots.slice(0, shotIndex).reduce((time, item) => time + item.frames, 0) ?? 0
  const visual = shot && shotVisual(shot, method)
  const monitorKind = usesTrack(method, 'image') ? 'image' : 'video'

  useEffect(() => {
    setMonitorPlaying(false)
    setMonitorMuted(true)
    setMonitorDropActive(false)
  }, [shot?.id, visual?.kind, visual?.version.id])

  useEffect(() => {
    if (busy) setMonitorDropActive(false)
  }, [busy])

  useEffect(() => {
    if (playerOpen) monitorVideoRef.current?.pause()
  }, [playerOpen])

  return <main className="stage">
    <div className="stage-heading">
      <div className="stage-title"><h2>{episode?.title ?? '分镜'}</h2>{episode && <>
        <span className="stage-count">{episode.shots.length} 镜头 <span>·</span> {timecode(totalFrames(episode))}</span>
        <button className="icon small subtle" title="集数剧本" aria-label="集数剧本" disabled={busy}
          onClick={onOpenEpisodeScript}><FileText size={17} /></button>
      </>}</div>
      <div className="actions stage-render-actions">
        <span className="export-size">{spec.width} × {spec.height}</span>
        <button disabled={!canRender} onClick={onPreview}><Play size={16} weight="fill" /> 顺序预览</button>
        {shot && <button className="subtle" disabled={!canRender} onClick={onRebuildPreview}>重新生成预览</button>}
        {shot && <button disabled={!canRender || !episode?.shots.some(item => item.dialogue.trim())} onClick={onExportSrt}>导出 SRT</button>}
        <button className="primary" disabled={!canRender} onClick={onExport}><DownloadSimple size={18} /> 导出 MP4</button>
      </div>
    </div>
    {shot ? <section className="monitor" aria-label="镜头画面" data-ratio={spec.ratio}>
      <div className="monitor-top"><div><span className="monitor-dot" /><strong>镜头 {sequence(shotIndex)} · {shot.title}</strong></div><span>{spec.ratio}</span></div>
      <div className="monitor-matte"
        onDragOver={event => {
          if (busy || !opened || !episode || !Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          if (!monitorDropActive) setMonitorDropActive(true)
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMonitorDropActive(false)
        }}
        onDrop={event => {
          event.preventDefault()
          setMonitorDropActive(false)
          if (busy || !opened || !episode) return
          const file = event.dataTransfer.files?.[0]
          if (!file) return
          const kind = droppedMediaKind(file, method, monitorKind)
          onDropMedia({ scope: 'shot', episodeId: episode.id, shotId: shot.id, kind }, file)
        }}>
        <div className={monitorDropActive ? 'monitor-body drop-active' : 'monitor-body'} style={{ aspectRatio: `${spec.width} / ${spec.height}` }}>
          {visual?.kind === 'image' ? <img key={visual.version.id} src={mediaUrl(opened, visual.version)} alt={shot.title} /> : visual
            ? <video key={`${shot.id}-${visual.version.id}`} ref={monitorVideoRef} src={mediaUrl(opened, visual.version)}
                preload="metadata" muted={monitorMuted}
                onPlay={() => setMonitorPlaying(true)}
                onPause={() => setMonitorPlaying(false)}
                onEnded={() => setMonitorPlaying(false)} />
            : <button className="monitor-import" onClick={() => episode && onImportMedia({ scope: 'shot', episodeId: episode.id,
              shotId: shot.id, kind: monitorKind })} disabled={busy}><ImageIcon size={22} /> {monitorKind === 'image' ? '导入参考图' : usesFinishedVideo(method) ? '导入成片' : '导入视频'}</button>}
          {shot.dialogue && <span className="frame-caption" style={{
            bottom: `${(100 * spec.subtitle.bottom) / spec.height}%`,
            fontSize: `${(100 * spec.subtitle.size) / spec.width}cqw`,
            maxWidth: `${100 - (200 * spec.subtitle.horizontal) / spec.width}%`,
          }}>{shot.dialogue}</span>}
        </div>
      </div>
      <div className="monitor-bottom">
        <span><span className="monitor-tick" />{timecode(start, true)}</span>
        {visual?.kind === 'video' && <div className="monitor-controls">
          <button type="button" className="monitor-btn" aria-label={monitorPlaying ? '暂停单镜视频' : '播放单镜视频'}
            onClick={() => {
              const element = monitorVideoRef.current
              if (!element) return
              if (element.paused) void element.play().catch(() => onPlaybackError('镜头视频无法播放'))
              else element.pause()
            }}>
            {monitorPlaying ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
            {monitorPlaying ? '暂停' : '播放'}
          </button>
          <button type="button" className="monitor-btn" aria-label={monitorMuted ? '取消静音' : '静音'}
            onClick={() => {
              const next = !monitorMuted
              if (monitorVideoRef.current) monitorVideoRef.current.muted = next
              setMonitorMuted(next)
            }}>
            {monitorMuted ? <SpeakerSlash size={13} /> : <SpeakerHigh size={13} />}
            {monitorMuted ? '取消静音' : '静音'}
          </button>
        </div>}
        <span>{timecode(shot.frames, true)} <span className="monitor-divider">/</span> 30 fps</span>
      </div>
    </section> : <Empty icon={<FilmStrip size={38} weight="duotone" />}>
      <div className="empty-actions">
        <button className="primary" disabled={busy} onClick={onMagpie}><Sparkle size={18} /> AI 生成分镜草案</button>
        <button disabled={busy} onClick={onAddPrimary}><Plus size={18} /> {episode ? '新建镜头' : '新建集数'}</button>
        <button className="subtle" disabled={busy} onClick={onImportPlan}>导入外部规划</button>
      </div>
    </Empty>}
    {episode && !!episode.shots.length && <Timeline opened={opened} episode={episode} shotId={shot?.id} busy={busy}
      onSelect={onSelectShot}
      onAdd={onAddShot} onMove={onMoveShot} onDuplicate={onDuplicateShot} />}
  </main>
}
