import { describe, expect, it } from 'vitest'
import type { Turn } from '../src/conversation'
import type { ExpansionNode } from '../src/rich-text'
import type { MappedConversation } from '../src/expansion-map'
import { buildExpansionMap, filterExpansionMap } from '../src/expansion-map'
import { expansionTermLabel } from '../src/expansion-terms'

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

const conversation = (
  id: string,
  updatedAt: string,
  turns: Turn[],
  source: MappedConversation['source'] = 'chat'
): MappedConversation => ({ id, source, title: `Title ${id}`, updatedAt, state: { turns } })

describe('expansionTermLabel', () => {
  it('keeps the case the user saw while dropping markdown and edge punctuation', () => {
    expect(expansionTermLabel('**Krebs  cycle**,')).toBe('Krebs cycle')
    expect(expansionTermLabel('x'.repeat(200))).toBe('')
  })
})

describe('buildExpansionMap', () => {
  it('counts a term across conversations under one spelling, newest place first', () => {
    const map = buildExpansionMap([
      conversation('a', '2026-01-01T00:00:00Z', [
        turn(1, [node({ id: 1, originalText: 'krebs cycle' })]),
        turn(3, [node({ id: 2, originalText: '**Krebs cycle**' })])
      ]),
      conversation(
        'b',
        '2026-02-01T00:00:00Z',
        [turn(1, [node({ id: 5, originalText: 'Krebs Cycle.' })])],
        'canvas'
      )
    ])
    expect(map).toHaveLength(1)
    expect(map[0]).toMatchObject({
      key: 'krebs cycle',
      label: 'Krebs Cycle',
      count: 3,
      lastSeen: '2026-02-01T00:00:00Z'
    })
    expect(map[0].places.map(({ id, count, source }) => [id, count, source])).toEqual([
      ['b', 1, 'canvas'],
      ['a', 2, 'chat']
    ])
  })

  it('leaves out passages, failed, streaming and blank answers', () => {
    const map = buildExpansionMap([
      conversation('a', '2026-01-01T00:00:00Z', [
        turn(1, [
          node({ id: 1, originalText: 'p'.repeat(120) }),
          node({ id: 2, originalText: 'failed', status: 'error' }),
          node({ id: 3, originalText: 'streaming', status: 'loading', answer: 'Half' }),
          node({ id: 4, originalText: 'blank', answer: '  ' }),
          node({ id: 5, originalText: 'kept' })
        ])
      ])
    ])
    expect(map.map(({ key }) => key)).toEqual(['kept'])
  })

  it('connects a term to the terms expanded inside its answers, through a passage', () => {
    const map = buildExpansionMap([
      conversation('a', '2026-01-01T00:00:00Z', [
        turn(1, [
          node({
            id: 1,
            originalText: 'mitochondria',
            children: [
              node({ id: 2, originalText: 'ATP' }),
              node({
                id: 3,
                originalText: 'a long passage '.repeat(10),
                children: [node({ id: 4, originalText: 'proton gradient' })]
              }),
              node({ id: 5, originalText: 'Mitochondria' })
            ]
          })
        ])
      ])
    ])
    const byKey = new Map(map.map((term) => [term.key, term]))
    expect(byKey.get('mitochondria')?.ledTo).toEqual(['atp', 'proton gradient'])
    expect(byKey.get('mitochondria')?.cameFrom).toEqual([])
    expect(byKey.get('atp')?.cameFrom).toEqual(['mitochondria'])
    expect(byKey.get('proton gradient')?.cameFrom).toEqual(['mitochondria'])
    expect(byKey.get('mitochondria')?.count).toBe(2)
  })

  it('lists repeated terms first, then the most recently seen', () => {
    const map = buildExpansionMap([
      conversation('old', '2026-01-01T00:00:00Z', [
        turn(1, [node({ id: 1, originalText: 'repeated' }), node({ id: 2, originalText: 'old' })])
      ]),
      conversation('new', '2026-03-01T00:00:00Z', [
        turn(1, [node({ id: 1, originalText: 'new' })])
      ]),
      conversation('mid', '2026-02-01T00:00:00Z', [
        turn(1, [node({ id: 1, originalText: 'repeated' })])
      ])
    ])
    expect(map.map(({ key }) => key)).toEqual(['repeated', 'new', 'old'])
  })

  it('ranks connections by how often they were made', () => {
    const child = (id: number, text: string): ExpansionNode => node({ id, originalText: text })
    const map = buildExpansionMap([
      conversation('a', '2026-01-01T00:00:00Z', [
        turn(1, [node({ id: 1, originalText: 'root', children: [child(2, 'b'), child(3, 'c')] })]),
        turn(3, [node({ id: 4, originalText: 'root', children: [child(5, 'c')] })])
      ])
    ])
    expect(map.find(({ key }) => key === 'root')?.ledTo).toEqual(['c', 'b'])
  })
})

describe('filterExpansionMap', () => {
  const map = buildExpansionMap([
    conversation('a', '2026-01-01T00:00:00Z', [
      turn(1, [node({ id: 1, originalText: 'Krebs cycle' }), node({ id: 2, originalText: 'ATP' })])
    ])
  ])

  it('keeps the terms whose spelling holds the query, in any case', () => {
    expect(filterExpansionMap(map, ' KREBS ').map(({ key }) => key)).toEqual(['krebs cycle'])
  })

  it('keeps every term for a blank query', () => {
    expect(filterExpansionMap(map, '  ')).toBe(map)
  })
})
