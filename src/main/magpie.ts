import { z } from 'zod'
import { detailTextSchema } from '../shared/creative'
import { aiBaseUrlSchema, magpieBaseUrl, magpieModelSchema, type AiConnectionTestResult } from '../shared/plan'
import { parseMagpieDraft } from './plan-import'

const maxCompletionBytes = 4 * 1024 * 1024
const maxModelsBytes = 2 * 1024 * 1024

const completionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable().optional() }),
  })).min(1),
})

const modelsSchema = z.object({
  data: z.array(z.object({ id: magpieModelSchema })),
})

async function readJsonResponse(response: Response, maxBytes: number, gatewayName: string) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`${gatewayName} 返回了空响应`)
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error(`${gatewayName} 响应过大，请分段生成`)
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function gatewayLabel(baseUrl: string) {
  return baseUrl === magpieBaseUrl ? 'Magpie' : 'AI 网关'
}

function unreachableMessage(baseUrl: string) {
  if (baseUrl === magpieBaseUrl) {
    return '无法连接本机 Magpie 网关，请确认已开启且监听 127.0.0.1:3425'
  }
  const host = new URL(baseUrl).host
  return `无法连接 AI 网关，请确认服务已开启且监听 ${host}`
}

function mapHttpFailure(status: number, baseUrl: string) {
  const isMagpie = baseUrl === magpieBaseUrl
  const name = gatewayLabel(baseUrl)
  const messages: Record<number, string> = isMagpie ? {
    400: '请核对模型 ID 及路由支持的请求格式',
    401: '请检查 Magpie 的本机网关访问设置',
    403: '请检查 Magpie 的本机网关访问设置',
    404: '请核对模型 ID 及本机网关是否已开启',
    429: '请求受限，请检查 Magpie 路由额度或稍后重试',
  } : {
    400: '请核对模型 ID 及网关支持的请求格式',
    401: '网关拒绝未授权请求，请检查本机/局域网访问策略',
    403: '网关拒绝访问，请检查本机/局域网访问策略',
    404: '请核对模型 ID 及网关路径是否包含 /v1',
    429: '请求受限，请稍后重试',
  }
  const fallback = isMagpie ? '请查看 Magpie 网关中的请求状态' : '请查看网关服务中的请求状态'
  return new Error(`${name} 请求失败（HTTP ${status}） · ${messages[status] ?? fallback}`)
}

/** Strips optional leading `<think>...</think>` blocks and outer Markdown code fences from plain-text AI responses. */
export function stripPlainTextCompletion(raw: string) {
  let text = raw.replace(/^\uFEFF/, '').trimStart()
  while (/^<think>/i.test(text)) {
    const close = text.search(/<\/think>/i)
    if (close === -1) break
    text = text.slice(close + '</think>'.length).trimStart()
  }
  text = text.trim()
  const fenced = text.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/)
  return (fenced ? fenced[1] : text).trim()
}

export async function requestChatCompletion(options: {
  baseUrl?: string
  model: string
  prompt: string
  signal: AbortSignal
  timeoutMs?: number
  emptyError?: string
}) {
  const baseUrl = aiBaseUrlSchema.parse(options.baseUrl ?? magpieBaseUrl)
  const isMagpie = baseUrl === magpieBaseUrl
  const name = gatewayLabel(baseUrl)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000)
  const requestSignal = AbortSignal.any([options.signal, timeout])
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (isMagpie) headers.Authorization = 'Bearer magpie'
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers,
      body: JSON.stringify({ model: options.model, messages: [{ role: 'user', content: options.prompt }], stream: false }),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw mapHttpFailure(response.status, baseUrl)
    }
    const completion = completionSchema.safeParse(await readJsonResponse(response, maxCompletionBytes, name))
    if (!completion.success) throw new Error(`${name} 响应格式无法识别，请检查所选模型路由`)
    const choice = completion.data.choices[0]
    if (choice.finish_reason === 'length') throw new Error('模型响应被截断，请缩短输入或分段生成')
    const content = choice.message.content?.trim()
    if (!content) throw new Error(options.emptyError ?? `模型未返回内容，请尝试其他 ${name} 模型`)
    return content
  } catch (error) {
    if (options.signal.aborted) return null
    if (timeout.aborted) throw new Error(`${name} 等待超过 2 分钟，请分段生成或更换模型`)
    if (error instanceof SyntaxError) throw new Error(`${name} 响应格式无法识别，请检查所选模型路由`)
    if (error instanceof TypeError) throw new Error(unreachableMessage(baseUrl))
    throw error
  }
}

export async function generateMagpiePlan(model: string, prompt: string, signal: AbortSignal, baseUrl = magpieBaseUrl) {
  const content = await requestChatCompletion({
    baseUrl,
    model,
    prompt,
    signal,
    emptyError: baseUrl === magpieBaseUrl ? '模型未返回分镜内容，请尝试其他 Magpie 模型' : '模型未返回分镜内容，请尝试其他模型',
  })
  if (content === null) return null
  const { episode } = parseMagpieDraft(content)
  if (!episode.shots.length) throw new Error('模型没有生成镜头，请补充动作或台词后再试')
  return episode
}

export async function generateAiTextDraft(model: string, prompt: string, signal: AbortSignal, baseUrl = magpieBaseUrl) {
  const content = await requestChatCompletion({
    baseUrl,
    model,
    prompt,
    signal,
    emptyError: '模型未返回可用文本，请重试或更换模型',
  })
  if (content === null) return null
  const cleaned = stripPlainTextCompletion(content)
  if (!cleaned) throw new Error('模型未返回可用文本，请重试或更换模型')
  return detailTextSchema.parse(cleaned)
}

export async function testAiGateway(baseUrlInput: string, signal: AbortSignal): Promise<AiConnectionTestResult> {
  const baseUrl = aiBaseUrlSchema.parse(baseUrlInput)
  const name = gatewayLabel(baseUrl)
  const started = Date.now()
  const timeout = AbortSignal.timeout(8_000)
  const requestSignal = AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      redirect: 'manual',
      signal: requestSignal,
      headers: baseUrl === magpieBaseUrl ? { Authorization: 'Bearer magpie' } : {},
    })
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) throw new Error(`${name} 连接超时，请确认服务已开启`)
    if (error instanceof TypeError) throw new Error(unreachableMessage(baseUrl))
    throw error
  }
  const latencyMs = Math.max(1, Date.now() - started)
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return { models: [], latencyMs, modelList: 'unavailable', issue: `/models 返回 HTTP ${response.status}` }
  }
  if (response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
    await response.body?.cancel().catch(() => {})
    return { models: [], latencyMs, modelList: 'invalid', issue: `/models 返回 HTTP ${response.status} HTML` }
  }
  const parsed = modelsSchema.safeParse(await readJsonResponse(response, maxModelsBytes, name).catch(() => undefined))
  signal.throwIfAborted()
  if (!parsed.success) {
    return { models: [], latencyMs, modelList: 'invalid', issue: `/models 返回 HTTP ${response.status}，数据格式无效` }
  }
  const models = [...new Set(parsed.data.data.map(item => item.id))].slice(0, 100)
  return { models, latencyMs, modelList: 'valid' }
}
