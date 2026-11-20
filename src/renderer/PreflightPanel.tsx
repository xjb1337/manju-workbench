import type { PreflightIssue, PreflightReport } from '../shared/api'
import { kindLabel, Modal, sequence } from './components'

const issueLabels: Record<PreflightIssue['code'], string> = {
  'no-shots': '缺镜头',
  'missing-file': '素材文件不存在',
  unreadable: '素材无法读取',
  'missing-visual': '缺画面 · 黑底',
  black: '黑底',
  still: '静图回退',
  'no-voice': '缺配音',
  dense: '字幕过密',
  'subtitle-overflow': '镜头过短，无法显示全部字幕',
  stale: '素材需更新',
}

function issueLabel({ code, target }: PreflightIssue) {
  if (code === 'missing-file' || code === 'unreadable' || code === 'stale') {
    const media = target === 'music' ? '背景音乐' : target in kindLabel ? kindLabel[target as keyof typeof kindLabel] : ''
    return media ? `${media} · ${issueLabels[code]}` : issueLabels[code]
  }
  return issueLabels[code]
}

export function PreflightPanel({ report, onClose, onSelect, onExport }: {
  report: PreflightReport
  onClose: () => void
  onSelect: (issue: PreflightIssue) => void
  onExport: () => void
}) {
  const errors = report.issues.filter(issue => issue.severity === 'error')
  const warnings = report.issues.filter(issue => issue.severity === 'warning')
  return <Modal title="成片检查" onClose={onClose}>
    <div className="preflight">
      <h3>{report.title}</h3>
      {!report.issues.length && <p className="preflight-pass" role="status">检查通过</p>}
      {([['error', '阻断', errors], ['warning', '警告', warnings]] as const).map(([severity, label, issues]) =>
        issues.length > 0 && <section key={severity} aria-label={label} data-severity={severity}>
          <h4>{label} <span>{issues.length}</span></h4>
          <ul>{issues.map(issue => <li key={`${issue.shot?.id ?? 'episode'}/${issue.target}/${issue.code}`}>
            <button type="button" className="subtle" onClick={() => onSelect(issue)}>
              <span>{issue.shot ? `镜头 ${sequence(issue.shot.index)} · ${issue.shot.title}` : report.title}</span>
              <strong>{issueLabel(issue)}</strong>
            </button>
          </li>)}</ul>
        </section>)}
    </div>
    <div className="dialog-actions">
      <button autoFocus onClick={onClose}>关闭</button>
      {!errors.length && <button className="primary" onClick={onExport}>{warnings.length ? '继续导出' : '导出 MP4'}</button>}
    </div>
  </Modal>
}
