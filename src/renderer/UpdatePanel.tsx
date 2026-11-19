import { useEffect, useState } from 'react'
import { ArrowsClockwise, WarningCircle } from '@phosphor-icons/react'
import type { Reply, UpdateCheck, UpdateProgress } from '../shared/api'
import { Modal } from './components'

const api = window.workbench

export function UpdatePanel({ busy, dirty }: { busy: boolean; dirty: boolean }) {
  const [visible, setVisible] = useState(false)
  const [check, setCheck] = useState<UpdateCheck | null>(null)
  const [pending, setPending] = useState<'check' | 'download' | 'install' | 'folder' | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [canceled, setCanceled] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [ready, setReady] = useState('')
  const [starting, setStarting] = useState(false)
  const [dirtyBlocked, setDirtyBlocked] = useState(false)
  const [error, setError] = useState('')
  const available = check?.status === 'available' ? check : null
  const percent = progress ? Math.floor(progress.received * 100 / progress.total) : 0

  useEffect(() => api.onUpdateProgress(setProgress), [])

  async function action<T>(phase: NonNullable<typeof pending>, invoke: () => Promise<Reply<T>>, accept: (value: T) => void) {
    setPending(phase)
    setError('')
    try {
      const reply = await invoke()
      if (reply.ok) accept(reply.value)
      else setError(reply.error)
    } catch {
      setError('桌面进程连接中断')
    } finally {
      setPending(null)
    }
  }

  function refresh() {
    setCheck(null)
    setReady('')
    setCanceled(false)
    setDirtyBlocked(false)
    void action('check', api.checkUpdate, setCheck)
  }

  async function cancel() {
    if (canceling) return
    setCanceling(true)
    try {
      const reply = await api.cancelUpdate()
      if (!reply.ok) setError(reply.error)
    } catch {
      setError('桌面进程连接中断')
    } finally {
      setCanceling(false)
    }
  }

  function close() {
    if (pending === 'download') void cancel()
    else if (!starting && pending !== 'install' && pending !== 'folder') setVisible(false)
  }

  function download() {
    setProgress(null)
    setCanceled(false)
    void action('download', api.downloadUpdate, result => {
      if (result.status === 'ready') setReady(result.fileName)
      else setCanceled(true)
    })
  }

  function install() {
    if (dirty) {
      setDirtyBlocked(true)
      return
    }
    void action('install', api.installUpdate, result => setStarting(result === 'started'))
  }

  return <>
    <button className="subtle update-entry" disabled={busy || !!pending || starting} onClick={() => {
      setVisible(true)
      setDirtyBlocked(false)
      if (!ready) refresh()
    }}><ArrowsClockwise aria-hidden="true" size={17} /> 检查更新</button>
    {visible && <Modal title="应用更新" onClose={close}>
      <div className="update-content">
        {check && <p className="update-version">当前版本 <strong>{check.currentVersion}</strong></p>}
        <p className="update-status" role="status">
          {pending === 'check' ? '正在检查更新…'
            : starting ? '已启动安装程序'
            : pending === 'install' ? '等待安装确认…'
            : check?.status === 'none' ? '暂无发布'
            : check?.status === 'latest' ? '已是最新版本'
            : available ? `发现新版本 ${available.version}` : ''}
        </p>
        {check && check.status !== 'none' && <section className="update-notes" aria-label="更新说明">
          <h3>更新说明{check.status === 'latest' && ` · ${check.version}`}</h3>
          <p tabIndex={check.notes ? 0 : undefined}>{check.notes || '暂无更新说明'}</p>
        </section>}
        {available && <>
          {available.kind && <p className="update-version">{available.kind === 'setup' ? '安装版 · Windows x64' : '便携版 · Windows x64'}</p>}
          <p className="update-risk"><WarningCircle aria-hidden="true" size={18} />
            <span>应用未签名。SHA-256 仅验证文件完整性，无法证明发布者身份。</span>
          </p>
          {available.unavailable && <p className="inline-error" role="alert">{available.unavailable}</p>}
        </>}
        {pending === 'download' && <>
          <p role="status">{canceling ? '正在取消…' : percent === 100 ? '正在校验更新包…' : '正在下载更新…'}</p>
          <div className="progress-line"><progress aria-label="下载进度" max={100} value={percent} /><span>{percent}%</span></div>
        </>}
        {canceled && <p role="status">已取消下载</p>}
        {ready && <p className="update-ready" role="status">已通过完整性校验 <strong>{ready}</strong></p>}
        {ready && available?.kind === 'portable' && <p>请打开便携包所在目录，自行打开或替换旧版本。</p>}
        {dirtyBlocked && <p className="inline-error" role="alert">请先保存修改，再安装更新。</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>
      <div className="dialog-actions update-actions">
        {pending === 'download' ? <button onClick={() => void cancel()} disabled={canceling}>取消下载</button> : <>
          <button onClick={close} autoFocus disabled={starting || pending === 'install' || pending === 'folder'}>{dirtyBlocked ? '返回保存' : '关闭'}</button>
          <button onClick={refresh} disabled={!!pending || starting}>重新检查</button>
          {available?.kind && <>
            <button className={ready ? undefined : 'primary'} onClick={download} disabled={!!pending || !!ready || !!available.unavailable}>下载</button>
            {available.kind === 'setup'
              ? <button className={ready ? 'primary' : undefined} onClick={install} disabled={!!pending || !ready || starting || dirtyBlocked}>安装</button>
              : <button className={ready ? 'primary' : undefined} disabled={!!pending || !ready}
                  onClick={() => void action('folder', api.openUpdateFolder, () => {})}>打开目录</button>}
          </>}
        </>}
      </div>
    </Modal>}
  </>
}
