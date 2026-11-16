import { describe, expect, it } from 'vitest'
import type { CanvasCard, CanvasMessageCard } from '../src/canvas'
import { normalizeCanvasLayout, rectsOverlap } from '../src/canvas'
import { SPAWN_SIZES, soundSpawn, spawnRect } from '../src/canvas-spawn'
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
  it('starts on the right of the answer, level with its top', () => {
    const rect = spawnRect([answer], 'a', 'visual')
    expect(rect).toMatchObject({ y: 0, ...SPAWN_SIZES.visual })
    expect(rect!.x).toBeGreaterThan(400)
  })

  it('stacks later cards below earlier ones, overlapping nothing', () => {
    const cards: CanvasCard[] = [answer]
    for (const kind of ['visual', 'explore', 'explore'] as const) {
      const rect = spawnRect(cards, 'a', kind)!
      for (const card of cards) expect(rectsOverlap(rect, card.rect)).toBe(false)
      cards.push({ kind: 'note', id: `n${cards.length}`, rect, text: '' })
    }
    expect(cards[2].rect.y).toBeGreaterThan(cards[1].rect.y)
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
