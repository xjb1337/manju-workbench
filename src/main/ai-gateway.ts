import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent } from 'undici'
import { aiBaseUrlSchema, aiIpNetwork, type AiNetwork } from '../shared/plan'

export type GatewayLookup = (host: string) => Promise<LookupAddress[]>
const resolveHost: GatewayLookup = host => lookup(host, { all: true })

export async function resolveAiGateway(baseUrl: string, signal: AbortSignal, resolve = resolveHost) {
  const { hostname } = new URL(aiBaseUrlSchema.parse(baseUrl))
  const literal = aiIpNetwork(hostname)
  signal.throwIfAborted()
  if (literal === 'loopback' || literal === 'lan') return { network: literal }

  let abort: () => void
  const addresses = await new Promise<LookupAddress[]>((done, fail) => {
    abort = () => fail(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then(() => resolve(hostname)).then(done, fail)
  }).catch(() => {
    signal.throwIfAborted()
    throw new Error('无法确认 AI 网关的本机或局域网地址')
  }).finally(() => signal.removeEventListener('abort', abort))

  if (!addresses.length) throw new Error('无法确认 AI 网关的本机或局域网地址')
  let network: AiNetwork = 'loopback'
  for (const { address, family } of addresses) {
    if (isIP(address) !== family) throw new Error('无法确认 AI 网关的本机或局域网地址')
    if (address.includes('%')) throw new Error('AI 网关仅允许本机或局域网地址')
    const scope = aiIpNetwork(new URL(`http://${family === 6 ? `[${address}]` : address}`).hostname)
    if (scope !== 'loopback' && scope !== 'lan') throw new Error('AI 网关仅允许本机或局域网地址')
    if (scope === 'lan') network = 'lan'
  }
  return { network, addresses }
}

export async function describeAiGateway(baseUrl: string, resolve?: GatewayLookup) {
  const signal = AbortSignal.timeout(8000)
  try {
    return (await resolveAiGateway(baseUrl, signal, resolve)).network
  } catch (error) {
    if (signal.aborted) throw new Error('AI 网关地址解析超时')
    throw error
  }
}

export type GatewayOptions = { resolve?: GatewayLookup; network?: AiNetwork }

export async function withAiDispatcher<T>(
  baseUrl: string,
  signal: AbortSignal,
  options: GatewayOptions,
  use: (dispatcher: Agent) => Promise<T>,
): Promise<T> {
  const { network, addresses } = await resolveAiGateway(baseUrl, signal, options.resolve)
  if (options.network && network !== options.network) throw new Error('网关网络范围已变化，请重新打开生成面板')
  signal.throwIfAborted()
  // Keep the configured hostname for HTTP Host and TLS, and pin the socket to validated DNS answers.
  const dispatcher = new Agent(addresses ? { connect: {
    lookup: (_host, lookupOptions, callback) => {
      const candidates = lookupOptions.family ? addresses.filter(item => item.family === lookupOptions.family) : addresses
      if (!candidates.length) return callback(new Error('无已校验的网关地址'), '', 0)
      if (lookupOptions.all) return callback(null, candidates)
      callback(null, candidates[0].address, candidates[0].family)
    },
  } } : {})
  try {
    return await use(dispatcher)
  } finally {
    await dispatcher.destroy().catch(() => {})
  }
}
