import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { toolActivityLabel, withToolActivity } from '../../src/main/tool-activity'

function run(tools: ToolSet, name: string, input: unknown): unknown {
  const execute = tools[name].execute as (input: unknown, options: unknown) => unknown
  return execute(input, { toolCallId: 'call-1', messages: [] })
}

describe('toolActivityLabel', () => {
  it('describes each tool with the path or text it was given', () => {
    expect(toolActivityLabel('memory_cat', { path: 'index-learning.md' })).toBe(
      'Reading your notes: index-learning.md'
    )
    expect(toolActivityLabel('memory_grep', { text: 'calculus', path: '.' })).toBe(
      'Searching your notes for “calculus”'
    )
    expect(toolActivityLabel('memory_ls', { path: '.' })).toBe('Looking through your notes')
    expect(toolActivityLabel('materials_view', { path: 'notes/ch1.pdf' })).toBe(
      'Reading notes/ch1.pdf'
    )
    expect(toolActivityLabel('canvas_add_visual', { title: 'Parabola' })).toBe(
      'Drawing a visual: Parabola'
    )
  })

  it('distrusts the model-written input', () => {
    expect(toolActivityLabel('memory_cat', null)).toBe('Reading your notes')
    expect(toolActivityLabel('memory_cat', { path: 42 })).toBe('Reading your notes')
    expect(toolActivityLabel('materials_cat', {})).toBe('Reading a file')
    expect(toolActivityLabel('something_else', { path: 'x' })).toBe('Using a tool')
  })

  it('keeps a long field to one short line', () => {
    const label = toolActivityLabel('memory_grep', { text: `a\n${'b'.repeat(200)}` })
    expect(label).not.toContain('\n')
    expect(label.length).toBeLessThan(100)
    expect(label).toContain('…')
  })
})

describe('withToolActivity', () => {
  const tools: ToolSet = {
    memory_cat: tool({
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path }, { toolCallId }) => `${toolCallId}:${path}`
    })
  }
  const agent = { tools, instructions: 'Rules.', maxSteps: 10 }

  it('reports a call before running it and passes the result and options through', () => {
    const reported: string[] = []
    const wrapped = withToolActivity(agent, (label) => reported.push(label))
    expect(wrapped?.instructions).toBe('Rules.')
    expect(run(wrapped!.tools, 'memory_cat', { path: 'a.md' })).toBe('call-1:a.md')
    expect(reported).toEqual(['Reading your notes: a.md'])
  })

  it('still runs the tool when reporting throws', () => {
    const wrapped = withToolActivity(agent, () => {
      throw new Error('window gone')
    })
    expect(run(wrapped!.tools, 'memory_cat', { path: 'a.md' })).toBe('call-1:a.md')
  })

  it('leaves a model without tools without tools', () => {
    expect(withToolActivity(undefined, () => undefined)).toBeUndefined()
  })
})
