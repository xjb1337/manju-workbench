const assert = require('node:assert/strict')
const { test } = require('node:test')
const { extractJsonObject, parseMagpieDraft, parsePlan } = require('../dist/main/plan-import')
const { generateAiTextDraft, generateMagpiePlan, stripPlainTextCompletion, testAiGateway } = require('../dist/main/magpie')
const { aiBaseUrlSchema } = require('../dist/shared/plan')

async function withMockFetch(mock, run) {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

function completionResponse(content, finishReason = 'stop') {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content } }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const validExternalPlan = {
  schemaVersion: 1,
  title: '示例作品',
  assets: ['背景图：手工绘制'],
  missing: [],
  episode: {
    title: '第一集',
    shots: [{ title: '开场镜头', frames: 45, method: 'image-video', dialogue: '示例 / 虚构' }],
  },
}

const validMagpiePlan = {
  schemaVersion: 1,
  episode: {
    title: '第一集',
    shots: [{ title: '开场镜头', frames: 60, dialogue: '示例 / 虚构', details: { image: '生图描述' } }],
  },
}

test('extractJsonObject 支持 BOM、前置 think 块、单个围栏与外层平衡对象提取', () => {
  const raw = JSON.stringify(validExternalPlan)
  assert.deepEqual(JSON.parse(extractJsonObject(`\uFEFF  ${raw}  `)), validExternalPlan)

  const withThink = `\uFEFF<THINK>\n推理过程包含 {假花括号}\n和 \`\`\`json\n{"fake":true}\n\`\`\`\n</think>\n${raw}`
  assert.deepEqual(JSON.parse(extractJsonObject(withThink)), validExternalPlan)

  const withFenceAndProse = `以下是为您拆分的分镜规划：\r\n\`\`\`json\r\n${raw}\r\n\`\`\`\r\n请核对后合并。`
  assert.deepEqual(JSON.parse(extractJsonObject(withFenceAndProse)), validExternalPlan)

  const withBareFence = `说明文字\n\`\`\`\n${raw}\n\`\`\`\n结束`
  assert.deepEqual(JSON.parse(extractJsonObject(withBareFence)), validExternalPlan)

  const trickyPlan = {
    ...validExternalPlan,
    script: '包含 {花括号} 和 "引号" 以及 \\ 反斜杠 和 ```code``` 片段',
  }
  const trickyRaw = JSON.stringify(trickyPlan)
  assert.deepEqual(JSON.parse(extractJsonObject(trickyRaw)), trickyPlan)
  assert.deepEqual(JSON.parse(extractJsonObject(`前置说明：\n${trickyRaw}\n后置说明 {尾部}`)), trickyPlan)

  assert.equal(extractJsonObject('{ "broken": true'), '{ "broken": true')
  assert.throws(() => JSON.parse(extractJsonObject('{ "broken": true')), SyntaxError)
})

test('parsePlan 兼容围栏与思考块，同时保持严格 Schema 校验拒绝非法结构', () => {
  const fenced = `<think>分析剧本</think>\n请复制以下 JSON：\n\`\`\`json\n${JSON.stringify(validExternalPlan)}\n\`\`\`\n完成`
  const parsed = parsePlan(fenced)
  assert.equal(parsed.title, '示例作品')
  assert.equal(parsed.episode.shots[0].frames, 45)

  assert.throws(() => parsePlan('说明：{"schemaVersion": 1, "episode": {'), /JSON 无法解析/)
  assert.throws(() => parsePlan('not json at all'), /JSON 无法解析/)
  assert.throws(() => parsePlan('x'.repeat(1_000_001)), /最多 1,000,000 个字符/)

  assert.throws(() => parsePlan(JSON.stringify({
    ...validExternalPlan,
    unexpected: true,
  })), /不支持的字段/)

  assert.throws(() => parsePlan(JSON.stringify({
    schemaVersion: 1,
    assets: [],
    episode: { shots: [] },
  })), /missing · 类型错误或缺少必填字段/)

  assert.throws(() => parsePlan(JSON.stringify({
    ...validExternalPlan,
    episode: { shots: [{ title: '缺帧镜头' }] },
  })), /episode\.shots\.0\.frames · 新增镜头必须填写此项/)

  assert.throws(() => parseMagpieDraft(JSON.stringify({
    schemaVersion: 1,
    episode: { shots: [{ title: '缺帧', frames: 30, extraField: 1 }] },
  })), /不支持的字段/)
})

