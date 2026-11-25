import type { ToolSet } from 'ai'
import type { AgentTools } from './provider'

/**
 * What the window shows while the model works through its tools instead of answering. The
 * label of the newest call stays up until text arrives, since the model's next step, not
 * the tool itself, is what the user waits for.
 */

const FIELD_LIMIT = 60

function field(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return ''
  const value = (input as Record<string, unknown>)[key]
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT - 1)}…` : text
}

function withDetail(label: string, detail: string): string {
  return detail && detail !== '.' ? `${label}: ${detail}` : label
}

function quoted(label: string, text: string): string {
  return text ? `${label} for “${text}”` : label
}

/** A short, human description of one tool call; input is model-written, so nothing is trusted. */
export function toolActivityLabel(name: string, input: unknown): string {
  switch (name) {
    case 'memory_ls':
      return 'Looking through your notes'
    case 'memory_cat':
      return withDetail('Reading your notes', field(input, 'path'))
    case 'memory_grep':
      return quoted('Searching your notes', field(input, 'text'))
    case 'memory_write':
      return withDetail('Writing a note', field(input, 'path'))
    case 'memory_edit':
      return withDetail('Updating a note', field(input, 'path'))
    case 'memory_mkdir':
    case 'memory_mv':
      return 'Organizing your notes'
    case 'memory_rm':
      return withDetail('Removing a note', field(input, 'path'))
    case 'materials_ls':
      return 'Browsing your materials'
    case 'materials_find':
      return quoted('Looking in your materials', field(input, 'pattern'))
    case 'materials_cat':
    case 'materials_view':
      return field(input, 'path') ? `Reading ${field(input, 'path')}` : 'Reading a file'
    case 'materials_wc':
      return field(input, 'path') ? `Measuring ${field(input, 'path')}` : 'Measuring a file'
    case 'materials_grep':
      return quoted('Searching your materials', field(input, 'text'))
    case 'canvas_add_visual':
      return withDetail('Drawing a visual', field(input, 'title'))
    case 'canvas_add_explore':
      return withDetail('Adding a card to explore', field(input, 'question'))
    case 'canvas_suggest':
      return withDetail('Suggesting a question', field(input, 'question'))
    default:
      return 'Using a tool'
  }
}

/** Each tool reports its call before it runs; the result and any failure are left untouched. */
export function reportToolActivity(tools: ToolSet, report: (label: string) => void): ToolSet {
  const reported: ToolSet = {}
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute
    reported[name] = execute
      ? {
          ...tool,
          execute: (input: unknown, options: Parameters<typeof execute>[1]) => {
            try {
              report(toolActivityLabel(name, input))
            } catch (err) {
              console.warn('Failed to report a tool call:', err)
            }
            return execute(input, options)
          }
        }
      : tool
  }
  return reported
}

/** `agent` with every tool reporting to `report`; undefined (no tools) stays undefined. */
export function withToolActivity(
  agent: AgentTools | undefined,
  report: (label: string) => void
): AgentTools | undefined {
  if (!agent) return agent
  return { ...agent, tools: reportToolActivity(agent.tools, report) }
}
