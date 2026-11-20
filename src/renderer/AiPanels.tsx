import { useEffect, useId, useState, type FormEvent } from 'react'
import { PlugsConnected, Sparkle } from '@phosphor-icons/react'
import {
  aiBaseUrlSchema, aiCompletionUrl, aiGatewayConfigSchema, aiGatewayPresets, aiInstructionSchema, aiIpNetwork, aiPresetSchema, magpieModelSchema,
  type AiConnectionTestResult, type AiGatewayConfig, type AiNetwork, type AiPreset, type AiRequestTarget,
} from '../shared/plan'
import type { Episode, Project } from '../shared/model'
import { aiRequestBody, scriptAiPrompt } from '../shared/prompts'
import { Badge, Modal } from './components'

type Failure = (message: string) => void

export type AiPanelOptions = {
  config: AiGatewayConfig
  discoveredModels: string[]
  openSettings: () => void
  setDefault: (model: string, failure: Failure) => void
}

export function useAiRequest({ baseUrl, model: defaultModel }: AiGatewayConfig, enabled = true) {
  const [trial, setTrial] = useState<{ baseUrl: string; model: string }>()
  const [destination, setDestination] = useState<{ baseUrl: string } & ({ network: AiNetwork } | { error: string })>()
  const literal = aiIpNetwork(new URL(baseUrl).hostname)
  const checked = destination?.baseUrl === baseUrl ? destination : undefined
  const network = literal === 'loopback' || literal === 'lan' ? literal : checked && 'network' in checked ? checked.network : undefined
  const error = checked && 'error' in checked ? checked.error : undefined
  useEffect(() => { setTrial(undefined) }, [baseUrl])
  useEffect(() => {
    if (!enabled || literal) return
    let current = true
    void window.workbench.describeAiTarget(baseUrl).then(reply => {
      if (current) setDestination(reply.ok ? { baseUrl, network: reply.value } : { baseUrl, error: reply.error })
    }).catch(() => {
      if (current) setDestination({ baseUrl, error: '桌面进程连接中断' })
    })
    return () => { current = false }
  }, [baseUrl, enabled, literal])
  const model = trial?.baseUrl === baseUrl ? trial.model : defaultModel
  const validModel = magpieModelSchema.safeParse(model)
  const target: AiRequestTarget | undefined = validModel.success && network ? { baseUrl, network, model: validModel.data } : undefined
  return { model, validModel, setModel: (model: string) => setTrial({ baseUrl, model }), target, network, error }
}

