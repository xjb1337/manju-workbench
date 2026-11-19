import { FilmSlate, FilmStrip, FolderOpen, Plus } from '@phosphor-icons/react'
import type { RecentProject } from '../shared/api'
import { Badge } from './components'

export function WelcomeView({ recent, busy, onCreate, onOpen, onOpenRecent }: {
  recent: RecentProject[]
  busy: boolean
  onCreate: (sample: boolean | 'vertical') => void
  onOpen: () => void
  onOpenRecent: (id: string) => void
}) {
  return <main className="welcome">
    <div className="welcome-card">
      <div className="welcome-mark"><FilmSlate size={49} weight="duotone" /></div>
      <h1>AI 视频制作工作台</h1>
      <div className="actions">
        <button className="primary" onClick={() => onCreate(false)} disabled={busy}><Plus size={19} /> 新建作品</button>
        <button onClick={onOpen} disabled={busy}><FolderOpen size={19} /> 打开作品</button>
      </div>
      <div className="sample-actions">
        <button className="sample-link subtle" onClick={() => onCreate(true)} disabled={busy}><FilmStrip size={17} /> 创建虚构示例</button>
        <button className="sample-link subtle" onClick={() => onCreate('vertical')} disabled={busy}><FilmStrip size={17} /> 创建竖屏代码示例</button>
      </div>
      {!!recent.length && <section className="recent-projects" aria-labelledby="recent-title">
        <h2 id="recent-title">最近作品</h2>
        <ul>{recent.map(item => <li key={item.id}>
          <button disabled={busy} onClick={() => onOpenRecent(item.id)}>
            <FolderOpen aria-hidden="true" size={19} />
            <span><strong>{item.title}</strong><small title={item.directory}>{item.directory}</small></span>
            {item.fictional && <Badge value="示例 / 虚构" />}
          </button>
        </li>)}</ul>
      </section>}
    </div>
  </main>
}
