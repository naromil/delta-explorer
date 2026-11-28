import { describe, expect, it } from 'vitest'
import type { ConversationMeta, ConversationRecord } from '@delta/core/conversation'
import type { ExpansionNode } from '@delta/core/rich-text'
import { loadExploredConversations } from '../../src/renderer/src/views/explored/load-explored'
import type {
  ConversationLoader,
  LoadProgress
} from '../../src/renderer/src/views/explored/load-explored'

function expansion(id: number): ExpansionNode {
  return {
    id,
    start: 0,
    end: 5,
    originalText: 'Krebs cycle',
    answer: 'The citric acid cycle.',
    status: 'done',
    folded: true,
    children: []
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

function loader(records: Array<ConversationRecord | Error>): ConversationLoader {
  const ids = records.map((r, i) => (r instanceof Error ? `broken-${i}` : r.id))
  return {
    listConversations: async () =>
      ids.map((id): ConversationMeta => ({
        id,
        source: 'chat',
        title: id,
        createdAt: '',
        updatedAt: '',
        kbFed: false,
        turnCount: 2
      })),
    loadConversation: async (id) => {
      const found = records[ids.indexOf(id)]
      if (found instanceof Error) throw found
      return found ?? null
    }
  }
}

describe('loadExploredConversations', () => {
  it('keeps only the turns with expansions, without their text', async () => {
    const loaded = await loadExploredConversations(
      loader([record('a', [expansion(1)]), record('b', [])])
    )
    expect(loaded).toEqual([
      {
        id: 'a',
        source: 'chat',
        title: 'Title a',
        updatedAt: '2026-01-02T00:00:00.000Z',
        state: { turns: [{ id: 2, content: '', expansions: [expansion(1)] }] }
      }
    ])
  })

  it('skips a record that fails to load and reports every read', async () => {
    const progress: LoadProgress[] = []
    const loaded = await loadExploredConversations(
      loader([record('a', [expansion(1)]), new Error('corrupt'), record('c', [expansion(2)])]),
      (next) => progress.push(next)
    )
    expect(loaded.map(({ id }) => id).sort()).toEqual(['a', 'c'])
    expect(progress[0]).toEqual({ read: 0, total: 3 })
    expect(progress.at(-1)).toEqual({ read: 3, total: 3 })
  })

  it('stops reading once cancelled', async () => {
    let reads = 0
    const records = Array.from({ length: 20 }, (_, i) => record(`r${i}`, [expansion(i)]))
    const api = loader(records)
    const counting: ConversationLoader = {
      ...api,
      loadConversation: (id) => {
        reads += 1
        return api.loadConversation(id)
      }
    }
    let cancelled = false
    const loaded = await loadExploredConversations(
      counting,
      ({ read }) => {
        if (read >= 2) cancelled = true
      },
      () => cancelled
    )
    expect(reads).toBeLessThan(20)
    expect(loaded.length).toBeLessThan(20)
  })
})
