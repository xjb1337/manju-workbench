import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowSquareOut, BookOpen, Check, FilmSlate, Copy, DownloadSimple, FilmStrip, FolderOpen, Image as ImageIcon,
  Moon, Play, Plus, Sun, Trash, WarningCircle, X, MapPin, UsersThree, FloppyDisk, FileText,
} from '@phosphor-icons/react'
import type { OpenProject, RecentProject, RenderProgress, Reply } from '../shared/api'
import {
  activeVersion, folderNameSchema, kinds, shotMedia, shotVisual, statuses, timecode, totalFrames, type Category, type Episode, type MediaTarget,
  type Mutation, type Project, type Shot, type ShotFields,
} from '../shared/model'
import { exportFallbacks, productionProgress, type StepId } from '../shared/production'
import { legacyDetail, savedShotPrompt } from '../shared/prompts'
import { Badge, MediaRow, Modal, NameModal, PreviewPlayer, TextEditor, Timeline, kindLabel, mediaUrl, sequence } from './components'
import {
  detailKinds, detailLabels, frameSpec, generationLabels, generationToolName, methodLabels, methodSchema, shotMethod,
  usesFinishedVideo, usesTrack, workTypeLabels, type DetailKind, type GenerationKind, type ShotMethod,
} from '../shared/creative'
import { BriefPanel, DetailDialog, PlanImportDialog, PlanningDialog } from './CreativePanels'
import { ProductionGuide, isShotStep } from './ProductionGuide'
import { UpdatePanel } from './UpdatePanel'

type Tab = 'shots' | 'script' | 'brief' | Category
type EditorField = 'shot-prompt' | 'shot-video-prompt' | 'shot-dialogue' | 'generation-image-name' | 'generation-video-name'
type Ask =
  | { kind: 'name'; title: string; initial?: string; confirm: string; action: (name: string) => Promise<boolean> }
  | { kind: 'remove'; title: string; name: string; change: Mutation }
  | { kind: 'discard'; action: () => void }
  | { kind: 'export'; fallbacks: ReturnType<typeof exportFallbacks> }
const api = window.workbench
const tabs = [{ id: 'shots', text: '分镜', icon: FilmStrip }, { id: 'brief', text: '制作简报', icon: FileText }, { id: 'script', text: '剧本', icon: BookOpen },
  { id: 'characters', text: '角色参考', icon: UsersThree }, { id: 'scenes', text: '场景参考', icon: MapPin }] as const