test('generateMagpiePlan 正常解析纯 JSON、围栏说明文字与 think 思考过程', async () => {
  const payload = JSON.stringify(validMagpiePlan)
  const cases = [
    payload,
    `好的，生成结果如下：\n\`\`\`json\n${payload}\n\`\`\`\n以上为草案。`,
    `<think>\n先梳理镜头节奏\n</think>\n\n\`\`\`\n${payload}\n\`\`\``,
  ]

  for (const content of cases) {
    let seenRequest
    const episode = await withMockFetch(async (url, init) => {
      seenRequest = { url, init }
      return completionResponse(content)
    }, () => generateMagpiePlan('group/never-stuck', '示例剧本', new AbortController().signal))

    assert.equal(seenRequest.url, 'http://127.0.0.1:3425/v1/chat/completions')
    assert.equal(seenRequest.init.method, 'POST')
    assert.equal(seenRequest.init.redirect, 'error')
    assert.deepEqual(JSON.parse(seenRequest.init.body), {
      model: 'group/never-stuck',
      messages: [{ role: 'user', content: '示例剧本' }],
      stream: false,
    })
    assert.equal(episode.title, '第一集')
    assert.equal(episode.shots.length, 1)
    assert.equal(episode.shots[0].frames, 60)
  }
})

test('generateMagpiePlan 严格映射 HTTP 400/401/403/404/429/500 错误文案', async () => {
  const expected = [
    [400, /HTTP 400.*核对模型 ID 及路由支持的请求格式/],
    [401, /HTTP 401.*检查 Magpie 的本机网关访问设置/],
    [403, /HTTP 403.*检查 Magpie 的本机网关访问设置/],
    [404, /HTTP 404.*核对模型 ID 及本机网关是否已开启/],
    [429, /HTTP 429.*请求受限，请检查 Magpie 路由额度或稍后重试/],
    [500, /HTTP 500.*查看 Magpie 网关中的请求状态/],
  ]

  for (const [status, pattern] of expected) {
    await withMockFetch(
      async () => new Response('error', { status }),
      () => assert.rejects(
        generateMagpiePlan('test-model', '剧本', new AbortController().signal),
        pattern,
      ),
    )
  }
})

test('generateMagpiePlan 拦截长度截断、空内容、空镜头与非法模型输出', async () => {
  await withMockFetch(
    async () => completionResponse(JSON.stringify(validMagpiePlan), 'length'),
    () => assert.rejects(
      generateMagpiePlan('test-model', '剧本', new AbortController().signal),
      /模型响应被截断/,
    ),
  )

  for (const empty of ['', '   \n  ', null]) {
    await withMockFetch(
      async () => completionResponse(empty),
      () => assert.rejects(
        generateMagpiePlan('test-model', '剧本', new AbortController().signal),
        /模型未返回分镜内容/,
      ),
    )
  }

  await withMockFetch(
    async () => completionResponse(JSON.stringify({ schemaVersion: 1, episode: { shots: [] } })),
    () => assert.rejects(
      generateMagpiePlan('test-model', '剧本', new AbortController().signal),
      /模型没有生成镜头/,
    ),
  )

  await withMockFetch(
    async () => completionResponse(JSON.stringify({
      schemaVersion: 1,
      episode: { shots: [{ title: '非法镜头', frames: 30, unknownKey: 1 }] },
    })),
    () => assert.rejects(
      generateMagpiePlan('test-model', '剧本', new AbortController().signal),
      /不支持的字段/,
    ),
  )

  await withMockFetch(
    async () => new Response('not-json', { status: 200 }),
    () => assert.rejects(
      generateMagpiePlan('test-model', '剧本', new AbortController().signal),
      /Magpie 响应格式无法识别/,
    ),
  )
})