export function AiRequestFields({ ai, request, scope, prompt, disabled }: {
  ai: AiPanelOptions; request: ReturnType<typeof useAiRequest>; scope: string; prompt?: () => string; disabled: boolean
}) {
  const listId = useId()
  const modelErrorId = useId()
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const { validModel } = request
  const modelError = !validModel.success && request.model.trim() ? validModel.error.issues[0].message : undefined
  const { config, discoveredModels, openSettings, setDefault } = ai
  return <section className="ai-request">
    <div className="ai-request-target">
      <span className="ai-request-url">{aiCompletionUrl(config.baseUrl)}</span>
      {request.network === 'lan' && new URL(config.baseUrl).protocol === 'http:' &&
        <Badge value="局域网明文 HTTP" />}
      <button type="button" className="small subtle" disabled={disabled} onClick={openSettings}>切换网关</button>
    </div>
    <div className="ai-request-model">
      <label className="field">{config.preset === 'magpie' ? 'Magpie 模型 ID' : '模型 ID'}
        <input value={request.model} maxLength={200} disabled={disabled}
          aria-invalid={!!modelError} aria-describedby={modelError ? modelErrorId : undefined} spellCheck={false} autoCapitalize="none" autoCorrect="off"
          list={discoveredModels.length ? listId : undefined} onChange={event => {
            setError('')
            request.setModel(event.target.value)
          }} />
      </label>
      {!!discoveredModels.length && <datalist id={listId}>{discoveredModels.map(model => <option key={model} value={model} />)}</datalist>}
      <button type="button" className="small" disabled={disabled || !request.target || !validModel.success || validModel.data === config.model}
        onClick={() => {
          if (!validModel.success) return
          setError('')
          setDefault(validModel.data, setError)
        }}>设为默认</button>
    </div>
    {modelError && <p id={modelErrorId} className="inline-error" role="alert">{modelError}</p>}
    <span className="ai-request-scope">{scope}</span>
    {prompt && validModel.success && <details className="prompt-settings" onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>查看将发送的内容</summary>
      {expanded && <pre>{JSON.stringify(aiRequestBody(validModel.data, prompt()), null, 2)}</pre>}
    </details>}
    {request.error && <p className="inline-error" role="alert">{request.error}</p>}
    {!request.network && !request.error && <span className="ai-request-scope" role="status">正在校验网关地址…</span>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}

function canonicalBaseUrl(config: Pick<AiGatewayConfig, 'baseUrl'>) {
  const parsed = aiBaseUrlSchema.safeParse(config.baseUrl)
  if (parsed.success) return parsed.data
  return config.baseUrl
}

export type GatewayProbe = Pick<AiGatewayConfig, 'preset' | 'baseUrl'> & (
  | { result: AiConnectionTestResult }
  | { error: string }
)

export function sameGateway(left: Pick<AiGatewayConfig, 'preset' | 'baseUrl'>, right: Pick<AiGatewayConfig, 'preset' | 'baseUrl'>) {
  return left.preset === right.preset && canonicalBaseUrl(left) === canonicalBaseUrl(right)
}

export function AiSettingsDialog({
  config,
  probe,
  busy,
  onEndpointChange,
  onTest,
  onSave,
  close,
}: {
  config: AiGatewayConfig
  probe: GatewayProbe | null
  onEndpointChange: () => void
  busy: boolean
  onTest: (config: AiGatewayConfig) => void
  onSave: (config: AiGatewayConfig, failure: Failure) => void
  close: () => void
}) {
  const [draft, setDraft] = useState<AiGatewayConfig>(() => ({ ...config }))
  const currentProbe = probe && sameGateway(draft, probe) ? probe : null
  const result = currentProbe && 'result' in currentProbe ? currentProbe.result : null
  const models = result?.models ?? []
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ baseUrl?: string; model?: string }>({})
  const presetId = useId()
  const baseUrlId = useId()
  const baseUrlErrorId = useId()
  const modelId = useId()
  const modelErrorId = useId()
  const modelsListId = useId()

  function parseDraft(): AiGatewayConfig | null {
    const parsed = aiGatewayConfigSchema.safeParse(draft)
    if (parsed.success) {
      setFieldErrors({})
      setError('')
      return parsed.data
    }
    const nextErrors: { baseUrl?: string; model?: string } = {}
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === 'baseUrl' && !nextErrors.baseUrl) nextErrors.baseUrl = issue.message
      if (issue.path[0] === 'model' && !nextErrors.model) nextErrors.model = issue.message
    }
    setFieldErrors(nextErrors)
    if (nextErrors.baseUrl) document.getElementById(baseUrlId)?.focus()
    else if (nextErrors.model) document.getElementById(modelId)?.focus()
    return null
  }

  function selectPreset(preset: AiPreset) {
    const info = aiGatewayPresets[preset]
    setDraft(current => preset === 'custom'
      ? { ...current, preset }
      : { preset, baseUrl: info.baseUrl, model: info.defaultModel })
    setFieldErrors({})
    onEndpointChange()
    setError('')
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const parsed = parseDraft()
    if (!parsed) return
    onSave(parsed, setError)
  }

  return <Modal title="AI 网关设置" onClose={() => { if (!busy) close() }}>
    <form className="creative-dialog ai-settings-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor={presetId}>网关预设</label>
        <select id={presetId} value={draft.preset} disabled={busy}
          onChange={event => selectPreset(aiPresetSchema.parse(event.target.value))}>
          {aiPresetSchema.options.map(key => (
            <option key={key} value={key}>{aiGatewayPresets[key].label}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={baseUrlId}>网关地址</label>
        <input id={baseUrlId} type="url" value={draft.baseUrl} maxLength={500}
          disabled={busy} spellCheck={false} autoCapitalize="none" autoCorrect="off"
          aria-invalid={Boolean(fieldErrors.baseUrl)}
          aria-describedby={fieldErrors.baseUrl ? baseUrlErrorId : undefined}
          onChange={event => {
            setDraft(current => ({ ...current, baseUrl: event.target.value }))
            setFieldErrors(current => ({ ...current, baseUrl: undefined }))
            onEndpointChange()
            setError('')
          }} />
        {fieldErrors.baseUrl && <p id={baseUrlErrorId} className="inline-error" role="alert">{fieldErrors.baseUrl}</p>}
      </div>

      <div className="field">
        <label htmlFor={modelId}>默认模型 ID</label>
        <input id={modelId} list={models.length ? modelsListId : undefined} value={draft.model} maxLength={200}
          disabled={busy} spellCheck={false} autoCapitalize="none" autoCorrect="off"
          aria-invalid={Boolean(fieldErrors.model)}
          aria-describedby={fieldErrors.model ? modelErrorId : undefined}
          onChange={event => {
            setDraft(current => ({ ...current, model: event.target.value }))
            setFieldErrors(current => ({ ...current, model: undefined }))
          }} />
        {!!models.length && <datalist id={modelsListId}>
          {models.map(item => <option key={item} value={item} />)}
        </datalist>}
        {fieldErrors.model && <p id={modelErrorId} className="inline-error" role="alert">{fieldErrors.model}</p>}
      </div>

      {!!models.length && <div className="ai-models-chips" aria-label="可用模型">
        {models.slice(0, 8).map(item => (
          <button key={item} type="button" className="small subtle" disabled={busy}
            aria-pressed={draft.model.trim() === item}
            onClick={() => setDraft(current => ({ ...current, model: item }))}>
            {item}
          </button>
        ))}
      </div>}

      {currentProbe && <div className="gateway-status" role="status">
        {result ? <>
          <span className="gateway-reachable">服务可达（{result.latencyMs} ms）</span>
          <span>{result.modelList === 'valid' ? `模型列表有效（${result.models.length} 个模型）`
            : result.modelList === 'invalid' ? '模型列表无效' : '模型列表不可用'}</span>
          <span>当前模型生成未验证</span>
          {result.issue && <span className="gateway-issue">{result.issue}</span>}
        </> : 'error' in currentProbe && <>
          <span className="gateway-issue">服务不可达</span>
          <span>{currentProbe.error}</span>
        </>}
      </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}

      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={() => {
          const parsed = parseDraft()
          if (!parsed) return
          onEndpointChange()
          onTest(parsed)
        }}><PlugsConnected size={16} /> 测试连接</button>
        <button type="button" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="primary" disabled={busy}>保存设置</button>
      </div>
    </form>
  </Modal>
}

export function ScriptAiDialog({
  scope,
  project,
  episode,
  currentScript,
  ai,
  busy,
  onGenerate,
  onCancel,
  onApply,
  close,
}: {
  scope: 'project' | 'episode'
  project: Project
  episode?: Episode
  currentScript: string
  ai: AiPanelOptions
  busy: boolean
  onGenerate: (target: AiRequestTarget, instruction: string, accept: (draft: string | null) => void, failure: Failure) => void
  onCancel: (failure: Failure) => void
  onApply: (nextScript: string) => void
  close: () => void
}) {
  const [instruction, setInstruction] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [stopped, setStopped] = useState(false)
  const [generating, setGenerating] = useState(false)
  const instructionId = useId()
  const request = useAiRequest(ai.config)
  const parsed = aiInstructionSchema.safeParse(instruction)

  const targetLabel = scope === 'episode' && episode ? `集数剧本 · ${episode.title}` : '作品总剧本'

  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !request.target) return
    if (!parsed.success) {
      setError(parsed.error.issues[0].message)
      return
    }
    setError('')
    setStopped(false)
    setGenerating(true)
    onGenerate(request.target, parsed.data, draft => {
      setGenerating(false)
      if (draft !== null) setPreview(draft)
      else setStopped(true)
    }, message => {
      setGenerating(false)
      setError(message)
    })
  }

  return <Modal title={preview ? 'AI 剧本草案预览' : 'AI 辅助写剧本'}
    onClose={() => { if (generating) onCancel(setError); else if (!busy) close() }}>
    <div className="creative-dialog">
      <div className="import-target">
        <span>{targetLabel}</span>
        {project.fictional && <Badge value="示例 / 虚构" />}
      </div>

      {preview !== null ? <>
        <div className="diff-values script-ai-preview">
          <div><strong>当前剧本</strong><pre>{currentScript.trim() || '（空）'}</pre></div>
          <div><strong>AI 草案</strong><pre>{preview}</pre></div>
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={() => { setPreview(null); setError('') }}>返回调整</button>
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button type="button" className="primary" disabled={busy} onClick={() => {
            onApply(preview)
            close()
          }}>应用到编辑器</button>
        </div>
      </> : <form onSubmit={submit}>
        <div className="field">
          <label htmlFor={instructionId}>编写或改写要求（可选）</label>
          <textarea id={instructionId} className="long-prompt" autoFocus rows={5} maxLength={2000}
            value={instruction} readOnly={busy}
            placeholder="例如：补全三幕冲突与人物对白、调整为 60 秒快节奏解说，留空则结合简报与当前剧本自动补全"
            onChange={event => setInstruction(event.target.value)} />
        </div>
        <AiRequestFields ai={ai} request={request} disabled={busy}
          scope={`${scope === 'episode' ? '集数及作品剧本' : '作品剧本'} · 写作要求 · 作品设定与大纲`}
          prompt={parsed.success ? () => scriptAiPrompt(project, scope, episode, currentScript, parsed.data) : undefined} />
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <span className="dialog-status" role="status">{generating ? '正在生成剧本草案…' : stopped ? '已停止等待' : ''}</span>
          {generating
            ? <button type="button" onClick={() => onCancel(setError)}>停止等待</button>
            : <button type="button" disabled={busy} onClick={close}>取消</button>}
          <button type="submit" className="primary" disabled={busy || !request.target}><Sparkle size={16} /> 生成剧本草案</button>
        </div>
      </form>}
    </div>
  </Modal>
}
