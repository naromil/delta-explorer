import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { app, screen } from 'electron'
import type { BrowserWindow, Rectangle } from 'electron'
import { writeFileAtomicSync } from './services/atomic-file'

/* ---- Main window size and position ----
 * Kept in its own file rather than `settings.json`: it changes on every resize,
 * and a settings write announces a config change to everything listening.
 */

export interface WindowState {
  width: number
  height: number
  /** Absent where the desktop never reports a position (Wayland). */
  x?: number
  y?: number
  maximized: boolean
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 960, height: 640, maximized: false }

const MIN_WIDTH = 480
const MIN_HEIGHT = 360
/** How much of the window must stay on a display for its position to be kept. */
const MIN_VISIBLE_PX = 80
const SAVE_DEBOUNCE_MS = 400

function overlap(a: Rectangle, b: Rectangle): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  }
}

/**
 * Stored state made safe for the displays present now: a hand-edited file or an
 * unplugged monitor must never open the window too small, too large or off screen.
 */
export function fitWindowState(raw: unknown, workAreas: Rectangle[]): WindowState {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const whole = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined

  const maxWidth = Math.max(MIN_WIDTH, ...workAreas.map((area) => area.width))
  const maxHeight = Math.max(MIN_HEIGHT, ...workAreas.map((area) => area.height))
  const width = Math.min(
    Math.max(whole(record.width) ?? DEFAULT_WINDOW_STATE.width, MIN_WIDTH),
    maxWidth
  )
  const height = Math.min(
    Math.max(whole(record.height) ?? DEFAULT_WINDOW_STATE.height, MIN_HEIGHT),
    maxHeight
  )
  const state: WindowState = { width, height, maximized: record.maximized === true }

  const x = whole(record.x)
  const y = whole(record.y)
  if (x === undefined || y === undefined) return state
  const visible = workAreas.some((area) => {
    const shared = overlap({ x, y, width, height }, area)
    // The title bar is what the user needs to reach, so the top edge must be on the display.
    return shared.w >= MIN_VISIBLE_PX && shared.h >= MIN_VISIBLE_PX && y >= area.y
  })
  return visible ? { ...state, x, y } : state
}

function statePath(): string {
  const dir = join(app.getPath('userData'), 'config')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'window-state.json')
}

export function loadWindowState(): WindowState {
  const workAreas = screen.getAllDisplays().map((display) => display.workArea)
  try {
    const path = statePath()
    if (!existsSync(path)) return fitWindowState(null, workAreas)
    return fitWindowState(JSON.parse(readFileSync(path, 'utf-8')), workAreas)
  } catch (err) {
    console.warn('Failed to read the window state:', err)
    return fitWindowState(null, workAreas)
  }
}

/** Saves the window's size and position as they change, and once more as it closes. */
export function trackWindowState(win: BrowserWindow, initial: WindowState): void {
  let timer: NodeJS.Timeout | undefined
  // The size to return to from maximized, which `getNormalBounds` reports wrongly on some desktops.
  let normal: Rectangle | null = null
  const tracksPosition = initial.x !== undefined || process.env['XDG_SESSION_TYPE'] !== 'wayland'

  const save = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    if (!maximized && !win.isMinimized() && !win.isFullScreen()) normal = win.getBounds()
    const state: WindowState = normal
      ? {
          width: normal.width,
          height: normal.height,
          ...(tracksPosition ? { x: normal.x, y: normal.y } : {}),
          maximized
        }
      : { ...initial, maximized }
    try {
      writeFileAtomicSync(statePath(), JSON.stringify(state, null, 2))
    } catch (err) {
      console.warn('Failed to save the window state:', err)
    }
  }
  const saveSoon = (): void => {
    clearTimeout(timer)
    timer = setTimeout(save, SAVE_DEBOUNCE_MS)
    timer.unref()
  }

  win.on('resize', saveSoon)
  win.on('move', saveSoon)
  win.on('maximize', saveSoon)
  win.on('unmaximize', saveSoon)
  win.on('close', save)
}
