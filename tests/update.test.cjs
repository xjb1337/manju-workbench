const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { Updater } = require('../dist/main/updater')
const { resolveUpdateTarget, setupLaunchOptions } = require('../dist/main/update-system')
const { openOfficialReleasePage } = require('../dist/main/update-release')
const { releasesPath, notes, futureVersion, sha256, executableFixture, releaseFixture, loopbackRequest, atUrl, startUpdateFixture } = require('./update-fixture.cjs')

const version = require('../package.json').version
const setupTarget = {
  kind: 'setup', directory: 'D:\\工具 与 漫剧\\安装 目录', identity: 'local.manju.workbench',
}
const zip = Buffer.from('UEsDBBQAAAAAAOCDcl3uQOUFBwAAAAcAAAALAAAAZXhhbXBsZS50eHRmaXh0dXJlUEsBAhQDFAAAAAAA4INyXe5A5QUHAAAABwAAAAsAAAAAAAAAAAAAAIABAAAAAGV4YW1wbGUudHh0UEsFBgAAAAABAAEAOQAAADAAAAAAAA==', 'base64')

async function service(t, { fixture = releaseFixture(), releases = [fixture.release], kind = 'setup', target = async () => kind === 'setup' ? setupTarget : { kind }, request } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'manju-update-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const urls = []
  const launched = []
  const updater = new Updater({
    version, temp, target, launch: async (file, target) => { launched.push({ file, target }) },
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
  const nextMajor = Number(version.split('.')[0]) + 1
  const highestVersion = `${nextMajor}.10.0`
  const first = releaseFixture({ version: `${nextMajor}.9.0` })
  const highest = releaseFixture({ version: highestVersion })
  const ignored = [{ ...first.release, tag_name: 'v3.0.0', draft: true },
    { ...first.release, tag_name: 'v4.0.0-beta.1', prerelease: true }]
  const empty = await service(t, { releases: ignored })
  assert.equal((await empty.updater.check()).status, 'none')
  const { updater } = await service(t, { releases: [...ignored, first.release, highest.release] })
  assert.deepEqual(await updater.check(), {
    currentVersion: version, status: 'available', version: highestVersion, notes, kind: 'setup', unavailable: undefined, directory: setupTarget.directory,
  })
})

test('正式发布可以出现在后续分页', async t => {
  const fixture = releaseFixture()
  const { updater, urls } = await service(t, { request: async url => Response.json(url.searchParams.get('page') === '1'
    ? Array.from({ length: 100 }, () => ({ ...fixture.release, prerelease: true })) : [fixture.release]) })
  assert.equal((await updater.check()).version, futureVersion)
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

test('离线、普通 HTTP 403、主限流和次级限流各自明确，备用路径不保留更新资格', async t => {
  const { updater } = await service(t, { request: async () => { throw new TypeError('fetch failed') } })
  assert.deepEqual(await updater.check(), { currentVersion: version, status: 'offline' })
  for (const [status, makeResponse] of [
    ['forbidden', () => new Response(null, { status: 403 })],
    ['rate-limited', () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })],
    ['rate-limited', () => Response.json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 })],
    ['rate-limited', () => new Response(null, { status: 429 })],
  ]) {
    const fixture = releaseFixture()
    let fail = false
    const { updater, launched, urls, temp } = await service(t, { request: async url => {
      if (url.pathname === releasesPath) return fail ? makeResponse() : Response.json([fixture.release])
      return new Response(fixture.paths[url.pathname])
    } })
    assert.equal((await updater.check()).status, 'available')
    assert.equal((await updater.download(() => {})).status, 'ready')
    fail = true
    assert.deepEqual(await updater.check(), { currentVersion: version, status })
    assert.throws(() => updater.download(() => {}), /没有可下载/)
    await assert.rejects(updater.install(async () => true), /没有已校验/)
    assert.deepEqual(launched, [])
    assert.deepEqual(await readdir(temp), [])
    assert.equal(urls.length, 4)
  }
  const opened = []
  await openOfficialReleasePage(async url => { opened.push(url) })
  assert.deepEqual(opened, ['https://github.com/xjb1337/manju-workbench/releases/latest'])
  await assert.rejects(openOfficialReleasePage(async () => { throw new Error('no default handler') }), /无法打开官方发布页/)
})

