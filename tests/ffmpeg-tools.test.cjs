const assert = require('node:assert/strict')
const { chmod, mkdir, mkdtemp, open, realpath, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { test } = require('node:test')
const { FfmpegTools, runExecutable } = require('../dist/main/process')
const { RecentProjects } = require('../dist/main/recent-projects')

const filename = name => process.platform === 'win32' ? name + '.exe' : name

test('FFmpeg 使用绝对 PATH 或已选目录，检测双工具版本并拒绝旧版和变更文件', async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'FFmpeg 测试-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const system = path.join(root, '环境 PATH')
  const selected = path.join(root, '配置 工具')
  await mkdir(system)
  await mkdir(selected)
  const fixture = async (directory, name) => {
    const file = path.join(directory, filename(name))
    await writeFile(file, '虚构占位文件，测试注入进程调用')
    await chmod(file, 0o700)
    return realpath(file)
  }
  const systemFfmpeg = await fixture(system, 'ffmpeg')
  const systemFfprobe = await fixture(system, 'ffprobe')
  const selectedFfmpeg = await fixture(selected, 'ffmpeg')
  const selectedFfprobe = path.join(await realpath(selected), filename('ffprobe'))
  const versions = new Map([[systemFfmpeg, 'n7.1.3'], [systemFfprobe, '8.0-full_build'], [selectedFfmpeg, '7.0.2']])
  const calls = []
  const tools = new FfmpegTools(() => ['.', system].join(path.delimiter), async (file, name, args) => {
    calls.push({ file, name, args })
    assert.equal(path.isAbsolute(file), true)
    if (args[0] === '-version') {
      if (!versions.has(file)) throw new Error('模拟不可执行')
      return `${name} version ${versions.get(file)} Copyright FFmpeg\n`
    }
    return '虚构检测输出'
  })
  const statuses = async () => (await tools.refresh()).tools.map(tool => [tool.name, tool.status, tool.version])
  assert.deepEqual(await statuses(), [['ffmpeg', 'ready', 'n7.1.3'], ['ffprobe', 'ready', '8.0-full_build']])
  const args = ['-i', '中文 文件 & 名称.wav']
  assert.equal(await tools.run('ffmpeg', args), '虚构检测输出')
  assert.deepEqual(calls.at(-1), { file: systemFfmpeg, name: 'ffmpeg', args })

  assert.throws(() => tools.configure('relative'), /目录无效/)
  tools.configure(selected)
  assert.deepEqual(await statuses(), [['ffmpeg', 'outdated', '7.0.2'], ['ffprobe', 'missing', undefined]])
  await assert.rejects(tools.run('ffmpeg', args), /7.1 或更高/)
  await fixture(selected, 'ffprobe')
  versions.set(selectedFfmpeg, '7.1.2-vendor')
  assert.deepEqual(await statuses(), [['ffmpeg', 'ready', '7.1.2-vendor'], ['ffprobe', 'unavailable', undefined]])
  await assert.rejects(tools.requireReady(), /ffprobe.*无法运行/)
  versions.set(selectedFfprobe, 'N-101010-g123')
  assert.deepEqual(await statuses(), [['ffmpeg', 'ready', '7.1.2-vendor'], ['ffprobe', 'unknown-version', 'N-101010-g123']])
  versions.set(selectedFfprobe, '7.1')
  assert.deepEqual((await statuses()).map(item => item[1]), ['ready', 'ready'])
  await tools.requireReady()
  await writeFile(selectedFfmpeg, '模拟工具文件发生变化')
  await assert.rejects(tools.run('ffmpeg', args), /已变化/)
  assert.equal(calls.at(-1).args[0], '-version')
  tools.configure(null)
  assert.equal((await tools.refresh()).directory, null)

  const preferences = await RecentProjects.open(root)
  await preferences.setFfmpegDirectory(selected)
  assert.equal((await RecentProjects.open(root)).ffmpegDirectory, selected)
  await preferences.setFfmpegDirectory(null)
  assert.equal((await RecentProjects.open(root)).ffmpegDirectory, null)
})

test('FFmpeg 版本校验放行 gyan.dev 正式版并拦截预发布版本', async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'FFmpeg 版本-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const fixture = async name => {
    const file = path.join(root, filename(name))
    await writeFile(file, '虚构占位文件')
    await chmod(file, 0o700)
    return realpath(file)
  }
  const ffmpeg = await fixture('ffmpeg')
  const ffprobe = await fixture('ffprobe')
  const versions = new Map([
    [ffmpeg, '9.0.1-full_build-www.gyan.dev'],
    [ffprobe, '8.0.1-essentials_build-www.gyan.dev'],
  ])
  const tools = new FfmpegTools(() => '', async (file, name, args) => {
    assert.equal(args[0], '-version')
    return `${name} version ${versions.get(file)} Copyright FFmpeg\n`
  })
  tools.configure(root)
  assert.deepEqual(
    (await tools.refresh()).tools.map(tool => [tool.name, tool.status, tool.version]),
    [
      ['ffmpeg', 'ready', '9.0.1-full_build-www.gyan.dev'],
      ['ffprobe', 'ready', '8.0.1-essentials_build-www.gyan.dev'],
    ],
  )
  await tools.requireReady()

  for (const prerelease of ['7.1-dev', 'N-12345-g1a2b3c-dev', '8.0-rc1', '8.0_beta2', '7.1.0-alpha.1']) {
    versions.set(ffmpeg, prerelease)
    const [ffmpegStatus] = (await tools.refresh()).tools
    assert.equal(ffmpegStatus.status, 'unknown-version', prerelease)
  }

  versions.set(ffmpeg, '7.0.2-full_build-www.gyan.dev')
  const [outdatedStatus] = (await tools.refresh()).tools
  assert.equal(outdatedStatus.status, 'outdated')
})

test('runExecutable 取消或子进程退出时等待输入管道关闭句柄后再结算', async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'FFmpeg 管道-'))
  context.after(() => rm(root, { recursive: true, force: true }))

  for (const mode of ['abort', 'early-exit']) {
    const workDir = path.join(root, mode)
    await mkdir(workDir)
    const openedFile = path.join(workDir, 'voice.pcm')
    await writeFile(openedFile, '虚构音轨数据')

    const controller = new AbortController()
    let handleClosed = false
    const firstChunkSent = Promise.withResolvers()

    async function* fakeMixedTracks() {
      const handle = await open(openedFile, 'r')
      try {
        yield Buffer.from('chunk-1\n')
        firstChunkSent.resolve()
        for (let i = 0; i < 500; i++) {
          await new Promise(resolve => setTimeout(resolve, 10))
          yield Buffer.from('chunk\n')
        }
      } finally {
        await new Promise(resolve => setTimeout(resolve, 60))
        await handle.close()
        handleClosed = true
      }
    }

    const script = mode === 'abort'
      ? 'process.stdin.resume(); setTimeout(() => {}, 5000)'
      : 'process.stdin.once("data", () => process.exit(1))'
    const execution = runExecutable(process.execPath, 'ffmpeg', ['-e', script], {
      input: Readable.from(fakeMixedTracks()),
      signal: controller.signal,
    })

    if (mode === 'abort') {
      await firstChunkSent.promise
      controller.abort()
      await assert.rejects(execution, { name: 'AbortError' })
    } else {
      await assert.rejects(execution, /ffmpeg 执行失败/)
    }

    assert.equal(handleClosed, true)
    await rm(workDir, { recursive: true, force: true })
  }
})
