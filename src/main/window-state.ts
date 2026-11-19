import type { Theme, WindowBounds } from './recent-projects'

export type DisplayRect = {
  x: number
  y: number
  width: number
  height: number
}

export type DisplayLike = {
  workArea: DisplayRect
}

export type InitialWindowBounds = {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

const DEFAULT_WIDTH = 1480
const DEFAULT_HEIGHT = 970
const MIN_WIDTH = 940
const MIN_HEIGHT = 650

export function themeBackground(theme?: Theme): string {
  return theme === 'dark' ? '#181622' : '#f3f2f7'
}

function clampSize(value: number | undefined, fallback: number, min: number, max?: number): number {
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  const atLeastMin = Math.max(min, base)
  if (max === undefined || !Number.isFinite(max)) return atLeastMin
  return Math.min(atLeastMin, Math.max(min, Math.round(max)))
}

function isVisibleOnDisplay(bounds: DisplayRect, area: DisplayRect): boolean {
  const minOverlapX = Math.min(100, bounds.width)
  const minOverlapY = Math.min(50, bounds.height)
  const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
  return overlapX >= minOverlapX && overlapY >= minOverlapY
}

/** Validates saved window bounds against active displays, clamping oversized dimensions and centering off-screen windows. */
export function resolveInitialBounds(
  saved: Partial<WindowBounds> | undefined,
  displays: readonly DisplayLike[],
): InitialWindowBounds {
  const maximized = Boolean(saved?.maximized)
  const hasPosition = typeof saved?.x === 'number' && Number.isFinite(saved.x)
    && typeof saved?.y === 'number' && Number.isFinite(saved.y)

  if (hasPosition) {
    const probeWidth = clampSize(saved?.width, DEFAULT_WIDTH, MIN_WIDTH)
    const probeHeight = clampSize(saved?.height, DEFAULT_HEIGHT, MIN_HEIGHT)
    const probe: DisplayRect = { x: Math.round(saved!.x!), y: Math.round(saved!.y!), width: probeWidth, height: probeHeight }
    const matched = displays.find(display => isVisibleOnDisplay(probe, display.workArea))
    if (matched) {
      return {
        width: clampSize(saved?.width, DEFAULT_WIDTH, MIN_WIDTH, matched.workArea.width),
        height: clampSize(saved?.height, DEFAULT_HEIGHT, MIN_HEIGHT, matched.workArea.height),
        x: probe.x,
        y: probe.y,
        maximized,
      }
    }
  }

  const primary = displays[0]
  if (!primary) {
    return {
      width: clampSize(saved?.width, DEFAULT_WIDTH, MIN_WIDTH),
      height: clampSize(saved?.height, DEFAULT_HEIGHT, MIN_HEIGHT),
      maximized,
    }
  }

  const width = clampSize(saved?.width, DEFAULT_WIDTH, MIN_WIDTH, primary.workArea.width)
  const height = clampSize(saved?.height, DEFAULT_HEIGHT, MIN_HEIGHT, primary.workArea.height)
  return {
    width,
    height,
    x: Math.round(primary.workArea.x + (primary.workArea.width - width) / 2),
    y: Math.round(primary.workArea.y + (primary.workArea.height - height) / 2),
    maximized,
  }
}
