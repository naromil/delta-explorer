import { describe, expect, it } from 'vitest'
import { findTextMatches } from '../../src/renderer/src/components/conversation/find-text'

describe('findTextMatches', () => {
  it('finds every match in a node, ignoring case', () => {
    expect(findTextMatches(['A graph is a Graph'], 'graph')).toEqual([
      { start: { node: 0, offset: 2 }, end: { node: 0, offset: 7 } },
      { start: { node: 0, offset: 13 }, end: { node: 0, offset: 18 } }
    ])
  })

  it('matches across the nodes that bold or a link cut a sentence into', () => {
    expect(findTextMatches(['a breadth-', 'first', ' search'], 'breadth-first search')).toEqual([
      { start: { node: 0, offset: 2 }, end: { node: 2, offset: 7 } }
    ])
  })

  it('ends a match in the node holding its last character', () => {
    expect(findTextMatches(['abc', 'def'], 'bc')).toEqual([
      { start: { node: 0, offset: 1 }, end: { node: 0, offset: 3 } }
    ])
    expect(findTextMatches(['abc', '', 'def'], 'def')).toEqual([
      { start: { node: 2, offset: 0 }, end: { node: 2, offset: 3 } }
    ])
  })

  it('does not count overlapping matches twice', () => {
    expect(findTextMatches(['aaaa'], 'aa')).toHaveLength(2)
  })

  it('returns nothing for an empty query or no text', () => {
    expect(findTextMatches(['text'], '')).toEqual([])
    expect(findTextMatches([], 'text')).toEqual([])
  })

  it('stops at the limit', () => {
    expect(findTextMatches(['a'.repeat(100)], 'a', 10)).toHaveLength(10)
  })

  it('keeps offsets true around a character whose lower case is longer', () => {
    expect(findTextMatches(['İ then word'], 'word')).toEqual([
      { start: { node: 0, offset: 7 }, end: { node: 0, offset: 11 } }
    ])
  })
})
