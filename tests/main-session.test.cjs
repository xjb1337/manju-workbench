const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { access, mkdir, mkdtemp, rm, utimes, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { emptyTrack } = require('../dist/shared/model')
const { WorkbenchSession } = require('../dist/main/session')
const { cleanupStaleTempDirs, staleTempAgeMs, staleTempPrefixes } = require('../dist/main/temp-cleanup')
const { resolveInitialBounds, themeBackground } = require('../dist/main/window-state')

async function exists(target) {
  return access(target).then(() => true, () => false)
}

function fakeStore(root, title = '示例作品') {
  return {
    root,
    snapshot: {
      id: randomUUID(),
      schemaVersion: 2,
      title,
      fictional: true,
      script: '',
      episodes: [{ id: randomUUID(), title: '第 1 集', script: '', shots: [], createdAt: '2026-11-18T00:00:00.000Z' }],
      characters: [],
      scenes: [{ id: randomUUID(), title: '示例场景', notes: '', image: emptyTrack() }],
    },
  }
}

test('WorkbenchSession.serial 串行防重入且异常后自动释放锁', async () => {
  const session = new WorkbenchSession()
  let releaseFirst
  const firstEntered = new Promise(resolve => {
    session._notify = resolve
  })

  const first = session.serial(async () => {
    session._notify()
    await new Promise(resolve => { releaseFirst = resolve })
    return 'ok'
  })

  await firstEntered
  await assert.rejects(() => session.serial(async () => 'second'), /已有操作在进行/)

  releaseFirst()
  assert.equal(await first, 'ok')

  await assert.rejects(() => session.serial(async () => { throw new Error('boom') }), /boom/)
  assert.equal(await session.serial(async () => 'recovered'), 'recovered')
})

test('WorkbenchSession.getStore 校验活动作品与 mediaKey', async () => {
  const session = new WorkbenchSession()
  assert.throws(() => session.getStore('missing'), /作品已关闭或切换/)

  const store = fakeStore(path.join(tmpdir(), 'fake-project-a'))
  const opened = await session.switchProject(store)
  assert.ok(opened)
  assert.equal(session.getStore(opened.mediaKey), store)
  assert.throws(() => session.getStore('wrong-key'), /作品已关闭或切换/)

  assert.equal(await session.switchProject(null), null)
  assert.throws(() => session.getStore(opened.mediaKey), /作品已关闭或切换/)
})

test('WorkbenchSession.switchProject 自动清理 preview 与 shotCacheDir 并记录最近作品', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'manju-session-test-'))
  try {
    const remembered = []
    const session = new WorkbenchSession({
      tempRoot,
      rememberProject: entry => { remembered.push(entry) },
    })

    const storeA = fakeStore(path.join(tempRoot, 'proj-a'), '示例甲')
    const openedA = await session.switchProject(storeA)
    assert.ok(openedA)

    const previewDirA = await mkdtemp(path.join(tempRoot, 'manju-preview-'))
    const previewFileA = path.join(previewDirA, 'preview.mp4')
    await writeFile(previewFileA, 'preview')
    const previewIdA = await session.setPreview(previewDirA, previewFileA)
    assert.ok(previewIdA)

    const cacheDirA = await session.ensureShotCache()
    assert.equal(await session.ensureShotCache(), cacheDirA)
    assert.equal(await exists(previewDirA), true)
    assert.equal(await exists(cacheDirA), true)

    const storeB = fakeStore(path.join(tempRoot, 'proj-b'), '示例乙')
    const openedB = await session.switchProject(storeB)
    assert.ok(openedB)
    assert.notEqual(openedB.mediaKey, openedA.mediaKey)
    assert.equal(session.preview, null)
    assert.equal(session.shotCacheDir, null)
    assert.equal(await exists(previewDirA), false)
    assert.equal(await exists(cacheDirA), false)
    assert.deepEqual(remembered.map(item => item.title), ['示例甲', '示例甲', '示例乙'])

    const cacheDirB = await session.ensureShotCache()
    assert.equal(await exists(cacheDirB), true)
    await session.switchProject(null)
    assert.equal(session.current, null)
    assert.equal(await exists(cacheDirB), false)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('WorkbenchSession.cancelRender / cancelPlanGeneration / abortActiveWork / dispose 行为正确', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'manju-session-abort-'))
  try {
    const session = new WorkbenchSession({ tempRoot })
    assert.equal(session.cancelRender(), false)

    const renderJob = { controller: new AbortController(), publishing: true }
    session.job = renderJob
    assert.equal(session.cancelRender(), false)
    assert.equal(renderJob.controller.signal.aborted, false)

    renderJob.publishing = false
    assert.equal(session.cancelRender(), true)
    assert.equal(renderJob.controller.signal.aborted, true)

    const planController = new AbortController()
    session.planGeneration = { key: 'k1', controller: planController }
    assert.equal(session.cancelPlanGeneration('wrong'), false)
    assert.equal(planController.signal.aborted, false)
    assert.equal(session.cancelPlanGeneration('k1'), true)
    assert.equal(planController.signal.aborted, true)

    const nextPlan = { key: 'k2', controller: new AbortController() }
    const nextJob = { controller: new AbortController(), publishing: false }
    session.planGeneration = nextPlan
    session.job = nextJob
    const previewDir = await mkdtemp(path.join(tempRoot, 'manju-preview-'))
    await session.setPreview(previewDir, path.join(previewDir, 'preview.mp4'))
    const cacheDir = await session.ensureShotCache()

    let finishOp
    const pendingOp = session.serial(() => new Promise(resolve => { finishOp = resolve }))
    assert.equal(session.canAcceptIpc(), true)

    const disposing = session.dispose()
    assert.equal(session.quitting, true)
    assert.equal(session.canAcceptIpc(), false)
    assert.equal(nextPlan.controller.signal.aborted, true)
    assert.equal(nextJob.controller.signal.aborted, true)
    assert.equal(await exists(cacheDir), true)

    finishOp('done')
    await pendingOp
    await disposing
    assert.equal(await exists(previewDir), false)
    assert.equal(await exists(cacheDir), false)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('themeBackground 与 resolveInitialBounds 覆盖正常恢复、副屏断开回退与超出尺寸裁剪', () => {
  assert.equal(themeBackground('dark'), '#181622')
  assert.equal(themeBackground('light'), '#f3f2f7')
  assert.equal(themeBackground(undefined), '#f3f2f7')

  const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  const secondary = { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }

  const restored = resolveInitialBounds(
    { width: 1400, height: 900, x: 2100, y: 80, maximized: true },
    [primary, secondary],
  )
  assert.deepEqual(restored, { width: 1400, height: 900, x: 2100, y: 80, maximized: true })

  const unpluggedFallback = resolveInitialBounds(
    { width: 1200, height: 800, x: 2200, y: 120, maximized: false },
    [primary],
  )
  assert.deepEqual(unpluggedFallback, { width: 1200, height: 800, x: 360, y: 120, maximized: false })

  const smallLaptop = { workArea: { x: 0, y: 0, width: 1280, height: 720 } }
  const clampedVisible = resolveInitialBounds(
    { width: 2560, height: 1440, x: 20, y: 10, maximized: false },
    [smallLaptop],
  )
  assert.deepEqual(clampedVisible, { width: 1280, height: 720, x: 20, y: 10, maximized: false })

  const clampedFallback = resolveInitialBounds(
    { width: 2560, height: 1440, x: 3000, y: 100 },
    [{ workArea: { x: 100, y: 40, width: 1200, height: 700 } }],
  )
  assert.deepEqual(clampedFallback, { width: 1200, height: 700, x: 100, y: 40, maximized: false })
})

test('cleanupStaleTempDirs 清理超时前缀目录并保留新目录与 manju-update-*', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manju-cleanup-test-'))
  try {
    const now = Date.now()
    const staleDate = new Date(now - staleTempAgeMs - 60_000)
    const freshDate = new Date(now - 60_000)

    const stalePreview = path.join(root, 'manju-preview-old')
    const staleCache = path.join(root, 'manju-shot-cache-old')
    const freshRender = path.join(root, 'manju-render-work-new')
    const staleUpdate = path.join(root, 'manju-update-installer')
    const staleOther = path.join(root, 'unrelated-old-dir')
    const staleFile = path.join(root, 'manju-preview-file')

    for (const dir of [stalePreview, staleCache, freshRender, staleUpdate, staleOther]) {
      await mkdir(dir)
    }
    await writeFile(staleFile, 'keep-file')

    await utimes(stalePreview, staleDate, staleDate)
    await utimes(staleCache, staleDate, staleDate)
    await utimes(freshRender, freshDate, freshDate)
    await utimes(staleUpdate, staleDate, staleDate)
    await utimes(staleOther, staleDate, staleDate)
    await utimes(staleFile, staleDate, staleDate)

    const removed = await cleanupStaleTempDirs(root, staleTempPrefixes, staleTempAgeMs, now)
    assert.deepEqual(removed.sort(), [stalePreview, staleCache].sort())

    assert.equal(await exists(stalePreview), false)
    assert.equal(await exists(staleCache), false)
    assert.equal(await exists(freshRender), true)
    assert.equal(await exists(staleUpdate), true)
    assert.equal(await exists(staleOther), true)
    assert.equal(await exists(staleFile), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
