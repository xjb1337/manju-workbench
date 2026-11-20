const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { mediaResponse, rangeFor } = require('../dist/main/media-protocol')
const { isLocalAbsolutePath, RecentProjects } = require('../dist/main/recent-projects')

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'manju-sec-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('isLocalAbsolutePath 放行本地绝对路径并拦截 UNC、设备路径与相对路径', () => {
  const validLocal = process.platform === 'win32'
    ? [
        'C:\\Users\\示例\\素材 01.png',
        'D:/manju/episodes/shot 02.mp4',
        'z:\\media\\voice.wav',
      ]
    : ['/Users/demo/素材 01.png', '/tmp/manju/shot.mp4']

  for (const sample of validLocal) {
    assert.equal(isLocalAbsolutePath(sample), true, `expected valid: ${sample}`)
  }

  const blocked = [
    '',
    'relative/clip.mp4',
    '.\\clip.mp4',
    'C:clip.mp4',
    'file:///C:/media/clip.mp4',
    '\\\\attacker\\share\\clip.png',
    '//attacker/share/clip.png',
    '\\/attacker/share/clip.png',
    '/\\attacker\\share\\clip.png',
    '\\\\?\\C:\\media\\clip.png',
    '\\\\?\\UNC\\attacker\\share\\clip.png',
    '\\\\.\\pipe\\manju',
    '\\\\.\\PhysicalDrive0',
    '//?/C:/media/clip.png',
    '//./C:/media/clip.png',
    'C:\\media\\clip.png\0.jpg',
  ]
  if (process.platform === 'win32') {
    blocked.push('\\Windows\\System32\\cmd.exe', '/tmp/clip.mp4')
  }

  for (const sample of blocked) {
    assert.equal(isLocalAbsolutePath(sample), false, `expected blocked: ${sample}`)
  }
})

