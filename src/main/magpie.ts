import { z } from 'zod'
import { magpieBaseUrl } from '../shared/plan'
import { parseMagpieDraft } from './plan-import'

const completionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable().optional() }),
  })).min(1),
})

async function readCompletion(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Magpie 返回了空响应')
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 4 * 1024 * 1024) throw new Error('Magpie 响应过大，请分段生成')
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function generateMagpiePlan(model: string, prompt: string, signal: AbortSignal) {
  const timeout = AbortSignal.timeout(120_000)
  const requestSignal = AbortSignal.any([signal, timeout])
  try {
    const response = await fetch(`${magpieBaseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: { Authorization: 'Bearer magpie', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      const messages: Record<number, string> = {
        400: '请核对模型 ID 及路由支持的请求格式',
        401: '请检查 Magpie 的本机网关访问设置',
        403: '请检查 Magpie 的本机网关访问设置',
        404: '请核对模型 ID 及本机网关是否已开启',
        429: '请求受限，请检查 Magpie 路由额度或稍后重试',
      }
      throw new Error(`Magpie 请求失败（HTTP ${response.status}） · ${messages[response.status] ?? '请查看 Magpie 网关中的请求状态'}`)
    }
    const completion = completionSchema.safeParse(await readCompletion(response))
    if (!completion.success) throw new Error('Magpie 响应格式无法识别，请检查所选模型路由')
    const choice = completion.data.choices[0]
    if (choice.finish_reason === 'length') throw new Error('模型响应被截断，请缩短剧本或分段生成')
    const content = choice.message.content?.trim()
    if (!content) throw new Error('模型未返回分镜内容，请尝试其他 Magpie 模型')
    const unwrapped = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content)?.[1] ?? content
    const { episode } = parseMagpieDraft(unwrapped)
    if (!episode.shots.length) throw new Error('模型没有生成镜头，请补充动作或台词后再试')
    return episode
  } catch (error) {
    if (signal.aborted) return null
    if (timeout.aborted) throw new Error('Magpie 等待超过 2 分钟，请分段生成或更换模型')
    if (error instanceof SyntaxError) throw new Error('Magpie 响应格式无法识别，请检查所选模型路由')
    if (error instanceof TypeError) throw new Error('无法连接本机 Magpie 网关，请确认已开启且监听 127.0.0.1:3425')
    throw error
  }
}
