/**
 * Tidying the canvas, family by family. Cards attached to each other form a block, which stays
 * attached and is only straightened (`canvas-straighten.ts`). A family is the blocks that
 * parent-child relationships connect: each is drawn as a tree that keeps every child on the side
 * of its parent it stood on (right, below, left or above), so branches never wind around each
 * other. Families are then packed apart, in the order that crosses the fewest of the lines left
 * between them. A drawn link never joins anything; it only affects that order. Everything is pure.
 */
import type { CanvasArrangeResult, CanvasBlock, PlacedBlock } from './canvas-arrange'
import { blocksFor, placedRect, settleBlocks } from './canvas-arrange'
import type { CanvasCard, CanvasLayout, CanvasPoint, CanvasRect } from './canvas'
import { askedAboutRelations, cardRects, rectClearOf, sharesSide } from './canvas'
import { boundsOf, movingBounds } from './canvas-selection'
import { straightenBlocks } from './canvas-straighten'

export type TidyItems = Pick<CanvasLayout, 'cards' | 'frames' | 'links'>

interface ParentEdge {
  parent: CanvasCard
  child: CanvasCard
}

interface TidyFamily {
  blocks: CanvasBlock[]
  edges: ParentEdge[]
}

/** A family, with `placed` relative to its own corner. */
interface TidyBox {
  placed: PlacedBlock[]
  w: number
  h: number
}

/** A pair of cards with a line drawn between them. */
type CardLine = readonly [string, string]

/** Space kept from what stays put. */
const CLEARANCE = 48
/** Between children on the same side of their parent. */
const SIBLING_GAP = 48
/** Between a parent and its children. */
const LAYER_GAP = 72
/** Wider than anything inside a family, so families read as families. */
const FAMILY_GAP = 120
/** The shape a tidied canvas aims for, roughly a window's. */
const TIDY_ASPECT = 1.6
const ORDER_PASSES = 4
/** With more families than this, an order is only tried against its near neighbours. */
const FULL_SEARCH_FAMILIES = 12
const NEAR_SEARCH_REACH = 4
/** One crossing costs more than any length of line can save. */
const CROSSING_COST = 1e9
/** A line running behind a card it does not belong to, which is bad but less so than a crossing. */
const OVER_CARD_COST = 1e8

function shifted(rect: CanvasRect, by: CanvasPoint): CanvasRect {
  return { ...rect, x: rect.x + by.x, y: rect.y + by.y }
}

