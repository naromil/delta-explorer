import { describe, expect, it } from 'vitest'
import {
  emptyKbState,
  KB_CHANGES_LIMIT,
  normalizeKbChanges,
  normalizeKbState
} from '../../src/shared/kb'

describe('normalizeKbState', () => {
  it('returns empty state for anything that is not an object', () => {
    expect(normalizeKbState(null)).toEqual(emptyKbState())
    expect(normalizeKbState('nope')).toEqual(emptyKbState())
    expect(normalizeKbState([])).toEqual(emptyKbState())
  })

  it('keeps valid timestamps and counts', () => {
    expect(
      normalizeKbState({
        lastRunAt: '2026-10-24T10:00:00.000Z',
        lastLearnedAt: '2026-10-24T09:00:00.000Z',
        lastAnalyzed: 3,
        lastError: 'API error 500',
        failedAttempts: 2
      })
    ).toEqual({
      lastRunAt: '2026-10-24T10:00:00.000Z',
      lastLearnedAt: '2026-10-24T09:00:00.000Z',
      lastAnalyzed: 3,
      lastError: 'API error 500',
      failedAttempts: 2,
      lastChanges: []
    })
  })

  it('replaces bad fields instead of trusting a hand-edited file', () => {
    expect(
      normalizeKbState({
        lastRunAt: '   ',
        lastLearnedAt: 42,
        lastAnalyzed: -1,
        lastError: '',
        failedAttempts: 1.9,
        lastChanges: 'everything'
      })
    ).toEqual({
      lastRunAt: null,
      lastLearnedAt: null,
      lastAnalyzed: 0,
      lastError: null,
      failedAttempts: 1,
      lastChanges: []
    })
  })
})

describe('normalizeKbChanges', () => {
  it('flattens a reply to one line and drops blank or malformed ones', () => {
    expect(
      normalizeKbChanges([
        { title: 'Graphs', summary: '  Added a note:\n\nBFS is solid, DFS is not.  ' },
        { title: 'Empty', summary: '   ' },
        { title: 'No summary' },
        null
      ])
    ).toEqual([{ title: 'Graphs', summary: 'Added a note: BFS is solid, DFS is not.' }])
  })

  it('cuts a long reply and a long list', () => {
    const many = Array.from({ length: KB_CHANGES_LIMIT + 3 }, (_, index) => ({
      title: `Conversation ${index}`,
      summary: 'x'.repeat(5000)
    }))
    const changes = normalizeKbChanges(many)
    expect(changes).toHaveLength(KB_CHANGES_LIMIT)
    expect(changes[0].summary.length).toBeLessThanOrEqual(400)
    expect(changes[0].summary.endsWith('…')).toBe(true)
  })
})
