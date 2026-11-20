import { readdirSync, realpathSync } from 'fs'
import { open, readFile } from 'fs/promises'
import type { Stats } from 'fs'
import { join } from 'path'
import { confinePath, lstatOrNull, type ConfinedPath } from '../services/confined-path'

/* ---- Learning materials ----
 * A folder the user chose (notes, course files, books as text), which the assistant may
 * explore but never change. Paths come from a model, whose input can include untrusted
 * text, so each one is confined to the folder; there is no write operation and no shell.
 * Hidden entries and symbolic links are invisible, and a file is text only if it reads as text.
 */

const MAX_LISTED_ENTRIES = 300
const DEFAULT_LIST_DEPTH = 2
const MAX_LIST_DEPTH = 8
/** What one read returns; a longer file is read in pages by line number. */
export const MAX_READ_CHARS = 24_000
const MAX_READABLE_BYTES = 16 * 1024 * 1024
const MAX_GREP_MATCHES = 100
const MAX_GREP_LINE_CHARS = 240
const MAX_GREP_FILES = 3_000
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024
const MAX_GREP_TOTAL_BYTES = 64 * 1024 * 1024
/** Large files a folder search names rather than reads. */
const MAX_SKIPPED_NAMED = 5
const BINARY_SNIFF_BYTES = 8_192
const MAX_FOUND_ENTRIES = 200
const MAX_FIND_PATTERN_CHARS = 200
/** A PDF or image is handed whole to the render window, so it has a ceiling. */
const MAX_VIEWABLE_BYTES = 64 * 1024 * 1024
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}
const SKIPPED_DIRECTORIES = new Set(['node_modules', '__pycache__'])

/** A refusal worded for the model; anything else is an unexpected filesystem failure. */
export class MaterialsError extends Error {}

/**
 * The folder as the tools may use it, or `null` when it is unset or gone. Resolved once, so a
 * chosen folder that is itself a link works while links inside it stay unfollowed.
 */
export function resolveMaterialsRoot(configured: string): string | null {
  if (configured === '') return null
  try {
    const root = realpathSync(configured)
    return lstatOrNull(root)?.isDirectory() ? root : null
  } catch {
    return null
  }
}

/* ---- Paths ---- */

function locate(root: string, input: string): ConfinedPath {
  const located = confinePath(
    root,
    input,
    'the materials folder',
    (message) => new MaterialsError(message)
  )
  if (located.relative.split('/').some(isHiddenName)) {
    throw new MaterialsError(`No such file or directory: ${located.relative}`)
  }
  return located
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)
}

function statOrThrow(path: ConfinedPath): Stats {
  const stats = lstatOrNull(path.absolute)
  if (!stats) throw new MaterialsError(`No such file or directory: ${path.relative || '.'}`)
  return stats
}

/* ---- Traversal ---- */

interface MaterialEntry {
  relative: string
  absolute: string
  isDirectory: boolean
  /** A directory at the depth limit: it has contents that were not listed. */
  unexplored?: boolean
}

