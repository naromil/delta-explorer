import { describe, expect, it } from 'vitest'
import type { Turn } from '../src/conversation'
import type { ExpansionNode } from '../src/rich-text'
import {
  TERM_KEY_LIMIT,
  earlierExpansionOfTerm,
  expansionTermKey,
  expansionsOfTerm
} from '../src/expansion-terms'

const node = (overrides: Partial<ExpansionNode> = {}): ExpansionNode => ({
  id: 1,
  start: 0,
  end: 4,
  originalText: 'term',
  answer: 'An answer.',
  status: 'done',
  folded: false,
  children: [],
  ...overrides
})

const turn = (id: number, expansions: ExpansionNode[]): Turn => ({
  id,
  role: 'assistant',
  content: 'Some answer text.',
  expansions
})

describe('expansionTermKey', () => {
  it('spells a term one way whatever its markdown, case, spacing or edge punctuation', () => {
    expect(expansionTermKey('**Krebs  cycle**')).toBe('krebs cycle')
    expect(expansionTermKey('`Krebs cycle`,')).toBe('krebs cycle')
    expect(expansionTermKey('“Krebs\ncycle.”')).toBe('krebs cycle')
    expect(expansionTermKey('[Krebs cycle](https://example.com)')).toBe('krebs cycle')
  })

  it('keeps punctuation inside the term', () => {
    expect(expansionTermKey('e.g.')).toBe('e.g')
    expect(expansionTermKey('C++')).toBe('c++')
    expect(expansionTermKey('long-term')).toBe('long-term')
  })

  it('treats nothing and a long passage as no term', () => {
    expect(expansionTermKey('  ...  ')).toBe('')
    expect(expansionTermKey('a'.repeat(TERM_KEY_LIMIT))).toBe('a'.repeat(TERM_KEY_LIMIT))
    expect(expansionTermKey('a'.repeat(TERM_KEY_LIMIT + 1))).toBe('')
  })
})

describe('expansionsOfTerm', () => {
  it('finds finished expansions of the term, nested ones included, in turn order', () => {
    const nested = node({ id: 3, originalText: 'Mitochondria' })
    const turns = [
      turn(2, [node({ id: 1, originalText: '*mitochondria*' })]),
      turn(4, [node({ id: 2, originalText: 'ATP', children: [nested] })])
    ]
    const found = expansionsOfTerm(turns, 'mitochondria')
    expect(found.map(({ turnId, node }) => [turnId, node.id])).toEqual([
      [2, 1],
      [4, 3]
    ])
  })

  it('skips answers that failed, are still streaming or are blank', () => {
    const turns = [
      turn(2, [
        node({ id: 1, status: 'error', answer: '' }),
        node({ id: 2, status: 'loading', answer: 'Partial' }),
        node({ id: 3, answer: '  ' }),
        node({ id: 4 })
      ])
    ]
    expect(expansionsOfTerm(turns, 'term').map(({ node }) => node.id)).toEqual([4])
  })

  it('matches nothing for an empty key', () => {
    expect(expansionsOfTerm([turn(2, [node({ originalText: '...' })])], '')).toEqual([])
  })
})

describe('earlierExpansionOfTerm', () => {
  it('finds the newest earlier expansion of the term elsewhere in the conversation', () => {
    const turns = [
      turn(2, [node({ id: 1, start: 0, end: 4 })]),
      turn(4, [node({ id: 3, start: 10, end: 14 })]),
      turn(6, [node({ id: 5, start: 0, end: 4, status: 'loading', answer: '' })])
    ]
    expect(earlierExpansionOfTerm(turns, 5)?.node.id).toBe(3)
    expect(earlierExpansionOfTerm(turns, 3)?.node.id).toBe(1)
    expect(earlierExpansionOfTerm(turns, 1)).toBeNull()
  })

  it('leaves out other answers on the same range, which the frame lists already', () => {
    const turns = [
      turn(2, [node({ id: 1, folded: true }), node({ id: 2, prompt: 'Why?' })]),
      turn(4, [node({ id: 3, start: 20, end: 24, originalText: 'Other' })])
    ]
    expect(earlierExpansionOfTerm(turns, 2)).toBeNull()
  })

  it('finds nothing for an unknown id or a passage', () => {
    const passage = 'p'.repeat(TERM_KEY_LIMIT + 1)
    const turns = [
      turn(2, [node({ id: 1, originalText: passage })]),
      turn(4, [node({ id: 2, originalText: passage })])
    ]
    expect(earlierExpansionOfTerm(turns, 9)).toBeNull()
    expect(earlierExpansionOfTerm(turns, 2)).toBeNull()
  })
})