function centerOf(rect: CanvasRect): CanvasPoint {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/* ---- Families ---- */

function parentEdges(items: TidyItems, blockOf: ReadonlyMap<string, CanvasBlock>): ParentEdge[] {
  const byId = new Map(items.cards.map((card) => [card.id, card]))
  return items.cards.flatMap((child): ParentEdge[] => {
    const parentId =
      child.kind === 'message' ? child.parentId : child.kind === 'expansion' ? child.hostId : null
    const parent = parentId ? byId.get(parentId) : undefined
    if (!parent || !blockOf.has(parent.id) || !blockOf.has(child.id)) return []
    if (blockOf.get(parent.id) === blockOf.get(child.id)) return []
    return [{ parent, child }]
  })
}

function familiesOf(
  blocks: CanvasBlock[],
  edges: ParentEdge[],
  blockOf: ReadonlyMap<string, CanvasBlock>
): TidyFamily[] {
  const leader = new Map(blocks.map((block) => [block, block]))
  const find = (block: CanvasBlock): CanvasBlock => {
    const next = leader.get(block) as CanvasBlock
    return next === block ? block : find(next)
  }
  for (const { parent, child } of edges) {
    leader.set(
      find(blockOf.get(parent.id) as CanvasBlock),
      find(blockOf.get(child.id) as CanvasBlock)
    )
  }
  const families = new Map<CanvasBlock, TidyFamily>()
  for (const block of blocks) {
    const key = find(block)
    const family = families.get(key) ?? { blocks: [], edges: [] }
    family.blocks.push(block)
    families.set(key, family)
  }
  for (const edge of edges) {
    families.get(find(blockOf.get(edge.parent.id) as CanvasBlock))?.edges.push(edge)
  }
  return [...families.values()]
}

function spansOverlap(aStart: number, aLength: number, bStart: number, bLength: number): boolean {
  return aStart < bStart + bLength && bStart < aStart + aLength
}

/* ---- Trees that keep their directions ---- */

type TidyDirection = 'right' | 'below' | 'left' | 'above'

/** The order groups are placed in: a later group moves out of an earlier one's way. */
const DIRECTIONS: readonly TidyDirection[] = ['right', 'below', 'left', 'above']

/** One block and everything under it, relative to the corner of what they cover. */
interface TreeBox {
  placed: PlacedBlock[]
  w: number
  h: number
  /** Where the tree's own block stands in the box. */
  root: CanvasRect
}

/**
 * Which side of its parent a child stands on, measured in units of the two cards' half sizes so a
 * wide card beside a tall one is still read as beside it. Down wins a tie, as that is where Enter
 * continues. Tidying keeps every child on this side, so a second tidy reads the same sides.
 */
function directionOf(parent: CanvasRect, child: CanvasRect): TidyDirection {
  const from = centerOf(parent)
  const to = centerOf(child)
  const across = (to.x - from.x) / ((parent.w + child.w) / 2)
  const down = (to.y - from.y) / ((parent.h + child.h) / 2)
  if (Math.abs(across) > Math.abs(down)) return across > 0 ? 'right' : 'left'
  return down >= 0 ? 'below' : 'above'
}

function boxesOverlap(a: CanvasRect, b: CanvasRect): boolean {
  return spansOverlap(a.x, a.w, b.x, b.w) && spansOverlap(a.y, a.h, b.y, b.h)
}

/**
 * The children on one side of `root`, stacked across that side in the order they stood and
 * centred on it, then moved out until they stand clear of `taken`. The gap from the parent is
 * wide enough that each child still reads as being on this side.
 */
function placeSide(
  root: CanvasRect,
  side: TidyDirection,
  trees: TreeBox[],
  taken: CanvasRect[]
): Array<{ tree: TreeBox; x: number; y: number }> {
  const sideways = side === 'right' || side === 'left'
  // Across the side: stack the trees, then centre their own blocks on the parent.
  let along = 0
  const offsets = trees.map((tree) => {
    const at = along
    along += (sideways ? tree.h : tree.w) + SIBLING_GAP
    return at
  })
  const rootMid = (tree: TreeBox, i: number): number =>
    offsets[i] + (sideways ? tree.root.y + tree.root.h / 2 : tree.root.x + tree.root.w / 2)
  const parentMid = sideways ? root.y + root.h / 2 : root.x + root.w / 2
  const shift =
    parentMid - (rootMid(trees[0], 0) + rootMid(trees[trees.length - 1], trees.length - 1)) / 2
  const cross = offsets.map((offset) => offset + shift)

  // Out from the side: far enough that every child is read on this side again.
  let gap = LAYER_GAP
  trees.forEach((tree, i) => {
    const { root: own } = tree
    const offCentre = Math.abs(rootMid(tree, i) + shift - parentMid)
    const [mainHalf, crossHalf] = sideways
      ? [(root.w + own.w) / 2, (root.h + own.h) / 2]
      : [(root.h + own.h) / 2, (root.w + own.w) / 2]
    const lead =
      side === 'right'
        ? own.x
        : side === 'left'
          ? tree.w - own.x - own.w
          : side === 'below'
            ? own.y
            : tree.h - own.y - own.h
    const ownHalf = sideways ? own.w / 2 : own.h / 2
    const parentHalf = sideways ? root.w / 2 : root.h / 2
    const needed = (offCentre * mainHalf) / crossHalf + 1 - parentHalf - lead - ownHalf
    gap = Math.max(gap, Math.ceil(needed))
  })

  const at = (distance: number): Array<{ tree: TreeBox; x: number; y: number }> =>
    trees.map((tree, i) => {
      if (side === 'right') return { tree, x: root.x + root.w + distance, y: cross[i] }
      if (side === 'left') return { tree, x: root.x - distance - tree.w, y: cross[i] }
      if (side === 'below') return { tree, x: cross[i], y: root.y + root.h + distance }
      return { tree, x: cross[i], y: root.y - distance - tree.h }
    })
  // Moving further out only makes the side clearer, so this always ends.
  let distance = gap
  for (;;) {
    const spots = at(distance)
    const boxes = spots.map(({ tree, x, y }) => ({ x, y, w: tree.w, h: tree.h }))
    const hits = taken.filter((other) => boxes.some((box) => boxesOverlap(box, other)))
    if (hits.length === 0) return spots
    const reach = Math.max(
      ...hits.map((other) =>
        side === 'right'
          ? other.x + other.w - root.x - root.w
          : side === 'left'
            ? root.x - other.x
            : side === 'below'
              ? other.y + other.h - root.y - root.h
              : root.y - other.y
      )
    )
    distance = Math.max(distance + 1, reach + SIBLING_GAP)
  }
}

/** A block with its children around it on the sides they stood, each child with its own. */
function layOutTree(
  block: CanvasBlock,
  childrenOf: ReadonlyMap<CanvasBlock, CanvasBlock[]>
): TreeBox {
  const root: CanvasRect = { x: 0, y: 0, w: block.rect.w, h: block.rect.h }
  const placed: PlacedBlock[] = [{ block, x: 0, y: 0 }]
  const taken: CanvasRect[] = [root]
  const children = childrenOf.get(block) ?? []
  for (const side of DIRECTIONS) {
    const sideways = side === 'right' || side === 'left'
    const group = children
      .filter((child) => directionOf(block.rect, child.rect) === side)
      .sort((a, b) =>
        sideways ? centerOf(a.rect).y - centerOf(b.rect).y : centerOf(a.rect).x - centerOf(b.rect).x
      )
    if (group.length === 0) continue
    const trees = group.map((child) => layOutTree(child, childrenOf))
    for (const { tree, x, y } of placeSide(root, side, trees, taken)) {
      taken.push({ x, y, w: tree.w, h: tree.h })
      for (const item of tree.placed) placed.push({ ...item, x: item.x + x, y: item.y + y })
    }
  }
  const bounds = boundsOf(placed.map(placedRect)) as CanvasRect
  return {
    placed: placed.map((item) => ({ ...item, x: item.x - bounds.x, y: item.y - bounds.y })),
    w: bounds.w,
    h: bounds.h,
    root: { ...root, x: -bounds.x, y: -bounds.y }
  }
}

/**
 * A family as trees: every child stays on the side of its parent it stood on, so what the user
 * laid out right, left, up or down still reads that way and branches do not wind around each
 * other. A block reached from two parents hangs from the first; one with none starts a tree.
 */
function layOutFamily(family: TidyFamily, blockOf: ReadonlyMap<string, CanvasBlock>): TidyBox[] {
  const reading = [...family.blocks].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  const parentsOf = new Map<CanvasBlock, CanvasBlock[]>()
  for (const { parent, child } of family.edges) {
    const from = blockOf.get(parent.id) as CanvasBlock
    const to = blockOf.get(child.id) as CanvasBlock
    parentsOf.set(to, [...(parentsOf.get(to) ?? []), from])
  }
  const childrenOf = new Map<CanvasBlock, CanvasBlock[]>()
  const reached = new Set<CanvasBlock>()
  const roots: CanvasBlock[] = []
  const grow = (start: CanvasBlock): void => {
    roots.push(start)
    reached.add(start)
    const queue = [start]
    while (queue.length > 0) {
      const block = queue.shift() as CanvasBlock
      for (const { parent, child } of family.edges) {
        if (blockOf.get(parent.id) !== block) continue
        const next = blockOf.get(child.id) as CanvasBlock
        if (reached.has(next)) continue
        reached.add(next)
        childrenOf.set(block, [...(childrenOf.get(block) ?? []), next])
        queue.push(next)
      }
    }
  }
  for (const block of reading) if (!parentsOf.has(block) && !reached.has(block)) grow(block)
  // Stored parent links are not trusted: a cycle still gets drawn from somewhere.
  for (const block of reading) if (!reached.has(block)) grow(block)
  return roots.map((root) => {
    const { placed, w, h } = layOutTree(root, childrenOf)
    return { placed, w, h }
  })
}

/* ---- Packing the families ---- */

/** Each box at the highest place with room, then the leftmost, inside `width`. */
function packBoxes(boxes: TidyBox[], width: number): CanvasPoint[] {
  const taken: CanvasRect[] = []
  const lowestClearY = (x: number, w: number, h: number): number => {
    let y = 0
    let hit: CanvasRect | undefined
    do {
      hit = taken.find(
        (other) =>
          spansOverlap(x - FAMILY_GAP, w + FAMILY_GAP * 2, other.x, other.w) &&
          spansOverlap(y - FAMILY_GAP, h + FAMILY_GAP * 2, other.y, other.h)
      )
      if (hit) y = hit.y + hit.h + FAMILY_GAP
    } while (hit)
    return y
  }
  return boxes.map(({ w, h }) => {
    const spot = [0, ...taken.map((other) => other.x + other.w + FAMILY_GAP)]
      .filter((x) => x === 0 || x + w <= width)
      .map((x) => ({ x, y: lowestClearY(x, w, h) }))
      .reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a))
    taken.push({ ...spot, w, h })
    return spot
  })
}

