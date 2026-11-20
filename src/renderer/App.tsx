import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowSquareOut, Broom, Check, FilmSlate, FolderOpen, Moon, Plus, SlidersHorizontal, Sparkle, Sun, WarningCircle, X } from '@phosphor-icons/react'
import type { OpenProject, OrphanMediaPreview, RecentProject, RenderProgress, Reply, ReplyError } from '../shared/api'
import { frameSpec, generationLabels, generationToolName, shotMethod, workTypeLabels, type DetailKind, type GenerationKind } from '../shared/creative'
import { folderNameSchema, type MediaTarget, type Mutation, type Project, type Track } from '../shared/model'
import { defaultAiGatewayConfig, type AiGatewayConfig } from '../shared/plan'
import { exportFallbacks, productionProgress, type StepId } from '../shared/production'
import { legacyDetail, savedShotPrompt } from '../shared/prompts'
import { AiSettingsDialog, sameGateway, ScriptAiDialog, type GatewayProbe } from './AiPanels'
import { Badge, Modal, NameModal, PreviewPlayer, kindLabel, sequence } from './components'
import { BriefPanel, DetailDialog, PlanImportDialog, PlanningDialog } from './CreativePanels'
import { Inspector } from './Inspector'
import { ProductionGuide, isShotStep } from './ProductionGuide'
import { ShotStage } from './ShotStage'
import { UpdatePanel } from './UpdatePanel'
import { WelcomeView } from './WelcomeView'
import { ProjectSidebar, ReferenceView, ScriptView, type Tab } from './WorkspaceViews'
import { useWorkbenchShortcuts } from './useWorkbenchShortcuts'

type EditorField = 'shot-prompt' | 'shot-video-prompt' | 'shot-dialogue' | 'script-text' | 'generation-image-name' | 'generation-video-name'
type Ask =
  | { kind: 'name'; title: string; initial?: string; confirm: string; action: (name: string) => Promise<boolean> }
  | { kind: 'remove'; title: string; name: string; change: Mutation }
  | { kind: 'clean-orphans'; report: OrphanMediaPreview; stale?: boolean }
  | { kind: 'discard'; action: () => void }
  | { kind: 'export'; fallbacks: ReturnType<typeof exportFallbacks> }

const api = window.workbench
const themeStorageKey = 'manju:theme'

