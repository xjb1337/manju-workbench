import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowSquareOut, Copy, FileText, FloppyDisk, Sparkle } from '@phosphor-icons/react'
import {
  defaultMethod, detailLabels, frameSpec, generationKindSchema, generationLabels, generationPresets, generationToolUrl,
  methodLabels, ratioSchema, workTypeLabels, workTypeSchema,
  type Brief, type DetailKind, type GenerationKind, type GenerationTool, type Ratio, type WorkType,
} from '../shared/creative'
import { shotDialogueSchema, type Episode, type Mutation, type Project, type Shot } from '../shared/model'
import {
  aiInstructionSchema, magpieModelSchema, magpieScriptSchema, maxPlanCharacters, type AiGatewayConfig, type PlanPreview,
} from '../shared/plan'
import { briefFields, missingBrief, planningPrompt, shotPromptBody, shotPromptContext, shotPromptText, voiceDialoguePreview } from '../shared/prompts'
import { aiGatewaySummary } from './AiPanels'
import { Badge, Modal, sequence } from './components'

type Failure = (message: string) => void
type CopyText = (text: string, failure: Failure) => Promise<boolean>
type BriefChange = Extract<Mutation, { type: 'project.brief' }>
type DetailAction = Extract<Mutation, { type: 'shot.detail' }>['action']
type VoiceChange = Pick<Extract<Mutation, { type: 'shot.apply-voice' }>, 'before' | 'voiceBody' | 'dialogue'>
const briefTextFields = ['theme', 'audience', 'style', 'language', 'tools', 'terms'] as const
const generationKinds = generationKindSchema.options
const emptyTool: GenerationTool = { name: '', url: '' }

