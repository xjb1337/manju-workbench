const assert = require('node:assert/strict')
const { test } = require('node:test')
const { z } = require('zod')
const {
  briefSchema,
  detailSchema,
  formatVolumePercent,
  generationToolUrl,
  parseBriefDraft,
  planNotesSchema,
} = require('../dist/shared/creative')
const { aiIpNetwork, externalPlanSchema } = require('../dist/shared/plan')

const hasChinese = /[\u3400-\u9fff]/

function assertChineseError(result, pattern) {
  assert.equal(result.success, false)
  const message = result.error.issues[0]?.message ?? ''
  assert.match(message, hasChinese, `校验错误应包含中文，实际为: ${message}`)
  if (pattern) assert.match(message, pattern)
}

function makeDraft(overrides = {}) {
  return {
    target: '',
    ratio: '16:9',
    ...overrides,
    text: {
      theme: '',
      audience: '',
      style: '',
      language: '',
      tools: '',
      terms: '',
      ...overrides.text,
    },
    generation: {
      image: { name: '', url: '' },
      video: { name: '', url: '' },
      ...overrides.generation,
    },
  }
}

test('briefSchema 对所有无效输入均返回清晰的中文错误消息', () => {
  assertChineseError(briefSchema.safeParse('invalid'), /制作简报格式无效/)
  assertChineseError(briefSchema.safeParse({ targetSeconds: 0 }), /大于 0/)
  assertChineseError(briefSchema.safeParse({ targetSeconds: -3.5 }), /大于 0/)
  assertChineseError(briefSchema.safeParse({ targetSeconds: Number.NaN }), /有效数字/)
  assertChineseError(briefSchema.safeParse({ targetSeconds: Number.POSITIVE_INFINITY }), /有效数字/)
  assertChineseError(briefSchema.safeParse({ targetSeconds: Number.NEGATIVE_INFINITY }), /有效数字/)
  assertChineseError(briefSchema.safeParse({ targetSeconds: '12' }), /有效数字/)
  assertChineseError(briefSchema.safeParse({ targetSeconds: 86_401 }), /86,400/)
  assertChineseError(briefSchema.safeParse({ ratio: '4:3' }), /16:9 或 9:16/)
  assertChineseError(briefSchema.safeParse({ theme: 123 }), /文本/)
  assertChineseError(briefSchema.safeParse({ theme: 'x'.repeat(1001) }), /1,000/)
  assertChineseError(briefSchema.safeParse({ terms: 'y'.repeat(5001) }), /5,000/)
  assertChineseError(briefSchema.safeParse({ generation: { image: { name: 'a'.repeat(81) } } }), /80/)
  assertChineseError(briefSchema.safeParse({ generation: { video: { url: 'ftp://example.com' } } }), /HTTP 或 HTTPS/)
  assertChineseError(generationToolUrl.safeParse(`https://example.com/${'a'.repeat(2040)}`), /2,048/)
  assertChineseError(detailSchema.safeParse({ body: 'ok', source: 'unknown' }), /提示词来源无效/)
})

test('planNotesSchema 返回中文错误且与 externalPlanSchema JSON Schema 导出兼容', () => {
  assertChineseError(planNotesSchema.safeParse(null), /规划内容格式无效/)
  assertChineseError(planNotesSchema.safeParse({ outline: 'a'.repeat(30_001) }), /30,000/)
  assertChineseError(planNotesSchema.safeParse({ assets: 'not-array' }), /素材清单必须是列表/)
  assertChineseError(planNotesSchema.safeParse({ assets: ['   '] }), /不能为空/)
  assertChineseError(planNotesSchema.safeParse({ assets: [123] }), /文本/)
  assertChineseError(planNotesSchema.safeParse({ missing: Array.from({ length: 501 }, (_, i) => `项 ${i}`) }), /500/)

  const jsonSchema = z.toJSONSchema(externalPlanSchema)
  assert.equal(jsonSchema.type, 'object')
  assert.ok(jsonSchema.properties.assets)
  assert.ok(jsonSchema.properties.missing)
})

