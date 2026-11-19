import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, FilmStrip, Image as ImageIcon, MusicNote, Plus, Trash, UploadSimple } from '@phosphor-icons/react'
import type { OpenProject } from '../shared/api'
import { activeVersion, shotMedia, timecode, type Episode, type MediaKind, type Track, type Version } from '../shared/model'

export const kindLabel: Record<MediaKind, string> = { image: '参考图', video: '视频', audio: '配音' }
const kindIcon = { image: ImageIcon, video: FilmStrip, audio: MusicNote }
export const sequence = (index: number) => String(index + 1).padStart(2, '0')
export const mediaUrl = (opened: OpenProject, version: Version) => `manju-media://project/${opened.mediaKey}/${version.id}`

export function Badge({ value }: { value: string }) {
  const color = { 待制作: 'idle', 待审核: 'review', 已通过: 'approved' }[value] ?? 'fiction'
  return <span className={`badge ${color}`}>{value}</span>
}

export function MediaRow({ track, kind, busy, onImport, onActivate }: {
  track: Track; kind: MediaKind; busy: boolean; onImport: () => void; onActivate: (id: string) => void
}) {
  const Icon = kindIcon[kind]
  const active = activeVersion(track)
  return <div className="media-row">
    <div className="asset-type"><span className="asset-icon"><Icon size={16} /></span><strong>{kindLabel[kind]}</strong></div>
    {active && <select aria-label={`${kindLabel[kind]}活动版本`} title={active.name} value={active.id} disabled={busy}
      onChange={event => onActivate(event.target.value)}>
      {track.versions.map((version, index) => <option key={version.id} value={version.id}>V{index + 1} · {version.name}</option>)}
    </select>}
    <button type="button" className="small subtle import" aria-label={`导入${kindLabel[kind]}`} disabled={busy} onClick={onImport}>
      <UploadSimple size={15} /> 导入
    </button>
  </div>
}

export function Timeline({ opened, episode, shotId, busy, onSelect, onAdd, onMove }: {
  opened: OpenProject; episode: Episode; shotId?: string; busy: boolean
  onSelect: (id: string) => void; onAdd: () => void; onMove: (direction: -1 | 1) => void
}) {
  const index = episode.shots.findIndex(shot => shot.id === shotId)
  let start = 0
  return <section className="timeline" aria-label="镜头时间线">
    <div className="section-head">
      <div className="section-label"><FilmStrip size={18} /><h3>镜头时间线</h3><span className="counter">{episode.shots.length}</span></div>
      <div className="actions">
        <button className="icon small subtle" title="前移镜头" aria-label="前移镜头" onClick={() => onMove(-1)} disabled={busy || index <= 0}><ArrowUp size={16} /></button>
        <button className="icon small subtle" title="后移镜头" aria-label="后移镜头" onClick={() => onMove(1)} disabled={busy || index < 0 || index === episode.shots.length - 1}><ArrowDown size={16} /></button>
        <button className="small" onClick={onAdd} disabled={busy}><Plus size={16} /> 新建镜头</button>
      </div>
    </div>
    {!!episode.shots.length && <div className="filmstrip">
      {episode.shots.map((shot, position) => {
        const image = shotMedia(shot, 'image')
        const from = start
        start += shot.frames
        return <button key={shot.id} className="clip" disabled={busy} aria-pressed={shot.id === shotId} onClick={() => onSelect(shot.id)}
          aria-label={`镜头 ${sequence(position)} ${shot.title}`}>
          <div className="clip-ruler">{timecode(from, true)}</div>
          <div className="clip-image">{image ? <img src={mediaUrl(opened, image)} alt="" /> : <FilmStrip size={26} />}<b>{sequence(position)}</b></div>
          <div className="clip-meta"><strong>{shot.title}</strong><span>{timecode(shot.frames, true)}</span></div>
          <div className={`clip-state ${shot.status === '已通过' ? 'approved' : shot.status === '待审核' ? 'review' : 'idle'}`} title={shot.status} />
        </button>
      })}
    </div>}
  </section>
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); onClose() }}>
    <h2>{title}</h2>{children}
  </dialog>
}

export function NameModal({ title, initial = '', confirm, busy, error, onClose, onSubmit }: {
  title: string; initial?: string; confirm: string; busy: boolean; error?: string; onClose: () => void; onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(initial)
  return <Modal title={title} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); onSubmit(name) }}>
      <fieldset disabled={busy}>
        <label className="field">名称<input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={!name.trim()}>{confirm}</button></div>
      </fieldset>
    </form>
  </Modal>
}

export function TextEditor({ title, name, script, field, busy, onSave, onRemove, onDirty }: {
  title: string; name: string; script: string; field: string; busy: boolean
  onSave: (title: string, text: string) => void; onRemove?: () => void; onDirty: (value: boolean) => void
}) {
  const [draft, setDraft] = useState({ name, script })
  useEffect(() => { setDraft({ name, script }) }, [name, script])
  const dirty = name !== draft.name || script !== draft.script
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  return <form className="text-editor" onSubmit={event => { event.preventDefault(); onSave(draft.name, draft.script) }}>
    <fieldset disabled={busy}>
      <div className="section-head"><h2>{title}</h2><div className="actions">
        {onRemove && <button type="button" className="icon subtle danger" title="删除" aria-label="删除" onClick={onRemove}><Trash size={17} /></button>}
        <button type="submit" className="primary small" disabled={!dirty || !draft.name.trim()}><Check size={17} /> 保存</button>
      </div></div>
      <label className="field">名称<input value={draft.name} required maxLength={100}
        onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="field">{field}<textarea rows={field === '剧本' ? 13 : 6} maxLength={30000} value={draft.script}
        onChange={event => setDraft({ ...draft, script: event.target.value })} /></label>
    </fieldset>
  </form>
}