function crossesProperly(a: CanvasPoint, b: CanvasPoint, c: CanvasPoint, d: CanvasPoint): boolean {
  const turn = (p: CanvasPoint, q: CanvasPoint, r: CanvasPoint): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0
}

/** Whether a segment passes through the rectangle (Liang-Barsky clipping). */
function segmentHitsRect(a: CanvasPoint, b: CanvasPoint, rect: CanvasRect): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let enter = 0
  let leave = 1
  const edges = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.w - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.h - a.y]
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q <= 0) return false
    } else if (p < 0) {
      enter = Math.max(enter, q / p)
    } else {
      leave = Math.min(leave, q / p)
    }
  }
  return enter < leave
}

/** Every line still drawn once a group is laid out: seams between touching cards are not lines. */
function linesBetween(items: TidyItems, boxes: TidyBox[]): CardLine[] {
  const rects = new Map<string, CanvasRect>()
  const known = new Map(items.cards.map((card) => [card.id, card]))
  for (const box of boxes) {
    for (const { block, x, y } of box.placed) {
      const offset = { x: x - block.rect.x, y: y - block.rect.y }
      for (const id of block.cards) {
        const card = known.get(id)
        if (card) rects.set(id, shifted(card.rect, offset))
      }
    }
  }
  const sameBox = (a: string, b: string): boolean =>
    boxes.some((box) => box.placed.some(({ block }) => block.cards.has(a) && block.cards.has(b)))
  const parentLines = items.cards.flatMap((card): CardLine[] => {
    const parent =
      card.kind === 'message' ? card.parentId : card.kind === 'expansion' ? card.hostId : undefined
    return parent ? [[parent, card.id]] : []
  })
  return [
    ...parentLines.filter(([a, b]) => {
      const one = rects.get(a)
      const two = rects.get(b)
      return one && two && !sameBox(a, b) && !sharesSide(one, two)
    }),
    ...items.links.map((link): CardLine => [link.from, link.to]),
    ...askedAboutRelations(items.cards).map((line): CardLine => [line.from, line.to])
  ].filter(([a, b]) => a !== b && rects.has(a) && rects.has(b))
}

