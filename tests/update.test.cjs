const assert = require('node:assert/strict')
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { Updater } = require('../dist/main/updater')
const { releasesPath, notes, sha256, executableFixture, releaseFixture, loopbackRequest, atUrl, startUpdateFixture } = require('./update-fixture.cjs')

const version = require('../package.json').version
const zip = Buffer.from('UEsDBBQAAAAAAOCDcl3uQOUFBwAAAAcAAAALAAAAZXhhbXBsZS50eHRmaXh0dXJlUEsBAhQDFAAAAAAA4INyXe5A5QUHAAAABwAAAAsAAAAAAAAAAAAAAIABAAAAAGV4YW1wbGUudHh0UEsFBgAAAAABAAEAOQAAADAAAAAAAA==', 'base64')

async function service(t, { fixture = releaseFixture(), releases = [fixture.release], kind = 'setup', request } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'manju-update-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const urls = []
  const launched = []
  const updater = new Updater({
    version, temp, kind: async () => kind, launch: async file => { launched.push(file) },
    request: async (url, init) => {
      urls.push(url.href)
      assert.equal(init.redirect, 'manual')
      assert.equal(init.credentials, 'omit')
      if (request) return atUrl(await request(url, init), url)
      if (url.pathname === releasesPath) return atUrl(Response.json(releases), url)
      const bytes = fixture.paths[url.pathname]
      return atUrl(bytes ? new Response(bytes) : new Response(null, { status: 404 }), url)
    },
  })
  return { updater, temp, urls, launched }
}

test('只在请求检查时联网，无正式 Release 时显示暂无发布且不能下载或安装', async t => {
  const { updater, urls, launched } = await service(t, { releases: [] })
  assert.deepEqual(urls, [])
  assert.deepEqual(await updater.check(), { currentVersion: version, status: 'none' })
  assert.deepEqual(urls, ['https://api.github.com/repos/xjb1337/manju-workbench/releases?per_page=100&page=1'])
  assert.throws(() => updater.download(() => {}), /没有可下载/)
  await assert.rejects(updater.install(async () => true), /没有已校验/)
  assert.deepEqual(launched, [])
})

test('当前版本与正式发布相同或更高时显示已是最新版本', async t => {
  for (const released of [version, '0.99.99']) {
    const { updater } = await service(t, { fixture: releaseFixture({ version: released }) })
    assert.deepEqual(await updater.check(), { currentVersion: version, status: 'latest', version: released, notes })
    assert.throws(() => updater.download(() => {}), /没有可下载/)
  }
})

test('按数字比较版本，忽略 draft 和 prerelease 并显示正式发布的原文', async t => {
  const first = releaseFixture({ version: '1.9.0' })
  const highest = releaseFixture({ version: '1.10.0' })
  const ignored = [{ ...first.release, tag_name: 'v3.0.0', draft: true },
    { ...first.release, tag_name: 'v4.0.0-beta.1', prerelease: true }]
  const empty = await service(t, { releases: ignored })
  assert.equal((await empty.updater.check()).status, 'none')
  const { updater } = await service(t, { releases: [...ignored, first.release, highest.release] })
  assert.deepEqual(await updater.check(), {
    currentVersion: version, status: 'available', version: '1.10.0', notes, kind: 'setup', unavailable: undefined,
  })
})

test('正式发布可以出现在后续分页', async t => {
  const fixture = releaseFixture()
  const { updater, urls } = await service(t, { request: async url => Response.json(url.searchParams.get('page') === '1'
    ? Array.from({ length: 100 }, () => ({ ...fixture.release, prerelease: true })) : [fixture.release]) })
  assert.equal((await updater.check()).version, '1.2.0')
  assert.equal(urls.length, 2)
})