export function BriefPanel({ project, episode, busy, onDirty, onSave, onPlan, onImport, hasScript, onWriteScript, onMagpie }: {
  project: Project; episode?: Episode; busy: boolean; onDirty: (dirty: boolean) => void
  onSave: (change: BriefChange) => Promise<boolean> | void; onPlan: () => void; onImport: () => void; hasScript: boolean; onWriteScript: () => void; onMagpie: () => void
}) {
  function fields() {
    return {
      workType: project.workType ?? 'story',
      target: String(project.brief?.targetSeconds ?? ''),
      ratio: frameSpec(project).ratio,
      text: Object.fromEntries(briefTextFields.map(key => [key, project.brief?.[key] ?? ''])) as Record<typeof briefTextFields[number], string>,
      generation: { image: project.brief?.generation?.image ?? emptyTool, video: project.brief?.generation?.video ?? emptyTool },
    }
  }
  const [draft, setDraft] = useState(fields)
  const [toolErrors, setToolErrors] = useState<Partial<Record<GenerationKind, string>>>({})
  const saved = fields()
  const targetSeconds = draft.target ? Number(draft.target) : undefined
  const normalizedTool = (kind: GenerationKind) => ({ name: draft.generation[kind].name.trim(), url: draft.generation[kind].url.trim() })
  const dirty = draft.workType !== saved.workType || draft.ratio !== saved.ratio || targetSeconds !== project.brief?.targetSeconds
    || briefTextFields.some(key => draft.text[key].trim() !== saved.text[key])
    || generationKinds.some(kind => {
      const tool = normalizedTool(kind)
      return tool.name !== saved.generation[kind].name || tool.url !== saved.generation[kind].url
    })
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  const tentative: Brief = { ...draft.text, ratio: draft.ratio, targetSeconds }
  const spec = frameSpec({ brief: tentative })
  const missing = missingBrief(tentative)
  function setTool(kind: GenerationKind, tool: GenerationTool) {
    setDraft(current => ({ ...current, generation: { ...current.generation, [kind]: tool } }))
    setToolErrors(current => ({ ...current, [kind]: undefined }))
  }
  async function commitBrief() {
    const generation: NonNullable<Brief['generation']> = {}
    const errors: typeof toolErrors = {}
    for (const kind of generationKinds) {
      const tool = normalizedTool(kind)
      const parsed = generationToolUrl.safeParse(tool.url)
      if (!parsed.success) errors[kind] = parsed.error.issues[0].message
      else if (tool.name || tool.url) generation[kind] = tool
    }
    setToolErrors(errors)
    const invalid = generationKinds.find(kind => errors[kind])
    if (invalid) {
      document.getElementById(`generation-${invalid}-url`)?.focus()
      return false
    }
    const savedOk = await onSave({ type: 'project.brief', workType: draft.workType, brief: { ...tentative, generation } })
    return savedOk !== false
  }
  function save(event: FormEvent) {
    event.preventDefault()
    void commitBrief()
  }
  async function saveThenOpen(openDialog: () => void) {
    if (dirty && !(await commitBrief())) return
    openDialog()
  }
  return <main className="stage wide brief-stage">
    <div className="stage-heading"><h2>制作简报</h2></div>
    <div className="brief-layout">
      <form className="brief-form" onSubmit={save}>
        <fieldset disabled={busy}>
          <div className="brief-grid">
            <label className="field">作品类型<select value={draft.workType} onChange={event => setDraft({ ...draft, workType: event.target.value as WorkType })}>
              {workTypeSchema.options.map(type => <option key={type} value={type}>{workTypeLabels[type]}</option>)}
            </select></label>
            <label className="field">{briefFields.ratio}<select value={draft.ratio}
              onChange={event => setDraft({ ...draft, ratio: event.target.value as Ratio })}>
              {ratioSchema.options.map(ratio => <option key={ratio}>{ratio}</option>)}
            </select></label>
            <label className="field">{briefFields.targetSeconds}<input type="number" min="0.001" max="86400" step="any"
              value={draft.target} onChange={event => setDraft({ ...draft, target: event.target.value })} /></label>
            {briefTextFields.map(key => {
              const replace = (value: string) => setDraft({ ...draft, text: { ...draft.text, [key]: value } })
              return <label className={`field${key === 'terms' ? ' span' : ''}`} key={key}>{briefFields[key]}
                {key === 'terms' ? <textarea rows={3} maxLength={5000} value={draft.text[key]} onChange={event => replace(event.target.value)} />
                  : <input maxLength={1000} value={draft.text[key]} onChange={event => replace(event.target.value)} />}
              </label>
            })}
          </div>
          <section className="generation-settings" aria-labelledby="generation-heading">
            <h3 id="generation-heading">生成工具</h3>
            {generationKinds.map(kind => {
              const label = `${generationLabels[kind]}工具`
              const tool = draft.generation[kind]
              const prefix = `generation-${kind}`
              return <div key={kind} className="generation-settings-row" role="group" aria-labelledby={`${prefix}-label`}>
                <div className="generation-settings-head">
                  <h4 id={`${prefix}-label`}>{label}</h4>
                  <button type="button" className="small subtle accent" onClick={() => setTool(kind, generationPresets[kind])}>
                    使用 {generationPresets[kind].name}
                  </button>
                </div>
                <div className="brief-grid">
                  <label className="field">{label}名称<input id={`${prefix}-name`} maxLength={80} value={tool.name}
                    onChange={event => setTool(kind, { ...tool, name: event.target.value })} /></label>
                  <label className="field">{label}网址<input id={`${prefix}-url`} type="url" maxLength={2048} value={tool.url}
                    aria-invalid={!!toolErrors[kind]} aria-describedby={toolErrors[kind] ? `${prefix}-error` : undefined}
                    onChange={event => setTool(kind, { ...tool, url: event.target.value })} /></label>
                </div>
                {toolErrors[kind] && <p id={`${prefix}-error`} className="inline-error" role="alert">{toolErrors[kind]}</p>}
              </div>
            })}
          </section>
          <div className="brief-save"><button className="primary" type="submit" disabled={!dirty}><FloppyDisk size={16} /> 保存简报</button></div>
        </fieldset>
      </form>
      <section className="planning-panel" aria-label="分镜规划">
        <div className="section-head"><h3>分镜规划</h3><Badge value={spec.ratio} /></div>
        <dl className="planning-spec">
          <div><dt>画布</dt><dd>{spec.width} × {spec.height} · 30 fps</dd></div>
          <div><dt>默认制作方式</dt><dd>{methodLabels[defaultMethod(draft.workType)]}</dd></div>
          {episode && <div><dt>目标集数</dt><dd>{episode.title}</dd></div>}
        </dl>
        <div className="brief-missing"><strong>简报待补项</strong>
          <ul>{(missing.length ? missing : ['无']).map(item => <li key={item}>{item}</li>)}</ul>
        </div>
        <div className="plan-buttons">
          {hasScript
            ? <button type="button" className="primary" disabled={busy} onClick={() => void saveThenOpen(onMagpie)}><Sparkle size={16} /> AI 生成分镜草案</button>
            : <button type="button" className="primary" disabled={busy} onClick={onWriteScript}><FileText size={16} /> 写／粘贴剧本</button>}
          {!hasScript && <button type="button" disabled={busy} onClick={() => void saveThenOpen(onMagpie)}>粘贴剧本</button>}
          <button type="button" disabled={busy} onClick={() => void saveThenOpen(onPlan)}>总规划提示词</button>
          <button type="button" disabled={busy} onClick={() => void saveThenOpen(onImport)}>导入外部规划</button>
        </div>
      </section>
      {project.plan && <section className="plan-results" aria-label="规划成果">
        <h3>规划成果</h3>
        {project.plan.outline && <div><h3>大纲</h3><p>{project.plan.outline}</p></div>}
        {!!project.plan.assets?.length && <div><h3>素材清单</h3><ul>{project.plan.assets.map((asset, index) => <li key={index}>{asset}</li>)}</ul></div>}
        {!!project.plan.missing?.length && <div><h3>规划待补项</h3><ul>{project.plan.missing.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      </section>}
    </div>
  </main>
}

export function PlanningDialog({ project, episode, busy, copy, openTool, close }: {
  project: Project; episode?: Episode; busy: boolean; copy: CopyText; openTool: (failure: Failure) => void; close: () => void
}) {
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const text = useMemo(() => planningPrompt(project, episode), [project, episode])
  return <Modal title="总规划提示词" onClose={close}>
    <div className="creative-dialog">
      <textarea className="long-prompt" readOnly aria-label="总规划提示词内容" value={text} rows={15} />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions"><span role="status" className="dialog-status">{notice}</span>
        <button disabled={busy} onClick={() => openTool(setError)}>用 ChatGPT 做规划 <ArrowSquareOut aria-hidden="true" size={15} /></button>
        <button disabled={busy} onClick={close}>关闭</button>
        <button className="primary" disabled={busy} onClick={async () => {
          setError('')
          if (await copy(text, setError)) setNotice('已复制')
        }}><Copy size={16} /> 复制总规划提示词</button>
      </div>
    </div>
  </Modal>
}

type PlanSource =
  | { kind: 'paste'; preview: (text: string, accept: (preview: PlanPreview) => void, failure: Failure) => void }
  | { kind: 'magpie'; script: string; preview: (model: string, script: string, accept: (preview: PlanPreview | null) => void, failure: Failure) => void;
      cancel: (failure: Failure) => void }

export function PlanImportDialog({
  episode, fictional, busy, aiConfig, discoveredModels, source, onOpenAiSettings, onSaveModel, onMerge, close,
}: {
  episode?: Episode; fictional: boolean; busy: boolean; aiConfig: AiGatewayConfig; discoveredModels: string[]
  close: () => void; source: PlanSource
  onOpenAiSettings: () => void; onSaveModel: (model: string) => void
  onMerge: (preview: PlanPreview, replacements: string[], failure: Failure) => void
}) {
  const [text, setText] = useState(source.kind === 'magpie' ? source.script : '')
  const [model, setModel] = useState(aiConfig.model)
  const [modelEdited, setModelEdited] = useState(false)
  const [preview, setPreview] = useState<PlanPreview>()
  const [replacements, setReplacements] = useState<string[]>([])
  const [error, setError] = useState('')
  const [stopped, setStopped] = useState(false)
  const back = useRef<HTMLButtonElement>(null)
  const modelsListId = useId()
  useEffect(() => { if (!modelEdited) setModel(aiConfig.model) }, [aiConfig.model, modelEdited])
  useEffect(() => { if (preview && !busy) back.current?.focus() }, [preview, busy])
  const magpie = source.kind === 'magpie' ? source : undefined
  const title = magpie ? (preview ? 'AI 分镜草案预览' : 'AI 生成分镜草案') : (preview ? '规划导入预览' : '导入外部规划')
  const conflictIds = preview ? preview.changes.filter(change => change.conflict).map(change => change.id) : []
  const stop = () => magpie?.cancel(setError)
  return <Modal title={title} onClose={busy && magpie && !preview ? stop : close}>
    <div className="creative-dialog">
      <div className="import-target">
        <span>{episode ? `目标集数 · ${episode.title}` : magpie ? '从草案创建集数' : '从规划创建集数'}</span>
        {fictional && <Badge value="示例 / 虚构" />}
        {magpie && !preview && <div className="ai-gateway-bar">
          <Badge value={aiGatewaySummary(aiConfig)} />
          <button type="button" className="small subtle" disabled={busy} onClick={onOpenAiSettings}>切换网关</button>
        </div>}
        {preview && !!conflictIds.length && <div className="plan-diff-actions">
          <button type="button" className="small subtle" disabled={busy || !replacements.length}
            onClick={() => setReplacements([])}>全部保留当前</button>
          <button type="button" className="small subtle" disabled={busy || conflictIds.every(id => replacements.includes(id))}
            onClick={() => setReplacements(conflictIds)}>{magpie ? '全部使用草案' : '全部使用导入'}</button>
        </div>}
      </div>
      {preview ? <>
        <div className="plan-diff" role="region" aria-label="导入差异" tabIndex={0}>
          {!preview.changes.length && <p className="no-changes">没有可合并的变更</p>}
          {preview.changes.map(change => <article key={change.id} className="diff-row" data-conflict={change.conflict}>
            <div className="section-head"><h3>{change.group} · {change.field}</h3>
              <Badge value={change.conflict ? '冲突' : '新增'} />
            </div>
            <div className="diff-values">
              <div><strong>当前</strong><pre>{change.before || '（空）'}</pre></div>
              <div><strong>{magpie ? '草案' : '导入'}</strong><pre>{change.after || '（空）'}</pre></div>
            </div>
            {change.conflict && <label className="diff-choice">处理方式
              <select aria-label={`${change.group} · ${change.field}处理方式`} disabled={busy}
                value={replacements.includes(change.id) ? 'update' : 'keep'} onChange={event => {
                  setReplacements(event.target.value === 'update' ? [...replacements, change.id] : replacements.filter(id => id !== change.id))
                }}>
                <option value="keep">保留当前</option><option value="update">{magpie ? '使用草案内容' : '使用导入内容'}</option>
              </select>
            </label>}
          </article>)}
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" ref={back} disabled={busy} onClick={() => { setPreview(undefined); setReplacements([]); setError('') }}>返回编辑</button>
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button type="button" className="primary" disabled={busy || !preview.changes.some(change => !change.conflict || replacements.includes(change.id))}
            onClick={() => { setError(''); onMerge(preview, replacements, setError) }}>确认合并</button>
        </div>
      </> : <form onSubmit={event => {
        event.preventDefault()
        if (busy) return
        setError('')
        setStopped(false)
        if (source.kind === 'paste') source.preview(text, setPreview, setError)
        else {
          const validModel = magpieModelSchema.safeParse(model)
          const validScript = magpieScriptSchema.safeParse(text)
          if (!validModel.success) { setError(validModel.error.issues[0].message); return }
          if (!validScript.success) { setError(validScript.error.issues[0].message); return }
          onSaveModel(validModel.data)
          source.preview(validModel.data, validScript.data, draft => {
            if (draft) setPreview(draft)
            else setStopped(true)
          }, setError)
        }
      }}>
        {magpie && <div className="magpie-settings">
          <label className="field">{aiConfig.preset === 'magpie' ? 'Magpie 模型 ID' : '模型 ID'}
            <input list={discoveredModels.length ? modelsListId : undefined} value={model} maxLength={200}
              disabled={busy} spellCheck={false} autoCapitalize="none" autoCorrect="off"
              onChange={event => { setModelEdited(true); setModel(event.target.value) }} />
          </label>
          {!!discoveredModels.length && <datalist id={modelsListId}>
            {discoveredModels.map(item => <option key={item} value={item} />)}
          </datalist>}
        </div>}
        <label className="field">{magpie ? '剧本文本' : '规划 JSON'}<textarea className="long-prompt" autoFocus rows={magpie ? 9 : 12} value={text}
          readOnly={busy && !!magpie} maxLength={magpie ? 30_000 : maxPlanCharacters}
          onChange={event => setText(event.target.value)} /></label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {magpie && <span className="dialog-status" role="status">{busy ? '正在等待 AI 返回草案…' : stopped ? '已停止等待' : ''}</span>}
          {magpie && busy ? <button type="button" onClick={stop}>停止等待</button> :
            <button type="button" disabled={busy} onClick={close}>取消</button>}
          <button type="submit" className="primary" disabled={busy || !text.trim()}>
            {magpie ? <><Sparkle size={16} /> 生成草案</> : '预览差异'}
          </button>
        </div>
      </form>}
    </div>
  </Modal>
}

export function DetailDialog({
  project, episode, shot, kind, busy, aiConfig, onOpenAiSettings, onOptimize, onCancelOptimize, onDirty, copy, save, onApplyVoice, close,
}: {
  project: Project; episode: Episode; shot: Shot; kind: DetailKind; busy: boolean; aiConfig: AiGatewayConfig
  onOpenAiSettings: () => void
  onOptimize: (body: string, instruction: string, accept: (draft: string | null) => void, failure: Failure) => void
  onCancelOptimize: (failure: Failure) => void
  onDirty: (dirty: boolean) => void; copy: CopyText
  save: (action: DetailAction, failure: Failure) => Promise<boolean>; close: () => void
  onApplyVoice?: (change: VoiceChange, failure: Failure) => Promise<boolean>
}) {
  const stored = shot.details?.[kind]
  const spec = frameSpec(project)
  const template = useMemo(() => shotPromptBody(project, episode, shot, kind), [project, episode, shot, kind])
  const sharedContext = useMemo(() => shotPromptContext(project), [project])
  const baseline = stored?.body ?? template
  const [body, setBody] = useState(baseline)
  const [instruction, setInstruction] = useState('')
  const [aiDraft, setAiDraft] = useState<string | null>(null)
  const [voicePreview, setVoicePreview] = useState<VoiceChange | null>(null)
  const [optimizing, setOptimizing] = useState(false)
  const [confirm, setConfirm] = useState<'regenerate' | 'discard' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const changed = body !== baseline
  useEffect(() => { onDirty(changed); return () => onDirty(false) }, [changed, onDirty])
  useEffect(() => { setBody(baseline); setAiDraft(null) }, [baseline])
  function askClose() {
    if (busy) {
      if (optimizing) onCancelOptimize(setError)
      return
    }
    if (voicePreview) {
      setVoicePreview(null)
      setError('')
    } else if (confirm) setConfirm(null)
    else if (changed) setConfirm('discard')
    else close()
  }
  function triggerOptimize() {
    if (busy) return
    const parsed = aiInstructionSchema.safeParse(instruction)
    if (!parsed.success) {
      setError(parsed.error.issues[0].message)
      return
    }
    setError('')
    setNotice('')
    setOptimizing(true)
    onOptimize(body, parsed.data, draft => {
      setOptimizing(false)
      if (draft !== null) setAiDraft(draft)
      else setNotice('已停止等待')
    }, message => {
      setOptimizing(false)
      setError(message)
    })
  }
  const shotNumber = sequence(episode.shots.findIndex(item => item.id === shot.id))
  if (voicePreview && onApplyVoice) {
    const valid = shotDialogueSchema.safeParse(voicePreview.dialogue)
    const canApply = valid.success && !!voicePreview.dialogue.trim() && voicePreview.dialogue !== voicePreview.before
    return <Modal title={`应用配音稿 · 镜头 ${shotNumber} · ${shot.title}`} onClose={askClose}>
      <div className="creative-dialog">
        <p className="caption-episode">{episode.title}</p>
        <div className="diff-values caption-diff">
          <div><strong>当前烧录台词</strong><pre>{voicePreview.before || '（空）'}</pre></div>
          <label className="field">拟应用台词<textarea rows={6} value={voicePreview.dialogue} disabled={busy}
            onChange={event => setVoicePreview({ ...voicePreview, dialogue: event.target.value })} /></label>
        </div>
        {!valid.success && <p className="inline-error" role="alert">{valid.error.issues[0].message}</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button autoFocus type="button" disabled={busy} onClick={askClose}>返回配音稿</button>
          <button type="button" className="primary" disabled={busy || !canApply} onClick={async () => {
            setError('')
            if (await onApplyVoice(voicePreview, setError)) {
              setVoicePreview(null)
              close()
            }
          }}>确认应用台词</button>
        </div>
      </div>
    </Modal>
  }
  return <Modal title={`${detailLabels[kind]} · ${shot.title}`} onClose={askClose}>
    <div className="creative-dialog">
      <div className="detail-header">
        {project.fictional && <Badge value="示例 / 虚构" />}
        <Badge value={stored?.needsUpdate ? '需更新' : stored?.source === 'manual' ? '手改' : stored?.source === 'external' ? '来自规划' : stored ? '已保存' : '未保存'} />
        {changed && <Badge value="有未保存修改" />}
        <span>{spec.ratio} · {spec.width} × {spec.height} · 30 fps</span>
        <div className="ai-gateway-bar">
          <Badge value={`${aiGatewaySummary(aiConfig)} · ${aiConfig.model}`} />
          <button type="button" className="small subtle" disabled={busy} onClick={onOpenAiSettings}>切换网关</button>
        </div>
      </div>
      <details className="prompt-settings"><summary>作品共享设定（复制时附上）</summary>
        <pre>{sharedContext}</pre>
      </details>
      {aiDraft !== null ? <>
        <div className="diff-values script-ai-preview">
          <div><strong>当前正文</strong><pre>{body.trim() || '（空）'}</pre></div>
          <div><strong>AI 建议</strong><pre>{aiDraft}</pre></div>
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={() => setAiDraft(null)}>放弃建议</button>
          <button type="button" className="primary" disabled={busy} onClick={() => {
            setBody(aiDraft)
            setAiDraft(null)
            setNotice('已应用 AI 建议，请确认后保存')
          }}>应用到编辑器</button>
        </div>
      </> : <>
        <div className="ai-optimize-bar">
          <input value={instruction} maxLength={2000} disabled={busy || !!confirm}
            aria-label="AI 优化要求"
            placeholder="AI 优化要求（可选，如：加强光影与运镜衔接）"
            onChange={event => setInstruction(event.target.value)} />
          {optimizing
            ? <button type="button" onClick={() => onCancelOptimize(setError)}>停止等待</button>
            : <button type="button" disabled={busy || !!confirm} onClick={triggerOptimize}>
                <Sparkle size={15} /> AI 优化提示词
              </button>}
        </div>
        <label className="field">提示词正文<textarea className="long-prompt" value={body} rows={11} maxLength={30000} disabled={busy || !!confirm}
          onChange={event => { setBody(event.target.value); setNotice('') }} /></label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {confirm ? <div className="detail-confirm">
          <p className="risk">{confirm === 'regenerate' ? '重新生成会替换本条提示词正文。' : '关闭会放弃本条未保存的修改。'}</p>
          <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setConfirm(null)}>继续编辑</button>
            <button type="button" className="destructive" disabled={busy} onClick={async () => {
              if (confirm === 'discard') { close(); return }
              setError('')
              if (await save({ type: 'regenerate' }, setError)) {
                setBody(template)
                setNotice('已重新生成')
                setConfirm(null)
              }
            }}>{confirm === 'regenerate' ? '确认替换' : '放弃修改'}</button>
          </div>
        </div> : <div className="dialog-actions detail-actions">
          <span role="status" className="dialog-status">{optimizing ? '正在生成 AI 优化建议…' : notice}</span>
          <button type="button" disabled={busy} onClick={askClose}>关闭</button>
          {stored?.needsUpdate && <button type="button" disabled={busy || changed} onClick={async () => {
            setError('')
            if (await save({ type: 'keep' }, setError)) setNotice('已保留')
          }}>保留手改</button>}
          {onApplyVoice && <button type="button" disabled={busy || changed || !stored}
            onClick={() => { setError(''); setVoicePreview(voiceDialoguePreview(shot)) }}>预览台词差异</button>}
          <button type="button" disabled={busy} onClick={() => setConfirm('regenerate')}>按设定重新生成提示词</button>
          <button type="button" disabled={busy || !body.trim()} onClick={async () => {
            setError('')
            if (await copy(shotPromptText(project, body), setError)) setNotice('已复制')
          }}><Copy size={16} /> 复制{detailLabels[kind]}</button>
          <button type="button" className="primary" disabled={busy || !body.trim() || (!!stored && !changed)} onClick={async () => {
            setError('')
            if (await save({ type: 'save', body }, setError)) setNotice('已保存')
          }}>保存提示词</button>
        </div>}
      </>}
    </div>
  </Modal>
}