test('RecentProjects 单字段损坏时保留其余有效偏好，且拦截配置中的 UNC 路径', async context => {
  const root = await workspace(context)
  const file = path.join(root, 'workbench-preferences.json')
  const validProjectDir = path.join(root, 'valid-project')
  const validMediaDir = path.join(root, 'valid-media')
  const validFfmpegDir = path.join(root, 'valid-ffmpeg')
  const validBounds = { width: 1280, height: 760, x: 40, y: 50, maximized: false }
  const validGateway = { preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:14b' }
  const validRecent = [{ id: randomUUID(), title: '示例作品', directory: validProjectDir, fictional: true }]

  await writeFile(file, JSON.stringify({
    recent: 'corrupted-recent',
    mediaDirectory: validMediaDir,
    theme: 'dark',
    windowBounds: validBounds,
    aiGateway: validGateway,
    ffmpegDirectory: validFfmpegDir,
  }))
  const caseA = await RecentProjects.open(root)
  assert.deepEqual(caseA.entries, [])
  assert.equal(caseA.theme, 'dark')
  assert.deepEqual(caseA.windowBounds, validBounds)
  assert.deepEqual(caseA.aiGateway, validGateway)
  assert.equal(caseA.ffmpegDirectory, validFfmpegDir)
  await mkdir(validMediaDir)
  assert.equal(await caseA.defaultDirectory('media'), validMediaDir)

  await writeFile(file, JSON.stringify({
    recent: validRecent,
    mediaDirectory: '\\\\attacker\\share\\media',
    theme: 'neon',
    windowBounds: { width: 120, height: 100 },
    aiGateway: { preset: 'custom', baseUrl: 'http://8.8.8.8/v1', model: 'bad' },
    ffmpegDirectory: '\\\\?\\C:\\ffmpeg',
  }))
  const caseB = await RecentProjects.open(root)
  assert.deepEqual(caseB.entries, validRecent)
  assert.equal(caseB.theme, undefined)
  assert.equal(caseB.windowBounds, undefined)
  assert.equal(caseB.ffmpegDirectory, null)
  assert.equal(caseB.aiGateway.preset, 'magpie')
  assert.equal(await caseB.defaultDirectory('media', validMediaDir), validMediaDir)
})

test('RecentProjects setTheme/setWindowBounds/remember 先落盘后改内存且写盘失败不污染内存', async context => {
  const root = await workspace(context)
  const prefs = await RecentProjects.open(root)
  const boundsA = { width: 1100, height: 700, x: 10, y: 20, maximized: false }
  const boundsB = { width: 1400, height: 900, x: 30, y: 40, maximized: true }
  const dirA = path.join(root, 'proj-a')
  const dirB = path.join(root, 'proj-b')

  await prefs.setTheme('dark')
  await prefs.setWindowBounds(boundsA)
  await prefs.remember({ directory: dirA, title: '示例甲', fictional: true })

  // Remove backing directory so atomicJson fails on temp file creation.
  await rm(root, { recursive: true, force: true })

  await assert.rejects(() => prefs.setTheme('light'))
  await assert.rejects(() => prefs.setWindowBounds(boundsB))
  await assert.rejects(() => prefs.remember({ directory: dirB, title: '示例乙', fictional: false }))

  assert.equal(prefs.theme, 'dark')
  assert.deepEqual(prefs.windowBounds, boundsA)
  assert.equal(prefs.entries.length, 1)
  assert.equal(prefs.entries[0].directory, dirA)

  // Queue tail must recover after failures, and boundsB must not be skipped.
  await mkdir(root, { recursive: true })
  await prefs.setWindowBounds(boundsB)
  const reopened = await RecentProjects.open(root)
  assert.deepEqual(reopened.windowBounds, boundsB)
  assert.equal(reopened.theme, 'dark')
  assert.equal(reopened.entries[0].directory, dirA)
})

test('RecentProjects.setWindowBounds 并发落盘保持最终调用顺序与同值回跳一致性', async context => {
  const root = await workspace(context)
  const prefs = await RecentProjects.open(root)
  const bounds1 = { width: 1000, height: 680, x: 10, y: 10, maximized: false }
  const bounds2 = { width: 1200, height: 780, x: 20, y: 20, maximized: false }
  const bounds3 = { width: 1360, height: 840, x: 50, y: 60, maximized: true }

  await Promise.all([
    prefs.setWindowBounds(bounds1),
    prefs.setWindowBounds(bounds2),
    prefs.setWindowBounds(bounds3),
  ])

  assert.deepEqual(prefs.windowBounds, bounds3)
  assert.deepEqual((await RecentProjects.open(root)).windowBounds, bounds3)

  // Concurrent A -> B -> A: second call must see B after A finishes, not stale A.
  await Promise.all([
    prefs.setWindowBounds(bounds1),
    prefs.setWindowBounds(bounds3),
  ])

  assert.deepEqual(prefs.windowBounds, bounds3)
  assert.deepEqual((await RecentProjects.open(root)).windowBounds, bounds3)
})

test('mediaResponse 覆盖完整读取、Range 边界、416、HEAD、405、目录拒绝与句柄释放', async context => {
  const root = await workspace(context)
  const file = path.join(root, 'sample.mp4')
  await writeFile(file, '0123456789')

  const full = await mediaResponse(new Request('manju-media://project/k/1'), file, 'mp4', {
    cacheControl: 'private, max-age=3600, immutable',
  })
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('Content-Type'), 'video/mp4')
  assert.equal(full.headers.get('Content-Length'), '10')
  assert.equal(full.headers.get('Accept-Ranges'), 'bytes')
  assert.equal(full.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(full.headers.get('Cache-Control'), 'private, max-age=3600, immutable')
  assert.equal(await full.text(), '0123456789')

  const slice = await mediaResponse(
    new Request('manju-media://project/k/1', { headers: { Range: 'bytes=2-5' } }),
    file,
    'mp4',
  )
  assert.equal(slice.status, 206)
  assert.equal(slice.headers.get('Cache-Control'), 'no-store')
  assert.equal(slice.headers.get('Content-Range'), 'bytes 2-5/10')
  assert.equal(slice.headers.get('Content-Length'), '4')
  assert.equal(await slice.text(), '2345')

  const suffix = await mediaResponse(
    new Request('manju-media://project/k/1', { headers: { Range: 'bytes=-3' } }),
    file,
    'mp4',
  )
  assert.equal(suffix.status, 206)
  assert.equal(suffix.headers.get('Content-Range'), 'bytes 7-9/10')
  assert.equal(await suffix.text(), '789')

  const openEnd = await mediaResponse(
    new Request('manju-media://project/k/1', { headers: { Range: 'bytes=7-' } }),
    file,
    'mp4',
  )
  assert.equal(openEnd.status, 206)
  assert.equal(openEnd.headers.get('Content-Range'), 'bytes 7-9/10')
  assert.equal(await openEnd.text(), '789')

  const clamped = await mediaResponse(
    new Request('manju-media://project/k/1', { headers: { Range: 'bytes=6-999' } }),
    file,
    'mp4',
  )
  assert.equal(clamped.status, 206)
  assert.equal(clamped.headers.get('Content-Range'), 'bytes 6-9/10')
  assert.equal(await clamped.text(), '6789')

  for (const invalidRange of ['bytes=10-12', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=bad-range']) {
    const res416 = await mediaResponse(
      new Request('manju-media://project/k/1', { headers: { Range: invalidRange } }),
      file,
      'mp4',
    )
    assert.equal(res416.status, 416, `expected 416 for ${invalidRange}`)
    assert.equal(res416.headers.get('Content-Range'), 'bytes */10')
  }

  const head = await mediaResponse(
    new Request('manju-media://project/k/1', { method: 'HEAD', headers: { Range: 'bytes=0-3' } }),
    file,
    'mp4',
  )
  assert.equal(head.status, 206)
  assert.equal(head.body, null)
  assert.equal(head.headers.get('Content-Length'), '4')

  const methodNotAllowed = await mediaResponse(
    new Request('manju-media://project/k/1', { method: 'POST' }),
    file,
    'mp4',
  )
  assert.equal(methodNotAllowed.status, 405)

  const canceled = await mediaResponse(new Request('manju-media://project/k/1'), file, 'mp4')
  await canceled.body.cancel()

  const abortedController = new AbortController()
  abortedController.abort()
  await assert.rejects(
    () => mediaResponse(new Request('manju-media://project/k/1', { signal: abortedController.signal }), file, 'mp4'),
    err => err.name === 'AbortError',
  )

  await assert.rejects(() => mediaResponse(new Request('manju-media://project/k/1'), root, 'mp4'))

  const emptyFile = path.join(root, 'empty.bin')
  await writeFile(emptyFile, '')
  const empty416 = await mediaResponse(
    new Request('manju-media://project/k/2', { headers: { Range: 'bytes=0-0' } }),
    emptyFile,
    'bin',
  )
  assert.equal(empty416.status, 416)
  assert.equal(empty416.headers.get('Content-Type'), 'application/octet-stream')
  assert.equal(empty416.headers.get('Content-Range'), 'bytes */0')
  assert.equal(rangeFor('bytes=0-0', 0), null)

  // On Windows, unlinking succeeds only if every FileHandle above was closed.
  await rm(file)
  await rm(emptyFile)
})

test('mediaResponse 头部校验与流读取共享同一打开句柄（无 TOCTOU 二次按路径读取）', async context => {
  const root = await workspace(context)
  const file = path.join(root, 'toctou.mp4')
  await writeFile(file, 'abcdefghij')

  const fsPromises = require('node:fs/promises')
  const originalOpen = fsPromises.open
  const modulePath = require.resolve('../dist/main/media-protocol')
  const previousCached = require.cache[modulePath]
  delete require.cache[modulePath]

  let openCount = 0
  let statCount = 0
  let streamFromHandleCount = 0
  let closedEarly = 0

  fsPromises.open = async (targetPath, flags) => {
    openCount++
    const realHandle = await originalOpen(targetPath, flags)
    return {
      get fd() { return realHandle.fd },
      async stat() {
        statCount++
        return realHandle.stat()
      },
      createReadStream(opts) {
        streamFromHandleCount++
        return realHandle.createReadStream(opts)
      },
      async close() {
        closedEarly++
        return realHandle.close()
      },
    }
  }

  try {
    const isolated = require('../dist/main/media-protocol')
    const okRes = await isolated.mediaResponse(
      new Request('manju-media://project/k/1', { headers: { Range: 'bytes=1-4' } }),
      file,
      'mp4',
    )
    assert.equal(okRes.status, 206)
    assert.equal(await okRes.text(), 'bcde')
    assert.equal(openCount, 1)
    assert.equal(statCount, 1)
    assert.equal(streamFromHandleCount, 1)
    assert.equal(closedEarly, 0)

    const headRes = await isolated.mediaResponse(
      new Request('manju-media://project/k/1', { method: 'HEAD' }),
      file,
      'mp4',
    )
    assert.equal(headRes.status, 200)
    assert.equal(closedEarly, 1)

    const res416 = await isolated.mediaResponse(
      new Request('manju-media://project/k/1', { headers: { Range: 'bytes=99-100' } }),
      file,
      'mp4',
    )
    assert.equal(res416.status, 416)
    assert.equal(closedEarly, 2)
  } finally {
    fsPromises.open = originalOpen
    delete require.cache[modulePath]
    if (previousCached) require.cache[modulePath] = previousCached
  }
})