export function App() {
  const [opened, setOpened] = useState<OpenProject | null>(null)
  const [recent, setRecent] = useState<RecentProject[]>([])
  const [episodeId, setEpisodeId] = useState('')
  const [shotId, setShotId] = useState('')
  const [referenceId, setReferenceId] = useState('')
  const [tab, setTab] = useState<Tab>('shots')
  const [guideStep, setGuideStep] = useState<StepId | null>(null)
  const [focusField, setFocusField] = useState<EditorField | null>(null)
  const [scriptScope, setScriptScope] = useState<'project' | 'episode'>('project')
  const [editorRevision, setEditorRevision] = useState(0)
  const [dark, setDark] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [player, setPlayer] = useState('')
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [dirty, setDirty] = useState(false)
  const [creativeDialog, setCreativeDialog] = useState<'plan' | 'import' | 'magpie' | DetailKind | null>(null)
  const running = useRef(false)
  const project = opened?.project
  const episode = project?.episodes.find(item => item.id === episodeId) ?? project?.episodes[0]
  const shot = episode?.shots.find(item => item.id === shotId) ?? episode?.shots[0]
  const category = tab === 'characters' || tab === 'scenes' ? tab : null
  const references = category && project ? project[category] : []
  const reference = references.find(item => item.id === referenceId) ?? references[0]
  const guide = project && productionProgress(project, episode?.id)
  const step = guideStep && guide?.statuses[guideStep] ? guideStep : guide?.recommended ?? 'export'
  const spec = frameSpec(project)
  const method = shotMethod(project ?? {}, shot)
  const onWelcome = !opened

  function shotForStep(id: StepId) {
    if (!isShotStep(id)) return shot
    const items = guide?.media[id].items
    return items?.some(item => item.id === shot?.id) ? shot : episode?.shots.find(item => item.id === items?.[0]?.id)
  }

  const guideShot = shotForStep(step)

  useEffect(() => api.onProgress(setProgress), [])
  useEffect(() => {
    if (!onWelcome) return
    let current = true
    void api.recentProjects().then(reply => {
      if (current && reply.ok) setRecent(reply.value)
    }).catch(() => {})
    return () => { current = false }
  }, [onWelcome])
  useLayoutEffect(() => { void api.setEditorDirty(dirty).catch(() => {}) }, [dirty])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])
  useEffect(() => {
    if (focusField) {
      document.getElementById(focusField)?.focus()
      setFocusField(null)
    }
  }, [focusField])
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

  async function run<T>(action: () => Promise<Reply<T>>, success?: (value: T) => void, failure?: (message: string) => void) {
    if (running.current) return false
    running.current = true
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      if (!result.ok) {
        if (failure) failure(result.error)
        else setMessage({ text: result.error, error: true })
        return false
      }
      success?.(result.value)
      return true
    } catch {
      if (failure) failure('桌面进程连接中断')
      else setMessage({ text: '桌面进程连接中断', error: true })
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
    setGuideStep(null)
    setCreativeDialog(null)
    setScriptScope('project')
    setDirty(false)
  }

  function accept(project: Project | null) {
    if (project) setOpened(current => current && ({ ...current, project }))
  }

  function edit(change: Mutation, saved?: (project: Project) => void, failure?: (message: string) => void) {
    if (!opened) return Promise.resolve(false)
    return run(() => api.edit(opened.mediaKey, change), next => {
      accept(next)
      saved?.(next)
    }, failure)
  }

  function importMedia(target: MediaTarget) {
    if (opened) void run(() => api.importMedia(opened.mediaKey, target), accept)
  }
  function activate(target: MediaTarget, id: string) {
    void edit({ type: 'media.activate', target, versionId: id })
  }
  function keepMedia(target: MediaTarget, versionId: string) {
    void edit({ type: 'media.keep', target, versionId })
  }
  function openDetail(kind: DetailKind, shotToEdit = shot) {
    goTo('shots', () => {
      if (shotToEdit) setShotId(shotToEdit.id)
      setCreativeDialog(kind)
    }, true)
  }
  function copyPrompt(text: string) {
    void run(() => api.copy(text), () => setMessage({ text: '提示词已复制' }))
  }

  function goTo(nextTab: Tab, action?: () => void, replacesEditor = false) {
    const open = () => {
      if (nextTab !== tab) {
        setTab(nextTab)
        setReferenceId('')
        setDirty(false)
      }
      action?.()
    }
    if (nextTab !== tab || replacesEditor) navigate(open)
    else open()
  }

  function goToScript(scope: typeof scriptScope, action?: () => void) {
    const open = () => { setScriptScope(scope); action?.() }
    if (tab === 'script' && scriptScope !== scope) navigate(open)
    else goTo('script', open)
  }

  function selectGuideStep(id: StepId) {
    const select = () => setGuideStep(id)
    if (id === 'script') {
      goToScript(tab === 'script' ? scriptScope : episode?.script.trim() && !project?.script.trim() ? 'episode' : 'project', select)
    } else if (id === 'references') {
      goTo(category ?? guide?.missingReferences[0] ?? 'characters', select)
    } else {
      const target = shotForStep(id)
      goTo('shots', () => {
        if (target && target.id !== shot?.id) { setShotId(target.id); setDirty(false) }
        select()
      }, !!target && target.id !== shot?.id)
    }
  }

  function selectShot(id: string) {
    if (shot?.id !== id) goTo('shots', () => { setShotId(id); setDirty(false) }, true)
  }

  function addProject(sample: boolean | 'vertical') {
    setAsk({ kind: 'name', title: sample === 'vertical' ? '创建竖屏代码示例' : sample ? '创建虚构示例' : '新建作品',
      initial: sample === 'vertical' ? '观测站信号' : sample ? '雾港来信' : '',
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
        else if (result.status === 'record-failed') setMessage({ text: `成片已导出 · 导出记录保存失败 · ${result.location}`, error: true })
        else if (result.mode === 'preview') setPlayer(result.location)
        else {
          accept(result.project)
          setMessage({ text: `导出完成 · ${result.location}` })
        }
      })
    } finally {
      setProgress(null)
    }
  }

  const shotIndex = episode && shot ? episode.shots.indexOf(shot) : 0
  const start = episode?.shots.slice(0, shotIndex).reduce((time, item) => time + item.frames, 0) ?? 0
  const visual = shot && shotVisual(shot, method)
  const monitorKind = usesTrack(method, 'image') ? 'image' : 'video'
  const canRender = !!episode?.shots.length && !dirty && !busy

  function requestExport() {
    if (!project || !episode || !canRender) return
    const fallbacks = exportFallbacks(project, episode)
    if (fallbacks.length) setAsk({ kind: 'export', fallbacks })
    else void render('export')
  }

  function generationAction(kind: GenerationKind, inGuide = false) {
    const tool = project?.brief?.generation?.[kind]
    const name = generationToolName(tool)
    const label = `${generationLabels[kind]}工具`
    const url = tool?.url
    const text = url ? (inGuide ? `打开 ${name}` : name) : `设置${label}`
    return <button className={inGuide ? undefined : 'subtle external'} disabled={busy}
      title={url || (name ? `${label} · ${name}` : label)} onClick={() => {
        if (url && opened) void run(() => api.openTool(opened.mediaKey, kind))
        else goTo('brief', () => setFocusField(`generation-${kind}-name`))
      }}>
      <span className="generation-action-label">{text}</span>{url && <ArrowSquareOut aria-hidden="true" size={15} />}
    </button>
  }

  function guideActions() {
    if (!project) return null
    const targetShot = guideShot
    if (step === 'script') return <>
      <button onClick={() => goToScript('project')} disabled={busy}>作品剧本</button>
      {episode && <button onClick={() => goToScript('episode')} disabled={busy}>集数剧本</button>}
    </>
    if (step === 'references') return <>
      <button onClick={() => goTo('characters')} disabled={busy}>角色参考</button>
      <button onClick={() => goTo('scenes')} disabled={busy}>场景参考</button>
      {category && (reference
        ? <button onClick={() => importMedia({ scope: 'reference', category, referenceId: reference.id })} disabled={busy}>导入参考图</button>
        : <button onClick={addReference} disabled={busy}>新建参考</button>)}
    </>
    if (!episode || !targetShot || step === 'shots') return <button className="primary" disabled={busy}
      onClick={() => goTo('shots', episode ? addShot : addEpisode, true)}>{episode ? '新建镜头' : '新建集数'}</button>
    if (step === 'export') return <button className="primary" disabled={!canRender} onClick={requestExport}>导出 MP4</button>
    if (step === 'code') return <button className="primary" disabled={busy} onClick={() => openDetail('code', targetShot)}>编辑代码任务书</button>
    if (isShotStep(step)) {
      const kind = step === 'finished' ? 'video' : step
      const target = { scope: 'shot', episodeId: episode.id, shotId: targetShot.id, kind } as const
      const omitted = !!targetShot.omittedMedia?.[kind]
      const omitLabel = { image: '跳过生图', video: '跳过视频', audio: '标为静默' }[kind]
      const focus = (field: EditorField) => goTo('shots', () => {
        if (targetShot.id !== shotId) setShotId(targetShot.id)
        setGuideStep(step)
        setFocusField(field)
      }, targetShot.id !== shot?.id)
      const promptKind = step === 'video' ? 'flow' : 'image'
      const detailed = savedShotPrompt(project, targetShot, promptKind)
      const prompt = detailed ?? legacyDetail(targetShot, promptKind)
      return <>
        {step === 'audio' && <>
          <button disabled={busy} onClick={() => focus('shot-dialogue')}>编辑台词</button>
          <button disabled={busy} onClick={() => openDetail('voice', targetShot)}>配音与字幕稿</button>
        </>}
        {(step === 'image' || step === 'video') && <>
          <button disabled={busy} onClick={() => {
            if (detailed) openDetail(promptKind, targetShot)
            else focus(step === 'video' ? 'shot-video-prompt' : 'shot-prompt')
          }}>{detailed ? '编辑详细提示词' : '编辑提示词'}</button>
          <button disabled={busy || !prompt?.trim()} onClick={() => prompt && copyPrompt(prompt)}>
            {step === 'image' ? '复制生图提示词' : '复制视频提示词'}
          </button>
          {generationAction(step, true)}
        </>}
        <button className="primary" disabled={busy} onClick={() => importMedia(target)}>导入{step === 'finished' ? '成片' : kindLabel[kind]}</button>
        <button aria-pressed={omitted} disabled={busy} onClick={() => void edit({ type: 'shot.omit-media',
          episodeId: episode.id, shotId: targetShot.id, kind, omitted: !omitted })}>
          {omitted ? step === 'audio' ? '取消静默' : '取消跳过' : omitLabel}
        </button>
      </>
    }
  }

  return <div className="app">
    <header className="appbar">
      <div className="brand"><span className="brand-mark"><FilmSlate weight="bold" size={20} /></span><strong>AI 视频制作工作台</strong></div>
      <div className="app-actions">
        <button className="subtle" onClick={() => navigate(() => addProject(false))} disabled={busy}><Plus size={17} /> 新建作品</button>
        <button className="subtle" onClick={() => navigate(() => void run(() => api.open(), next => { if (next) load(next) }))} disabled={busy}><FolderOpen size={18} /> 打开作品</button>
        <span className="separator" />
        <UpdatePanel busy={busy} dirty={dirty} />
        <button className="icon subtle" aria-label={dark ? '切换浅色' : '切换深色'} title={dark ? '切换浅色' : '切换深色'}
          onClick={() => setDark(!dark)}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button>
      </div>
    </header>

    {!opened || !project ? <main className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark"><FilmSlate size={49} weight="duotone" /></div>
        <h1>AI 视频制作工作台</h1>
        <div className="actions">
          <button className="primary" onClick={() => addProject(false)} disabled={busy}><Plus size={19} /> 新建作品</button>
          <button onClick={() => void run(() => api.open(), next => { if (next) load(next) })} disabled={busy}><FolderOpen size={19} /> 打开作品</button>
        </div>
        <div className="sample-actions">
          <button className="sample-link subtle" onClick={() => addProject(true)} disabled={busy}><FilmStrip size={17} /> 创建虚构示例</button>
          <button className="sample-link subtle" onClick={() => addProject('vertical')} disabled={busy}><FilmStrip size={17} /> 创建竖屏代码示例</button>
        </div>
        {!!recent.length && <section className="recent-projects" aria-labelledby="recent-title">
          <h2 id="recent-title">最近作品</h2>
          <ul>{recent.map(item => <li key={item.id}>
            <button disabled={busy} onClick={() => void run(() => api.openRecent(item.id), next => { if (next) load(next) })}>
              <FolderOpen aria-hidden="true" size={19} />
              <span><strong>{item.title}</strong><small title={item.directory}>{item.directory}</small></span>
              {item.fictional && <Badge value="示例 / 虚构" />}
            </button>
          </li>)}</ul>
        </section>}
      </div>
    </main> : <>
      <div className="projectbar">
        <div className="project-title"><span className="project-icon"><FolderOpen size={20} weight="duotone" /></span>
          <h1>{project.title}</h1>{project.workType && <Badge value={workTypeLabels[project.workType]} />}{project.fictional && <Badge value="示例 / 虚构" />}</div>
        <div className="actions">
          {generationAction('image')}
          {generationAction('video')}
          <span className="separator" />
          <button className="icon subtle" title="关闭作品" aria-label="关闭作品" disabled={busy}
            onClick={() => navigate(() => void run(() => api.close(), () => load(null)))}><X size={19} /></button>
        </div>
      </div>
      {guide && <ProductionGuide progress={guide} step={step} episode={episode} shot={guideShot} busy={busy}
        onStep={selectGuideStep} onShot={selectShot}>{guideActions()}</ProductionGuide>}
      <div className="workspace">
        <aside className="sidebar">
          <div className="section-head"><h2>作品目录</h2></div>
          <nav aria-label="作品目录">{tabs.map(({ id, text, icon: Icon }) => <button key={id} className="nav-entry"
            aria-current={tab === id ? 'page' : undefined} disabled={busy}
            onClick={() => goTo(id)}>
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
              <span className="export-size">{spec.width} × {spec.height}</span>
              <button disabled={!canRender} onClick={() => void render('preview')}><Play size={16} weight="fill" /> 顺序预览</button>
              <button className="primary" disabled={!canRender} onClick={requestExport}><DownloadSimple size={18} /> 导出 MP4</button>
            </div>
          </div>
          {shot ? <section className="monitor" aria-label="镜头画面" data-ratio={spec.ratio}>
            <div className="monitor-top"><div><span className="monitor-dot" /><strong>镜头 {sequence(shotIndex)} · {shot.title}</strong></div><span>{spec.ratio}</span></div>
            <div className="monitor-matte">
              <div className="monitor-body" style={{ aspectRatio: `${spec.width} / ${spec.height}` }}>
                {visual?.kind === 'image' ? <img key={visual.version.id} src={mediaUrl(opened, visual.version)} alt={shot.title} /> : visual
                  ? <video key={visual.version.id} src={mediaUrl(opened, visual.version)} preload="metadata" muted />
                  : <button className="monitor-import" onClick={() => episode && importMedia({ scope: 'shot', episodeId: episode.id,
                    shotId: shot.id, kind: monitorKind })} disabled={busy}><ImageIcon size={22} /> {monitorKind === 'image' ? '导入参考图' : usesFinishedVideo(method) ? '导入成片' : '导入视频'}</button>}
                {shot.dialogue && <span className="frame-caption" style={{
                  bottom: `${(100 * spec.subtitle.bottom) / spec.height}%`,
                  fontSize: `${(100 * spec.subtitle.size) / spec.width}cqw`,
                  maxWidth: `${100 - (200 * spec.subtitle.horizontal) / spec.width}%`,
                }}>{shot.dialogue}</span>}
              </div>
            </div>
            <div className="monitor-bottom"><span><span className="monitor-tick" />{timecode(start, true)}</span><span>{timecode(shot.frames, true)} <span className="monitor-divider">/</span> 30 fps</span></div>
          </section> : <Empty icon={<FilmStrip size={38} weight="duotone" />}>
            <button className="primary" disabled={busy} onClick={() => episode ? addShot() : addEpisode()}><Plus size={18} /> {episode ? '新建镜头' : '新建集数'}</button>
          </Empty>}
          {episode && !!episode.shots.length && <Timeline opened={opened} episode={episode} shotId={shot?.id} busy={busy}
            onSelect={selectShot}
            onAdd={() => navigate(addShot)} onMove={direction => shot && void edit({
              type: 'shot.move', episodeId: episode.id, shotId: shot.id, direction,
            })} />}
        </main> : tab === 'brief' ? <BriefPanel key={project.id + editorRevision} project={project} episode={episode} busy={busy}
          onDirty={setDirty} onSave={change => void edit(change, () => setMessage({ text: '简报已保存' }))}
          onPlan={() => setCreativeDialog('plan')} onImport={() => setCreativeDialog('import')}
          onMagpie={() => setCreativeDialog('magpie')} /> : tab === 'script' ? <main className="stage wide">
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
                  onActivate={id => activate({ scope: 'reference', category, referenceId: reference.id }, id)}
                  onKeep={id => keepMedia({ scope: 'reference', category, referenceId: reference.id }, id)} />
              </div>
            </>}
        </main>}
        {tab === 'shots' && shot && episode && <Inspector key={shot.id + editorRevision} shot={shot} episode={episode} index={shotIndex} busy={busy}
          method={method} showVideoPrompt={step === 'video' && (method === 'flow' || method === 'flow-only')}
          onDetail={openDetail} onKeep={keepMedia}
          onDirty={setDirty} onSave={fields => void edit({ type: 'shot.edit', episodeId: episode.id, shotId: shot.id, fields },
            () => setMessage({ text: '镜头已保存' }))}
          onCopy={copyPrompt} detailedImagePrompt={savedShotPrompt(project, shot, 'image')}
          onImport={importMedia} onActivate={activate}
          onRemove={() => remove('删除镜头', shot.title, { type: 'shot.remove', episodeId: episode.id, shotId: shot.id })} />}
      </div>
      <footer><span><FolderOpen size={14} /> <span className="project-path" title={opened.directory}>{opened.directory}</span></span>
        <span>{busy ? '处理中' : dirty ? '有未保存修改' : '已保存'}</span></footer>
    </>}

    {opened && project && creativeDialog === 'plan' && <PlanningDialog project={project} episode={episode} busy={busy}
      copy={(text, failure) => run(() => api.copy(text), undefined, failure)}
      openTool={failure => void run(() => api.openTool(opened.mediaKey, 'planning'), undefined, failure)}
      close={() => { if (!busy) setCreativeDialog(null) }} />}
    {opened && project && (creativeDialog === 'import' || creativeDialog === 'magpie') &&
      <PlanImportDialog key={creativeDialog} episode={episode} fictional={project.fictional} busy={busy}
      source={creativeDialog === 'magpie' ? {
        kind: 'magpie', script: episode?.script || project.script,
        preview: (model, script, acceptPreview, failure) => void run(
          () => api.generateMagpiePlan(opened.mediaKey, episode?.id ?? null, model, script), acceptPreview, failure),
        cancel: failure => void api.cancelPlanGeneration(opened.mediaKey).then(reply => {
          if (!reply.ok) failure(reply.error)
        }).catch(() => failure('桌面进程连接中断')),
      } : { kind: 'paste', preview: (text, acceptPreview, failure) => void run(
        () => api.previewPlan(opened.mediaKey, episode?.id ?? null, text), acceptPreview, failure) }}
      onMerge={(preview, replacements, failure) => void run(() => api.mergePlan(opened.mediaKey, preview.token, replacements), next => {
        accept(next)
        setCreativeDialog(null)
        setMessage({ text: '规划已合并' })
      }, failure)}
      close={() => { if (!busy) setCreativeDialog(null) }} />}
    {project && episode && shot && creativeDialog && creativeDialog !== 'plan' && creativeDialog !== 'import' && creativeDialog !== 'magpie' &&
      <DetailDialog key={shot.id + creativeDialog} project={project} episode={episode} shot={shot} kind={creativeDialog} busy={busy}
        onDirty={setDirty} copy={(text, failure) => run(() => api.copy(text), undefined, failure)}
        save={(action, failure) => edit({ type: 'shot.detail', episodeId: episode.id, shotId: shot.id, kind: creativeDialog, action }, undefined, failure)}
        close={() => setCreativeDialog(null)} />}
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
    {ask?.kind === 'export' && <Modal title="确认导出替代画面" onClose={() => setAsk(null)}>
      <p className="risk"><WarningCircle aria-hidden="true" size={20} />{ask.fallbacks.length} 个镜头缺少所需画面，成片会使用下列替代画面。</p>
      <ul className="export-fallbacks">{ask.fallbacks.map(({ index, title, label }) => <li key={index}>
        <span>{sequence(index)} · {title}</span><strong>{label}</strong>
      </li>)}</ul>
      <div className="dialog-actions">
        <button autoFocus onClick={() => setAsk(null)}>返回补素材</button>
        <button className="primary" onClick={() => { setAsk(null); void render('export') }}>继续导出</button>
      </div>
    </Modal>}
    {progress && <Modal title={progress.mode === 'preview' ? '生成顺序预览' : '导出 MP4'} onClose={() => void api.cancelRender()}>
      <p className="render-spec">{spec.ratio} · {spec.width} × {spec.height} · 30 fps</p>
      <div className="progress-line"><progress max={100} value={progress.percent} /><span>{progress.percent}%</span></div>
      <div className="dialog-actions"><button onClick={() => void api.cancelRender()}>{progress.mode === 'preview' ? '取消预览' : '取消导出'}</button></div>
    </Modal>}
    {player && <Modal title={`顺序预览 · ${episode?.title ?? ''}`} onClose={() => setPlayer('')}>
      <PreviewPlayer key={player} source={player} ratio={spec.ratio} onError={() => setMessage({ text: '预览视频无法播放', error: true })} />
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

function Inspector({ shot, episode, index, busy, method, showVideoPrompt, detailedImagePrompt, onSave, onCopy, onImport, onActivate, onKeep, onDetail, onRemove, onDirty }: {
  shot: Shot; episode: Episode; index: number; busy: boolean; method: ShotMethod; showVideoPrompt: boolean
  onKeep: (target: MediaTarget, id: string) => void; onDetail: (kind: DetailKind) => void
  onSave: (fields: ShotFields) => void; onCopy: (text: string) => void; onImport: (target: MediaTarget) => void
  detailedImagePrompt?: string
  onActivate: (target: MediaTarget, id: string) => void; onRemove: () => void; onDirty: (value: boolean) => void
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
        <label className="field">台词<textarea id="shot-dialogue" rows={2} maxLength={1000} value={draft.dialogue} onChange={event => setDraft({ ...draft, dialogue: event.target.value })} /></label>
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
        return <MediaRow key={kind} track={shot.media[kind]} kind={kind} busy={busy}
          onImport={() => onImport(target)} onActivate={id => onActivate(target, id)} onKeep={id => onKeep(target, id)} />
      })}
    </div>
  </aside>
}

function fieldsFor(shot: Shot, method: ShotMethod) {
  return { title: shot.title, seconds: String(Number((shot.frames / 30).toFixed(3))), dialogue: shot.dialogue,
    prompt: shot.prompt, videoPrompt: shot.videoPrompt ?? '', status: shot.status, method }
}
