import { describe, expect, it } from 'vitest'
import type { CanvasCard, CanvasMessageCard } from '../src/canvas'
import { normalizeCanvasLayout, rectsOverlap } from '../src/canvas'
import {
  SPAWN_SIZES,
  settleSpawns,
  soundSpawn,
  spawnRect,
  spawnRole,
  untouchedSpawns
} from '../src/canvas-spawn'
import type { TidyItems } from '../src/canvas-tidy'
import type { Turn } from '../src/conversation'

const answer: CanvasMessageCard = {
  kind: 'message',
  id: 'a',
  rect: { x: 0, y: 0, w: 400, h: 300 },
  userTurnId: 1,
  turnId: 2
}

describe('soundSpawn', () => {
  it('keeps a usable visual or exploration, trimmed', () => {
    expect(
      soundSpawn({ kind: 'visual', title: ' Parabola ', content: '\n```graph\ny = x^2\n```\n' })
    ).toEqual({
      kind: 'visual',
      title: 'Parabola',
      content: '```graph\ny = x^2\n```',
      relation: ''
    })
    expect(
      soundSpawn({ kind: 'explore', question: 'What is a vertex?', relation: 'has a' })
    ).toEqual({ kind: 'explore', question: 'What is a vertex?', relation: 'has a' })
  })

  it('keeps a known role and drops an unknown one', () => {
    expect(soundSpawn({ kind: 'explore', question: 'Why?', role: 'background' })).toMatchObject({
      role: 'background'
    })
    const unknown = soundSpawn({ kind: 'explore', question: 'Why?', role: 'sideways' })!
    expect(unknown).not.toHaveProperty('role')
    expect(spawnRole(unknown)).toBe('deeper')
    expect(spawnRole({ kind: 'visual', title: 't', content: 'c', relation: '' })).toBe('visual')
  })

  it('refuses what cannot become a card', () => {
    expect(soundSpawn(null)).toBeNull()
    expect(soundSpawn({ kind: 'explore', question: '  ' })).toBeNull()
    expect(soundSpawn({ kind: 'visual', title: 'Empty', content: '' })).toBeNull()
    expect(soundSpawn({ kind: 'note', text: 'x' })).toBeNull()
  })

  it('names an untitled visual', () => {
    expect(soundSpawn({ kind: 'visual', content: 'x' })).toMatchObject({ title: 'Visual' })
  })
})

describe('spawnRect', () => {
  it('puts a deeper exploration on the right of the answer, level with its top', () => {
    const rect = spawnRect([answer], 'a', 'explore')
    expect(rect).toMatchObject({ y: 0, ...SPAWN_SIZES.explore })
    expect(rect!.x).toBeGreaterThan(400)
  })

  it('puts background on the left, and examples and visuals below', () => {
    const left = spawnRect([answer], 'a', 'explore', 'background')!
    expect(left.x + left.w).toBeLessThan(0)
    expect(left.y).toBe(0)
    for (const [kind, role] of [
      ['explore', 'example'],
      ['visual', 'visual']
    ] as const) {
      const below = spawnRect([answer], 'a', kind, role)!
      expect(below.x).toBe(0)
      expect(below.y).toBeGreaterThan(300)
    }
    expect(spawnRect([answer], 'a', 'visual')).toEqual(spawnRect([answer], 'a', 'visual', 'visual'))
  })

  it('stacks later cards below earlier ones, overlapping nothing', () => {
    const cards: CanvasCard[] = [answer]
    for (const kind of ['explore', 'explore', 'explore'] as const) {
      const rect = spawnRect(cards, 'a', kind)!
      for (const card of cards) expect(rectsOverlap(rect, card.rect)).toBe(false)
      cards.push({ kind: 'note', id: `n${cards.length}`, rect, text: '' })
    }
    expect(cards[2].rect.y).toBeGreaterThan(cards[1].rect.y)
  })

  it('stacks later cards on every side, overlapping nothing', () => {
    for (const role of ['background', 'example'] as const) {
      const cards: CanvasCard[] = [answer]
      for (let i = 0; i < 3; i++) {
        const rect = spawnRect(cards, 'a', 'explore', role)!
        for (const card of cards) expect(rectsOverlap(rect, card.rect)).toBe(false)
        cards.push({ kind: 'note', id: `n${i}`, rect, text: '' })
      }
    }
  })

  it('places nothing for a card that is gone', () => {
    expect(spawnRect([answer], 'gone', 'explore')).toBeNull()
  })
})

