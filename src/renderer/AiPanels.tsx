import { useId, useState, type FormEvent } from 'react'
import { PlugsConnected, Sparkle } from '@phosphor-icons/react'
import {
  aiGatewayConfigSchema, aiGatewayPresets, aiInstructionSchema, aiPresetSchema,
  type AiConnectionTestResult, type AiGatewayConfig, type AiPreset,
} from '../shared/plan'
import { Badge, Modal } from './components'

type Failure = (message: string) => void

export function aiGatewaySummary(config: AiGatewayConfig) {
  const preset = aiGatewayPresets[config.preset]
  try {
    const host = new URL(config.baseUrl).host
    return `${config.preset === 'custom' ? '自定义网关' : preset.label.replace(/本机网关|本机服务/, '').trim()} · ${host}`
  } catch {
    return preset.label
  }
}

export function AiSettingsDialog({
  config,
  discoveredModels,
  busy,
  onTest,
  onSave,
  close,
}: {
  config: AiGatewayConfig
  discoveredModels: string[]
  busy: boolean
  onTest: (config: AiGatewayConfig, accept: (result: AiConnectionTestResult) => void, failure: Failure) => void
  onSave: (config: AiGatewayConfig, failure: Failure) => void
  close: () => void
}) {
  const [draft, setDraft] = useState<AiGatewayConfig>(() => ({ ...config }))
  const [models, setModels] = useState<string[]>(discoveredModels)
  const [testNotice, setTestNotice] = useState('')
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
    setTestNotice('')
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
            setTestNotice('')
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

      {error && <p className="inline-error" role="alert">{error}</p>}

      <div className="dialog-actions">
        <span className="dialog-status" role="status">{testNotice}</span>
        <button type="button" disabled={busy} onClick={() => {
          const parsed = parseDraft()
          if (!parsed) return
          setTestNotice('')
          onTest(parsed, result => {
            setModels(result.models)
            const modelInfo = result.models.length ? ` · ${result.models.length} 个模型` : ''
            setTestNotice(`已连接（${result.latencyMs} ms${modelInfo}）`)
          }, setError)
        }}><PlugsConnected size={16} /> 测试连接</button>
        <button type="button" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="primary" disabled={busy}>保存设置</button>
      </div>
    </form>
  </Modal>
}

export function ScriptAiDialog({
  scope,
  episodeTitle,
  fictional,
  currentScript,
  aiConfig,
  busy,
  onOpenSettings,
  onGenerate,
  onCancel,
  onApply,
  close,
}: {
  scope: 'project' | 'episode'
  episodeTitle?: string
  fictional: boolean
  currentScript: string
  aiConfig: AiGatewayConfig
  busy: boolean
  onOpenSettings: () => void
  onGenerate: (instruction: string, accept: (draft: string | null) => void, failure: Failure) => void
  onCancel: (failure: Failure) => void
  onApply: (nextScript: string) => void
  close: () => void
}) {
  const [instruction, setInstruction] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [stopped, setStopped] = useState(false)
  const instructionId = useId()

  const targetLabel = scope === 'episode' && episodeTitle ? `集数剧本 · ${episodeTitle}` : '作品总剧本'

  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const parsed = aiInstructionSchema.safeParse(instruction)
    if (!parsed.success) {
      setError(parsed.error.issues[0].message)
      return
    }
    setError('')
    setStopped(false)
    onGenerate(parsed.data, draft => {
      if (draft !== null) setPreview(draft)
      else setStopped(true)
    }, setError)
  }

  return <Modal title={preview ? 'AI 剧本草案预览' : 'AI 辅助写剧本'}
    onClose={() => { if (busy) onCancel(setError); else close() }}>
    <div className="creative-dialog">
      <div className="import-target">
        <span>{targetLabel}</span>
        {fictional && <Badge value="示例 / 虚构" />}
        <div className="ai-gateway-bar">
          <Badge value={`${aiGatewaySummary(aiConfig)} · ${aiConfig.model}`} />
          <button type="button" className="small subtle" disabled={busy} onClick={onOpenSettings}>切换网关</button>
        </div>
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
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <span className="dialog-status" role="status">{busy ? '正在生成剧本草案…' : stopped ? '已停止等待' : ''}</span>
          {busy
            ? <button type="button" onClick={() => onCancel(setError)}>停止等待</button>
            : <button type="button" disabled={busy} onClick={close}>取消</button>}
          <button type="submit" className="primary" disabled={busy}><Sparkle size={16} /> 生成剧本草案</button>
        </div>
      </form>}
    </div>
  </Modal>
}
