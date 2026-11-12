import { describe, expect, it } from 'vitest'
import type { Turn } from '../src/conversation'
import type { ExpansionNode } from '../src/rich-text'
import {
  highlightedPassages,
  isHighlighted,
  restartExpansion,
  soundHighlights,
  soundTurnHighlights,
  toggleHighlight,
  toggleHighlightInTurns
} from '../src/rich-text'

const node = (overrides: Partial<ExpansionNode> = {}): ExpansionNode => ({
  id: 7,
  start: 0,
  end: 4,
  originalText: 'term',
  answer: 'An answer about the term.',
  status: 'done',
  folded: false,
  children: [],
  ...overrides
})

const answer = (overrides: Partial<Turn> = {}): Turn => ({
  id: 2,
  role: 'assistant',
  content: 'Alpha beta gamma delta.',
  expansions: [node()],
  ...overrides
})

describe('soundHighlights', () => {
  it('drops malformed and empty ranges, clamps, sorts and merges', () => {
    expect(
      soundHighlights(
        [
          { start: 8, end: 12 },
          { start: 2, end: 4 },
          { start: 3, end: 9 },
          { start: 5, end: 5 },
          'x',
          { start: 20, end: 99 }
        ],
        24
      )
    ).toEqual([
      { start: 2, end: 12 },
      { start: 20, end: 24 }
    ])
    expect(soundHighlights(undefined, 10)).toEqual([])
  })
})

describe('toggleHighlight', () => {
  it('adds a range, merging with what it overlaps', () => {
    expect(toggleHighlight([{ start: 0, end: 5 }], { start: 3, end: 10 }, 20)).toEqual([
      { start: 0, end: 10 }
    ])
  })

  it('removes the highlights a range inside one touches', () => {
    const highlights = [
      { start: 0, end: 5 },
      { start: 8, end: 12 }
    ]
    expect(isHighlighted(highlights, { start: 1, end: 3 })).toBe(true)
    expect(toggleHighlight(highlights, { start: 1, end: 3 }, 20)).toEqual([{ start: 8, end: 12 }])
  })
})

describe('toggleHighlightInTurns', () => {
  it('highlights a turn content or a nested expansion answer', () => {
    const turns = [answer()]
    const inContent = toggleHighlightInTurns(turns, 2, { start: 6, end: 10 })
    expect(inContent[0].highlights).toEqual([{ start: 6, end: 10 }])

    const inAnswer = toggleHighlightInTurns(turns, 2, { start: 3, end: 9 }, 7)
    expect(inAnswer[0].expansions[0].highlights).toEqual([{ start: 3, end: 9 }])
    expect(inAnswer[0].highlights).toBeUndefined()
  })

  it('leaves the turns alone when the turn or expansion is gone', () => {
    const turns = [answer()]
    expect(toggleHighlightInTurns(turns, 99, { start: 0, end: 1 })).toBe(turns)
    expect(toggleHighlightInTurns(turns, 2, { start: 0, end: 1 }, 99)).toBe(turns)
  })

  it('forgets an answer highlight when that answer is asked again', () => {
    const turns = toggleHighlightInTurns([answer()], 2, { start: 3, end: 9 }, 7)
    expect(restartExpansion(turns, 7)[0].expansions[0].highlights).toBeUndefined()
  })
})

describe('soundTurnHighlights', () => {
  it('repairs stored highlights and drops empty lists', () => {
    const [turn] = soundTurnHighlights([
      answer({
        highlights: [{ start: 0, end: 500 }],
        expansions: [node({ highlights: [] })]
      })
    ])
    expect(turn.highlights).toEqual([{ start: 0, end: 23 }])
    expect('highlights' in turn.expansions[0]).toBe(false)
  })
})

describe('highlightedPassages', () => {
  it('returns the marked text without markdown', () => {
    expect(highlightedPassages('Make **ATP** now', [{ start: 5, end: 12 }])).toEqual(['ATP'])
  })
})