describe('spawned cards at load', () => {
  const turns: Turn[] = [
    { id: 1, role: 'user', content: 'q', expansions: [] },
    { id: 2, role: 'assistant', content: 'a', expansions: [] }
  ]

  it('keep a sound mark and relation, and drop broken ones', () => {
    const layout = normalizeCanvasLayout(
      {
        cards: [
          { ...answer, spawned: 'yes', relation: '   ' },
          { ...answer, id: 'b', parentId: 'a', spawned: true, relation: ' graphed as ' }
        ]
      },
      turns
    )
    const [first, second] = layout.cards as CanvasMessageCard[]
    expect(first.spawned).toBeUndefined()
    expect(first.relation).toBeUndefined()
    expect(second.spawned).toBe(true)
    expect(second.relation).toBe('graphed as')
  })
})

describe('settling an answer and its cards', () => {
  const child = (id: string, parentId: string, x: number, y: number): CanvasMessageCard => ({
    kind: 'message',
    id,
    rect: { x, y, w: 320, h: 200 },
    userTurnId: 10,
    turnId: 11,
    parentId,
    spawned: true
  })
  const items = (cards: CanvasCard[]): TidyItems => ({ cards, frames: [], links: [] })

  it('finds only the cards the agent placed that nobody moved, and what hangs under them', () => {
    const cards: CanvasCard[] = [
      answer,
      child('b', 'a', 600, 0),
      child('c', 'a', 600, 400),
      child('d', 'c', 1100, 400),
      child('e', 'b', 1100, 0)
    ]
    // 'c' was moved by the user, which leaves 'd' under it alone as well.
    expect(untouchedSpawns(cards, 'a', new Set(['b', 'd', 'e']))).toEqual(['b', 'e'])
  })

  it('tidies the cards around the answer and never moves the answer', () => {
    // Two deeper cards strewn on the right, one far off; a visual below.
    const cards: CanvasCard[] = [
      answer,
      child('b', 'a', 900, 37),
      child('c', 'a', 1500, 900),
      child('v', 'a', 13, 700)
    ]
    const result = settleSpawns(items(cards), 'a', new Set(['b', 'c', 'v']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cards.find((update) => update.id === 'a')).toBeUndefined()
    const moved = new Map(cards.map((card) => [card.id, card.rect]))
    for (const update of result.cards) moved.set(update.id, update.rect)
    const rects = [...moved.values()]
    rects.forEach((rect, i) =>
      rects.slice(i + 1).forEach((other) => expect(rectsOverlap(rect, other)).toBe(false))
    )
    // Each card keeps its side: the deeper ones right, the visual below.
    expect(moved.get('b')!.x).toBeGreaterThan(400)
    expect(moved.get('c')!.x).toBeGreaterThan(400)
    expect(moved.get('v')!.y).toBeGreaterThan(300)
    // And the far one comes back near its answer.
    expect(moved.get('c')!.y).toBeLessThan(900)
  })

  it('leaves alone a card the user moved, and does nothing when there is nothing to tidy', () => {
    const cards: CanvasCard[] = [answer, child('b', 'a', 1500, 900)]
    expect(settleSpawns(items(cards), 'a', new Set())).toEqual({ ok: false })
    expect(settleSpawns(items(cards), 'gone', new Set(['b']))).toEqual({ ok: false })
  })

  it('moves nothing when the tidied cards would land on something else', () => {
    const cards: CanvasCard[] = [answer, child('b', 'a', 1500, 0)]
    const tidied = settleSpawns(items(cards), 'a', new Set(['b']))
    expect(tidied.ok).toBe(true)
    if (!tidied.ok) return
    const blocker: CanvasCard = { kind: 'note', id: 'n', rect: tidied.cards[0].rect, text: '' }
    expect(settleSpawns(items([...cards, blocker]), 'a', new Set(['b']))).toEqual({ ok: false })
  })
})
