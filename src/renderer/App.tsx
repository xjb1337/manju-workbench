import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowSquareOut, BookOpen, Check, FilmSlate, Copy, DownloadSimple, FilmStrip, FolderOpen, Image as ImageIcon,
  Moon, Play, Plus, Sun, Trash, WarningCircle, X, MapPin, UsersThree, FloppyDisk, FileText,
} from '@phosphor-icons/react'
import type { OpenProject, RenderProgress, Reply } from '../shared/api'
import {
  activeVersion, folderNameSchema, kinds, statuses, timecode, totalFrames, type Category, type Episode, type MediaTarget,
  type Mutation, type Project, type Shot, type ShotFields,
} from '../shared/model'
import { Badge, MediaRow, Modal, NameModal, TextEditor, Timeline, mediaUrl, sequence } from './components'

type Tab = 'shots' | 'script' | Category
type Ask =
  | { kind: 'name'; title: string; initial?: string; confirm: string; action: (name: string) => Promise<boolean> }
  | { kind: 'remove'; title: string; name: string; change: Mutation }
  | { kind: 'discard'; action: () => void }
const api = window.workbench
const tabs = [{ id: 'shots', text: '分镜', icon: FilmStrip }, { id: 'script', text: '剧本', icon: BookOpen },
  { id: 'characters', text: '角色参考', icon: UsersThree }, { id: 'scenes', text: '场景参考', icon: MapPin }] as const

