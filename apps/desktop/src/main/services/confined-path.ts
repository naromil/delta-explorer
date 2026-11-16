import { lstatSync } from 'fs'
import type { Stats } from 'fs'
import { join } from 'path'

/* ---- Path confinement ----
 * Paths written by a model, whose input can include untrusted screen or file text,
 * are resolved here so they can never leave the directory a tool set was given.
 */

export interface ConfinedPath {
  absolute: string
  /** Relative to the root with `/` separators; empty for the root itself. */
  relative: string
}

export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Resolves `input` below `root`, refusing absolute paths, `..` and symbolic links.
 * `rootLabel` names the root in a refusal, and `refuse` builds the caller's own error.
 */
export function confinePath(
  root: string,
  input: string,
  rootLabel: string,
  refuse: (message: string) => Error
): ConfinedPath {
  const normalized = input.trim().replaceAll('\\', '/')
  // eslint-disable-next-line no-control-regex
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || /[\x00-\x1f]/.test(input)) {
    throw refuse(`Invalid path "${input}": use a path relative to ${rootLabel}.`)
  }
  const segments = normalized.split('/').filter((part) => part !== '' && part !== '.')
  if (segments.includes('..')) {
    throw refuse(`Invalid path "${input}": ".." is not allowed.`)
  }
  let absolute = root
  for (const segment of segments) {
    absolute = join(absolute, segment)
    if (lstatOrNull(absolute)?.isSymbolicLink()) {
      throw refuse(`Invalid path "${input}": symbolic links are not followed.`)
    }
  }
  return { absolute, relative: segments.join('/') }
}