test('缺清单或缺匹配包的新版本仍显示版本和说明，但禁止下载', async t => {
  const fixture = releaseFixture()
  const { updater: missing } = await service(t, { releases: [{ ...fixture.release, assets: [] }] })
  assert.equal((await missing.check()).unavailable, '此版本缺少更新清单')
  assert.throws(() => missing.download(() => {}), /没有可下载/)
  const { updater } = await service(t, { fixture, kind: 'portable' })
  assert.equal((await updater.check()).unavailable, '此版本缺少便携包')
  assert.throws(() => updater.download(() => {}), /没有可下载/)
})

test('下载中取消后清理不完整文件，不能安装，可以重新下载', async t => {
  const fixture = releaseFixture()
  const server = await startUpdateFixture()
  t.after(() => server.close())
  Object.assign(server.state, { releases: [fixture.release], paths: fixture.paths, stalledPath: fixture.assetPath })
  const { updater, temp, launched } = await service(t, { request: (url, init) => loopbackRequest(server.origin, url, init) })
  await updater.check()
  const canceled = await updater.download(({ received, total }) => {
    assert.ok(received > 0 && received < total)
    assert.equal(updater.cancel(), true)
  })
  assert.deepEqual(canceled, { status: 'canceled' })
  assert.deepEqual(await readdir(temp), [])
  await assert.rejects(updater.install(async () => true), /没有已校验/)
  assert.deepEqual(launched, [])
  server.state.stalledPath = ''
  assert.equal((await updater.download(() => {})).status, 'ready')
})

test('生产校验始终执行，校验错误不发布文件、不改变当前版本且不能安装', async t => {
  const bytes = executableFixture()
  for (const [label, fixture, error] of [
    ['SHA-256', releaseFixture({ digest: '0'.repeat(64) }), /SHA-256 校验失败/],
    ['远端摘要交叉校验', releaseFixture({ githubDigest: '0'.repeat(64) }), /SHA-256 与 GitHub/],
    ['下载文件太短', releaseFixture({ sent: bytes.subarray(0, -1) }), /大小校验失败/],
    ['下载文件太长', releaseFixture({ sent: Buffer.concat([bytes, bytes]) }), /大小校验失败/],
    ['清单大小不匹配', releaseFixture({ manifestSize: bytes.length + 1 }), /大小与 GitHub/],
    ['ZIP 冒充 EXE', releaseFixture({ bytes: zip }), /文件类型校验失败/],
    ['清单类型不匹配', releaseFixture({ manifestKind: 'portable' }), /文件名或包类型无效/],
    ['路径穿越', releaseFixture({ manifestFileName: '../Setup.exe' }), /文件名或包类型无效/],
    ['清单版本不匹配', releaseFixture({ manifestVersion: '2.0.0' }), /清单格式或版本无效/],
  ]) {
    await t.test(label, async sub => {
      const { updater, temp, urls, launched } = await service(sub, { fixture })
      assert.equal((await updater.check()).currentVersion, version)
      // Arbitrary caller properties and arguments cannot disable validation.
      Object.assign(updater, { skipHash: true })
      await assert.rejects(updater.download(() => {}, { skipHash: true }), error)
      await assert.rejects(updater.install(async () => true), /没有已校验/)
      assert.deepEqual(launched, [])
      assert.deepEqual(await readdir(temp), [])
      assert.equal((await updater.check()).currentVersion, version)
      assert.ok(urls.every(url => url.startsWith('https://')))
    })
  }
})

test('离线时显示明确网络错误，HTTP 错误和暂无发布有区别', async t => {
  const { updater } = await service(t, { request: async () => { throw new TypeError('fetch failed') } })
  await assert.rejects(updater.check(), /网络连接失败/)
  const blocked = await service(t, { request: async () => new Response(null, { status: 403 }) })
  await assert.rejects(blocked.updater.check(), /HTTP 403/)
})

