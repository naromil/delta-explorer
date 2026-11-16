import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import {
  buildMaterialsPrompt,
  MATERIALS_PATH_HINT,
  MATERIALS_TOOL_DESCRIPTIONS
} from '@delta/core/prompts'
import { loadAppSettings } from '../config'
import type { AgentTools } from '../provider'
import {
  grepMaterials,
  listMaterials,
  MaterialsError,
  readMaterial,
  resolveMaterialsRoot
} from './store'

/** Finding a passage takes a listing, a search and a read or two on top of the memory notes. */
const MATERIALS_MAX_STEPS = 16
/** The part of the folder every prompt shows; the rest is listed on demand. */
const PROMPT_LAYOUT_DEPTH = 2
const PROMPT_LAYOUT_ENTRIES = 60

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

/** Read-only by construction: there is no tool here that writes, moves or deletes. */
export function createMaterialsTools(root: string): ToolSet {
  return {
    materials_ls: tool({
      description: MATERIALS_TOOL_DESCRIPTIONS.ls,
      inputSchema: z.object({
        path: pathInput,
        depth: z.number().int().min(1).max(8).describe('Levels to list; 2 is a good start.')
      }),
      execute: ({ path, depth }) => report(() => listMaterials(root, path, depth))
    }),
    materials_cat: tool({
      description: MATERIALS_TOOL_DESCRIPTIONS.cat,
      inputSchema: z.object({
        path: pathInput,
        start_line: z.number().int().min(1).describe('First line to read; 1 for the start.')
      }),
      execute: ({ path, start_line }) => report(() => readMaterial(root, path, start_line))
    }),
    materials_grep: tool({
      description: MATERIALS_TOOL_DESCRIPTIONS.grep,
      inputSchema: z.object({ text: z.string(), path: pathInput }),
      execute: ({ text, path }) => report(() => grepMaterials(root, text, path))
    })
  }
}

/**
 * Adds the learning-materials tools to the assistant's tool set when the user chose a folder.
 * Without an agent the model holds no tools at all, so there is nothing to add to. Never throws:
 * a missing or unreadable folder must not be why a message fails.
 */
export function withMaterials(agent: AgentTools | undefined): AgentTools | undefined {
  if (!agent) return agent
  try {
    const root = resolveMaterialsRoot(loadAppSettings().materialsDir)
    if (!root) return agent
    const layout = listMaterials(root, '.', PROMPT_LAYOUT_DEPTH, PROMPT_LAYOUT_ENTRIES)
    return {
      ...agent,
      tools: { ...agent.tools, ...createMaterialsTools(root) },
      instructions: `${agent.instructions}\n\n${buildMaterialsPrompt(layout)}`,
      maxSteps: Math.max(agent.maxSteps, MATERIALS_MAX_STEPS)
    }
  } catch (err) {
    console.warn('Learning materials are unavailable for this request:', err)
    return agent
  }
}
