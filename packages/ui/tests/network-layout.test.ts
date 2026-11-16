import { describe, expect, it } from 'vitest'
import { layoutNetwork } from '../src/lib/network-layout'

const BOX = { width: 150, height: 100, padX: 20, padY: 9, gapX: 36, gapY: 19 }

describe('layoutNetwork', () => {
  const edges = [
    { from: 0, to: 1 },
    { from: 0, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 3 },
    { from: 2, to: 4 },
    { from: 4, to: 4 }
  ]

  it('keeps every node inside the padded box and apart from the others', () => {
    const points = layoutNetwork(5, edges, BOX)
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(BOX.padX - 1e-6)
      expect(point.x).toBeLessThanOrEqual(BOX.width - BOX.padX + 1e-6)
      expect(point.y).toBeGreaterThanOrEqual(BOX.padY - 1e-6)
      expect(point.y).toBeLessThanOrEqual(BOX.height - BOX.padY + 1e-6)
    }
    for (let a = 0; a < points.length; a += 1) {
      for (let b = a + 1; b < points.length; b += 1) {
        const apartX = Math.abs(points[a].x - points[b].x) >= BOX.gapX - 1e-6
        const apartY = Math.abs(points[a].y - points[b].y) >= BOX.gapY - 1e-6
        expect(apartX || apartY).toBe(true)
      }
    }
  })

  it('draws the same network the same way', () => {
    expect(layoutNetwork(5, edges, BOX)).toEqual(layoutNetwork(5, edges, BOX))
  })

  it('places one node in the middle and none nowhere', () => {
    expect(layoutNetwork(0, [], BOX)).toEqual([])
    expect(layoutNetwork(1, [], BOX)).toEqual([{ x: 75, y: 50 }])
  })
})
