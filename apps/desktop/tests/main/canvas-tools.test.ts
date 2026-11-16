import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import type { CanvasSpawn } from '@delta/core/canvas-spawn'
import { CANVAS_SPAWN_LIMITS } from '@delta/core/prompts'
import { createCanvasTools, withCanvasTools } from '../../src/main/canvas-tools'

function run(tools: ToolSet, name: string, input: Record<string, string>): unknown {
  const execute = tools[name].execute as (input: unknown, options: unknown) => unknown
  return execute(input, { toolCallId: 'call', messages: [] })
}

const agent = { tools: {}, instructions: 'Memory rules.', maxSteps: 10 }

describe('canvas tools', () => {
  it('report each card to the window and say so to the model', () => {
    const spawned: CanvasSpawn[] = []
    const tools = createCanvasTools({ explore: true }, (spawn) => spawned.push(spawn))
    const reply = run(tools, 'canvas_add_visual', {
      title: 'Parabola',
      content: '```graph\ny = x^2\n```',
      relation: 'graphed as'
    })
    run(tools, 'canvas_add_explore', { question: 'What is a vertex?', relation: 'has a' })
    expect(reply).toMatch(/Added/)
    expect(spawned.map((spawn) => spawn.kind)).toEqual(['visual', 'explore'])
  })

  it('refuse cards past the limit for one answer', () => {
    const spawned: CanvasSpawn[] = []
    const tools = createCanvasTools({ explore: true }, (spawn) => spawned.push(spawn))
    const replies = Array.from({ length: CANVAS_SPAWN_LIMITS.explore + 1 }, () =>
      run(tools, 'canvas_add_explore', { question: 'Why?', relation: '' })
    )
    expect(spawned).toHaveLength(CANVAS_SPAWN_LIMITS.explore)
    expect(replies.at(-1)).toMatch(/Not added/)
  })

  it('leave out exploration for a card the model added itself', () => {
    const tools = createCanvasTools({ explore: false }, () => undefined)
    expect(Object.keys(tools)).toEqual(['canvas_add_visual'])
  })

  it('join the memory tools, with their instructions and more steps', () => {
    const merged = withCanvasTools(agent, { explore: true }, () => undefined)
    expect(Object.keys(merged?.tools ?? {})).toContain('canvas_add_explore')
    expect(merged?.instructions).toMatch(/^Memory rules\.\n\n.*canvas/s)
    expect(merged?.maxSteps).toBeGreaterThan(agent.maxSteps)
  })

  it('are not offered to a model that holds no tools', () => {
    expect(withCanvasTools(undefined, { explore: true }, () => undefined)).toBeUndefined()
  })
})
