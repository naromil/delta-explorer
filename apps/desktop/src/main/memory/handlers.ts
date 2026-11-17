import { ipcMain, shell } from 'electron'
import {
  MAX_MEMORY_FILE_CHARS,
  memoriesDir,
  memoryFiles,
  MemoryError,
  readMemory,
  removeMemory,
  writeMemory
} from './store'
import type { MemoryFile } from './store'
import { broadcastMemoryUpdated } from './tools'

export type MemoryResult<T = object> = ({ ok: true } & T) | { ok: false; error: string }

/** A refusal reads as written; anything else must not leak an absolute path. */
function failure(err: unknown): { ok: false; error: string } {
  if (err instanceof MemoryError) return { ok: false, error: err.message }
  const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
  return { ok: false, error: `The filesystem refused this operation (${code}).` }
}

function attempt<T extends object>(operation: () => T): MemoryResult<T> {
  try {
    return { ok: true, ...operation() }
  } catch (err) {
    return failure(err)
  }
}

/**
 * The Knowledge view's window onto the document base. It goes through the same
 * store as the model's tools, so the same path rules hold for a renderer payload.
 */
export function registerMemoryIpcHandlers(): void {
  ipcMain.handle('memory-list', (): MemoryResult<{ files: MemoryFile[] }> =>
    attempt(() => ({ files: memoryFiles(memoriesDir()) }))
  )

  ipcMain.handle(
    'memory-read',
    (_event, path: unknown): MemoryResult<{ content: string; truncated: boolean }> =>
      attempt(() => {
        const content = readMemory(memoriesDir(), String(path))
        // A cut file must not be saved back over the whole one.
        return { content, truncated: content.length > MAX_MEMORY_FILE_CHARS }
      })
  )

  ipcMain.handle('memory-write', (_event, path: unknown, content: unknown): MemoryResult => {
    if (typeof content !== 'string') return { ok: false, error: 'Nothing to save.' }
    const result = attempt(() => {
      writeMemory(memoriesDir(), String(path), content)
      return {}
    })
    if (result.ok) broadcastMemoryUpdated()
    return result
  })

  ipcMain.handle('memory-remove', (_event, path: unknown): MemoryResult => {
    const result = attempt(() => {
      removeMemory(memoriesDir(), String(path))
      return {}
    })
    if (result.ok) broadcastMemoryUpdated()
    return result
  })

  ipcMain.handle('memory-open-folder', async (): Promise<MemoryResult> => {
    const error = await shell.openPath(memoriesDir())
    return error ? { ok: false, error } : { ok: true }
  })
}
