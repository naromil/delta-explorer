import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import {
  buildMaterialsPrompt,
  MATERIALS_IMAGES_ATTACHED,
  MATERIALS_IMAGES_EXHAUSTED,
  MATERIALS_IMAGES_UNREADABLE,
  MATERIALS_PATH_HINT,
  MATERIALS_TOOL_DESCRIPTIONS
} from '@delta/core/prompts'
import type { ImageInput } from '@delta/core/messages'
import { loadAppSettings } from '../config'
import type { ImageSupport } from '../image-support'
import type { AgentTools } from '../provider'
import { renderMaterial } from './render'
import type { RenderedMaterial } from './render'
import {
  countMaterial,
  findMaterials,
  grepMaterials,
  listMaterials,
  MaterialsError,
  readMaterial,
  readViewableMaterial,
  resolveMaterialsRoot
} from './store'
import type { ViewableMaterial } from './store'

/** Finding a passage takes a listing, a search and a read or two on top of the memory notes. */
const MATERIALS_MAX_STEPS = 16
/** The part of the folder every prompt shows; the rest is listed on demand. */
const PROMPT_LAYOUT_DEPTH = 2
const PROMPT_LAYOUT_ENTRIES = 60
const MAX_PAGES_PER_VIEW = 4
/** Pictures are large and stay in the request for every later step. */
const MAX_IMAGES_PER_REQUEST = 12
const PAGE_MEDIA_TYPE = 'image/jpeg'

export type MaterialRenderer = (
  file: ViewableMaterial,
  firstPage: number,
  lastPage: number,
  images: boolean
) => Promise<RenderedMaterial>

export interface MaterialsToolOptions {
  /** Whether the model can be shown pictures; without it a PDF gives only its text. */
  images: boolean
  /** Receives the pictures of one tool call; the provider loop shows them to the model. */
  toolImages: Map<string, ImageInput[]>
  render?: MaterialRenderer
}

const pathInput = z.string().describe(MATERIALS_PATH_HINT)

/** The model reads a failure as a tool result and can correct itself; absolute paths stay out. */
async function report(operation: () => string | Promise<string>): Promise<string> {
  try {
    return await operation()
  } catch (err) {
    if (err instanceof MaterialsError) return `Error: ${err.message}`
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
    return `Error: the filesystem refused this operation (${code}).`
  }
}

const renderInWindow: MaterialRenderer = (file, firstPage, lastPage, images) =>
  renderMaterial({
    kind: file.kind,
    mediaType: file.kind === 'image' ? file.mediaType : undefined,
    data: file.data,
    firstPage,
    lastPage,
    images
  })

function attachedCount(toolImages: Map<string, ImageInput[]>): number {
  let count = 0
  for (const images of toolImages.values()) count += images.length
  return count
}

/** Shows pages of a PDF, or an image: text in the result, pictures through `toolImages`. */
async function viewMaterial(
  root: string,
  options: MaterialsToolOptions,
  toolCallId: string,
  path: string,
  firstPage: number,
  lastPage: number
): Promise<string> {
  const file = await readViewableMaterial(root, path)
  const room = MAX_IMAGES_PER_REQUEST - attachedCount(options.toolImages)
  const wantImages = options.images && room > 0
  if (file.kind === 'image' && !wantImages) {
    return `${file.relative}: ${options.images ? MATERIALS_IMAGES_EXHAUSTED : MATERIALS_IMAGES_UNREADABLE}`
  }
  const first = Math.max(Math.trunc(firstPage) || 1, 1)
  const last = Math.min(
    Math.max(Math.trunc(lastPage) || first, first),
    first + MAX_PAGES_PER_VIEW - 1
  )

  let rendered: RenderedMaterial
  try {
    rendered = await (options.render ?? renderInWindow)(file, first, last, wantImages)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error'
    throw new MaterialsError(`${file.relative} could not be opened: ${reason}`)
  }

  const images = rendered.pages
    .flatMap((page) => (page.image ? [{ mediaType: PAGE_MEDIA_TYPE, data: page.image }] : []))
    .slice(0, room)
  if (images.length > 0) options.toolImages.set(toolCallId, images)
  const imagesNote = !options.images
    ? MATERIALS_IMAGES_UNREADABLE
    : images.length > 0
      ? MATERIALS_IMAGES_ATTACHED
      : MATERIALS_IMAGES_EXHAUSTED
  if (file.kind === 'image') return `${file.relative}: ${imagesNote}`

  const shown = rendered.pages.map((page) => page.page)
  if (shown.length === 0) {
    throw new MaterialsError(`${file.relative} has only ${rendered.pageCount} pages.`)
  }
  const range = shown.length === 1 ? `page ${shown[0]}` : `pages ${shown[0]}-${shown.at(-1)}`
  return [
    `${file.relative}: ${range} of ${rendered.pageCount}. ${imagesNote}`,
    ...rendered.pages.map(
      (page) => `--- Page ${page.page} text ---\n${page.text || '(no text on this page)'}`
    )
  ].join('\n\n')
}

