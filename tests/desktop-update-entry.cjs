const path = require('node:path')
const { app } = require('electron')
const { Updater } = require('../dist/main/updater')
const { loopbackRequest } = require('./update-fixture.cjs')

const origin = process.env.MANJU_UPDATE_FIXTURE_ORIGIN
const temp = process.env.MANJU_UPDATE_FIXTURE_TEMP
if (!origin || new URL(origin).hostname !== '127.0.0.1' || !path.isAbsolute(temp ?? '')) {
  throw new Error('桌面更新验收需要本地 HTTP 夹具和绝对临时目录')
}

app.setAppPath(path.resolve(__dirname, '..'))
globalThis.updateLaunches = []
globalThis.updateTarget = {
  kind: 'setup', directory: 'D:\\工具 与 漫剧\\安装 目录', identity: 'local.manju.workbench',
}
require('../dist/main/update-system').createProductionUpdater = () => new Updater({
  version: require('../package.json').version,
  temp,
  target: async () => globalThis.updateTarget,
  request: (url, init) => loopbackRequest(origin, url, init),
  launch: async file => {
    globalThis.updateLaunches.push(file)
    throw new Error('桌面夹具禁止启动 Windows 安装程序')
  },
})
require('../dist/main/main')