function checkWorkflowContexts(value, location = '') {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      checkWorkflowContexts(child, location ? `${location}.${key}` : key)
    }
  }
  if (typeof value !== 'string') return

  // https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#available-contexts
  const step = /^jobs\.[^.]+\.steps\.\d+\.(?:continue-on-error|if|name|run|timeout-minutes|working-directory|(?:env|with)\.[^.]+)$/.test(location)
  const output = /^jobs\.[^.]+\.(?:environment\.url|outputs\.[^.]+)$/.test(location)
  const containerEnv = /^jobs\.[^.]+\.(?:container|services\.[^.]+)\.env\.[^.]+$/.test(location)
  const available = {
    runner: step || output || containerEnv,
    job: step || output || containerEnv,
    steps: step || output,
    jobs: /^on\.workflow_call\.outputs\.[^.]+\.value$/.test(location),
    env: !/^jobs\.[^.]+\.env\./.test(location),
  }
  const expressions = Array.from(value.matchAll(/\$\{\{((?:'(?:[^']|'')*'|[^'}]|\}(?!\}))*?)\}\}/g), match => match[1])
  if (!expressions.length && /^jobs\.[^.]+\.(?:steps\.\d+\.)?if$/.test(location)) expressions.push(value)
  for (const expression of expressions) {
    // Skip string literals and property names, such as github.event.job.
    for (const [, name] of expression.matchAll(/'(?:[^']|'')*'|\.\s*[a-z_][\w-]*|([a-z_][\w-]*)/gi)) {
      const context = name?.toLowerCase()
      if (Object.hasOwn(available, context)) assert.ok(available[context], `${location} 不允许使用 ${context} 上下文`)
    }
  }
}