/** What an order of boxes costs: crossings, then lines over other cards, then line length. */
function orderCost(
  order: TidyBox[],
  spots: CanvasPoint[],
  lines: CardLine[],
  items: TidyItems
): number {
  const rects = new Map<string, CanvasRect>()
  const byId = new Map(items.cards.map((card) => [card.id, card]))
  order.forEach((box, i) => {
    for (const { block, x, y } of box.placed) {
      const offset = { x: x + spots[i].x - block.rect.x, y: y + spots[i].y - block.rect.y }
      for (const id of block.cards) {
        const card = byId.get(id)
        if (card) rects.set(id, shifted(card.rect, offset))
      }
    }
  })
  const center = (id: string): CanvasPoint => centerOf(rects.get(id) as CanvasRect)
  let cost = 0
  lines.forEach(([a, b], i) => {
    const from = center(a)
    const to = center(b)
    cost += Math.hypot(to.x - from.x, to.y - from.y)
    for (const [id, rect] of rects) {
      if (id !== a && id !== b && segmentHitsRect(from, to, rect)) cost += OVER_CARD_COST
    }
    for (const [c, d] of lines.slice(i + 1)) {
      if (a === c || a === d || b === c || b === d) continue
      if (crossesProperly(from, to, center(c), center(d))) cost += CROSSING_COST
    }
  })
  return cost
}

