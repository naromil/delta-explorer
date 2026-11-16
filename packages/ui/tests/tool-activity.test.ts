import { describe, expect, it } from 'vitest'
import {
  NO_ACTIVITY_LABELS,
  NO_TOOL_ACTIVITY,
  liveActivityLabels,
  resolveToolActivity,
  withActivityLabel,
  withoutActivityLabel
} from '../src/lib/tool-activity'

describe('tool activity labels', () => {
  it('maps each request to the turn or expansion it answers', () => {
    let labels = withActivityLabel(NO_ACTIVITY_LABELS, 'send', 'Reading notes', { turnId: 4 })
    labels = withActivityLabel(labels, 'expand', 'Searching', { expansionId: 9 })
    const activity = resolveToolActivity(labels)
    expect(activity.turns.get(4)).toBe('Reading notes')
    expect(activity.expansions.get(9)).toBe('Searching')
    expect(activity.turns.has(9)).toBe(false)
  })

  it('keeps only the newest label of a request', () => {
    let labels = withActivityLabel(NO_ACTIVITY_LABELS, 'send', 'First', { turnId: 1 })
    labels = withActivityLabel(labels, 'send', 'Second', { turnId: 1 })
    expect(resolveToolActivity(labels).turns.get(1)).toBe('Second')
  })

  it('returns the same map when nothing changes, so state does not re-render', () => {
    const labels = withActivityLabel(NO_ACTIVITY_LABELS, 'send', 'Reading', { turnId: 1 })
    expect(withoutActivityLabel(labels, 'other')).toBe(labels)
    expect(liveActivityLabels(labels, () => true)).toBe(labels)
    expect(resolveToolActivity(NO_ACTIVITY_LABELS)).toBe(NO_TOOL_ACTIVITY)
  })

  it('forgets the labels of dropped requests', () => {
    let labels = withActivityLabel(NO_ACTIVITY_LABELS, 'old', 'Reading', { turnId: 1 })
    labels = withActivityLabel(labels, 'new', 'Writing', { turnId: 2 })
    const live = liveActivityLabels(labels, (id) => id === 'new')
    expect([...live.keys()]).toEqual(['new'])
    expect(withoutActivityLabel(live, 'new').size).toBe(0)
  })
})
