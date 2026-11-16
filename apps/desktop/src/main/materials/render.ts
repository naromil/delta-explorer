import { join } from 'path'
import { BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import type {
  MaterialsRenderJob,
  MaterialsRenderResult,
  RenderedPage
} from '../../shared/materials-render'
import { guardWindowNavigation } from '../window-guards'

/* ---- Render window ----
 * PDFs and images are turned into pictures by Chromium, in a hidden, sandboxed window
 * that loads the app bundle with `?role=render`. That keeps PDF parsing out of the main
 * process and needs no native canvas addon. The window exists only while it has work:
 * it must not keep the app alive or count as one of the user's windows.
 */

const RENDER_TIMEOUT_MS = 45_000
const IDLE_CLOSE_MS = 30_000

export interface RenderedMaterial {
  pageCount: number
  pages: RenderedPage[]
}

interface PendingJob {
  resolve: (result: RenderedMaterial) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let renderWindow: BrowserWindow | null = null
let ready: Promise<BrowserWindow> | null = null
let markReady: ((window: BrowserWindow) => void) | null = null
let idleTimer: NodeJS.Timeout | undefined
let listening = false
let nextJobId = 1
const pending = new Map<number, PendingJob>()

/** True for the hidden window, which is never one of the user's windows. */
export function isRenderWindow(window: BrowserWindow): boolean {
  return window === renderWindow
}

function failPending(message: string): void {
  for (const [id, job] of pending) {
    clearTimeout(job.timer)
    job.reject(new Error(message))
    pending.delete(id)
  }
}

function closeWhenIdle(): void {
  clearTimeout(idleTimer)
  if (pending.size > 0) return
  idleTimer = setTimeout(() => {
    if (pending.size === 0 && renderWindow && !renderWindow.isDestroyed()) renderWindow.destroy()
  }, IDLE_CLOSE_MS)
}

/** For when the user's last window goes: the hidden one must not keep the app running. */
export function closeRenderWindow(): void {
  if (renderWindow && !renderWindow.isDestroyed()) renderWindow.destroy()
}

/** Only the render window may answer: any other window sending these is ignored. */
function listen(): void {
  if (listening) return
  listening = true
  ipcMain.on('materials-render-ready', (event) => {
    if (renderWindow && event.sender === renderWindow.webContents) markReady?.(renderWindow)
  })
  ipcMain.on('materials-render-result', (event, result: MaterialsRenderResult) => {
    if (!renderWindow || event.sender !== renderWindow.webContents) return
    const job = pending.get(result?.id)
    if (!job) return
    pending.delete(result.id)
    clearTimeout(job.timer)
    if (result.ok) job.resolve({ pageCount: result.pageCount, pages: result.pages })
    else job.reject(new Error(result.error))
    closeWhenIdle()
  })
}

function openRenderWindow(): Promise<BrowserWindow> {
  if (ready && renderWindow && !renderWindow.isDestroyed()) return ready
  listen()
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      devTools: false,
      // A window that is never shown would otherwise have its timers and frames throttled.
      backgroundThrottling: false
    }
  })
  renderWindow = window
  guardWindowNavigation(window)
  ready = new Promise<BrowserWindow>((resolve) => {
    markReady = resolve
  })
  const gone = (): void => {
    if (renderWindow !== window) return
    renderWindow = null
    ready = null
    markReady = null
    clearTimeout(idleTimer)
    failPending('The document could not be rendered.')
  }
  window.on('closed', gone)
  window.webContents.on('render-process-gone', () => {
    if (!window.isDestroyed()) window.destroy()
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && rendererUrl) void window.loadURL(`${rendererUrl}?role=render`)
  else
    void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { role: 'render' } })
  return ready
}

/** Renders pages of a PDF, or one image, to JPEGs plus their text. Rejects with a plain message. */
export async function renderMaterial(
  job: Omit<MaterialsRenderJob, 'id'>
): Promise<RenderedMaterial> {
  clearTimeout(idleTimer)
  const id = nextJobId++
  const result = new Promise<RenderedMaterial>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Rendering took too long.'))
      closeWhenIdle()
    }, RENDER_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
  })
  const window = await Promise.race([openRenderWindow(), result.then(() => null)])
  if (window && !window.isDestroyed() && pending.has(id)) {
    window.webContents.send('materials-render', { ...job, id } satisfies MaterialsRenderJob)
  }
  return result
}
