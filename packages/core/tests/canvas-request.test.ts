import { describe, expect, it } from 'vitest'
import type { CanvasCard, CanvasMessageCard, CanvasPageCard, CanvasRect } from '../src/canvas'
import { expansionCardRequest, messageCardRequest } from '../src/canvas-request'
import type { Turn } from '../src/conversation'
import { buildExpandUserInstruction, getSystemPrompt } from '../src/prompts'
import type { ExpansionNode } from '../src/rich-text'

const at: CanvasRect = { x: 0, y: 0, w: 400, h: 300 }

const page: CanvasPageCard = {
  kind: 'page',
  id: 'page',
  rect: at,
  turnId: 1,
  title: 'Photosynthesis',
  url: 'https://example.org/photosynthesis'
}

const nested: ExpansionNode = {
  id: 7,
  start: 0,
  end: 11,
  originalText: 'Chlorophyll',
  answer: 'A green pigment.',
  status: 'done',
  folded: false,
  children: []
}

const turns: Turn[] = [
  { id: 1, role: 'user', content: 'Chlorophyll absorbs light.', expansions: [nested] },
  { id: 2, role: 'user', content: 'Why green?', expansions: [] },
  { id: 3, role: 'assistant', content: 'It reflects green light.', expansions: [] }
]

const question: CanvasMessageCard = {
  kind: 'message',
  id: 'q',
  rect: { ...at, y: 300 },
  userTurnId: 2,
  turnId: 3,
  parentId: 'page'
}

const cards: CanvasCard[] = [page, question]

describe('canvas requests', () => {
  it('send a message its session, the page first, and the length that fits', () => {
    // The answer being written is still blank.
    const asking = turns.map((turn) => (turn.id === 3 ? { ...turn, content: '' } : turn))
    const messages = messageCardRequest(cards, [], asking, question, 7)
    expect(messages[0]).toEqual({ role: 'system', content: getSystemPrompt('chat') })
    expect(messages[1].content).toContain('Chlorophyll absorbs light.')
    expect(messages.at(-1)?.content).toContain('Why green?')
    expect(messages.at(-1)?.content).toMatch(/\d+ words/)
  })

  it('ask about a term on a page with the page as context, never as an earlier question', () => {
    const messages = expansionCardRequest(
      cards,
      [],
      turns,
      turns[0],
      { start: 12, end: 19 },
      undefined,
      at,
      'absorbs',
      7
    )
    expect(messages?.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(messages?.[1].content).toContain('https://example.org/photosynthesis')
    expect(messages?.[2].content).toContain(buildExpandUserInstruction('absorbs'))
  })

  it('walk the chain of expansions a nested term on a page sits in', () => {
    const messages = expansionCardRequest(
      cards,
      [],
      turns,
      turns[0],
      { start: 8, end: 15, parentExpansionId: 7 },
      undefined,
      at,
      'pigment',
      7
    )
    expect(messages?.map((message) => message.role)).toEqual([
      'system',
      'user',
      'user',
      'assistant',
      'user'
    ])
    expect(messages?.[3].content).toBe('A green pigment.')
  })

  it('refuse a turn no card holds', () => {
    const orphan: Turn = { id: 9, role: 'assistant', content: 'Gone.', expansions: [] }
    expect(
      expansionCardRequest(
        cards,
        [],
        [...turns, orphan],
        orphan,
        { start: 0, end: 4 },
        undefined,
        at,
        'Gone',
        7
      )
    ).toBeNull()
  })
})