test('拒绝未授权重定向、跳到同主机其他仓库和运输层自动跟随', async t => {
  const fixture = releaseFixture()
  for (const location of [
    'https://example.invalid/file', 'http://objects.githubusercontent.com/file',
    'https://objects.githubusercontent.com.evil.invalid/file', 'https://objects.githubusercontent.com:444/file',
    'https://github.com/someone/else/releases/download/v1/setup.exe',
  ]) {
    const { updater, urls, temp, launched } = await service(t, { request: async url => {
      if (url.pathname === releasesPath) return Response.json([fixture.release])
      return new Response(null, { status: 302, headers: { location } })
    } })
    await updater.check()
    await assert.rejects(updater.download(() => {}), /重定向到不受信任/)
    assert.equal(urls.length, 2)
    assert.deepEqual(await readdir(temp), [])
    assert.deepEqual(launched, [])
  }
  const { updater } = await service(t, { request: async () => {
    const response = Response.json([])
    Object.defineProperty(response, 'url', { value: 'https://example.invalid/' })
    return response
  } })
  await assert.rejects(updater.check(), /未经校验的地址/)
})

test('拒绝看似可信但属于不同仓库的原始附件 URL', async t => {
  const fixture = releaseFixture()
  fixture.release.assets[1].browser_download_url = fixture.release.assets[1].browser_download_url.replace('xjb1337', 'another-user')
  const { updater } = await service(t, { fixture })
  await assert.rejects(updater.check(), /不属于指定 GitHub 仓库/)
})

test('GitHub 官方 CDN 重定向通过，明确确认后才启动本地绝对路径', async t => {
  const bytes = Buffer.concat([executableFixture(), Buffer.alloc(256 * 1024, 42)])
  const fixture = releaseFixture({ bytes })
  const { updater, temp, launched } = await service(t, { fixture, request: async url => {
    if (url.pathname === releasesPath) return Response.json([fixture.release])
    if (url.pathname === fixture.assetPath && url.hostname === 'github.com') {
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/test?token=fixture' } })
    }
    if (url.hostname === 'release-assets.githubusercontent.com') {
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(bytes.subarray(0, 512))
          stream.enqueue(bytes.subarray(512))
          stream.close()
        },
      }))
    }
    return new Response(fixture.paths[url.pathname])
  } })
  await updater.check()
  assert.deepEqual(await updater.download(() => {}), { status: 'ready', fileName: fixture.fileName })
  assert.deepEqual(launched, [])
  assert.equal(await updater.install(async () => false), false)
  assert.deepEqual(launched, [])
  const [directory] = await readdir(temp)
  assert.deepEqual(await readdir(path.join(temp, directory)), [fixture.fileName])
  assert.equal(await updater.install(async () => true), true)
  assert.deepEqual(launched, [path.join(temp, directory, fixture.fileName)])
})

test('安装确认后重新校验，下载后的篡改阻止执行', async t => {
  const fixture = releaseFixture()
  const { updater, temp, launched } = await service(t, { fixture })
  await updater.check()
  await updater.download(() => {})
  const [directory] = await readdir(temp)
  const file = path.join(temp, directory, fixture.fileName)
  await assert.rejects(updater.install(async () => {
    const bytes = await readFile(file)
    bytes[bytes.length - 1] = 1
    await writeFile(file, bytes)
    return true
  }), /SHA-256 校验失败/)
  assert.deepEqual(launched, [])
  assert.deepEqual(await readdir(temp), [])
})

test('便携 EXE 和 ZIP 均可校验和打开目录，均不可启动安装器', async t => {
  for (const fixture of [releaseFixture({ kind: 'portable' }),
    releaseFixture({ kind: 'portable', fileName: 'Manju-Workbench-1.2.0-x64-Portable.zip', bytes: zip })]) {
    const { updater, launched } = await service(t, { fixture, kind: 'portable' })
    assert.equal((await updater.check()).kind, 'portable')
    await updater.download(() => {})
    await assert.rejects(updater.install(async () => { assert.fail('portable confirmation') }), /没有已校验的安装包/)
    let file
    await updater.openPortable(async directory => { file = path.join(directory, fixture.fileName) })
    await updater.check()
    await updater.dispose()
    assert.equal(sha256(await readFile(file)), sha256(fixture.bytes))
    assert.deepEqual(launched, [])
  }
})