test('generateMagpiePlan 处理网络 TypeError、AbortSignal 取消与超 4 MiB 响应限制', async () => {
  await withMockFetch(
    async () => { throw new TypeError('fetch failed') },
    () => assert.rejects(
      generateMagpiePlan('test-model', '剧本', new AbortController().signal),
      /无法连接本机 Magpie 网关.*127\.0\.0\.1:3425/,
    ),
  )

  const controller = new AbortController()
  const abortedResult = await withMockFetch(async (_url, init) => {
    controller.abort()
    assert.equal(init.signal.aborted, true)
    throw new DOMException('Aborted', 'AbortError')
  }, () => generateMagpiePlan('test-model', '剧本', controller.signal))
  assert.equal(abortedResult, null)

  let cancelled = false
  await withMockFetch(async () => {
    const stream = new ReadableStream({
      pull(ctrl) {
        ctrl.enqueue(new Uint8Array(1024 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(stream, { status: 200 })
  }, () => assert.rejects(
    generateMagpiePlan('test-model', '剧本', new AbortController().signal),
    /Magpie 响应过大/,
  ))
  assert.equal(cancelled, true)
})

test('generateMagpiePlan 支持自定义 OpenAI 兼容网关地址且不附带 Magpie 令牌', async () => {
  let seen
  const episode = await withMockFetch(async (url, init) => {
    seen = { url, init }
    return completionResponse(JSON.stringify(validMagpiePlan))
  }, () => generateMagpiePlan('qwen2.5:14b', '示例剧本', new AbortController().signal, 'http://127.0.0.1:11434/v1///'))

  assert.equal(seen.url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(seen.init.headers.Authorization, undefined)
  assert.equal(episode.title, '第一集')
})

test('testAiGateway 支持 /models 探测、404 回退探测与不可达报错', async () => {
  const listed = await withMockFetch(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/v1/models')
    assert.equal(init.method, 'GET')
    return new Response(JSON.stringify({ data: [{ id: 'qwen2.5:14b' }, { id: 'qwen2.5:14b' }, { id: 'llama3.2' }] }), { status: 200 })
  }, () => testAiGateway('http://127.0.0.1:11434/v1/', 'qwen2.5:14b', new AbortController().signal))
  assert.deepEqual(listed.models, ['qwen2.5:14b', 'llama3.2'])
  assert.equal(listed.probedByCompletion, undefined)

  let calls = 0
  const fallback = await withMockFetch(async url => {
    calls++
    if (url.endsWith('/models')) return new Response('not found', { status: 404 })
    return completionResponse('ok')
  }, () => testAiGateway('http://127.0.0.1:1234/v1', 'local-model', new AbortController().signal))
  assert.equal(calls, 2)
  assert.equal(fallback.probedByCompletion, true)

  await withMockFetch(
    async () => { throw new TypeError('connect ECONNREFUSED') },
    () => assert.rejects(
      testAiGateway('http://192.168.1.50:11434/v1', 'qwen2.5:14b', new AbortController().signal),
      /无法连接 AI 网关.*192\.168\.1\.50:11434/,
    ),
  )
})

test('stripPlainTextCompletion 与 generateAiTextDraft 清洗 think 块与围栏并校验空内容', async () => {
  assert.equal(stripPlainTextCompletion('\uFEFF<think>推理</think>\n```\n第一镜：全景推进\n```'), '第一镜：全景推进')

  const drafted = await withMockFetch(
    async () => completionResponse('<think>分析光影</think>\n```markdown\n主体：少年站在雨夜巷口\n```'),
    () => generateAiTextDraft('qwen2.5:14b', '优化提示词', new AbortController().signal, 'http://127.0.0.1:11434/v1'),
  )
  assert.equal(drafted, '主体：少年站在雨夜巷口')

  await withMockFetch(
    async () => completionResponse('<think>只有思考</think>'),
    () => assert.rejects(
      generateAiTextDraft('qwen2.5:14b', '优化提示词', new AbortController().signal),
      /模型未返回可用文本/,
    ),
  )
})

test('aiBaseUrlSchema 规范化尾部斜杠并拒绝携带凭据或非法协议', () => {
  assert.equal(aiBaseUrlSchema.parse('http://127.0.0.1:11434/v1///'), 'http://127.0.0.1:11434/v1')
  assert.throws(() => aiBaseUrlSchema.parse('http://user:secret@127.0.0.1:3425/v1'), /不含账号密码/)
  assert.throws(() => aiBaseUrlSchema.parse('file:///C:/test'), /有效的 http:\/\/ 或 https:\/\//)
})
