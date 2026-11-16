/**
 * Where a network's nodes go. A small force layout (nodes repel, edges pull) run for a fixed
 * number of rounds from a ring, so the same network always draws the same way, then stretched
 * to fill the box it is drawn in.
 */

export interface LayoutEdge {
  from: number
  to: number
}

export interface LayoutPoint {
  x: number
  y: number
}

const ROUNDS = 300

function spread(values: number[], low: number, high: number): number[] {
  const min = Math.min(...values)
  const span = Math.max(...values) - min
  // Nodes in one line have no extent this way: they sit in the middle of it.
  if (span < 1e-6) return values.map(() => (low + high) / 2)
  return values.map((value) => low + ((value - min) / span) * (high - low))
}

export interface LayoutBox {
  width: number
  height: number
  /** Kept clear at the edges, for the boxes drawn on the points. */
  padX: number
  padY: number
  /** The room one node's box needs: two nodes closer than this both ways are pushed apart. */
  gapX: number
  gapY: number
}

const SEPARATE_ROUNDS = 80

/**
 * Forces settle distances between points, but what is drawn on them are wide boxes, so nodes
 * that would cover each other are moved apart along whichever way needs the smaller move.
 */
function separate(points: LayoutPoint[], box: LayoutBox): LayoutPoint[] {
  const clamp = (value: number, low: number, high: number): number =>
    Math.min(high, Math.max(low, value))
  for (let round = 0; round < SEPARATE_ROUNDS; round += 1) {
    let moved = false
    for (let a = 0; a < points.length; a += 1) {
      for (let b = a + 1; b < points.length; b += 1) {
        const dx = points[b].x - points[a].x
        const dy = points[b].y - points[a].y
        const overX = box.gapX - Math.abs(dx)
        const overY = box.gapY - Math.abs(dy)
        if (overX <= 0 || overY <= 0) continue
        moved = true
        if (overX / box.gapX < overY / box.gapY) {
          const shift = (overX / 2) * (dx < 0 ? -1 : 1)
          points[a].x -= shift
          points[b].x += shift
        } else {
          const shift = (overY / 2) * (dy < 0 ? -1 : 1)
          points[a].y -= shift
          points[b].y += shift
        }
      }
    }
    for (const point of points) {
      point.x = clamp(point.x, box.padX, box.width - box.padX)
      point.y = clamp(point.y, box.padY, box.height - box.padY)
    }
    if (!moved) break
  }
  return points
}

/**
 * A point per node inside `width` × `height`, keeping `padX` and `padY` clear at the edges
 * for the boxes drawn on the points.
 */
export function layoutNetwork(count: number, edges: LayoutEdge[], box: LayoutBox): LayoutPoint[] {
  if (count === 0) return []
  const points = Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * 2 * Math.PI - Math.PI / 2
    return { x: Math.cos(angle), y: Math.sin(angle) }
  })
  const links = edges.filter((edge) => edge.from !== edge.to)
  // The distance two joined nodes settle at, on a ring of radius 1.
  const ideal = 2 / Math.sqrt(count)
  for (let round = 0; round < ROUNDS; round += 1) {
    const moves = points.map(() => ({ x: 0, y: 0 }))
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const dx = points[a].x - points[b].x
        const dy = points[a].y - points[b].y
        const distance = Math.max(0.01, Math.hypot(dx, dy))
        const push = (ideal * ideal) / distance
        moves[a].x += (dx / distance) * push
        moves[a].y += (dy / distance) * push
        moves[b].x -= (dx / distance) * push
        moves[b].y -= (dy / distance) * push
      }
    }
    for (const { from, to } of links) {
      const dx = points[from].x - points[to].x
      const dy = points[from].y - points[to].y
      const distance = Math.max(0.01, Math.hypot(dx, dy))
      const pull = (distance * distance) / ideal
      moves[from].x -= (dx / distance) * pull
      moves[from].y -= (dy / distance) * pull
      moves[to].x += (dx / distance) * pull
      moves[to].y += (dy / distance) * pull
    }
    // Steps shrink each round, so the layout settles instead of circling.
    const limit = 0.2 * (1 - round / ROUNDS)
    points.forEach((point, index) => {
      const length = Math.hypot(moves[index].x, moves[index].y)
      if (length < 1e-9) return
      const step = Math.min(length, limit)
      point.x += (moves[index].x / length) * step
      point.y += (moves[index].y / length) * step
    })
  }
  const xs = spread(
    points.map((point) => point.x),
    box.padX,
    box.width - box.padX
  )
  const ys = spread(
    points.map((point) => point.y),
    box.padY,
    box.height - box.padY
  )
  return separate(
    points.map((_, index) => ({ x: xs[index], y: ys[index] })),
    box
  )
}
