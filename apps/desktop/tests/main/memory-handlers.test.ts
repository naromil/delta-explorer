import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, paths, send, openPath } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  paths: { userData: '' },
  send: vi.fn(),
  openPath: vi.fn<(path: string) => Promise<string>>()
}))

vi.mock('electron', () => ({
  app: { getPath: (): string => paths.userData },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    ]
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  },
  shell: { openPath }
}))
vi.mock('../../src/main/config', () => ({
  resolveRole: vi.fn(),
  RoleUnassignedError: class RoleUnassignedError extends Error {}
}))
vi.mock('../../src/main/services/model-catalog', () => ({ getCachedModel: vi.fn() }))

import { registerMemoryIpcHandlers } from '../../src/main/memory/handlers'
import type { MemoryResult } from '../../src/main/memory/handlers'
import { MAX_MEMORY_FILE_CHARS } from '../../src/main/memory/store'

type Failure = { ok: false; error: string }

function invoke<T extends object = object>(channel: string, ...args: unknown[]): MemoryResult<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args) as MemoryResult<T>
}

function memories(): string {
  return join(paths.userData, 'memories')
}

function seed(relative: string, content: string): void {
  const file = join(memories(), relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

function expectFailure(result: MemoryResult<object>): string {
  expect(result.ok).toBe(false)
  const { error } = result as Failure
  // Neither the user's home nor the app's data folder belongs in a message the window shows.
  expect(error).not.toContain(paths.userData)
  expect(error).not.toContain(tmpdir())
  return error
}

beforeEach(() => {
  paths.userData = mkdtempSync(join(tmpdir(), 'delta-memory-ipc-'))
  handlers.clear()
  send.mockClear()
  openPath.mockReset()
  registerMemoryIpcHandlers()
})

afterEach(() => {
  rmSync(paths.userData, { recursive: true, force: true })
})

describe('memory-read', () => {
  it('reads a whole file as not truncated', () => {
    seed('topics/chemistry.md', '# Chemistry\n- knows moles')

    expect(invoke('memory-read', 'topics/chemistry.md')).toEqual({
      ok: true,
      content: '# Chemistry\n- knows moles',
      truncated: false
    })
  })

  it('reads a file of exactly the limit as whole', () => {
    seed('long.md', 'a'.repeat(MAX_MEMORY_FILE_CHARS))

    const result = invoke<{ content: string; truncated: boolean }>('memory-read', 'long.md')

    expect(result).toMatchObject({ ok: true, truncated: false })
  })

  it('reports a cut file as truncated, so the editor cannot save it over the whole one', () => {
    seed('long.md', 'a'.repeat(MAX_MEMORY_FILE_CHARS + 10))

    const result = invoke<{ content: string; truncated: boolean }>('memory-read', 'long.md')

    expect(result).toMatchObject({ ok: true, truncated: true })
    if (!result.ok) return
    expect(result.content.startsWith('a'.repeat(MAX_MEMORY_FILE_CHARS))).toBe(true)
    expect(result.content.length).toBeGreaterThan(MAX_MEMORY_FILE_CHARS)
  })

  it('refuses a cut file written back, leaving the whole one on disk', () => {
    const whole = 'a'.repeat(MAX_MEMORY_FILE_CHARS + 10)
    seed('long.md', whole)
    const read = invoke<{ content: string }>('memory-read', 'long.md')
    if (!read.ok) throw new Error('read failed')

    expectFailure(invoke('memory-write', 'long.md', read.content))
    expect(readFileSync(join(memories(), 'long.md'), 'utf-8')).toBe(whole)
    expect(send).not.toHaveBeenCalled()
  })

  it('names a missing file by its relative path only', () => {
    const error = expectFailure(invoke('memory-read', 'topics/missing.md'))
    expect(error).toContain('topics/missing.md')
  })

  it('refuses paths outside the document base without naming where it lives', () => {
    writeFileSync(join(paths.userData, 'secret.md'), 'outside')

    expectFailure(invoke('memory-read', '../secret.md'))
    expectFailure(invoke('memory-read', 'notes.txt'))

    // An absolute path is echoed as given, but the refusal still says nothing of the base.
    const absolute = invoke('memory-read', join(paths.userData, 'secret.md'))
    expect(absolute.ok).toBe(false)
    expect((absolute as Failure).error).not.toContain(memories())
  })

  it('turns a non-string path into a refusal rather than a throw', () => {
    expectFailure(invoke('memory-read', { path: 'x.md' }))
    expectFailure(invoke('memory-read', undefined))
  })
})

describe('memory-write', () => {
  it('writes the file and tells every window', () => {
    const result = invoke('memory-write', 'topics/goals.md', '- pass the exam')

    expect(result).toEqual({ ok: true })
    expect(readFileSync(join(memories(), 'topics/goals.md'), 'utf-8')).toBe('- pass the exam')
    expect(send).toHaveBeenCalledWith('memory-updated')
  })

  it('refuses content that is not text', () => {
    seed('goals.md', 'keep')

    expect(invoke('memory-write', 'goals.md', 42)).toEqual({ ok: false, error: 'Nothing to save.' })
    expect(readFileSync(join(memories(), 'goals.md'), 'utf-8')).toBe('keep')
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses an escape from the document base and announces nothing', () => {
    expectFailure(invoke('memory-write', '../escaped.md', 'x'))

    expect(existsSync(join(paths.userData, 'escaped.md'))).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('reports a filesystem failure by its code, never by its absolute path', () => {
    // A file where a directory should be makes the write fail below the store's own checks.
    seed('topics', 'not a directory')

    const error = expectFailure(invoke('memory-write', 'topics/goals.md', 'x'))

    expect(error).toMatch(/^The filesystem refused this operation \([A-Z]+\)\.$/)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('memory-remove', () => {
  it('removes a file and tells every window', () => {
    seed('inbox.md', '- note')

    expect(invoke('memory-remove', 'inbox.md')).toEqual({ ok: true })
    expect(existsSync(join(memories(), 'inbox.md'))).toBe(false)
    expect(send).toHaveBeenCalledWith('memory-updated')
  })

  it('never removes a folder that still holds notes', () => {
    seed('topics/chemistry.md', '- note')

    expectFailure(invoke('memory-remove', 'topics'))
    expect(existsSync(join(memories(), 'topics/chemistry.md'))).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses the document base itself and anything outside it', () => {
    expectFailure(invoke('memory-remove', ''))
    expectFailure(invoke('memory-remove', '..'))
    expect(existsSync(memories())).toBe(true)
  })
})

describe('memory-list', () => {
  it('lists the files with the auto-loaded ones marked', () => {
    seed('index-learning.md', '- visual')
    seed('topics/chemistry.md', '- moles')

    const result = invoke<{ files: Array<{ path: string; autoLoaded: boolean }> }>('memory-list')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byPath = new Map(result.files.map((file) => [file.path, file.autoLoaded]))
    expect(byPath.get('index-learning.md')).toBe(true)
    expect(byPath.get('topics/chemistry.md')).toBe(false)
  })
})

describe('memory-open-folder', () => {
  it('opens the document base and passes on a refusal', async () => {
    openPath.mockResolvedValueOnce('')
    await expect(invoke('memory-open-folder')).resolves.toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledWith(memories())

    openPath.mockResolvedValueOnce('No application is registered')
    await expect(invoke('memory-open-folder')).resolves.toEqual({
      ok: false,
      error: 'No application is registered'
    })
  })
})