export function App() {
  const [opened, setOpened] = useState<OpenProject | null>(null)
  const [episodeId, setEpisodeId] = useState('')
  const [shotId, setShotId] = useState('')
  const [referenceId, setReferenceId] = useState('')
  const [tab, setTab] = useState<Tab>('shots')
  const [scriptScope, setScriptScope] = useState<'project' | 'episode'>('project')
  const [editorRevision, setEditorRevision] = useState(0)
  const [dark, setDark] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [player, setPlayer] = useState('')
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [dirty, setDirty] = useState(false)
  const running = useRef(false)
  const project = opened?.project
  const episode = project?.episodes.find(item => item.id === episodeId) ?? project?.episodes[0]
  const shot = episode?.shots.find(item => item.id === shotId) ?? episode?.shots[0]
  const category = tab === 'characters' || tab === 'scenes' ? tab : null
  const references = category && project ? project[category] : []
  const reference = references.find(item => item.id === referenceId) ?? references[0]

  useEffect(() => api.onProgress(setProgress), [])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])
  useEffect(() => {
    if (!message || message.error) return
    const timer = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(timer)
  }, [message])
  useEffect(() => {
    if (!dirty && !busy) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, busy])

  function navigate(action: () => void) {
    if (dirty) setAsk({ kind: 'discard', action })
    else action()
  }

  async function run<T>(action: () => Promise<Reply<T>>, success?: (value: T) => void) {
    if (running.current) return false
    running.current = true
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      if (!result.ok) {
        setMessage({ text: result.error, error: true })
        return false
      }
      success?.(result.value)
      return true
    } catch {
      setMessage({ text: '桌面进程连接中断', error: true })
      return false
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  function load(next: OpenProject | null) {
    setOpened(next)
    setEpisodeId('')
    setShotId('')
    setReferenceId('')
    setTab('shots')
    setScriptScope('project')
    setDirty(false)
  }

  function accept(project: Project | null) {
    if (project) setOpened(current => current && ({ ...current, project }))
  }

  function edit(change: Mutation, saved?: (project: Project) => void) {
    if (!opened) return Promise.resolve(false)
    return run(() => api.edit(opened.mediaKey, change), next => {
      accept(next)
      saved?.(next)
    })
  }

  function importMedia(target: MediaTarget) {
    if (opened) void run(() => api.importMedia(opened.mediaKey, target), accept)
  }
  function activate(target: MediaTarget, id: string) {
    void edit({ type: 'media.activate', target, versionId: id })
  }

  function addProject(sample: boolean) {
    setAsk({ kind: 'name', title: sample ? '创建虚构示例' : '新建作品', initial: sample ? '雾港来信' : '',
      confirm: '选择保存位置', action: name => {
        const checked = folderNameSchema.safeParse(name)
        if (!checked.success) {
          setMessage({ text: checked.error.issues[0].message, error: true })
          return Promise.resolve(false)
        }
        return run(() => api.create(checked.data, sample), next => { if (next) load(next) })
      } })
  }
  function addEpisode() {
    setAsk({ kind: 'name', title: '新建集数', initial: `第 ${(project?.episodes.length ?? 0) + 1} 集`, confirm: '新建',
      action: title => edit({ type: 'episode.add', title }, next => {
        setEpisodeId(next.episodes.at(-1)!.id)
        setShotId('')
        setTab('shots')
      }) })
  }
  function addShot() {
    if (!episode) return
    setAsk({ kind: 'name', title: '新建镜头', confirm: '新建',
      action: title => edit({ type: 'shot.add', episodeId: episode.id, title },
        next => setShotId(next.episodes.find(item => item.id === episode.id)!.shots.at(-1)!.id)) })
  }
  function addReference() {
    if (!category) return
    setAsk({ kind: 'name', title: category === 'characters' ? '新建角色参考' : '新建场景参考', confirm: '新建',
      action: title => edit({ type: 'reference.add', category, title }, next => setReferenceId(next[category].at(-1)!.id)) })
  }
  function remove(title: string, name: string, change: Mutation) {
    setAsk({ kind: 'remove', title, name, change })
  }

  async function render(mode: RenderProgress['mode']) {
    if (!opened || !episode || running.current) return
    setProgress({ mode, percent: 0 })
    try {
      await run(() => api.render(opened.mediaKey, episode.id, mode), result => {
        if (result.status === 'canceled') setMessage({ text: mode === 'export' ? '已取消导出' : '已取消预览' })
        else if (mode === 'preview') setPlayer(result.location)
        else setMessage({ text: `导出完成 · ${result.location}` })
      })
    } finally {
      setProgress(null)
    }
  }

  const shotIndex = episode && shot ? episode.shots.indexOf(shot) : 0
  const start = episode?.shots.slice(0, shotIndex).reduce((time, item) => time + item.frames, 0) ?? 0
  const visual = shot && activeVersion(shot.media.image)
  const video = shot && activeVersion(shot.media.video)
  const canRender = !!episode?.shots.length && !dirty && !busy

  return <div className="app">
    <header className="appbar">
      <div className="brand"><span className="brand-mark"><FilmSlate weight="bold" size={20} /></span><strong>漫剧工作台</strong></div>
      <div className="app-actions">
        <button className="subtle" onClick={() => navigate(() => addProject(false))} disabled={busy}><Plus size={17} /> 新建作品</button>
        <button className="subtle" onClick={() => navigate(() => void run(() => api.open(), next => { if (next) load(next) }))} disabled={busy}><FolderOpen size={18} /> 打开作品</button>
        <span className="separator" />
        <button className="icon subtle" aria-label={dark ? '切换浅色' : '切换深色'} title={dark ? '切换浅色' : '切换深色'}
          onClick={() => setDark(!dark)}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button>
      </div>
    </header>

    {!opened || !project ? <main className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark"><FilmSlate size={49} weight="duotone" /></div>
        <h1>漫剧工作台</h1>
        <div className="actions">
          <button className="primary" onClick={() => addProject(false)} disabled={busy}><Plus size={19} /> 新建作品</button>
          <button onClick={() => void run(() => api.open(), next => { if (next) load(next) })} disabled={busy}><FolderOpen size={19} /> 打开作品</button>
        </div>
        <button className="sample-link subtle" onClick={() => addProject(true)} disabled={busy}><FilmStrip size={17} /> 创建虚构示例</button>
      </div>
    </main> : <>
      <div className="projectbar">
        <div className="project-title"><span className="project-icon"><FolderOpen size={20} weight="duotone" /></span>
          <h1>{project.title}</h1>{project.fictional && <Badge value="示例 / 虚构" />}</div>
        <div className="actions">
          <button className="subtle external" disabled={busy} onClick={() => void run(() => api.openTool('chatgpt'))}>ChatGPT <ArrowSquareOut size={15} /></button>
          <button className="subtle external" disabled={busy} onClick={() => void run(() => api.openTool('flow'))}>Google Flow <ArrowSquareOut size={15} /></button>
          <span className="separator" />
          <button className="icon subtle" title="关闭作品" aria-label="关闭作品" disabled={busy}
            onClick={() => navigate(() => void run(() => api.close(), () => load(null)))}><X size={19} /></button>
        </div>
      </div>
      <div className="workspace">
        <aside className="sidebar">
          <div className="section-head"><h2>作品目录</h2></div>
          <nav aria-label="作品目录">{tabs.map(({ id, text, icon: Icon }) => <button key={id} className="nav-entry"
            aria-current={tab === id ? 'page' : undefined} disabled={busy}
            onClick={() => { if (tab !== id) navigate(() => { setTab(id); setReferenceId(''); setDirty(false) }) }}>
            <Icon size={18} /><span>{text}</span>{(id === 'characters' || id === 'scenes') && <small>{project[id].length}</small>}
          </button>)}</nav>
          <div className="section-head episode-head"><h2>集数</h2>
            <button className="icon small subtle" title="新建集数" aria-label="新建集数" onClick={() => navigate(addEpisode)} disabled={busy}><Plus size={17} /></button>
          </div>
          <nav aria-label="集数">{project.episodes.map((item, index) => <button key={item.id} className="episode-entry"
            aria-current={tab === 'shots' && episode?.id === item.id ? 'page' : undefined}
            disabled={busy} onClick={() => { if (episode?.id !== item.id || tab !== 'shots') navigate(() => {
              setEpisodeId(item.id); setShotId(''); setTab('shots'); setDirty(false)
            }) }}>
            <span className="episode-number">{sequence(index)}</span><span className="episode-name"><strong>{item.title}</strong>
              <small>{item.shots.length} 镜头 <span>·</span> {timecode(totalFrames(item))}</small></span>
          </button>)}</nav>
        </aside>
        {tab === 'shots' ? <main className="stage">
          <div className="stage-heading">
            <div className="stage-title"><h2>{episode?.title ?? '分镜'}</h2>{episode && <>
              <span className="stage-count">{episode.shots.length} 镜头 <span>·</span> {timecode(totalFrames(episode))}</span>
              <button className="icon small subtle" title="集数剧本" aria-label="集数剧本" disabled={busy}
                onClick={() => navigate(() => { setScriptScope('episode'); setTab('script'); setDirty(false) })}><FileText size={17} /></button>
            </>}</div>
            <div className="actions">
              <button disabled={!canRender} onClick={() => void render('preview')}><Play size={16} weight="fill" /> 顺序预览</button>
              <button className="primary" disabled={!canRender} onClick={() => void render('export')}><DownloadSimple size={18} /> 导出 MP4</button>
            </div>
          </div>
          {shot ? <section className="monitor" aria-label="镜头画面">
            <div className="monitor-top"><div><span className="monitor-dot" /><strong>镜头 {sequence(shotIndex)} · {shot.title}</strong></div><span>16:9</span></div>
            <div className="monitor-body">
              {visual ? <img key={visual.id} src={mediaUrl(opened, visual)} alt={shot.title} /> : video
                ? <video key={video.id} src={mediaUrl(opened, video)} preload="metadata" muted />
                : <button className="monitor-import" onClick={() => episode && importMedia({ scope: 'shot', episodeId: episode.id, shotId: shot.id, kind: 'image' })} disabled={busy}><ImageIcon size={22} /> 导入参考图</button>}
              {shot.dialogue && <span className="frame-caption">{shot.dialogue}</span>}
            </div>
            <div className="monitor-bottom"><span><span className="monitor-tick" />{timecode(start, true)}</span><span>{timecode(shot.frames, true)} <span className="monitor-divider">/</span> 30 fps</span></div>
          </section> : <Empty icon={<FilmStrip size={38} weight="duotone" />}>
            <button className="primary" disabled={busy} onClick={() => episode ? addShot() : addEpisode()}><Plus size={18} /> {episode ? '新建镜头' : '新建集数'}</button>
          </Empty>}
          {episode && !!episode.shots.length && <Timeline opened={opened} episode={episode} shotId={shot?.id} busy={busy}
            onSelect={id => { if (shot?.id !== id) navigate(() => { setShotId(id); setDirty(false) }) }}
            onAdd={() => navigate(addShot)} onMove={direction => shot && void edit({
              type: 'shot.move', episodeId: episode.id, shotId: shot.id, direction,
            })} />}
        </main> : tab === 'script' ? <main className="stage wide">
          <div className="stage-heading"><h2>剧本</h2><div className="actions">
            <button aria-pressed={scriptScope === 'project' || !episode} disabled={busy}
              onClick={() => { if (scriptScope !== 'project') navigate(() => setScriptScope('project')) }}>作品剧本</button>
            <button aria-pressed={scriptScope === 'episode' && !!episode} disabled={busy || !episode}
              onClick={() => { if (scriptScope !== 'episode') navigate(() => setScriptScope('episode')) }}>集数剧本</button>
          </div></div>
          {scriptScope === 'episode' && episode
            ? <TextEditor key={episode.id + editorRevision} title={episode.title} name={episode.title} script={episode.script} field="剧本" busy={busy}
                onDirty={setDirty} onSave={(title, script) => void edit({ type: 'episode.edit', episodeId: episode.id, title, script })}
                onRemove={() => remove('删除集数', episode.title, { type: 'episode.remove', episodeId: episode.id })} />
            : <TextEditor key={project.id + editorRevision} title={project.title} name={project.title} script={project.script} field="剧本"
                busy={busy} onDirty={setDirty} onSave={(title, script) => void edit({ type: 'project.edit', title, script })} />}

        </main> : category && <main className="stage wide">
          <div className="stage-heading"><h2>{category === 'characters' ? '角色参考' : '场景参考'}</h2>
            <button className="primary" disabled={busy} onClick={() => navigate(addReference)}><Plus size={18} /> 新建参考</button>
          </div>
          {!reference ? <Empty icon={<ImageIcon size={38} weight="duotone" />}><button className="primary" onClick={addReference} disabled={busy}><Plus size={18} /> 新建参考</button></Empty>
            : <>
              <div className="reference-grid">{references.map(item => {
                const image = activeVersion(item.image)
                return <button className="reference-tile" key={item.id} disabled={busy} aria-pressed={item.id === reference.id} onClick={() => {
                  if (item.id !== reference.id) navigate(() => { setReferenceId(item.id); setDirty(false) })
                }}>{image ? <img src={mediaUrl(opened, image)} alt="" /> : <ImageIcon size={30} />}<strong>{item.title}</strong></button>
              })}</div>
              <div className="reference-edit">
                <TextEditor key={reference.id + editorRevision} title={category === 'characters' ? '角色资料' : '场景资料'} name={reference.title}
                  script={reference.notes} field="备注" busy={busy} onDirty={setDirty}
                  onSave={(title, notes) => void edit({ type: 'reference.edit', category, referenceId: reference.id, title, notes })}
                  onRemove={() => remove('删除参考资料', reference.title, { type: 'reference.remove', category, referenceId: reference.id })} />
                <MediaRow kind="image" track={reference.image} busy={busy}
                  onImport={() => importMedia({ scope: 'reference', category, referenceId: reference.id })}
                  onActivate={id => activate({ scope: 'reference', category, referenceId: reference.id }, id)} />
              </div>
            </>}
        </main>}
        {tab === 'shots' && shot && episode && <Inspector key={shot.id + editorRevision} shot={shot} episode={episode} index={shotIndex} busy={busy}
          onDirty={setDirty} onSave={fields => void edit({ type: 'shot.edit', episodeId: episode.id, shotId: shot.id, fields },
            () => setMessage({ text: '镜头已保存' }))}
          onCopy={text => void run(() => api.copy(text), () => setMessage({ text: '提示词已复制' }))}
          onImport={importMedia} onActivate={activate}
          onRemove={() => remove('删除镜头', shot.title, { type: 'shot.remove', episodeId: episode.id, shotId: shot.id })} />}
      </div>
      <footer><span><FolderOpen size={14} /> <span className="project-path" title={opened.directory}>{opened.directory}</span></span>
        <span>{busy ? '处理中' : dirty ? '有未保存修改' : '已保存'}</span></footer>
    </>}

    {ask?.kind === 'name' && <NameModal key={ask.title} title={ask.title} initial={ask.initial} confirm={ask.confirm} busy={busy} error={message?.error ? message.text : undefined}
      onClose={() => { if (!busy) { setAsk(null); setMessage(null) } }} onSubmit={name => void ask.action(name).then(ok => { if (ok) setAsk(null) })} />}
    {ask?.kind === 'remove' && <Modal title={ask.title} onClose={() => { if (!busy) setAsk(null) }}>
      <p className="risk"><WarningCircle size={20} />{ask.name} · 此操作无法撤销</p>
      <div className="dialog-actions"><button onClick={() => setAsk(null)} disabled={busy}>取消</button>
        <button className="destructive" disabled={busy} onClick={() => void edit(ask.change, () => { setDirty(false); setAsk(null) })}>删除</button></div>
    </Modal>}
    {ask?.kind === 'discard' && <Modal title="未保存修改" onClose={() => setAsk(null)}>
      <div className="dialog-actions"><button autoFocus onClick={() => setAsk(null)}>继续编辑</button>
        <button className="destructive" onClick={() => { setAsk(null); setDirty(false); setEditorRevision(value => value + 1); ask.action() }}>放弃修改</button></div>
    </Modal>}
    {progress && <Modal title={progress.mode === 'preview' ? '生成顺序预览' : '导出 MP4'} onClose={() => void api.cancelRender()}>
      <div className="progress-line"><progress max={100} value={progress.percent} /><span>{progress.percent}%</span></div>
      <div className="dialog-actions"><button onClick={() => void api.cancelRender()}>{progress.mode === 'preview' ? '取消预览' : '取消导出'}</button></div>
    </Modal>}
    {player && <Modal title={`顺序预览 · ${episode?.title ?? ''}`} onClose={() => setPlayer('')}>
      <video className="episode-player" src={player} controls autoPlay onError={() => setMessage({ text: '预览视频无法播放', error: true })} />
      {message?.error && <p className="inline-error" role="alert">{message.text}</p>}
      <div className="dialog-actions"><button onClick={() => setPlayer('')}>关闭预览</button></div>
    </Modal>}
    {message && !player && ask?.kind !== 'name' && <div className={`toast ${message.error ? 'error' : ''}`} role={message.error ? 'alert' : 'status'}>
      {message.error ? <WarningCircle size={19} /> : <Check size={19} />}
      <span>{message.text}</span><button className="icon small subtle" title="关闭提示" aria-label="关闭提示" onClick={() => setMessage(null)}><X size={16} /></button>
    </div>}
  </div>
}

