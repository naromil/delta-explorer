import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import type { CanvasSpawn } from '@delta/core/canvas-spawn'
import {
  CANVAS_SPAWN_LIMITS,
  CANVAS_TOOL_DESCRIPTIONS,
  CANVAS_TOOL_FIELDS,
  buildCanvasToolInstructions
} from '@delta/core/prompts'
import type { AgentTools } from './provider'

/** Memory steps plus one per card a canvas answer may add. */
const CANVAS_EXTRA_STEPS = CANVAS_SPAWN_LIMITS.explore + CANVAS_SPAWN_LIMITS.visual

/** What a canvas send asks for: the visual tool always, the exploration tool unless spawned. */
export interface CanvasToolOptions {
  explore: boolean
}

/**
 * The canvas tools for one request. They only report: each call hands the card to `onSpawn`,
 * which forwards it to the window that asked, so nothing here touches the canvas itself.
 */
export function createCanvasTools(
  options: CanvasToolOptions,
  onSpawn: (spawn: CanvasSpawn) => void
): ToolSet {
  const added = { explore: 0, visual: 0 }
  const add = (spawn: CanvasSpawn): string => {
    if (added[spawn.kind] >= CANVAS_SPAWN_LIMITS[spawn.kind]) {
      return `Not added: this answer already has ${CANVAS_SPAWN_LIMITS[spawn.kind]} such cards.`
    }
    added[spawn.kind] += 1
    onSpawn(spawn)
    return 'Added the card beside your answer.'
  }
  const relation = z.string().describe(CANVAS_TOOL_FIELDS.relation)
  return {
    canvas_add_visual: tool({
      description: CANVAS_TOOL_DESCRIPTIONS.visual,
      inputSchema: z.object({
        title: z.string().describe(CANVAS_TOOL_FIELDS.title),
        content: z.string().describe(CANVAS_TOOL_FIELDS.content),
        relation
      }),
      execute: ({ title, content, relation }) => add({ kind: 'visual', title, content, relation })
    }),
    ...(options.explore
      ? {
          canvas_add_explore: tool({
            description: CANVAS_TOOL_DESCRIPTIONS.explore,
            inputSchema: z.object({
              question: z.string().describe(CANVAS_TOOL_FIELDS.question),
              relation
            }),
            execute: ({ question, relation }) => add({ kind: 'explore', question, relation })
          })
        }
      : {})
  }
}

/**
 * `agent` (the memory tools) with the canvas tools added. Undefined stays undefined: that is
 * a model the catalog says holds no tools, which would not get these either.
 */
export function withCanvasTools(
  agent: AgentTools | undefined,
  options: CanvasToolOptions,
  onSpawn: (spawn: CanvasSpawn) => void
): AgentTools | undefined {
  if (!agent) return undefined
  return {
    ...agent,
    tools: { ...agent.tools, ...createCanvasTools(options, onSpawn) },
    instructions: `${agent.instructions}\n\n${buildCanvasToolInstructions(options.explore)}`,
    maxSteps: agent.maxSteps + CANVAS_EXTRA_STEPS
  }
}