/** Families with lines between them next to each other, then swaps while one crosses fewer lines. */
function orderBoxes(
  boxes: TidyBox[],
  lines: CardLine[],
  items: TidyItems,
  width: number
): TidyBox[] {
  const boxOf = new Map<string, TidyBox>()
  for (const box of boxes) {
    for (const { block } of box.placed) {
      for (const id of block.cards) boxOf.set(id, box)
    }
  }
  const neighbours = new Map<TidyBox, TidyBox[]>(boxes.map((box) => [box, []]))
  for (const [a, b] of lines) {
    const one = boxOf.get(a) as TidyBox
    const two = boxOf.get(b) as TidyBox
    if (one !== two) {
      neighbours.get(one)?.push(two)
      neighbours.get(two)?.push(one)
    }
  }
  const order: TidyBox[] = []
  const visit = (box: TidyBox): void => {
    if (order.includes(box)) return
    order.push(box)
    for (const next of neighbours.get(box) as TidyBox[]) visit(next)
  }
  boxes.forEach(visit)
  if (lines.length < 2) return order

  const movable = order.flatMap((box, i) =>
    (neighbours.get(box) as TidyBox[]).length > 0 ? [i] : []
  )
  const reach = movable.length <= FULL_SEARCH_FAMILIES ? movable.length : NEAR_SEARCH_REACH
  let best = orderCost(order, packBoxes(order, width), lines, items)
  for (let pass = 0; pass < ORDER_PASSES; pass++) {
    let improved = false
    for (let i = 0; i < movable.length; i++) {
      for (let j = i + 1; j < Math.min(i + 1 + reach, movable.length); j++) {
        const [a, b] = [movable[i], movable[j]]
        ;[order[a], order[b]] = [order[b], order[a]]
        const cost = orderCost(order, packBoxes(order, width), lines, items)
        if (cost < best) {
          best = cost
          improved = true
        } else {
          ;[order[a], order[b]] = [order[b], order[a]]
        }
      }
    }
    if (!improved) break
  }
  return order
}

function movesAnything(items: TidyItems, result: CanvasArrangeResult): boolean {
  if (!result.ok) return false
  const standing = new Map([...items.cards, ...items.frames].map((item) => [item.id, item.rect]))
  return [...result.cards, ...result.frames].some(({ id, rect }) => {
    const before = standing.get(id)
    return !before || before.x !== rect.x || before.y !== rect.y
  })
}

/**
 * Tidies the selection, or everything without one. Attached cards are straightened, each family
 * is drawn in layers, and families are packed apart. Lines to anything staying put do not count,
 * and what stays is cleared by moving the result down. Refuses when nothing would move, such as
 * a canvas where every card is attached.
 */
export function tidySelection(
  items: TidyItems,
  selected?: ReadonlySet<string>
): CanvasArrangeResult {
  const ids =
    selected ??
    new Set([...items.cards.map((card) => card.id), ...items.frames.map((frame) => frame.id)])
  const found = blocksFor(items, ids)
  if (found.length === 0) return { ok: false }
  const straight = straightenBlocks(items.cards, found)
  const tidied: TidyItems = {
    ...items,
    cards: items.cards.map((card) => ({ ...card, rect: straight.get(card.id) ?? card.rect }))
  }
  const blocks = found.map(
    (block) => ({ ...block, rect: movingBounds(tidied, block) as CanvasRect }) as CanvasBlock
  )
  const bounds = boundsOf(blocks.map((block) => block.rect)) as CanvasRect

  const blockOf = new Map(
    blocks.flatMap((block) => [...block.cards].map((id) => [id, block] as const))
  )
  const families = familiesOf(blocks, parentEdges(tidied, blockOf), blockOf)
  // Size first keeps a second tidy from reshuffling; reading order only separates equals.
  const boxes = families
    .flatMap((family) =>
      layOutFamily(family, blockOf).map((box) => ({
        box,
        at: boundsOf(box.placed.map(({ block }) => block.rect)) as CanvasRect
      }))
    )
    .sort((a, b) => b.box.h - a.box.h || b.box.w - a.box.w || a.at.y - b.at.y || a.at.x - b.at.x)
    .map(({ box }) => box)

  const area = boxes.reduce((sum, { w, h }) => sum + (w + FAMILY_GAP) * (h + FAMILY_GAP), 0)
  const widest = Math.max(...boxes.map((box) => box.w))
  const width = Math.max(Math.sqrt(area * TIDY_ASPECT), widest)
  const order = orderBoxes(boxes, linesBetween(tidied, boxes), tidied, width)
  const spots = packBoxes(order, width)

  const packed = order.flatMap((box, i) =>
    box.placed.map((item) => ({ ...item, x: item.x + spots[i].x, y: item.y + spots[i].y }))
  )
  const moving = new Set(blocks.flatMap((block) => [...block.cards]))
  const packedBounds = boundsOf(packed.map(placedRect)) as CanvasRect
  const landing = rectClearOf(
    { ...packedBounds, x: bounds.x, y: bounds.y },
    cardRects(tidied.cards, moving),
    CLEARANCE
  )
  const result = settleBlocks(
    tidied,
    packed.map((item) => ({ ...item, x: item.x + landing.x, y: item.y + landing.y }))
  )
  return result.ok && movesAnything(items, result) ? result : { ok: false }
}