function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className="empty-stage"><div className="empty-icon">{icon}</div>{children}</div>
}

function Inspector({ shot, episode, index, busy, onSave, onCopy, onImport, onActivate, onRemove, onDirty }: {
  shot: Shot; episode: Episode; index: number; busy: boolean
  onSave: (fields: ShotFields) => void; onCopy: (text: string) => void; onImport: (target: MediaTarget) => void
  onActivate: (target: MediaTarget, id: string) => void; onRemove: () => void; onDirty: (value: boolean) => void
}) {
  const [draft, setDraft] = useState(() => fieldsFor(shot))
  const { title, frames, dialogue, prompt, status } = shot
  useEffect(() => { setDraft({ title, seconds: String(Number((frames / 30).toFixed(3))), dialogue, prompt, status }) }, [title, frames, dialogue, prompt, status])
  const dirty = draft.title.trim() !== title || Math.round(Number(draft.seconds) * 30) !== frames
    || draft.dialogue !== dialogue || draft.prompt !== prompt || draft.status !== status
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  return <aside className="inspector" aria-label="镜头编辑">
    <div className="section-head inspector-head"><div className="inspector-title"><span className="shot-number">{sequence(index)}</span><h2>镜头编辑</h2></div><Badge value={shot.status} /></div>
    <form onSubmit={event => {
      event.preventDefault()
      onSave({ title: draft.title.trim(), frames: Math.round(Number(draft.seconds) * 30),
        dialogue: draft.dialogue, prompt: draft.prompt, status: draft.status })
    }}>
      <fieldset disabled={busy}>
        <label className="field">镜头名称<input required maxLength={100} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <div className="field-grid">
          <label className="field">时长（秒）<input type="number" required min="0.033" max="600" step="any" value={draft.seconds}
            onChange={event => setDraft({ ...draft, seconds: event.target.value })} /></label>
          <label className="field">状态<select aria-label="状态" value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as ShotFields['status'] })}>
            {statuses.map(str => <option key={str}>{str}</option>)}</select></label>
        </div>
        <label className="field">台词<textarea rows={2} maxLength={1000} value={draft.dialogue} onChange={event => setDraft({ ...draft, dialogue: event.target.value })} /></label>
        <div className="prompt-field"><div className="field-header"><label htmlFor="shot-prompt">提示词</label>
          <button type="button" className="small subtle accent" disabled={!draft.prompt.trim()} onClick={() => onCopy(draft.prompt)}><Copy size={15} /> 复制提示词</button></div>
          <textarea id="shot-prompt" rows={3} maxLength={30000} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} />
        </div>
        <div className="inspector-save"><button type="button" className="icon small subtle danger" title="删除镜头" aria-label="删除镜头" onClick={onRemove}><Trash size={17} /></button>
          <button type="submit" className="primary small" disabled={!dirty || !draft.title.trim()}><FloppyDisk size={15} /> 保存镜头</button></div>
      </fieldset>
    </form>
    <div className="asset-panel"><h3>素材版本</h3>
      {kinds.map(kind => {
        const target = { scope: 'shot', episodeId: episode.id, shotId: shot.id, kind } as const
        return <MediaRow key={kind} track={shot.media[kind]} kind={kind} busy={busy}
          onImport={() => onImport(target)} onActivate={id => onActivate(target, id)} />
      })}
    </div>
  </aside>
}

function fieldsFor(shot: Shot) {
  return { title: shot.title, seconds: String(Number((shot.frames / 30).toFixed(3))), dialogue: shot.dialogue, prompt: shot.prompt, status: shot.status }
}