function readDarkTheme() {
  try {
    return localStorage.getItem(themeStorageKey) === 'dark'
  } catch {
    return false
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

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
  const [dark, setDark] = useState(readDarkTheme)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [player, setPlayer] = useState('')
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [upgradeRequest, setUpgradeRequest] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [creativeDialog, setCreativeDialog] = useState<'plan' | 'import' | 'magpie' | DetailKind | null>(null)
  const [magpieSeedScript, setMagpieSeedScript] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<AiGatewayConfig>(defaultAiGatewayConfig)
  const [gatewayProbe, setGatewayProbe] = useState<GatewayProbe | null>(null)
  const discoveredModels = gatewayProbe && 'result' in gatewayProbe && sameGateway(aiConfig, gatewayProbe)
    ? gatewayProbe.result.models : []
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false)
  const [scriptAi, setScriptAi] = useState<{
    scope: 'project' | 'episode'; script: string; apply: (next: string) => void
  } | null>(null)
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
  const shotIndex = episode && shot ? episode.shots.indexOf(shot) : 0
  const hasScript = !!(episode?.script.trim() || project?.script.trim())
  const canRender = !!episode?.shots.length && !dirty && !busy

  function shotForStep(id: StepId) {
    if (!isShotStep(id)) return shot
    const items = guide?.media[id].items
    return items?.some(item => item.id === shot?.id) ? shot : episode?.shots.find(item => item.id === items?.[0]?.id)
  }

  const guideShot = shotForStep(step)

  useEffect(() => api.onProgress(setProgress), [])
  useEffect(() => api.onUpgradeRequired(setUpgradeRequest), [])
  useEffect(() => api.onUpgraded(next => {
    setOpened(current => current?.mediaKey === next.mediaKey ? next : current)
  }), [])
  useEffect(() => {
    let current = true
    void api.getAiConfig?.().then(reply => {
      if (current && reply.ok) setAiConfig(reply.value)
    }).catch(() => {})
    return () => { current = false }
  }, [])
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
    const theme = dark ? 'dark' : 'light'
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem(themeStorageKey, theme) } catch {}
    void api.setTheme?.(theme).catch(() => {})
  }, [dark])
  useEffect(() => {
    if (!focusField) return
    document.getElementById(focusField)?.focus()
    setFocusField(null)
  }, [focusField])
  useEffect(() => {
    if (!message || message.error) return
    const timer = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(timer)
  }, [message])

  useWorkbenchShortcuts({
    opened: Boolean(opened),
    canSwitchShot: tab === 'shots' && Boolean(episode && shot),
    shots: episode?.shots,
    shotIndex,
    busy,
    dirty,
    hasModalOpen: Boolean(ask || creativeDialog || progress || player || aiSettingsOpen || scriptAi),
    onSelectShot: selectShot,
  })

  function openMagpieDialog(seedScript?: string) {
    setMagpieSeedScript(seedScript ?? null)
    setCreativeDialog('magpie')
  }

  function saveAiConfig(next: AiGatewayConfig, failure?: (text: string) => void) {
    return run(() => api.setAiConfig(next), saved => {
      setAiConfig(saved)
      setGatewayProbe(current => current && sameGateway(saved, current) ? current : null)
    }, failure)
  }

  function navigate(action: () => void) {
    if (dirty) setAsk({ kind: 'discard', action })
    else action()
  }

  async function run<T>(action: () => Promise<Reply<T>>, success?: (value: T) => void, failure?: (message: string, code?: ReplyError['code']) => void) {
    if (running.current) return false
    running.current = true
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      if (!result.ok) {
        if (result.code === 'upgrade-canceled') return false
        if (failure) failure(result.error, result.code)
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
    setMagpieSeedScript(null)
    setScriptAi(null)
    setScriptScope('project')
    setDirty(false)
    setEditorRevision(value => value + 1)
  }

  function accept(next: Project | null) {
    if (next) setOpened(current => current && ({ ...current, project: next }))
  }

  function edit(change: Mutation, saved?: (next: Project) => void, failure?: (message: string, code?: ReplyError['code']) => void) {
    if (!opened) return Promise.resolve(false)
    return run(() => api.edit(opened.mediaKey, change), next => {
      accept(next)
      saved?.(next)
    }, failure)
  }

  function saveScript(change: Extract<Mutation, { type: 'project.edit' | 'episode.edit' }>, onConflict: () => void) {
    void edit(change, undefined, (text, code) => {
      if (code === 'project-conflict') onConflict()
      setMessage({ text, error: true })
    })
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
  function mediaTrackFor(target: MediaTarget): Track | undefined {
    if (!project) return undefined
    if (target.scope === 'reference') {
      return project[target.category].find(item => item.id === target.referenceId)?.image
    }
    return project.episodes.find(item => item.id === target.episodeId)
      ?.shots.find(item => item.id === target.shotId)?.media[target.kind]
  }
  function removeMedia(target: MediaTarget, versionId: string) {
    const kind = target.scope === 'reference' ? 'image' : target.kind
    const version = mediaTrackFor(target)?.versions.find(item => item.id === versionId)
    const name = version ? `${kindLabel[kind]} · ${version.name}` : kindLabel[kind]
    remove(`删除${kindLabel[kind]}当前版本`, name, { type: 'media.remove', target, versionId })
  }
  function dropMedia(target: MediaTarget, file: File) {
    if (opened && !busy) void run(() => api.importDroppedMedia(opened.mediaKey, target, file), accept)
  }
  function inspectOrphans() {
    if (opened) void run(() => api.inspectOrphanMedia(opened.mediaKey), report => setAsk({ kind: 'clean-orphans', report }))
  }
  function closeOrphanPreview() {
    if (busy || ask?.kind !== 'clean-orphans') return
    if (opened) void api.cancelOrphanMedia(opened.mediaKey, ask.report.token).catch(() => {})
    setAsk(null)
    setMessage(null)
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
      if (nextTab !== tab || replacesEditor) {
        setDirty(false)
        setEditorRevision(value => value + 1)
      }
      if (nextTab !== tab) {
        setTab(nextTab)
        setReferenceId('')
      }
      action?.()
    }
    if (nextTab !== tab || replacesEditor) navigate(open)
    else open()
  }

  function goToScript(scope: typeof scriptScope, action?: () => void) {
    const nextScope = episode ? scope : 'project'
    goTo('script', () => {
      setScriptScope(nextScope)
      action?.()
    }, (episode ? scriptScope : 'project') !== nextScope)
  }

  function writeScript() {
    goToScript(episode ? 'episode' : 'project', () => setFocusField('script-text'))
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
        setDirty(false)
        setEditorRevision(value => value + 1)
      }) })
  }
  function addShot() {
    if (!episode) return
    setAsk({ kind: 'name', title: '新建镜头', confirm: '新建',
      action: title => edit({ type: 'shot.add', episodeId: episode.id, title }, next => {
        setShotId(next.episodes.find(item => item.id === episode.id)!.shots.at(-1)!.id)
        setTab('shots')
        setDirty(false)
        setEditorRevision(value => value + 1)
      }) })
  }
  function addReference() {
    if (!category) return
    setAsk({ kind: 'name', title: category === 'characters' ? '新建角色参考' : '新建场景参考', confirm: '新建',
      action: title => edit({ type: 'reference.add', category, title }, next => {
        setReferenceId(next[category].at(-1)!.id)
        setDirty(false)
        setEditorRevision(value => value + 1)
      }) })
  }
  function remove(title: string, name: string, change: Mutation) {
    setAsk({ kind: 'remove', title, name, change })
  }

  function exportSrt() {
    if (!opened || !episode) return
    void run(() => api.exportSrt(opened.mediaKey, episode.id), location => {
      if (location) setMessage({ text: `字幕已导出 · ${location}` })
    })
  }

  async function render(mode: RenderProgress['mode'], rebuild = false) {
    if (!opened || !episode || running.current) return
    setProgress({ mode, percent: 0 })
    try {
      await run(() => api.render(opened.mediaKey, episode.id, mode, rebuild), result => {
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

  function duplicateShot() {
    if (!episode || !shot) return
    const currentEpisodeId = episode.id
    const previousIds = new Set(episode.shots.map(item => item.id))
    const fallbackIndex = shotIndex + 1
    void edit({ type: 'shot.duplicate', episodeId: currentEpisodeId, shotId: shot.id }, next => {
      const nextEpisode = next.episodes.find(item => item.id === currentEpisodeId)
      const duplicated = nextEpisode?.shots.find(item => !previousIds.has(item.id)) ?? nextEpisode?.shots[fallbackIndex]
      if (duplicated) setShotId(duplicated.id)
      setDirty(false)
      setEditorRevision(value => value + 1)
      setMessage({ text: '已复制镜头' })
    })
  }

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
      {!hasScript && <button className="primary" onClick={writeScript} disabled={busy}>写／粘贴剧本</button>}
      {(hasScript || episode) && <button onClick={() => goToScript('project')} disabled={busy}>作品剧本</button>}
      {episode && hasScript && <button onClick={() => goToScript('episode')} disabled={busy}>集数剧本</button>}
      {hasScript && <button className="primary" onClick={() => openMagpieDialog()} disabled={busy}><Sparkle size={15} /> AI 生成分镜草案</button>}
    </>
    if (step === 'references') return <>
      <button onClick={() => goTo('characters')} disabled={busy}>角色参考</button>
      <button onClick={() => goTo('scenes')} disabled={busy}>场景参考</button>
      {category && (reference
        ? <button onClick={() => importMedia({ scope: 'reference', category, referenceId: reference.id })} disabled={busy}>导入参考图</button>
        : <button onClick={addReference} disabled={busy}>新建参考</button>)}
    </>
    if (!episode || !targetShot || step === 'shots') return <>
      {!targetShot && !hasScript && <button className="primary" onClick={writeScript} disabled={busy}>写／粘贴剧本</button>}
      <button className={targetShot ? 'primary' : undefined} disabled={busy}
        onClick={() => navigate(episode ? addShot : addEpisode)}>{episode ? '新建镜头' : '新建集数'}</button>
      <button className={!targetShot && hasScript ? 'primary' : undefined} disabled={busy} onClick={() => openMagpieDialog()}>
        <Sparkle size={15} /> {hasScript || targetShot ? 'AI 生成分镜草案' : '粘贴剧本'}</button>
      <button className="subtle" disabled={busy} onClick={() => setCreativeDialog('import')}>导入外部规划</button>
    </>
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
        <button className="subtle" onClick={() => setAiSettingsOpen(true)} disabled={busy} title={`${aiConfig.baseUrl} · ${aiConfig.model}`}>
          <SlidersHorizontal size={17} />
          <span>AI 设置</span>
        </button>
        <UpdatePanel busy={busy} dirty={dirty} />
        <button className="icon subtle" aria-label={dark ? '切换浅色' : '切换深色'} title={dark ? '切换浅色' : '切换深色'}
          onClick={() => setDark(!dark)}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button>
      </div>
    </header>

    {!opened || !project ? <WelcomeView recent={recent} busy={busy} onCreate={addProject}
      onOpen={() => void run(() => api.open(), next => { if (next) load(next) })}
      onOpenRecent={id => void run(() => api.openRecent(id), next => { if (next) load(next) })} /> : <>
      <div className="projectbar">
        <div className="project-title"><span className="project-icon"><FolderOpen size={20} weight="duotone" /></span>
          <h1>{project.title}</h1>{project.workType && <Badge value={workTypeLabels[project.workType]} />}{project.fictional && <Badge value="示例 / 虚构" />}</div>
        <div className="actions">
          {generationAction('image')}
          {generationAction('video')}
          <span className="separator" />
          <button type="button" className="icon subtle" title="清理未用素材" aria-label="清理未用素材" disabled={busy}
            onClick={inspectOrphans}><Broom size={18} /></button>
          <button className="icon subtle" title="关闭作品" aria-label="关闭作品" disabled={busy}
            onClick={() => navigate(() => void run(() => api.close(), () => load(null)))}><X size={19} /></button>
        </div>
      </div>
      {guide && <ProductionGuide progress={guide} step={step} episode={episode} shot={guideShot} busy={busy}
        onStep={selectGuideStep} onShot={selectShot}>{guideActions()}</ProductionGuide>}
      <div className="workspace">
        <ProjectSidebar project={project} tab={tab} episodeId={episode?.id} busy={busy} onSelectTab={goTo}
          onAddEpisode={() => navigate(addEpisode)}
          onSelectEpisode={id => {
            if (episode?.id !== id || tab !== 'shots') navigate(() => {
              setEpisodeId(id); setShotId(''); setTab('shots'); setDirty(false); setEditorRevision(value => value + 1)
            })
          }} />
        {tab === 'shots' ? <ShotStage opened={opened} episode={episode} shot={shot} shotIndex={shotIndex} spec={spec}
          method={method} busy={busy} canRender={canRender} playerOpen={Boolean(player)}
          onOpenEpisodeScript={() => goToScript('episode')}
          onPreview={() => void render('preview')} onRebuildPreview={() => void render('preview', true)} onExport={requestExport} onExportSrt={exportSrt}
          onAddPrimary={() => episode ? addShot() : addEpisode()}
          hasScript={hasScript} onWriteScript={writeScript} onMagpie={() => openMagpieDialog()}
          onImportPlan={() => setCreativeDialog('import')}
          onSelectShot={selectShot}
          onAddShot={() => navigate(addShot)}
          onMoveShot={direction => episode && shot && void edit({ type: 'shot.move', episodeId: episode.id, shotId: shot.id, direction })}
          onDuplicateShot={() => navigate(duplicateShot)}
          onImportMedia={importMedia} onDropMedia={dropMedia}
          onPlaybackError={text => setMessage({ text, error: true })} />
          : tab === 'brief' ? <BriefPanel key={project.id + editorRevision} project={project} episode={episode} busy={busy}
            onDirty={setDirty} onSave={change => edit(change, () => setMessage({ text: '简报已保存' }))}
            onPlan={() => setCreativeDialog('plan')} onImport={() => setCreativeDialog('import')}
            hasScript={hasScript} onWriteScript={writeScript} onMagpie={() => openMagpieDialog()} />
          : tab === 'script' ? <ScriptView project={project} episode={episode} scriptScope={scriptScope}
            editorRevision={editorRevision} busy={busy}
            onSelectScope={goToScript}
            onDirty={setDirty}
            onSaveProject={(title, script, onConflict) => saveScript({ type: 'project.edit', title, script }, onConflict)}
            onSaveEpisode={(title, script, onConflict) => episode && saveScript({ type: 'episode.edit', episodeId: episode.id, title, script }, onConflict)}
            onCopyDraft={text => void run(() => api.copy(text), () => setMessage({ text: '草稿已复制' }))}
            onRemoveEpisode={() => episode && remove('删除集数', episode.title, { type: 'episode.remove', episodeId: episode.id })}
            onAiAssist={(scope, script, apply) => setScriptAi({ scope, script, apply })}
            onAiStoryboard={script => openMagpieDialog(script)} />
          : category && <ReferenceView opened={opened} category={category} references={references} reference={reference}
            editorRevision={editorRevision} busy={busy} onAddNavigate={() => navigate(addReference)} onAddDirect={addReference}
            onSelectReference={id => navigate(() => { setReferenceId(id); setDirty(false); setEditorRevision(value => value + 1) })}
            onDirty={setDirty}
            onSaveReference={(id, title, notes) => void edit({ type: 'reference.edit', category, referenceId: id, title, notes })}
            onRemoveReference={item => remove('删除参考资料', item.title, { type: 'reference.remove', category, referenceId: item.id })}
            onImportMedia={importMedia} onActivateMedia={activate} onKeepMedia={keepMedia}
            onRemoveMedia={removeMedia} onDropMedia={dropMedia} />}
        {tab === 'shots' && shot && episode && <Inspector key={shot.id + editorRevision} opened={opened} shot={shot} episode={episode} index={shotIndex} busy={busy}
          method={method} showVideoPrompt={step === 'video' && (method === 'flow' || method === 'flow-only')}
          onDetail={openDetail} onKeep={keepMedia}
          onDirty={setDirty} onSave={fields => void edit({ type: 'shot.edit', episodeId: episode.id, shotId: shot.id, fields },
            () => setMessage({ text: '镜头已保存' }))}
          onCopy={copyPrompt} detailedImagePrompt={savedShotPrompt(project, shot, 'image')}
          onImport={importMedia} onActivate={activate}
          onRemoveMedia={removeMedia} onDropFile={dropMedia}
          onRemove={() => remove('删除镜头', shot.title, { type: 'shot.remove', episodeId: episode.id, shotId: shot.id })} />}
      </div>
      <footer><span><FolderOpen size={14} /> <span className="project-path" title={opened.directory}>{opened.directory}</span></span>
        <span>{project.schemaVersion === 1 && <Badge value="格式 1" />}<span>{busy ? '处理中' : dirty ? '有未保存修改' : '已保存'}</span></span></footer>
    </>}

    {opened && project && creativeDialog === 'plan' && <PlanningDialog project={project} episode={episode} busy={busy}
      copy={(text, failure) => run(() => api.copy(text), undefined, failure)}
      openTool={failure => void run(() => api.openTool(opened.mediaKey, 'planning'), undefined, failure)}
      close={() => { if (!busy) setCreativeDialog(null) }} />}
    {opened && project && (creativeDialog === 'import' || creativeDialog === 'magpie') &&
      <PlanImportDialog key={creativeDialog} episode={episode} fictional={project.fictional} busy={busy}
      aiConfig={aiConfig} discoveredModels={discoveredModels}
      onOpenAiSettings={() => setAiSettingsOpen(true)}
      onSaveModel={model => {
        if (model !== aiConfig.model) {
          void api.setAiConfig({ ...aiConfig, model }).then(reply => {
            if (reply.ok) setAiConfig(reply.value)
          }).catch(() => {})
        }
      }}
      source={creativeDialog === 'magpie' ? {
        kind: 'magpie', script: magpieSeedScript ?? (episode?.script || project.script),
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
        setMagpieSeedScript(null)
        setMessage({ text: '规划已合并' })
      }, failure)}
      close={() => { if (!busy) { setCreativeDialog(null); setMagpieSeedScript(null) } }} />}
    {opened && project && episode && shot && creativeDialog && creativeDialog !== 'plan' && creativeDialog !== 'import' && creativeDialog !== 'magpie' &&
      <DetailDialog key={shot.id + creativeDialog} project={project} episode={episode} shot={shot} kind={creativeDialog} busy={busy}
        aiConfig={aiConfig} onOpenAiSettings={() => setAiSettingsOpen(true)}
        onOptimize={(body, instruction, acceptDraft, failure) => void run(
          () => api.generateShotDetailDraft(opened.mediaKey, episode.id, shot.id, creativeDialog, body, instruction),
          acceptDraft, failure,
        )}
        onCancelOptimize={failure => void api.cancelPlanGeneration(opened.mediaKey).then(reply => {
          if (!reply.ok) failure(reply.error)
        }).catch(() => failure('桌面进程连接中断'))}
        onDirty={setDirty} copy={(text, failure) => run(() => api.copy(text), undefined, failure)}
        save={(action, failure) => edit({ type: 'shot.detail', episodeId: episode.id, shotId: shot.id, kind: creativeDialog, action }, undefined, failure)}
        onApplyVoice={creativeDialog === 'voice' ? (change, failure) => {
          if (dirty) {
            failure('请先保存台词或配音稿')
            return Promise.resolve(false)
          }
          return edit({ type: 'shot.apply-voice', episodeId: episode.id, shotId: shot.id, ...change },
            () => setMessage({ text: '已应用到本镜台词' }), failure)
        } : undefined}
        close={() => setCreativeDialog(null)} />}
    {opened && project && scriptAi && <ScriptAiDialog
      scope={scriptAi.scope} episodeTitle={episode?.title} fictional={project.fictional}
      currentScript={scriptAi.script} aiConfig={aiConfig} busy={busy}
      onOpenSettings={() => setAiSettingsOpen(true)}
      onGenerate={(instruction, acceptDraft, failure) => void run(
        () => api.generateScriptDraft(opened.mediaKey, scriptAi.scope, episode?.id ?? null, scriptAi.script, instruction),
        acceptDraft, failure,
      )}
      onCancel={failure => void api.cancelPlanGeneration(opened.mediaKey).then(reply => {
        if (!reply.ok) failure(reply.error)
      }).catch(() => failure('桌面进程连接中断'))}
      onApply={nextScript => { scriptAi.apply(nextScript); setMessage({ text: 'AI 剧本草案已填入编辑器，请确认后保存' }) }}
      close={() => { if (!busy) setScriptAi(null) }} />}
    {ask?.kind === 'name' && <NameModal key={ask.title} title={ask.title} initial={ask.initial} confirm={ask.confirm} busy={busy} error={message?.error ? message.text : undefined}
      onClose={() => { if (!busy) { setAsk(null); setMessage(null) } }} onSubmit={name => void ask.action(name).then(ok => { if (ok) setAsk(null) })} />}
    {ask?.kind === 'remove' && <Modal title={ask.title} onClose={() => { if (!busy) { setAsk(null); setMessage(null) } }}>
      <p className="risk"><WarningCircle size={20} />{ask.name} · 此操作无法撤销</p>
      {message?.error && <p className="inline-error" role="alert">{message.text}</p>}
      <div className="dialog-actions"><button onClick={() => { setAsk(null); setMessage(null) }} disabled={busy}>取消</button>
        <button className="destructive" disabled={busy} onClick={() => void edit(ask.change, () => {
          if (ask.change.type !== 'media.remove') setDirty(false)
          setAsk(null)
        })}>删除</button></div>
    </Modal>}
    {ask?.kind === 'clean-orphans' && <Modal title="清理未用素材" onClose={closeOrphanPreview}>
      {!ask.stale && (ask.report.count === 0
        ? <p className="orphan-summary">没有未引用的素材文件</p>
        : <p className="risk"><WarningCircle aria-hidden="true" size={20} />发现 {ask.report.count} 个未引用素材文件（共 {formatBytes(ask.report.bytes)}），清理后无法撤销</p>)}
      {ask.report.count > 0 && !ask.stale && <details className="orphan-files" key={ask.report.token}>
        <summary>候选文件</summary>
        <ul>{ask.report.files.map(file => <li key={file}>{file}</li>)}</ul>
      </details>}
      {message?.error && <p className="inline-error" role="alert">{message.text}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={closeOrphanPreview} disabled={busy}>{ask.report.count === 0 ? '关闭' : '取消'}</button>
        {ask.stale ? <button type="button" className="primary" disabled={busy} onClick={inspectOrphans}>重新预览</button> :
          ask.report.count > 0 && <button type="button" className="destructive" disabled={busy} onClick={() => {
          if (!opened) return
          void run(() => api.cleanOrphanMedia(opened.mediaKey, ask.report.token), result => {
            setAsk(null)
            setMessage({ text: result.count > 0 ? `已清理 ${result.count} 个未引用素材（释放 ${formatBytes(result.bytes)}）` : '没有未引用的素材文件' })
          }, (text, code) => {
            if (code === 'orphan-preview-stale') setAsk({ ...ask, stale: true })
            setMessage({ text, error: true })
          })
        }}>确认清理</button>}
      </div>
    </Modal>}
    {ask?.kind === 'discard' && <Modal title="未保存修改" onClose={() => setAsk(null)}>
      <div className="dialog-actions"><button autoFocus onClick={() => setAsk(null)}>继续编辑</button>
        <button className="destructive" onClick={() => { const action = ask.action; setAsk(null); action() }}>放弃修改</button></div>
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
    {aiSettingsOpen && <AiSettingsDialog config={aiConfig} probe={gatewayProbe} busy={busy}
      onEndpointChange={() => setGatewayProbe(null)}
      onTest={next => void run(() => api.testAiConnection(next),
        result => setGatewayProbe({ ...next, result }),
        error => setGatewayProbe({ ...next, error }))}
      onSave={(next, failure) => void saveAiConfig(next, failure).then(ok => {
        if (ok) {
          setAiSettingsOpen(false)
          setMessage({ text: 'AI 网关设置已保存' })
        }
      })}
      close={() => setAiSettingsOpen(false)} />}
    {upgradeRequest && (() => {
      const answer = (approved: boolean) => {
        setUpgradeRequest(null)
        void api.answerUpgrade(upgradeRequest, approved)
      }
      return <Modal title="升级格式 1 作品" onClose={() => answer(false)}>
        <p className="risk"><WarningCircle aria-hidden="true" size={20} />旧版无法打开升级后的格式 2。升级将在同一上级目录创建带素材的副本，并保留格式 1 原件。</p>
        <div className="dialog-actions">
          <button autoFocus onClick={() => answer(false)}>取消</button>
          <button className="primary" onClick={() => answer(true)}>保留原件并升级副本</button>
        </div>
      </Modal>
    })()}
    {message && !player && ask?.kind !== 'name' && ask?.kind !== 'remove' && ask?.kind !== 'clean-orphans' && <div className={`toast ${message.error ? 'error' : ''}`} role={message.error ? 'alert' : 'status'}>
      {message.error ? <WarningCircle size={19} /> : <Check size={19} />}
      <span>{message.text}</span><button className="icon small subtle" title="关闭提示" aria-label="关闭提示" onClick={() => setMessage(null)}><X size={16} /></button>
    </div>}
  </div>
}
