import { describe, expect, it } from 'vitest'
import { formatRelativeTime } from '../src/lib/format'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

describe('formatRelativeTime', () => {
  it.each([
    [0, 'Just now'],
    [59 * SECOND, 'Just now'],
    [MINUTE, '1m ago'],
    [59 * MINUTE + 59 * SECOND, '59m ago'],
    [HOUR, '1h ago'],
    [23 * HOUR + 59 * MINUTE, '23h ago'],
    [DAY, '1d ago'],
    [7 * DAY - SECOND, '6d ago']
  ])('labels %i ms ago as %s', (ms, label) => {
    expect(formatRelativeTime(ago(ms), NOW)).toBe(label)
  })

  it('shows the date from seven days on', () => {
    const iso = ago(7 * DAY)
    expect(formatRelativeTime(iso, NOW)).toBe(new Date(iso).toLocaleDateString())
  })

  it('treats a timestamp in the future as just now', () => {
    expect(formatRelativeTime(ago(-5 * MINUTE), NOW)).toBe('Just now')
  })
})