test('parseBriefDraft 校验目标时长、文本与生成工具并返回精确聚焦目标', () => {
  const valid = parseBriefDraft(makeDraft({
    target: ' 12.5 ',
    ratio: '9:16',
    text: { theme: ' 雾港信号 ', terms: ' 脉冲：短时升高 ' },
    generation: { image: { name: ' ChatGPT ', url: ' https://chatgpt.com/ ' }, video: { name: ' ', url: ' ' } },
  }))
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.data, {
    theme: '雾港信号',
    audience: '',
    style: '',
    language: '',
    tools: '',
    terms: '脉冲：短时升高',
    ratio: '9:16',
    targetSeconds: 12.5,
    generation: { image: { name: 'ChatGPT', url: 'https://chatgpt.com/' } },
  })

  const emptyTarget = parseBriefDraft(makeDraft({ target: '   ' }))
  assert.equal(emptyTarget.ok, true)
  assert.equal(emptyTarget.data.targetSeconds, undefined)

  for (const [badTarget, expected] of [
    ['0', /大于 0/],
    ['-1', /大于 0/],
    ['NaN', /有效数字/],
    ['abc', /有效数字/],
    ['1e309', /有效数字/],
    ['86401', /86,400/],
  ]) {
    const res = parseBriefDraft(makeDraft({ target: badTarget }))
    assert.equal(res.ok, false)
    assert.equal(res.focusId, 'brief-target-seconds')
    assert.match(res.errors.targetSeconds, expected)
  }

  const badUrl = parseBriefDraft(makeDraft({
    generation: { video: { name: '本地工具', url: 'https://user:secret@127.0.0.1:8188/' } },
  }))
  assert.equal(badUrl.ok, false)
  assert.equal(badUrl.focusId, 'generation-video-url')
  assert.match(badUrl.errors.generation.video.message, /HTTP 或 HTTPS/)

  const badToolName = parseBriefDraft(makeDraft({
    generation: { image: { name: '名'.repeat(81), url: '' } },
  }))
  assert.equal(badToolName.ok, false)
  assert.equal(badToolName.focusId, 'generation-image-name')
  assert.match(badToolName.errors.generation.image.message, /80/)

  const multiInvalid = parseBriefDraft(makeDraft({
    target: '-5',
    text: { terms: '长'.repeat(5001) },
    generation: { image: { name: '', url: 'file:///C:/bad.html' } },
  }))
  assert.equal(multiInvalid.ok, false)
  assert.equal(multiInvalid.focusId, 'brief-target-seconds')
  assert.ok(multiInvalid.errors.text.terms)
  assert.ok(multiInvalid.errors.generation.image)
})

test('formatVolumePercent 消除浮点乘百误差并处理非有限值', () => {
  assert.equal(formatVolumePercent(0.29), 29)
  assert.equal(String(formatVolumePercent(0.29)), '29')
  assert.equal(formatVolumePercent(0.14), 14)
  assert.equal(formatVolumePercent(0.57), 57)
  assert.equal(formatVolumePercent(0.255), 25.5)
  assert.equal(formatVolumePercent(0.2525), 25.25)
  assert.equal(formatVolumePercent(0), 0)
  assert.equal(formatVolumePercent(1), 100)
  assert.equal(formatVolumePercent(Number.NaN), 0)
  assert.equal(formatVolumePercent(Number.POSITIVE_INFINITY), 0)
})

test('URL.parse 配合 aiIpNetwork 对非法或空网关地址安全降级不抛异常', () => {
  for (const invalidUrl of ['', 'not-a-url', 'http://', '://broken']) {
    assert.equal(aiIpNetwork(URL.parse(invalidUrl)?.hostname ?? ''), undefined)
  }
  assert.equal(aiIpNetwork(URL.parse('http://127.0.0.1:3425/v1')?.hostname ?? ''), 'loopback')
  assert.equal(aiIpNetwork(URL.parse('http://192.168.1.10:11434/v1')?.hostname ?? ''), 'lan')
  assert.equal(aiIpNetwork(URL.parse('https://8.8.8.8/v1')?.hostname ?? ''), 'blocked')
})
