import { describe, expect, it } from 'vitest'
import type { CanvasCard, CanvasPageCard, CanvasRect } from '../src/canvas'
import {
  normalizeCanvasLayout,
  sessionCardIds,
  sourceCardId,
  turnsThroughCard
} from '../src/canvas'
import { duplicateSelection } from '../src/canvas-arrange'
import { cardText, sessionAncestorIds } from '../src/canvas-selection'
import type { Turn } from '../src/conversation'
import { PAGE_LINKS_NOTE } from '../src/prompts'
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

function node(id: number, originalText: string, answer: string, prompt?: string): ExpansionNode {
  return {
    id,
    start: 0,
    end: originalText.length,
    originalText,
    answer,
    ...(prompt ? { prompt } : {}),
    status: 'done',
    folded: false,
    children: []
  }
}

const turns: Turn[] = [
  {
    id: 1,
    role: 'user',
    content: 'Chlorophyll absorbs light.',
    expansions: [node(7, 'Chlorophyll', 'A pigment.')]
  },
  { id: 2, role: 'user', content: 'Why green?', expansions: [] },
  { id: 3, role: 'assistant', content: 'It reflects green light.', expansions: [] }
]

const cards: CanvasCard[] = [
  page,
  { kind: 'message', id: 'q', rect: { ...at, y: 300 }, userTurnId: 2, turnId: 3, parentId: 'page' },
  { kind: 'expansion', id: 'x', rect: { ...at, x: 400 }, turnId: 1, expansionId: 7, hostId: 'page' }
]

describe('page cards', () => {
  it('start every session that continues them with the page as context', () => {
    const history = turnsThroughCard(cards, turns, 'q')
    expect(history.map((turn) => turn.id)).toEqual([1, 2, 3])
    expect(history[0].content).toContain('from a web page I am reading')
    expect(history[0].content).toContain('Photosynthesis — https://example.org/photosynthesis')
    expect(history[0].content).toContain(PAGE_LINKS_NOTE)
    expect(history[0].expansions).toEqual([])
  })

  it('ask a term selected on the page as a fresh expand instruction', () => {
    const history = turnsThroughCard(cards, turns, 'x')
    expect(history).toHaveLength(3)
    expect(history[1].role).toBe('user')
    expect(history[1].content).toContain('Chlorophyll')
    expect(history[2].content).toBe('A pigment.')
  })

  it('end a session walk and have no source of their own', () => {
    expect(sessionCardIds(cards, 'x')).toEqual(['x', 'page'])
    expect(sourceCardId(page)).toBeUndefined()
    expect([...sessionAncestorIds(cards, 'q')]).toEqual(['page'])
  })

  it('read as their title and page text', () => {
    expect(cardText(page, turns)).toEqual({
      title: 'Photosynthesis',
      body: 'Chlorophyll absorbs light.'
    })
  })

  it('survive normalization only with their turn, title and address', () => {
    const kept = normalizeCanvasLayout({ cards }, turns)
    expect(kept.cards.map((card) => card.id)).toEqual(['page', 'q', 'x'])
    const broken = normalizeCanvasLayout({ cards: [{ ...page, url: undefined }] }, turns)
    expect(broken.cards).toEqual([])
  })

  it('stay single when a selection is duplicated', () => {
    let next = 100
    const result = duplicateSelection(
      { cards, frames: [], links: [] },
      turns,
      new Set(['page', 'q']),
      {
        newId: () => `copy-${next++}`,
        newTurnId: () => next++,
        streamingTurnIds: new Set()
      }
    )
    expect(result?.cards.map((card) => card.kind)).toEqual(['message'])
  })
})
