import type { CSSProperties, ReactNode } from 'react'
import type { Episode, Shot } from '../shared/model'
import type { productionProgress, StepId, StepStatus } from '../shared/production'
import { kindLabel, sequence } from './components'

const statusLabels: Record<StepStatus, string> = {
  complete: '已完成', partial: '部分完成', incomplete: '待完成', stale: '已过期',
}
const stepAsset = { ...kindLabel, finished: '成片', code: '任务书' }

export function isShotStep(step: StepId): step is keyof typeof stepAsset {
  return step in stepAsset
}

export function ProductionGuide({ progress, step, episode, shot, busy, onStep, onShot, children }: {
  progress: ReturnType<typeof productionProgress>; step: StepId; episode?: Episode; shot?: Shot; busy: boolean;
  onStep: (step: StepId) => void; onShot: (id: string) => void; children: ReactNode;
}) {
  const media = isShotStep(step) ? progress.media[step] : undefined
  const label = isShotStep(step) ? stepAsset[step] : ''
  const omittedLabel = step === 'audio' ? '静默' : '已跳过'
  let details: string[] = []
  if (step === 'script' && progress.statuses.script !== 'complete') {
    details = [episode ? '缺作品或集数剧本' : '缺作品剧本']
  } else if (step === 'references') {
    details = progress.missingReferences.map(category => category === 'characters' ? '缺角色参考' : '缺场景参考')
  } else if (step === 'shots' || step === 'export' || media) {
    if (!episode) details = ['缺集数']
    else if (!episode.shots.length) details = ['缺镜头']
    else if (media) {
      if (media.missing) details.push(`缺${label} ${media.missing} 镜`)
      if (media.ready) details.push(`已有${label} ${media.ready} 镜`)
      if (media.stale) details.push(`${label}需更新 ${media.stale} 镜`)
      if (media.omitted) details.push(`${omittedLabel} ${media.omitted} 镜`)
      if (step === 'audio' && progress.dialogueCount) details.push(`有台词 ${progress.dialogueCount} 镜`)
    }
  }
  if (step === 'export') {
    if (progress.statuses.export === 'stale') details.push('需重新导出')
    else if (episode?.shots.length && progress.statuses.export === 'incomplete') details.push('未导出')
  }

  return <section className="production-guide" aria-labelledby="production-title">
    <div className="guide-head"><h2 id="production-title">制作步骤</h2>
      {episode && <span className="guide-episode" title={episode.title}>{episode.title}</span>}
      <span className="guide-total">{Object.values(progress.statuses).filter(status => status === 'complete').length} / {progress.steps.length}</span>
    </div>
    <nav aria-label="制作步骤" className="guide-steps" style={{ '--step-count': progress.steps.length } as CSSProperties}>
      {progress.steps.map(({ id, label }) => {
        const status = progress.statuses[id] ?? 'incomplete'
        return <button key={id} type="button" data-step={id} aria-pressed={step === id} disabled={busy} onClick={() => onStep(id)}>
          <span className="guide-label">{label}</span>
          <span className="guide-badges">
            <span className={`badge guide-status ${status}`}>{id === 'code' && status === 'stale' ? '需更新' : statusLabels[status]}</span>
            {progress.recommended === id && <span className="badge guide-next">建议下一步</span>}
          </span>
        </button>
      })}
    </nav>
    <div className="guide-detail" aria-label="步骤操作">
      {!!details.length && <ul className="guide-details" aria-label="步骤状态">{details.map(detail => <li key={detail}>{detail}</li>)}</ul>}
      {!!media?.items.length && shot && <label className="guide-shot">镜头<select value={shot.id} disabled={busy}
        onChange={event => onShot(event.target.value)}>
        {media.items.map(item => <option key={item.id} value={item.id}>
          {sequence(item.index)} {item.title} · {item.state === 'omitted' ? omittedLabel
            : item.state === 'stale' ? `${label}需更新` : item.state === 'ready' ? `已有${label}` : `缺${label}`}
        </option>)}
      </select></label>}
      <div className="guide-actions">{children}</div>
    </div>
  </section>
}
