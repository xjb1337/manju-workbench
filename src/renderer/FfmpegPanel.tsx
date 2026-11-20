import { useEffect, useState } from 'react'
import type { FfmpegStatus, FfmpegToolStatus, Reply } from '../shared/api'
import { Modal } from './components'

const labels: Record<FfmpegToolStatus['status'], string> = {
  ready: '可用',
  missing: '未找到',
  outdated: '版本过低',
  'unknown-version': '无法识别版本',
  unavailable: '无法运行',
}
const api = window.workbench

export function FfmpegPanel({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState<FfmpegStatus>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

  async function request(action: () => Promise<Reply<FfmpegStatus | null>>) {
    setBusy(true)
    setError('')
    try {
      const response = await action()
      if (!response.ok) setError(response.error)
      else if (response.value) setResult(response.value)
    } catch {
      setError('桌面进程连接中断')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void request(api.detectFfmpeg) }, [])

  return <Modal title="FFmpeg 设置" onClose={() => { if (!busy) onClose() }}>
    <div className="ffmpeg-content">
      <p>需要 FFmpeg 7.1 或更高版本</p>
      {result && <>
        <p className="ffmpeg-directory">{result.directory ?? '系统 PATH'}</p>
        <ul aria-label="工具状态">{result.tools.map(tool => <li key={tool.name}>
          <strong>{tool.name}</strong>
          <span>{tool.version}</span>
          <span data-status={tool.status}>{labels[tool.status]}</span>
        </li>)}</ul>
      </>}
      {busy && <p role="status">正在检测…</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <div className="dialog-actions">
      <button autoFocus disabled={busy} onClick={onClose}>关闭</button>
      {result?.directory && <button disabled={busy} onClick={() => void request(api.useFfmpegPath)}>使用 PATH</button>}
      <button disabled={busy} onClick={() => void request(api.detectFfmpeg)}>重新检测</button>
      <button className="primary" disabled={busy} onClick={() => void request(api.chooseFfmpegDirectory)}>选择工具目录</button>
    </div>
  </Modal>
}
