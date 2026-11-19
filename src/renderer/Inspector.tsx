import { useEffect, useState } from 'react'
import { Copy, FloppyDisk, Trash } from '@phosphor-icons/react'
import type { OpenProject } from '../shared/api'
import {
  detailKinds, detailLabels, methodLabels, methodSchema, usesFinishedVideo, usesTrack, type DetailKind, type ShotMethod,
} from '../shared/creative'
import {
  kinds, shotMedia, statuses, type Episode, type MediaTarget, type Shot, type ShotFields,
} from '../shared/model'
import { Badge, MediaRow, sequence } from './components'

export function fieldsFor(shot: Shot, method: ShotMethod) {
  return {
    title: shot.title,
    seconds: String(Number((shot.frames / 30).toFixed(3))),
    dialogue: shot.dialogue,
    prompt: shot.prompt,
    videoPrompt: shot.videoPrompt ?? '',
    status: shot.status,
    method,
  }
}

export function Inspector({
  opened, shot, episode, index, busy, method, showVideoPrompt, detailedImagePrompt,
  onSave, onCopy, onImport, onActivate, onKeep, onRemoveMedia, onDropFile, onDetail, onRemove, onDirty,
}: {
  opened: OpenProject; shot: Shot; episode: Episode; index: number; busy: boolean; method: ShotMethod; showVideoPrompt: boolean
  onKeep: (target: MediaTarget, id: string) => void; onDetail: (kind: DetailKind) => void
  onSave: (fields: ShotFields) => void; onCopy: (text: string) => void; onImport: (target: MediaTarget) => void
  detailedImagePrompt?: string
  onActivate: (target: MediaTarget, id: string) => void
  onRemoveMedia: (target: MediaTarget, id: string) => void
  onDropFile: (target: MediaTarget, file: File) => void
  onRemove: () => void; onDirty: (value: boolean) => void
}) {
  const [draft, setDraft] = useState(() => fieldsFor(shot, method))
  const { title, frames, dialogue, prompt, videoPrompt = '', status } = shot
  useEffect(() => {
    setDraft({ title, seconds: String(Number((frames / 30).toFixed(3))), dialogue, prompt, videoPrompt, status, method })
  }, [title, frames, dialogue, prompt, videoPrompt, status, method])
  const finished = shotMedia(shot, 'video', method)
  const finishedFrames = finished?.seconds && Math.round(finished.seconds * 30)
  const canUseFinishedDuration = usesFinishedVideo(method) && !!finishedFrames && finishedFrames <= 18_000
    && Math.round(Number(draft.seconds) * 30) !== finishedFrames
  const dirty = draft.title.trim() !== title || Math.round(Number(draft.seconds) * 30) !== frames
    || draft.dialogue !== dialogue || draft.prompt !== prompt || draft.videoPrompt !== videoPrompt || draft.status !== status || draft.method !== method
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  const promptToCopy = detailedImagePrompt ?? draft.prompt
  return <aside className="inspector" aria-label="镜头编辑">
    <div className="section-head inspector-head"><div className="inspector-title"><span className="shot-number">{sequence(index)}</span><h2>镜头编辑</h2></div><Badge value={shot.status} /></div>
    <form onSubmit={event => {
      event.preventDefault()
      onSave({ title: draft.title.trim(), frames: Math.round(Number(draft.seconds) * 30),
        dialogue: draft.dialogue, prompt: draft.prompt, status: draft.status,
        ...(draft.method !== method && { method: draft.method }),
        ...(draft.videoPrompt !== videoPrompt && { videoPrompt: draft.videoPrompt }) })
    }}>
      <fieldset disabled={busy}>
        <label className="field">镜头名称<input required maxLength={100} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label className="field">制作方式<select value={draft.method} onChange={event => setDraft({ ...draft, method: event.target.value as ShotMethod })}>
          {methodSchema.options.map(option => <option key={option} value={option}>{methodLabels[option]}</option>)}
        </select></label>
        <div className="field-grid">
          <label className="field">时长（秒）<input type="number" required min="0.033" max="600" step="any" value={draft.seconds}
            onChange={event => setDraft({ ...draft, seconds: event.target.value })} /></label>
          <label className="field">状态<select aria-label="状态" value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as ShotFields['status'] })}>
            {statuses.map(str => <option key={str}>{str}</option>)}</select></label>
        </div>
        {canUseFinishedDuration && <button type="button" className="small subtle accent use-clip-duration"
          onClick={() => setDraft({ ...draft, seconds: String(Number((finishedFrames / 30).toFixed(3))) })}>使用成片时长</button>}
        <div className="field">
          <label htmlFor="shot-dialogue">{draft.dialogue === dialogue ? '本镜烧录台词' : '台词草稿'}</label>
          <textarea id="shot-dialogue" rows={2} maxLength={1000} value={draft.dialogue}
            onChange={event => setDraft({ ...draft, dialogue: event.target.value })} />
        </div>
        {draft.dialogue !== dialogue && <div className="caption-saved"><span>本镜烧录台词</span><p>{dialogue || '（空）'}</p></div>}
        {usesTrack(method, 'image') && <div className="prompt-field"><div className="field-header"><label htmlFor="shot-prompt">提示词</label>
          {shot.legacyPromptReview?.image && <Badge value="需更新" />}
          <button type="button" className="small subtle accent" disabled={!promptToCopy.trim()} onClick={() => onCopy(promptToCopy)}>
            <Copy size={15} /> {detailedImagePrompt ? '复制详细提示词' : '复制提示词'}</button></div>
          <textarea id="shot-prompt" rows={3} maxLength={30000} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} />
        </div>}
        {(showVideoPrompt || draft.videoPrompt !== videoPrompt) && <label className="field video-prompt">视频提示词
          {shot.legacyPromptReview?.flow && <Badge value="需更新" />}
          <textarea id="shot-video-prompt" rows={3} maxLength={30000} value={draft.videoPrompt}
            onChange={event => setDraft({ ...draft, videoPrompt: event.target.value })} />
        </label>}
        <div className="inspector-save"><button type="button" className="icon small subtle danger" title="删除镜头" aria-label="删除镜头" onClick={onRemove}><Trash size={17} /></button>
          <button type="submit" className="primary small" disabled={!dirty || !draft.title.trim()}><FloppyDisk size={15} /> 保存镜头</button></div>
      </fieldset>
    </form>
    <div className="asset-panel shot-details"><h3>详细提示词</h3>
      {detailKinds(method, shot.omittedMedia).map(kind => {
        const detail = shot.details?.[kind]
        return <button className="detail-entry" key={kind} disabled={busy} onClick={() => onDetail(kind)}>
          <span>{detailLabels[kind]}</span>
          <Badge value={detail?.needsUpdate ? '需更新' : detail?.source === 'manual' ? '手改' : detail?.source === 'external' ? '来自规划' : detail ? '已保存' : '未保存'} />
        </button>
      })}
    </div>
    <div className="asset-panel"><h3>素材版本</h3>
      {kinds.map(kind => {
        const target = { scope: 'shot', episodeId: episode.id, shotId: shot.id, kind } as const
        return <MediaRow key={kind} track={shot.media[kind]} kind={kind} opened={opened} busy={busy}
          onImport={() => onImport(target)} onActivate={id => onActivate(target, id)} onKeep={id => onKeep(target, id)}
          onRemove={id => onRemoveMedia(target, id)} onDropFile={file => onDropFile(target, file)} />
      })}
    </div>
  </aside>
}
