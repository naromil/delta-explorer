import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_TITLE_SYSTEM_PROMPT } from '@delta/core/prompts'

const { callProviderStream } = vi.hoisted(() => ({ callProviderStream: vi.fn() }))

vi.mock('../../src/main/provider', () => ({ callProviderStream }))

import { generateConversationTitle } from '../../src/main/conversation-title'

async function* streamOf(...chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk
}

async function* failingAfter(chunk: string): AsyncGenerator<string> {
  yield chunk
  throw new Error('connection reset')
}

describe('generateConversationTitle', () => {
  beforeEach(() => {
    callProviderStream.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('joins the streamed reply and cleans it into a title', async () => {
    callProviderStream.mockReturnValue(streamOf('Title: "Photo', 'synthesis basics".\n', 'extra'))
    await expect(generateConversationTitle('How do plants make food?')).resolves.toBe(
      'Photosynthesis basics'
    )
  })

  it('asks the assistant role with the title prompt and a timeout signal', async () => {
    callProviderStream.mockReturnValue(streamOf('Plant food'))
    await generateConversationTitle('How do plants make food?')
    expect(callProviderStream).toHaveBeenCalledTimes(1)
    const [messages, role, signal] = callProviderStream.mock.calls[0]
    expect(role).toBe('chat')
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(messages[0]).toEqual({ role: 'system', content: CONVERSATION_TITLE_SYSTEM_PROMPT })
    expect(messages[1]).toEqual({ role: 'user', content: 'How do plants make food?' })
  })

  it('returns null for a blank message without calling the model', async () => {
    await expect(generateConversationTitle('  \n ')).resolves.toBeNull()
    expect(callProviderStream).not.toHaveBeenCalled()
  })

  it('returns null when the model replies with nothing usable', async () => {
    callProviderStream.mockReturnValue(streamOf('', '  \n', '""'))
    await expect(generateConversationTitle('Hi')).resolves.toBeNull()
  })

  it('returns null instead of throwing when the call fails before streaming', async () => {
    callProviderStream.mockImplementation(() => {
      throw new Error('No model assigned')
    })
    await expect(generateConversationTitle('Hi')).resolves.toBeNull()
  })

  it('returns null instead of throwing when the stream fails midway', async () => {
    callProviderStream.mockReturnValue(failingAfter('Partial'))
    await expect(generateConversationTitle('Hi')).resolves.toBeNull()
  })
})
