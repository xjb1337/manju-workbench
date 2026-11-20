import { useState } from 'react'
import type { Episode, MusicSettings } from '../shared/model'
import { Modal } from './components'

export function MusicPanel({ music, busy, canPreview, error, onClose, onImport, onSave, onRemove, onPreview }: {
  music: Episode['music']
  busy: boolean
  canPreview: boolean
  error?: string
  onClose: () => void
  onImport: () => void
  onSave: (settings: MusicSettings) => void
  onRemove: () => void
  onPreview: () => void
}) {
  const [enabled, setEnabled] = useState(music?.enabled ?? false)
  const [volume, setVolume] = useState(String((music?.volume ?? 0) * 100))
  const [fadeIn, setFadeIn] = useState(String(music?.fadeIn ?? 0))
  const [fadeOut, setFadeOut] = useState(String(music?.fadeOut ?? 0))
  const changed = !!music && (enabled !== music.enabled || volume !== String(music.volume * 100)
    || fadeIn !== String(music.fadeIn) || fadeOut !== String(music.fadeOut))

  return <Modal title="背景音乐" onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault()
      onSave({ enabled, volume: Number(volume) / 100, fadeIn: Number(fadeIn), fadeOut: Number(fadeOut) })
    }}>
      {music && <>
        <p className="music-name">{music.version.name}</p>
        <label className="music-toggle"><input type="checkbox" checked={enabled} disabled={busy}
          onChange={event => setEnabled(event.target.checked)} /> 启用背景音乐</label>
        <label className="field">音量（%）<input type="number" min="0" max="100" step="any" required disabled={busy}
          value={volume} onChange={event => setVolume(event.target.value)} /></label>
        <div className="field-grid">
          <label className="field">淡入（秒）<input type="number" min="0" max="30" step="any" required disabled={busy}
            value={fadeIn} onChange={event => setFadeIn(event.target.value)} /></label>
          <label className="field">淡出（秒）<input type="number" min="0" max="30" step="any" required disabled={busy}
            value={fadeOut} onChange={event => setFadeOut(event.target.value)} /></label>
        </div>
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions music-actions">
        <button type="button" disabled={busy} onClick={onClose}>关闭</button>
        {music && <button type="button" className="subtle" disabled={busy} onClick={onRemove}>移除音乐</button>}
        <button type="button" id="music-import" className={music ? '' : 'primary'} disabled={busy || changed} onClick={onImport}>
          {music ? '替换音乐' : '导入背景音乐'}
        </button>
        {music && <button type="button" disabled={busy || !canPreview || changed || !music.enabled || music.volume === 0}
          onClick={onPreview}>试听混音</button>}
        {music && <button type="submit" className="primary" disabled={busy || !changed}>保存</button>}
      </div>
    </form>
  </Modal>
}
