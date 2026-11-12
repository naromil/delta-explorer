import { describe, expect, it } from 'vitest'
import {
  claudeCodeArgs,
  claudeCodeMcpArgs,
  claudeCodePrompt,
  claudeCodeToolName,
  readClaudeCodeEvent
} from '../../src/main/services/claude-code'

describe('claudeCodePrompt', () => {
  it('sends a lone question as it is, with the system messages as the system prompt', () => {
    expect(
      claudeCodePrompt([
        { role: 'system', content: 'Be brief.' },
        { role: 'system', content: 'Memory rules.' },
        { role: 'user', content: 'What is ATP?' }
      ])
    ).toEqual({ system: 'Be brief.\n\nMemory rules.', prompt: 'What is ATP?' })
  })

  it('puts earlier turns in a transcript before the newest message', () => {
    const { prompt } = claudeCodePrompt([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'And mitosis?' }
    ])
    expect(prompt).toContain('User: Hi\n\nAssistant: Hello')
    expect(prompt.endsWith('And mitosis?')).toBe(true)
  })
})

describe('claudeCodeArgs', () => {
  it('runs headless with no tools, MCP servers or settings', () => {
    const args = claudeCodeArgs('sonnet', 'sys')
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config']))
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('sys')
  })

  it('leaves the model to Claude Code when none is chosen', () => {
    expect(claudeCodeArgs(' ', '')).not.toContain('--model')
  })
})

describe('readClaudeCodeEvent', () => {
  it('reads text deltas and ignores everything else', () => {
    const delta = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }
    }
    expect(readClaudeCodeEvent(JSON.stringify(delta))).toEqual({ text: 'Hi' })
    expect(readClaudeCodeEvent('{"type":"system","subtype":"init"}')).toEqual({})
    expect(readClaudeCodeEvent('not json')).toEqual({})
  })

  it('turns an error result into an error', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' })
    expect(readClaudeCodeEvent(line)).toEqual({ error: 'Claude Code: Not logged in' })
  })
})

describe('claudeCodeMcpArgs', () => {
  it('names only our server and allows exactly its tools', () => {
    const tools = { memory_cat: {}, memory_write: {} } as never
    const args = claudeCodeMcpArgs(
      { url: 'http://127.0.0.1:1/mcp', token: 't' },
      {
        tools,
        maxSteps: 10
      }
    )
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect(Object.keys(config.mcpServers)).toEqual(['delta-memory'])
    expect(config.mcpServers['delta-memory'].headers.Authorization).toBe('Bearer t')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      `${claudeCodeToolName('memory_cat')},${claudeCodeToolName('memory_write')}`
    )
    expect(args[args.indexOf('--max-turns') + 1]).toBe('10')
  })
})

describe('readClaudeCodeEvent steps', () => {
  it('marks each new model message and a run out of turns', () => {
    const start = { type: 'stream_event', event: { type: 'message_start', message: {} } }
    expect(readClaudeCodeEvent(JSON.stringify(start))).toEqual({ step: true })
    const out = { type: 'result', subtype: 'error_max_turns', is_error: true }
    expect(readClaudeCodeEvent(JSON.stringify(out))).toMatchObject({ outOfTurns: true })
  })
})
