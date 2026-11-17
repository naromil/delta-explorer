import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: (): string => '' }, screen: {} }))

import { DEFAULT_WINDOW_STATE, fitWindowState } from '../../src/main/window-state'

const laptop = { x: 0, y: 0, width: 1920, height: 1040 }
const second = { x: 1920, y: 0, width: 2560, height: 1400 }

describe('fitWindowState', () => {
  it('falls back to the default size for a missing or corrupt file', () => {
    expect(fitWindowState(null, [laptop])).toEqual(DEFAULT_WINDOW_STATE)
    expect(fitWindowState({ width: 'wide', height: NaN }, [laptop])).toEqual(DEFAULT_WINDOW_STATE)
  })

  it('keeps a stored size, position and maximized flag that fit a display', () => {
    const stored = { width: 1200, height: 800, x: 2100, y: 120, maximized: true }
    expect(fitWindowState(stored, [laptop, second])).toEqual(stored)
  })

  it('drops the position when its display is gone, keeping the size', () => {
    const stored = { width: 1200, height: 800, x: 2100, y: 120, maximized: false }
    expect(fitWindowState(stored, [laptop])).toEqual({ width: 1200, height: 800, maximized: false })
  })

  it('drops a position that would put the title bar above the display', () => {
    const stored = { width: 1200, height: 800, x: 100, y: -300 }
    expect(fitWindowState(stored, [laptop])).toEqual({ width: 1200, height: 800, maximized: false })
  })

  it('holds the size between a usable minimum and the largest display', () => {
    expect(fitWindowState({ width: 10, height: 10 }, [laptop])).toMatchObject({
      width: 480,
      height: 360
    })
    expect(fitWindowState({ width: 9000, height: 9000 }, [laptop])).toMatchObject({
      width: 1920,
      height: 1040
    })
  })

  it('never keeps half a position', () => {
    expect(fitWindowState({ width: 900, height: 600, x: 40 }, [laptop])).toEqual({
      width: 900,
      height: 600,
      maximized: false
    })
  })
})
