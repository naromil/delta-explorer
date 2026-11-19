import { describe, expect, it, vi } from 'vitest'
import type { ConversationRecord, ConversationSearchResult } from '@delta/core/conversation'
import type { ExpansionNode } from '@delta/core/rich-text'
import { earlierElsewhere } from '../../src/renderer/src/hooks/useExpansionHistory'
import type { ConversationReader } from '../../src/renderer/src/hooks/useExpansionHistory'

function expansion(overrides: Partial<ExpansionNode> = {}): ExpansionNode {
  return {
    id: 1,
    start: 0,
    end: 5,
    originalText: 'Krebs cycle',
    answer: 'The citric acid cycle.',
    status: 'done',
    folded: true,
    children: [],
    ...overrides
  }
}

function record(id: string, expansions: ExpansionNode[]): ConversationRecord {
  return {
    id,
    source: 'chat',
    title: `Title ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    kbFed: false,
    state: {
      turns: [
        { id: 1, role: 'user', content: 'Q', expansions: [] },
        { id: 2, role: 'assistant', content: 'The Krebs cycle.', expansions }
      ]
    }
  }
}

function reader(records: ConversationRecord[]): ConversationReader {
  const results = records.map((r): ConversationSearchResult => ({
    id: r.id,
    source: r.source,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    kbFed: r.kbFed,
    turnCount: r.state.turns.length,
    matchedIn: 'content'
  }))
  return {
    searchConversations: vi.fn(async () => results),
    loadConversation: vi.fn(async (id: string) => records.find((r) => r.id === id) ?? null)
  }
}

describe('earlierElsewhere', () => {
  it('returns the newest answer to the term in the first conversation that holds one', async () => {
    const api = reader([
      record('a', []),
      record('b', [
        expansion({ id: 1, answer: 'Older answer.' }),
        expansion({ id: 2, originalText: '**krebs cycle**', prompt: 'Why?', answer: 'Newer.' })
      ]),
      record('c', [expansion({ answer: 'Not reached.' })])
    ])
    expect(await earlierElsewhere(api, 'krebs cycle', null)).toEqual({
      originalText: '**krebs cycle**',
      prompt: 'Why?',
      answer: 'Newer.',
      conversation: { id: 'b', source: 'chat', title: 'Title b' }
    })
    expect(api.searchConversations).toHaveBeenCalledWith('krebs cycle')
    expect(api.loadConversation).not.toHaveBeenCalledWith('c')
  })

  it('skips the open conversation and those that only mention the term', async () => {
    const api = reader([record('open', [expansion()]), record('b', [])])
    expect(await earlierElsewhere(api, 'krebs cycle', 'open')).toBeNull()
    expect(api.loadConversation).not.toHaveBeenCalledWith('open')
  })

  it('reads only the first few results', async () => {
    const records = Array.from({ length: 12 }, (_, i) => record(`r${i}`, []))
    records[11] = record('r11', [expansion()])
    const api = reader(records)
    expect(await earlierElsewhere(api, 'krebs cycle', null)).toBeNull()
    expect(vi.mocked(api.loadConversation).mock.calls.length).toBe(8)
  })
})
