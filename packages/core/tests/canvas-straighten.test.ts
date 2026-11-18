import { describe, expect, it } from 'vitest'
import type {
  CanvasCard,
  CanvasExpansionCard,
  CanvasMessageCard,
  CanvasNoteCard,
  CanvasRect
} from '../src/canvas'
import { rectsOverlap, sharedSide } from '../src/canvas'
import type { CanvasMoving } from '../src/canvas-selection'
import { straightenBlocks } from '../src/canvas-straighten'

const rect = (x: number, y: number, w = 100, h = 100): CanvasRect => ({ x, y, w, h })

function message(id: string, at: CanvasRect, parentId?: string): CanvasMessageCard {
  return { kind: 'message', id, rect: at, userTurnId: 1, turnId: 2, parentId }
}

function expansion(id: string, hostId: string, at: CanvasRect): CanvasExpansionCard {
  return { kind: 'expansion', id, rect: at, turnId: 2, expansionId: 1, hostId }
}

function note(id: string, at: CanvasRect): CanvasNoteCard {
  return { kind: 'note', id, rect: at, text: 'a thought' }
}

function block(...ids: string[]): CanvasMoving {
  return { cards: new Set(ids), frames: new Set() }
}

function applied(cards: CanvasCard[], moved: Map<string, CanvasRect>): CanvasCard[] {
  return cards.map((card) => ({ ...card, rect: moved.get(card.id) ?? card.rect }))
}

function byId(cards: CanvasCard[]): Record<string, CanvasRect> {
  return Object.fromEntries(cards.map((card) => [card.id, card.rect]))
}

describe('straightenBlocks', () => {
  it('lines a nearly aligned continuation up with its parent, keeping the seam', () => {
    const cards = [message('a', rect(0, 0, 300, 200)), message('b', rect(18, 200, 200, 100), 'a')]
    const at = byId(applied(cards, straightenBlocks(cards, [block('a', 'b')])))
    expect(at.b).toEqual({ x: 0, y: 200, w: 200, h: 100 })
    expect(at.a).toEqual(cards[0].rect)
    expect(sharedSide(at.a, at.b)).toBe('bottom')
  })

  it('aligns the tops of a card attached on the right', () => {
    const cards = [message('a', rect(0, 0, 300, 200)), expansion('e', 'a', rect(300, 12, 200, 150))]
    const at = byId(applied(cards, straightenBlocks(cards, [block('a', 'e')])))
    expect(at.e).toEqual({ x: 300, y: 0, w: 200, h: 150 })
  })

  it('names nothing when the block is already straight', () => {
    const cards = [message('a', rect(0, 0, 300, 200)), message('b', rect(0, 200, 200, 100), 'a')]
    expect(straightenBlocks(cards, [block('a', 'b')]).size).toBe(0)
  })

  it('names nothing for a single card, or cards that do not all touch', () => {
    const cards = [message('a', rect(0, 0)), message('b', rect(500, 500), 'a')]
    expect(straightenBlocks(cards, [block('a')]).size).toBe(0)
    expect(straightenBlocks(cards, [block('a', 'b')]).size).toBe(0)
  })

  it('leaves a block holding a frame alone', () => {
    const cards = [message('a', rect(0, 0, 300, 200)), message('b', rect(18, 200, 200, 100), 'a')]
    const framed: CanvasMoving = { cards: new Set(['a', 'b']), frames: new Set(['f']) }
    expect(straightenBlocks(cards, [framed]).size).toBe(0)
  })

  it('touches only cards inside the given blocks', () => {
    const cards = [
      message('a', rect(0, 0, 300, 200)),
      message('b', rect(18, 200, 200, 100), 'a'),
      message('c', rect(1000, 0, 300, 200)),
      message('d', rect(1018, 200, 200, 100), 'c')
    ]
    const moved = straightenBlocks(cards, [block('a', 'b')])
    expect([...moved.keys()].sort()).toEqual(['a', 'b'])
  })

  it('keeps a session seam over a mere touch', () => {
    // `n` touches `b` but `c` continues it; straightening must not trade the seam away.
    const cards = [
      message('a', rect(0, 0, 300, 200)),
      message('b', rect(30, 200, 200, 100), 'a'),
      message('c', rect(230, 230, 100, 300), 'b'),
      note('n', rect(20, -100, 120, 100))
    ]
    const at = byId(applied(cards, straightenBlocks(cards, [block('a', 'b', 'c', 'n')])))
    expect(sharedSide(at.a, at.b)).toBeDefined()
    expect(sharedSide(at.b, at.c)).toBeDefined()
    expect(sharedSide(at.a, at.n)).toBeDefined()
  })

  it('keeps a touch the cards were placed against, not only the ones that hold them', () => {
    // `c` continues `b` but also sits under `a`: no straightening of `d` may cost that touch.
    const cards = [
      message('a', rect(0, 0, 180, 100)),
      message('b', rect(180, 0, 220, 100), 'a'),
      message('c', rect(0, 100, 220, 100), 'b'),
      message('d', rect(220, 100, 170, 100), 'c')
    ]
    const moved = straightenBlocks(cards, [block('a', 'b', 'c', 'd')])
    const at = byId(applied(cards, moved))
    for (const [one, other] of [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
      ['c', 'd']
    ]) {
      expect(sharedSide(at[one], at[other])).toBeDefined()
    }
  })

  it('never resizes, detaches or overlaps, and a second pass changes nothing', () => {
    let seed = 29
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }
    for (let round = 0; round < 60; round++) {
      // A chain of cards, each against a random side of an earlier one, slightly off line.
      const cards: CanvasCard[] = [message('c0', rect(0, 0, 200 + random(200), 100 + random(200)))]
      for (let i = 1; i < 5; i++) {
        const parent = cards[random(cards.length)]
        const p = parent.rect
        const w = 120 + random(200)
        const h = 80 + random(200)
        const shift = random(40) - 20
        const side = random(4)
        const at =
          side === 0
            ? rect(p.x + p.w, p.y + shift, w, h)
            : side === 1
              ? rect(p.x + shift, p.y + p.h, w, h)
              : side === 2
                ? rect(p.x - w, p.y + shift, w, h)
                : rect(p.x + shift, p.y - h, w, h)
        if (cards.some((card) => rectsOverlap(card.rect, at))) continue
        cards.push(message(`c${i}`, at, parent.id))
      }
      const all = block(...cards.map((card) => card.id))
      const once = applied(cards, straightenBlocks(cards, [all]))

      once.forEach((card, i) => {
        expect([card.rect.w, card.rect.h]).toEqual([cards[i].rect.w, cards[i].rect.h])
      })
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          if (sharedSide(cards[i].rect, cards[j].rect)) {
            expect(sharedSide(once[i].rect, once[j].rect)).toBeDefined()
          }
          if (!rectsOverlap(cards[i].rect, cards[j].rect)) {
            expect(rectsOverlap(once[i].rect, once[j].rect)).toBe(false)
          }
        }
      }
      expect(straightenBlocks(once, [all]).size).toBe(0)
    }
  })
})
