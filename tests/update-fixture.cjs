const { createHash } = require('node:crypto')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { version: currentVersion } = require('../package.json')

const releasesPath = '/repos/xjb1337/manju-workbench/releases'
const notes = '虚构验收发布\n改善示例镜头导出。\n<strong>这段标记按纯文本显示</strong>'
const [major, minor, patch] = currentVersion.split('.').map(Number)
const futureVersion = `${major}.${minor}.${patch + 1}`
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function executableFixture() {
  // A PE header for type checks. The fixture contains no executable code.
  const bytes = Buffer.alloc(512)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 60)
  bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(0x14c, 68)
  bytes.writeUInt16LE(1, 70)
  bytes.writeUInt16LE(224, 84)
  bytes.writeUInt16LE(2, 86)
  bytes.writeUInt16LE(0x10b, 88)
  return bytes
}

function releaseFixture({ version = futureVersion, kind = 'setup', fileName, bytes = executableFixture(),
  size = bytes.length, digest = sha256(bytes), sent = bytes, manifestVersion = version,
  manifestFileName, manifestKind = kind, manifestSize = size, githubDigest } = {}) {
  const tag = `v${version}`
  const base = `Manju-Workbench-${version}`
  const manifestName = `${base}-win-x64.manifest.json`
  const name = fileName ?? `${base}-x64-${kind === 'setup' ? 'Setup' : 'Portable'}.exe`
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, version: manifestVersion,
    assets: [{ fileName: manifestFileName ?? name, size: manifestSize, sha256: digest, kind: manifestKind }] }))
  const asset = (name, size) => ({
    name, size, state: 'uploaded', browser_download_url: `https://github.com/xjb1337/manju-workbench/releases/download/${tag}/${name}`,
  })
  const installer = asset(name, size)
  if (githubDigest) installer.digest = `sha256:${githubDigest}`
  const manifestAsset = { ...asset(manifestName, manifest.length), digest: `sha256:${sha256(manifest)}` }
  const paths = Object.fromEntries([[manifestAsset, manifest], [installer, sent]].map(
    ([file, data]) => [new URL(file.browser_download_url).pathname, data]))
  const release = { tag_name: tag, draft: false, prerelease: false, body: notes, assets: [manifestAsset, installer] }
  return { release, paths, assetPath: new URL(installer.browser_download_url).pathname, fileName: name, bytes }
}

// Map only the transport to loopback. Updater still receives and validates the
// GitHub URLs and redirect targets before any request reaches this adapter.
async function loopbackRequest(origin, url, init) {
  const response = await fetch(new URL(url.pathname + url.search, origin), init)
  return atUrl(new Response(response.body, { status: response.status, headers: response.headers }), url)
}

function atUrl(response, url) {
  if (!response.url) Object.defineProperty(response, 'url', { value: url.href })
  return response
}

async function startUpdateFixture() {
  const transfers = []
  const state = { releases: [], paths: {}, stalledPath: '', requests: [], releaseFailure: '' }
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost')
    state.requests.push(pathname)
    if (pathname === releasesPath) {
      if (state.releaseFailure === 'offline') return req.socket.destroy()
      if (state.releaseFailure) {
        res.statusCode = 403
        if (state.releaseFailure === 'rate-limited') res.setHeader('x-ratelimit-remaining', '0')
        return res.end('{}')
      }
      return res.end(JSON.stringify(state.releases))
    }
    const bytes = state.paths[pathname]
    if (!bytes) { res.statusCode = 404; return res.end() }
    if (pathname === state.stalledPath) {
      transfers.push(res)
      return res.write(bytes.subarray(0, 128))
    }
    res.end(bytes)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    state,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const res of transfers) res.destroy()
      const finished = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await finished
    },
  }
}

module.exports = { releasesPath, notes, futureVersion, sha256, executableFixture, releaseFixture, loopbackRequest, atUrl, startUpdateFixture }