/** Read-only by construction: there is no tool here that writes, moves or deletes. */
export function createMaterialsTools(root: string, options: MaterialsToolOptions): ToolSet {
  return {
    materials_ls: tool({
      description: MATERIALS_TOOL_DESCRIPTIONS.ls,
      inputSchema: z.object({
        path: pathInput,
        depth: z.number().int().min(1).max(8).describe('Levels to list; 2 is a good start.')
      }),
      execute: ({ path, depth }) => report(() => listMaterials(root, path, depth))
    }),
    materials_find: tool({
      description: MATERIALS_TOOL_DESCRIPTIONS.find,
      inputSchema: z.object({ pattern: z.string(), path: pathInput }),
      execute: ({ pattern, path }) => report(() => findMaterials(root, pattern, path))
    }),
    materials_cat: tool({
      description: MATERIALS_TOOL_DESCRIPTIONS.cat,
      inputSchema: z.object({
        path: pathInput,
        start_line: z.number().int().min(1).describe('First line to read; 1 for the start.'),
        line_count: z.number().int().min(1).describe('Lines to read; 400 is a good default.')
      }),
      execute: ({ path, start_line, line_count }) =>
        report(() => readMaterial(root, path, start_line, line_count))
    }),
    materials_wc: tool({
      description: MATERIALS_TOOL_DESCRIPTIONS.wc,
      inputSchema: z.object({ path: pathInput }),
      execute: ({ path }) => report(() => countMaterial(root, path))
    }),
    materials_grep: tool({
      description: MATERIALS_TOOL_DESCRIPTIONS.grep,
      inputSchema: z.object({ text: z.string(), path: pathInput }),
      execute: ({ text, path }) => report(() => grepMaterials(root, text, path))
    }),
    materials_view: tool({
      description: MATERIALS_TOOL_DESCRIPTIONS.view,
      inputSchema: z.object({
        path: pathInput,
        first_page: z.number().int().min(1).describe('First PDF page to show; 1 for the start.'),
        last_page: z.number().int().min(1).describe('Last PDF page to show.')
      }),
      execute: ({ path, first_page, last_page }, { toolCallId }) =>
        report(() => viewMaterial(root, options, toolCallId, path, first_page, last_page))
    })
  }
}

/**
 * Adds the learning-materials tools to the assistant's tool set when the user chose a folder.
 * Without an agent the model holds no tools at all, so there is nothing to add to. A model that
 * may read images (`unknown` included, as for attachments) is shown pages as pictures. Never
 * throws: a missing or unreadable folder must not be why a message fails.
 */
export function withMaterials(
  agent: AgentTools | undefined,
  imageSupport: ImageSupport
): AgentTools | undefined {
  if (!agent) return agent
  try {
    const root = resolveMaterialsRoot(loadAppSettings().materialsDir)
    if (!root) return agent
    const layout = listMaterials(root, '.', PROMPT_LAYOUT_DEPTH, PROMPT_LAYOUT_ENTRIES)
    const toolImages = new Map<string, ImageInput[]>()
    const tools = createMaterialsTools(root, { images: imageSupport !== 'no', toolImages })
    return {
      ...agent,
      tools: { ...agent.tools, ...tools },
      instructions: `${agent.instructions}\n\n${buildMaterialsPrompt(layout)}`,
      maxSteps: Math.max(agent.maxSteps, MATERIALS_MAX_STEPS),
      toolImages
    }
  } catch (err) {
    console.warn('Learning materials are unavailable for this request:', err)
    return agent
  }
}
