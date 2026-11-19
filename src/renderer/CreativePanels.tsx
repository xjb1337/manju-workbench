import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowSquareOut, Copy, FloppyDisk } from '@phosphor-icons/react'
import {
  defaultMethod, detailLabels, frameSpec, methodLabels, ratioSchema, workTypeLabels, workTypeSchema,
  type Brief, type DetailKind, type Ratio, type WorkType,
} from '../shared/creative'
import type { Episode, Mutation, Project, Shot } from '../shared/model'
import { maxPlanCharacters, type PlanPreview } from '../shared/plan'
import { briefFields, missingBrief, planningPrompt, shotPromptBody, shotPromptContext, shotPromptText } from '../shared/prompts'
import { Badge, Modal } from './components'

type Failure = (message: string) => void
type CopyText = (text: string, failure: Failure) => Promise<boolean>
type BriefChange = Extract<Mutation, { type: 'project.brief' }>
type DetailAction = Extract<Mutation, { type: 'shot.detail' }>['action']
const briefTextFields = ['theme', 'audience', 'style', 'language', 'tools', 'terms'] as const

export function BriefPanel({ project, episode, busy, onDirty, onSave, onPlan, onImport }: {
  project: Project; episode?: Episode; busy: boolean; onDirty: (dirty: boolean) => void
  onSave: (change: BriefChange) => void; onPlan: () => void; onImport: () => void
}) {
  function fields() {
    return {
      workType: project.workType ?? 'story',
      target: String(project.brief?.targetSeconds ?? ''),
      ratio: frameSpec(project).ratio,
      text: Object.fromEntries(briefTextFields.map(key => [key, project.brief?.[key] ?? ''])) as Record<typeof briefTextFields[number], string>,
    }
  }
  const [draft, setDraft] = useState(fields)
  const saved = fields()
  const dirty = draft.workType !== saved.workType || draft.ratio !== saved.ratio || draft.target !== saved.target
    || briefTextFields.some(key => draft.text[key].trim() !== saved.text[key])
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  const tentative: Brief = { ...draft.text, ratio: draft.ratio, targetSeconds: draft.target ? Number(draft.target) : undefined }
  const spec = frameSpec({ brief: tentative })
  const missing = missingBrief(tentative)
  function save(event: FormEvent) {
    event.preventDefault()
    onSave({ type: 'project.brief', workType: draft.workType, brief: tentative })
  }
  return <main className="stage wide">
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
          <div className="brief-save"><button className="primary" type="submit" disabled={!dirty}><FloppyDisk size={16} /> 保存简报</button></div>
        </fieldset>
      </form>
      <section className="planning-panel" aria-label="外部规划">
        <div className="section-head"><h3>外部规划</h3><Badge value={spec.ratio} /></div>
        <dl className="planning-spec">
          <div><dt>画布</dt><dd>{spec.width} × {spec.height} · 30 fps</dd></div>
          <div><dt>默认制作方式</dt><dd>{methodLabels[defaultMethod(draft.workType)]}</dd></div>
          {episode && <div><dt>目标集数</dt><dd>{episode.title}</dd></div>}
        </dl>
        <div className="brief-missing"><strong>简报待补项</strong>
          <ul>{(missing.length ? missing : ['无']).map(item => <li key={item}>{item}</li>)}</ul>
        </div>
        <div className="plan-buttons">
          <button disabled={busy || dirty} onClick={onPlan}>总规划提示词</button>
          <button disabled={busy || dirty} className="primary" onClick={onImport}>导入外部规划</button>
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
  const text = planningPrompt(project, episode)
  return <Modal title="总规划提示词" onClose={close}>
    <div className="creative-dialog">
      <textarea className="long-prompt" readOnly aria-label="总规划提示词内容" value={text} rows={15} />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions"><span role="status" className="dialog-status">{notice}</span>
        <button disabled={busy} onClick={() => openTool(setError)}>打开 ChatGPT <ArrowSquareOut size={15} /></button>
        <button disabled={busy} onClick={close}>关闭</button>
        <button className="primary" disabled={busy} onClick={async () => {
          setError('')
          if (await copy(text, setError)) setNotice('已复制')
        }}><Copy size={16} /> 复制总规划提示词</button>
      </div>
    </div>
  </Modal>
}

