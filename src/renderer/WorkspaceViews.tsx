import type { ReactNode } from 'react'
import { BookOpen, FileText, FilmStrip, Image as ImageIcon, MapPin, Plus, UsersThree } from '@phosphor-icons/react'
import type { OpenProject } from '../shared/api'
import { activeVersion, timecode, totalFrames, type Category, type Episode, type MediaTarget, type Project, type Reference } from '../shared/model'
import { MediaRow, TextEditor, mediaUrl, sequence } from './components'

export type Tab = 'shots' | 'script' | 'brief' | Category

const tabs = [
  { id: 'shots', text: '分镜', icon: FilmStrip },
  { id: 'brief', text: '制作简报', icon: FileText },
  { id: 'script', text: '剧本', icon: BookOpen },
  { id: 'characters', text: '角色参考', icon: UsersThree },
  { id: 'scenes', text: '场景参考', icon: MapPin },
] as const

export function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className="empty-stage"><div className="empty-icon">{icon}</div>{children}</div>
}

export function ProjectSidebar({
  project,
  tab,
  episodeId,
  busy,
  onSelectTab,
  onAddEpisode,
  onSelectEpisode,
}: {
  project: Project
  tab: Tab
  episodeId?: string
  busy: boolean
  onSelectTab: (tab: Tab) => void
  onAddEpisode: () => void
  onSelectEpisode: (episodeId: string) => void
}) {
  return <aside className="sidebar">
    <div className="section-head"><h2>作品目录</h2></div>
    <nav aria-label="作品目录">{tabs.map(({ id, text, icon: Icon }) => <button key={id} className="nav-entry"
      aria-current={tab === id ? 'page' : undefined} disabled={busy}
      onClick={() => onSelectTab(id)}>
      <Icon size={18} /><span>{text}</span>{(id === 'characters' || id === 'scenes') && <small>{project[id].length}</small>}
    </button>)}</nav>
    <div className="section-head episode-head"><h2>集数</h2>
      <button className="icon small subtle" title="新建集数" aria-label="新建集数" onClick={onAddEpisode} disabled={busy}><Plus size={17} /></button>
    </div>
    <nav aria-label="集数">{project.episodes.map((item, index) => <button key={item.id} className="episode-entry"
      aria-current={tab === 'shots' && episodeId === item.id ? 'page' : undefined}
      disabled={busy} onClick={() => onSelectEpisode(item.id)}>
      <span className="episode-number">{sequence(index)}</span><span className="episode-name"><strong>{item.title}</strong>
        <small>{item.shots.length} 镜头 <span>·</span> {timecode(totalFrames(item))}</small></span>
    </button>)}</nav>
  </aside>
}

export function ScriptView({
  project,
  episode,
  scriptScope,
  editorRevision,
  busy,
  onSelectScope,
  onDirty,
  onSaveProject,
  onSaveEpisode,
  onRemoveEpisode,
}: {
  project: Project
  episode?: Episode
  scriptScope: 'project' | 'episode'
  editorRevision: number
  busy: boolean
  onSelectScope: (scope: 'project' | 'episode') => void
  onDirty: (value: boolean) => void
  onSaveProject: (title: string, script: string) => void
  onSaveEpisode: (title: string, script: string) => void
  onRemoveEpisode: () => void
}) {
  return <main className="stage wide">
    <div className="stage-heading"><h2>剧本</h2><div className="actions">
      <button aria-pressed={scriptScope === 'project' || !episode} disabled={busy}
        onClick={() => { if (scriptScope !== 'project') onSelectScope('project') }}>作品剧本</button>
      <button aria-pressed={scriptScope === 'episode' && !!episode} disabled={busy || !episode}
        onClick={() => { if (scriptScope !== 'episode') onSelectScope('episode') }}>集数剧本</button>
    </div></div>
    {scriptScope === 'episode' && episode
      ? <TextEditor key={episode.id + editorRevision} title={episode.title} name={episode.title} script={episode.script} field="剧本" busy={busy}
          onDirty={onDirty} onSave={onSaveEpisode} onRemove={onRemoveEpisode} />
      : <TextEditor key={project.id + editorRevision} title={project.title} name={project.title} script={project.script} field="剧本"
          busy={busy} onDirty={onDirty} onSave={onSaveProject} />}
  </main>
}

export function ReferenceView({
  opened,
  category,
  references,
  reference,
  editorRevision,
  busy,
  onAddNavigate,
  onAddDirect,
  onSelectReference,
  onDirty,
  onSaveReference,
  onRemoveReference,
  onImportMedia,
  onActivateMedia,
  onKeepMedia,
  onRemoveMedia,
  onDropMedia,
}: {
  opened: OpenProject
  category: Category
  references: Reference[]
  reference?: Reference
  editorRevision: number
  busy: boolean
  onAddNavigate: () => void
  onAddDirect: () => void
  onSelectReference: (id: string) => void
  onDirty: (value: boolean) => void
  onSaveReference: (id: string, title: string, notes: string) => void
  onRemoveReference: (reference: Reference) => void
  onImportMedia: (target: MediaTarget) => void
  onActivateMedia: (target: MediaTarget, versionId: string) => void
  onKeepMedia: (target: MediaTarget, versionId: string) => void
  onRemoveMedia: (target: MediaTarget, versionId: string) => void
  onDropMedia: (target: MediaTarget, file: File) => void
}) {
  const target = reference ? ({ scope: 'reference', category, referenceId: reference.id } as const) : null
  return <main className="stage wide">
    <div className="stage-heading"><h2>{category === 'characters' ? '角色参考' : '场景参考'}</h2>
      <button className="primary" disabled={busy} onClick={onAddNavigate}><Plus size={18} /> 新建参考</button>
    </div>
    {!reference || !target ? <Empty icon={<ImageIcon size={38} weight="duotone" />}><button className="primary" onClick={onAddDirect} disabled={busy}><Plus size={18} /> 新建参考</button></Empty>
      : <>
        <div className="reference-grid">{references.map(item => {
          const image = activeVersion(item.image)
          return <button className="reference-tile" key={item.id} disabled={busy} aria-pressed={item.id === reference.id} onClick={() => {
            if (item.id !== reference.id) onSelectReference(item.id)
          }}>{image ? <img src={mediaUrl(opened, image)} alt="" /> : <ImageIcon size={30} />}<strong>{item.title}</strong></button>
        })}</div>
        <div className="reference-edit">
          <TextEditor key={reference.id + editorRevision} title={category === 'characters' ? '角色资料' : '场景资料'} name={reference.title}
            script={reference.notes} field="备注" busy={busy} onDirty={onDirty}
            onSave={(title, notes) => onSaveReference(reference.id, title, notes)}
            onRemove={() => onRemoveReference(reference)} />
          <MediaRow kind="image" track={reference.image} opened={opened} busy={busy}
            onImport={() => onImportMedia(target)}
            onActivate={id => onActivateMedia(target, id)}
            onKeep={id => onKeepMedia(target, id)}
            onRemove={id => onRemoveMedia(target, id)}
            onDropFile={file => onDropMedia(target, file)} />
        </div>
      </>}
  </main>
}