test('Windows workflow 仅手动打包且只上传四个精确命名的 Actions 附件', async () => {
  // Use the YAML parser already locked by the packaging tool.
  const { load } = createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml')
  const root = path.join(__dirname, '..')
  const yaml = load(await readFile(path.join(root, '.github/workflows/package-windows.yml'), 'utf8'))
  checkWorkflowContexts(yaml)
  assert.deepEqual(yaml.on, { workflow_dispatch: null })
  assert.deepEqual(yaml.permissions, { contents: 'read' })
  assert.deepEqual(Object.keys(yaml.jobs), ['package'])
  const job = yaml.jobs.package
  assert.equal(job['runs-on'], 'windows-latest')
  assert.equal(job.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
  assert.equal(job.permissions, undefined)
  assert.deepEqual(job.steps.flatMap(step => step.uses ? [step.uses.split('@')[0]] : []),
    ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'])
  assert.equal(job.steps[0].with['persist-credentials'], false)
  const portable = job.steps.find(step => step.run === 'npx.cmd --no-install electron-builder --win portable --x64 --publish never')
  const setup = job.steps.find(step => step.id === 'packages')
  const cache = '${{ runner.temp }}/manju-builder-cache'
  assert.equal(portable?.env?.ELECTRON_BUILDER_CACHE, cache)
  assert.equal(setup?.env?.ELECTRON_BUILDER_CACHE, cache)
  const packages = setup.run
  assert.match(packages, /Get-ChildItem -LiteralPath \$env:ELECTRON_BUILDER_CACHE -Filter makensis\.exe/)
  assert.match(packages, /\$compilers\.Count -ne 1/)
  assert.match(packages, /Get-Content package\.json -Raw/)
  assert.match(packages, /node scripts\/pack-native\.cjs \$compiler release\/win-unpacked \$setup/)
  assert.match(packages, /node scripts\/write-update-manifest\.cjs --sha256 \$setup \$portable/)
  const upload = job.steps.at(-1).with
  const output = 'Manju-Workbench-${{ steps.packages.outputs.version }}'
  const suffixes = ['x64-Setup.exe', 'x64-Portable.exe', 'win-x64.manifest.json', 'win-x64.sha256.txt']
  assert.equal(upload['if-no-files-found'], 'error')
  assert.deepEqual(upload.path.trim().split('\n'), suffixes.map(suffix => `release/${output}-${suffix}`))
  for (const suffix of suffixes) assert.ok(packages.includes(`"release/$prefix-${suffix}"`))
  const { build } = require('../package.json')
  assert.equal(build.win.signExecutable, false)
  assert.equal(build.portable.artifactName.replace('${version}', version).replace('${arch}', 'x64').replace('${ext}', 'exe'),
    `Manju-Workbench-${version}-${suffixes[1]}`)
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
  assert.equal(await updater.install(async target => {
    assert.equal(target, setupTarget.directory)
    return true
  }), true)
  assert.deepEqual(launched, [{ file: path.join(temp, directory, fixture.fileName), target: setupTarget }])
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
    releaseFixture({ kind: 'portable', fileName: `Manju-Workbench-${futureVersion}-x64-Portable.zip`, bytes: zip })]) {
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

function windowsInstall(directory, { registered = directory, identity = '', portable = false, installed = true, canonicalDir = directory } = {}) {
  const exe = candidate => path.win32.join(candidate, '漫剧工作台.exe')
  const uninstall = candidate => path.win32.join(candidate, 'Uninstall.exe')
  let registry = registered ? {
    directory: registered, identity, displayIcon: exe(registered), uninstallString: `"${uninstall(registered)}"`,
  } : null
  const files = new Set([exe(canonicalDir), ...(installed ? [uninstall(canonicalDir)] : [])])
  const actual = {
    platform: 'win32', arch: 'x64', packaged: true, exePath: exe(directory),
    env: portable ? { PORTABLE_EXECUTABLE_DIR: directory } : {},
  }
  const inspect = {
    canonical: async file => file === actual.exePath ? exe(canonicalDir) : file,
    isFile: async file => files.has(file),
    registry: async () => registry,
  }
  return { actual, inspect, files, setRegistry: value => { registry = value } }
}

test('Windows Setup：默认路径和中文空格目录绑定到正在运行的安装实例', async () => {
  for (const directory of ['C:\\Users\\User\\AppData\\Local\\Programs\\Manju Workbench', setupTarget.directory]) {
    for (const identity of ['', setupTarget.identity]) {
      const fixture = windowsInstall(directory, { identity })
      const target = await resolveUpdateTarget(fixture.actual, fixture.inspect)
      assert.deepEqual(target, { ...setupTarget, directory })
      const installer = 'C:\\Users\\User\\更新 缓存\\Manju-Workbench-' + futureVersion + '-x64-Setup.exe'
      const launch = setupLaunchOptions(installer, target)
      assert.deepEqual(launch.args, ['/MANJUUPDATE=local.manju.workbench', `/MANJUDIR="${directory}"`])
      assert.equal(launch.options.argv0, `"${installer}"`)
      assert.equal(launch.options.windowsVerbatimArguments, true)
      assert.equal(launch.options.shell, false)
      assert.equal(launch.options.cwd, path.win32.dirname(installer))
    }
  }
})

test('Windows Setup：注册表错位、缺失、身份不符或路径别名进入手动更新，便携模式隔离', async () => {
  const directory = setupTarget.directory
  for (const options of [
    { registered: 'C:\\Other Install' }, { registered: null }, { identity: 'different.install' },
    { canonicalDir: 'D:\\Real Install' }, { installed: false },
  ]) {
    const { actual, inspect } = windowsInstall(directory, options)
    assert.deepEqual(await resolveUpdateTarget(actual, inspect), { kind: 'manual' })
  }
  for (const options of [{ portable: true }, { registered: null, installed: false }]) {
    const { actual, inspect } = windowsInstall(directory, options)
    assert.deepEqual(await resolveUpdateTarget(actual, inspect), { kind: 'portable' })
  }
  const { actual, inspect } = windowsInstall(directory)
  assert.deepEqual(await resolveUpdateTarget({ ...actual, platform: 'linux' }, inspect), { kind: null })
  assert.deepEqual(await resolveUpdateTarget({ ...actual, packaged: false }, inspect), { kind: null })
  assert.throws(() => setupLaunchOptions('C:\\Updates\\Setup.exe', { ...setupTarget, directory: directory + '"' }), /手动更新/)
})

test('已下载的 Setup 在确认期间注册表变更时停止启动并切换手动更新', async t => {
  const fixture = windowsInstall(setupTarget.directory)
  const target = () => resolveUpdateTarget(fixture.actual, fixture.inspect)
  const { updater, launched, temp } = await service(t, { target })
  assert.equal((await updater.check()).directory, setupTarget.directory)
  await updater.download(() => {})
  await assert.rejects(updater.install(async directory => {
    assert.equal(directory, setupTarget.directory)
    fixture.setRegistry(null)
    return true
  }), /手动更新/)
  assert.deepEqual(launched, [])
  assert.deepEqual(await readdir(temp), [])
  const manual = await updater.check()
  assert.equal(manual.manual, true)
  assert.equal(manual.kind, null)
  assert.match(manual.unavailable, /手动更新/)
  assert.throws(() => updater.download(() => {}), /没有可下载/)
})