export function PlanImportDialog({ episode, fictional, busy, onPreview, onMerge, close }: {
  episode?: Episode; fictional: boolean; busy: boolean; close: () => void
  onPreview: (text: string, accept: (preview: PlanPreview) => void, failure: Failure) => void
  onMerge: (preview: PlanPreview, replacements: string[], failure: Failure) => void
}) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<PlanPreview>()
  const [replacements, setReplacements] = useState<string[]>([])
  const [error, setError] = useState('')
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (preview && !busy) back.current?.focus() }, [preview, busy])
  return <Modal title={preview ? '规划导入预览' : '导入外部规划'} onClose={close}>
    <div className="creative-dialog">
      <div className="import-target">
        <span>{episode ? `目标集数 · ${episode.title}` : '从规划创建集数'}</span>
        {fictional && <Badge value="示例 / 虚构" />}
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
              <div><strong>导入</strong><pre>{change.after || '（空）'}</pre></div>
            </div>
            {change.conflict && <label className="diff-choice">处理方式
              <select aria-label={`${change.group} · ${change.field}处理方式`} disabled={busy}
                value={replacements.includes(change.id) ? 'update' : 'keep'} onChange={event => {
                  setReplacements(event.target.value === 'update' ? [...replacements, change.id] : replacements.filter(id => id !== change.id))
                }}>
                <option value="keep">保留当前</option><option value="update">使用导入内容</option>
              </select>
            </label>}
          </article>)}
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button ref={back} disabled={busy} onClick={() => { setPreview(undefined); setReplacements([]); setError('') }}>返回编辑</button>
          <button disabled={busy} onClick={close}>取消</button>
          <button className="primary" disabled={busy || !preview.changes.some(change => !change.conflict || replacements.includes(change.id))}
            onClick={() => { setError(''); onMerge(preview, replacements, setError) }}>确认合并</button>
        </div>
      </> : <form onSubmit={event => {
        event.preventDefault()
        setError('')
        onPreview(text, setPreview, setError)
      }}>
        <label className="field">规划 JSON<textarea className="long-prompt" autoFocus rows={12} value={text} maxLength={maxPlanCharacters}
          onChange={event => setText(event.target.value)} /></label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button className="primary" disabled={busy || !text.trim()}>预览差异</button>
        </div>
      </form>}
    </div>
  </Modal>
}

export function DetailDialog({ project, episode, shot, kind, busy, onDirty, copy, save, close }: {
  project: Project; episode: Episode; shot: Shot; kind: DetailKind; busy: boolean
  onDirty: (dirty: boolean) => void; copy: CopyText
  save: (action: DetailAction, failure: Failure) => Promise<boolean>; close: () => void
}) {
  const stored = shot.details?.[kind]
  const spec = frameSpec(project)
  const template = shotPromptBody(project, episode, shot, kind)
  const baseline = stored?.body ?? template
  const [body, setBody] = useState(baseline)
  const [confirm, setConfirm] = useState<'regenerate' | 'discard' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const changed = body !== baseline
  useEffect(() => { onDirty(changed); return () => onDirty(false) }, [changed, onDirty])
  useEffect(() => { setBody(baseline) }, [baseline])
  function askClose() {
    if (busy) return
    if (confirm) setConfirm(null)
    else if (changed) setConfirm('discard')
    else close()
  }
  return <Modal title={`${detailLabels[kind]} · ${shot.title}`} onClose={askClose}>
    <div className="creative-dialog">
      <div className="detail-header">
        {project.fictional && <Badge value="示例 / 虚构" />}
        <Badge value={stored?.needsUpdate ? '需更新' : stored?.source === 'manual' ? '手改' : stored?.source === 'external' ? '来自规划' : stored ? '已保存' : '未保存'} />
        {changed && <Badge value="有未保存修改" />}
        <span>{spec.ratio} · {spec.width} × {spec.height} · 30 fps</span>
      </div>
      <details className="prompt-settings"><summary>作品共享设定（复制时附上）</summary>
        <pre>{shotPromptContext(project)}</pre>
      </details>
      <label className="field">提示词正文<textarea className="long-prompt" value={body} rows={13} maxLength={30000} disabled={busy || !!confirm}
        onChange={event => { setBody(event.target.value); setNotice('') }} /></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {confirm ? <div className="detail-confirm">
        <p className="risk">{confirm === 'regenerate' ? '重新生成会替换本条提示词正文。' : '关闭会放弃本条未保存的修改。'}</p>
        <div className="dialog-actions"><button disabled={busy} onClick={() => setConfirm(null)}>继续编辑</button>
          <button className="destructive" disabled={busy} onClick={async () => {
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
        <span role="status" className="dialog-status">{notice}</span>
        <button disabled={busy} onClick={askClose}>关闭</button>
        {stored?.needsUpdate && <button disabled={busy || changed} onClick={async () => {
          setError('')
          if (await save({ type: 'keep' }, setError)) setNotice('已保留')
        }}>保留手改</button>}
        <button disabled={busy} onClick={() => setConfirm('regenerate')}>按设定重新生成提示词</button>
        <button disabled={busy || !body.trim()} onClick={async () => {
          setError('')
          if (await copy(shotPromptText(project, body), setError)) setNotice('已复制')
        }}><Copy size={16} /> 复制{detailLabels[kind]}</button>
        <button className="primary" disabled={busy || !body.trim() || (!!stored && !changed)} onClick={async () => {
          setError('')
          if (await save({ type: 'save', body }, setError)) setNotice('已保存')
        }}>保存提示词</button>
      </div>}
    </div>
  </Modal>
}
