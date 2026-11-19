import { useEffect, useRef } from 'react'
import type { Shot } from '../shared/model'

/** Registers workbench keyboard shortcuts (save, shot arrow navigation) and unsaved/busy unload guard. */
export function useWorkbenchShortcuts({
  opened,
  canSwitchShot,
  shots,
  shotIndex,
  busy,
  dirty,
  hasModalOpen,
  onSelectShot,
}: {
  opened: boolean
  canSwitchShot: boolean
  shots?: Shot[]
  shotIndex: number
  busy: boolean
  dirty: boolean
  hasModalOpen: boolean
  onSelectShot: (id: string) => void
}) {
  const selectShotRef = useRef(onSelectShot)
  selectShotRef.current = onSelectShot

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 's') return
      if (!opened || !dirty || busy || hasModalOpen) return
      if (document.querySelector('dialog[open]')) return
      const form = document.querySelector<HTMLFormElement>('.workspace form')
      if (!form) return
      const submitter = form.querySelector<HTMLButtonElement>('button[type="submit"]')
      if (submitter?.disabled) return
      event.preventDefault()
      form.requestSubmit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [opened, dirty, busy, hasModalOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (!opened || !canSwitchShot || !shots || busy || dirty) return
      if (hasModalOpen || document.querySelector('dialog[open]')) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select') || target?.isContentEditable) return
      const delta = event.key === 'ArrowLeft' ? -1 : 1
      const nextShot = shots[shotIndex + delta]
      if (!nextShot) return
      event.preventDefault()
      selectShotRef.current(nextShot.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [opened, canSwitchShot, shots, shotIndex, busy, dirty, hasModalOpen])

  useEffect(() => {
    if (!dirty && !busy) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, busy])
}