/** Depth-first, sorted, lazy: a caller that stops early reads no further directories. */
function* walk(directory: ConfinedPath, depth: number): Generator<MaterialEntry> {
  let entries
  try {
    entries = readdirSync(directory.absolute, { withFileTypes: true })
  } catch {
    // An unreadable directory is skipped rather than failing the whole listing.
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (isHiddenName(entry.name)) continue
    const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name
    const absolute = join(directory.absolute, entry.name)
    if (entry.isDirectory()) {
      yield { relative, absolute, isDirectory: true, unexplored: depth <= 1 }
      if (depth > 1) yield* walk({ absolute, relative }, depth - 1)
    } else if (entry.isFile()) {
      yield { relative, absolute, isDirectory: false }
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ---- Operations ---- */

/** `ls -R` to a depth: directories end in `/`, files show their size. */
export function listMaterials(
  root: string,
  path = '.',
  depth = DEFAULT_LIST_DEPTH,
  maxEntries = MAX_LISTED_ENTRIES
): string {
  const target = locate(root, path)
  if (!statOrThrow(target).isDirectory()) return target.relative
  const levels = Math.min(Math.max(Math.trunc(depth) || DEFAULT_LIST_DEPTH, 1), MAX_LIST_DEPTH)

  const lines: string[] = []
  for (const entry of walk(target, levels)) {
    if (lines.length === maxEntries) {
      lines.push(`… listing truncated at ${maxEntries} entries; list a subdirectory for the rest`)
      break
    }
    if (entry.isDirectory) {
      lines.push(entry.unexplored ? `${entry.relative}/ …` : `${entry.relative}/`)
    } else {
      lines.push(`${entry.relative} (${formatSize(lstatOrNull(entry.absolute)?.size ?? 0)})`)
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(empty)'
}

function looksBinary(sample: Buffer): boolean {
  return sample.includes(0)
}

async function sniffBinary(absolute: string): Promise<boolean> {
  const handle = await open(absolute, 'r')
  try {
    const sample = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await handle.read(sample, 0, BINARY_SNIFF_BYTES, 0)
    return looksBinary(sample.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/** What `materials_view` can show, by extension; everything else is text or unreadable. */
function viewableKind(
  relative: string
): { kind: 'pdf' } | { kind: 'image'; mediaType: string } | null {
  const extension = relative.slice(relative.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'pdf') return { kind: 'pdf' }
  const mediaType = IMAGE_MEDIA_TYPES[extension]
  return mediaType ? { kind: 'image', mediaType } : null
}

async function readTextLines(
  root: string,
  path: string
): Promise<{ relative: string; lines: string[] }> {
  const target = locate(root, path)
  const stats = statOrThrow(target)
  if (!stats.isFile()) throw new MaterialsError(`Not a file: ${target.relative || '.'}`)
  if (viewableKind(target.relative)) {
    throw new MaterialsError(
      `${target.relative} is not a text file; look at it with materials_view.`
    )
  }
  if (stats.size > MAX_READABLE_BYTES) {
    throw new MaterialsError(
      `${target.relative} is ${formatSize(stats.size)}, too large to read; search it with materials_grep on its path instead.`
    )
  }
  if (await sniffBinary(target.absolute)) {
    throw new MaterialsError(`${target.relative} is not a text file and cannot be read.`)
  }
  return {
    relative: target.relative,
    lines: (await readFile(target.absolute, 'utf-8')).split('\n')
  }
}

/**
 * Reads a text file from `startLine` (1-based): at most `lineCount` lines and `MAX_READ_CHARS`.
 */
export async function readMaterial(
  root: string,
  path: string,
  startLine = 1,
  lineCount = Number.POSITIVE_INFINITY
): Promise<string> {
  const { relative, lines } = await readTextLines(root, path)
  const wanted = Math.max(Math.trunc(lineCount) || 1, 1)
  const first = Math.max(Math.trunc(startLine) || 1, 1)
  if (first > lines.length) {
    throw new MaterialsError(`${relative} has only ${lines.length} lines.`)
  }
  const page: string[] = []
  let used = 0
  for (let index = first - 1; index < lines.length; index++) {
    const line = lines[index]
    if (page.length === wanted || (page.length > 0 && used + line.length > MAX_READ_CHARS)) break
    // A single line longer than a page (minified text) is cut rather than refused.
    page.push(line.length > MAX_READ_CHARS ? `${line.slice(0, MAX_READ_CHARS)}…` : line)
    used += line.length + 1
  }
  const last = first + page.length - 1
  if (first === 1 && last === lines.length) return page.join('\n')
  const more = last < lines.length ? `; continue with start_line ${last + 1}` : ''
  return `${page.join('\n')}\n… lines ${first}-${last} of ${lines.length}${more}`
}

/** `wc`: how much a text file holds, so the model can decide how to read it. */
export async function countMaterial(root: string, path: string): Promise<string> {
  const { relative, lines } = await readTextLines(root, path)
  const text = lines.join('\n')
  const words = text.split(/\s+/).filter((word) => word !== '').length
  return `${relative}: ${lines.length} lines, ${words} words, ${text.length} characters`
}

/** A glob as a regular expression: `*` and `?` stay inside a name, `**` crosses directories. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*{2,}/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${source}$`, 'i')
}

/** `find -iname`: entries below `path` whose name, or whose path when the glob has a `/`, matches. */
export function findMaterials(root: string, pattern: string, path = '.'): string {
  const glob = pattern.trim().replaceAll('\\', '/')
  if (glob === '') throw new MaterialsError('The pattern must not be empty.')
  if (glob.length > MAX_FIND_PATTERN_CHARS) throw new MaterialsError('The pattern is too long.')
  const target = locate(root, path)
  if (!statOrThrow(target).isDirectory()) throw new MaterialsError(`Not a directory: ${path}`)
  const matcher = globToRegExp(glob)
  const byPath = glob.includes('/')

  const lines: string[] = []
  for (const entry of walk(target, Number.POSITIVE_INFINITY)) {
    const name = entry.relative.slice(entry.relative.lastIndexOf('/') + 1)
    if (!matcher.test(byPath ? entry.relative : name)) continue
    if (lines.length === MAX_FOUND_ENTRIES) {
      lines.push(
        `… results truncated at ${MAX_FOUND_ENTRIES} entries; narrow the pattern or the path`
      )
      break
    }
    lines.push(
      entry.isDirectory
        ? `${entry.relative}/`
        : `${entry.relative} (${formatSize(lstatOrNull(entry.absolute)?.size ?? 0)})`
    )
  }
  return lines.length > 0 ? lines.join('\n') : '(no matches)'
}

export type ViewableMaterial = { relative: string; data: Buffer } & (
  { kind: 'pdf' } | { kind: 'image'; mediaType: string }
)

/** The bytes of a PDF or image, for the render window; nothing else is handed out raw. */
export async function readViewableMaterial(root: string, path: string): Promise<ViewableMaterial> {
  const target = locate(root, path)
  const stats = statOrThrow(target)
  if (!stats.isFile()) throw new MaterialsError(`Not a file: ${target.relative || '.'}`)
  const kind = viewableKind(target.relative)
  if (!kind) {
    throw new MaterialsError(
      `${target.relative} is not a PDF or a PNG, JPEG, WebP or GIF image; read text files with materials_cat.`
    )
  }
  if (stats.size > MAX_VIEWABLE_BYTES) {
    throw new MaterialsError(`${target.relative} is ${formatSize(stats.size)}, too large to open.`)
  }
  return { relative: target.relative, data: await readFile(target.absolute), ...kind }
}

function clipLine(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > MAX_GREP_LINE_CHARS
    ? `${trimmed.slice(0, MAX_GREP_LINE_CHARS)}…`
    : trimmed
}

/**
 * Case-insensitive literal search: a model-written regex could hang the main process. Files are
 * read one at a time between awaits, and the scan has a budget, so a huge folder cannot stall it.
 */
export async function grepMaterials(root: string, text: string, path = '.'): Promise<string> {
  const needle = text.toLowerCase()
  if (needle.trim() === '') throw new MaterialsError('The search text must not be empty.')
  const target = locate(root, path)
  const stats = statOrThrow(target)
  const files: Iterable<MaterialEntry> = stats.isDirectory()
    ? walk(target, Number.POSITIVE_INFINITY)
    : [{ relative: target.relative, absolute: target.absolute, isDirectory: false }]

  // A file named by its path may be as large as the whole scan; a folder search skips large
  // files but names them, so a miss in a big book never reads as "not in the materials".
  const fileLimit = stats.isDirectory() ? MAX_GREP_FILE_BYTES : MAX_GREP_TOTAL_BYTES
  if (!stats.isDirectory() && stats.size > fileLimit) {
    throw new MaterialsError(
      `${target.relative} is ${formatSize(stats.size)}, too large to search.`
    )
  }
  const matches: string[] = []
  const skipped: string[] = []
  let scanned = 0
  let bytes = 0
  for (const file of files) {
    if (file.isDirectory) continue
    const size = lstatOrNull(file.absolute)?.size ?? 0
    if (size > fileLimit) {
      skipped.push(`${file.relative} (${formatSize(size)})`)
      continue
    }
    if (scanned === MAX_GREP_FILES || bytes + size > MAX_GREP_TOTAL_BYTES) {
      matches.push(`… search stopped after ${scanned} files; search a subdirectory for the rest`)
      break
    }
    scanned++
    bytes += size
    let content: Buffer
    try {
      content = await readFile(file.absolute)
    } catch {
      continue
    }
    if (looksBinary(content.subarray(0, BINARY_SNIFF_BYTES))) continue
    for (const [index, line] of content.toString('utf-8').split('\n').entries()) {
      if (!line.toLowerCase().includes(needle)) continue
      if (matches.length === MAX_GREP_MATCHES) {
        matches.push(`… results truncated at ${MAX_GREP_MATCHES} matches; narrow the search`)
        return matches.join('\n')
      }
      matches.push(`${file.relative}:${index + 1}: ${clipLine(line)}`)
    }
  }
  if (matches.length === 0) matches.push('(no matches)')
  if (skipped.length > 0) {
    const named = skipped.slice(0, MAX_SKIPPED_NAMED).join(', ')
    const more =
      skipped.length > MAX_SKIPPED_NAMED ? ` and ${skipped.length - MAX_SKIPPED_NAMED} more` : ''
    matches.push(`… skipped ${named}${more}: too large for a folder search; search it by its path`)
  }
  return matches.join('\n')
}
