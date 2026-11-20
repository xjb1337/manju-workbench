const assert = require('node:assert/strict')
const { chmod, mkdir, mkdtemp, realpath, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { FfmpegTools } = require('../dist/main/process')
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
