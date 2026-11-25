/**
 * Cards the model adds beside its own answer through the canvas tools: an exploration card
 * asks a follow-up in its own space, a visual card shows a graph, chart or diagram the model
 * wrote. Both continue the answering card (`parentId`), with the relation on their line.
 * Main validates the tool input; this distrusts it again and places the cards, each on the
 * side its role belongs to, and tidies them once the answer and its cards have settled.
 */
import type { CanvasArrangeResult } from './canvas-arrange'
import type { CanvasCard, CanvasRect } from './canvas'
import { cardRects, rectClearOf, rectsOverlap } from './canvas'
import { tidySelection } from './canvas-tidy'
import type { TidyItems } from './canvas-tidy'

/**
 * What an exploration card is for, which decides its side: background the answer builds on
 * goes on the left, going deeper on the right (the default), a worked example below.
 */
export const EXPLORE_ROLES = ['background', 'deeper', 'example'] as const
export type ExploreRole = (typeof EXPLORE_ROLES)[number]
/** Visuals always go below the answer they illustrate. */
export type SpawnRole = ExploreRole | 'visual'

export type CanvasSpawn =
  | { kind: 'explore'; question: string; relation: string; role?: ExploreRole }
  | { kind: 'visual'; title: string; content: string; relation: string }

export function spawnRole(spawn: CanvasSpawn): SpawnRole {
  return spawn.kind === 'visual' ? 'visual' : (spawn.role ?? 'deeper')
}

function isExploreRole(value: unknown): value is ExploreRole {
  return typeof value === 'string' && (EXPLORE_ROLES as readonly string[]).includes(value)
}

export const SPAWN_SIZES = {
  explore: { w: 320, h: 200 },
  visual: { w: 440, h: 340 }
} as const

/** Room for the line and its relation label between the answer and what it adds. */
const SPAWN_REACH = 120
const SPAWN_GAP = 24
const QUESTION_LIMIT = 400
const TITLE_LIMIT = 80
const RELATION_LIMIT = 40
const CONTENT_LIMIT = 6000

function clip(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat
}

/** A spawn as the renderer received it, made sound; null when nothing usable is left. */
export function soundSpawn(raw: unknown): CanvasSpawn | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const relation = clip(value.relation, RELATION_LIMIT)
  if (value.kind === 'explore') {
    const question = clip(value.question, QUESTION_LIMIT)
    if (!question) return null
    // An unknown role is not worth refusing the card over; it goes where deeper ones go.
    return isExploreRole(value.role)
      ? { kind: 'explore', question, relation, role: value.role }
      : { kind: 'explore', question, relation }
  }
  if (value.kind === 'visual' && typeof value.content === 'string') {
    const content = value.content.trim().slice(0, CONTENT_LIMIT)
    const title = clip(value.title, TITLE_LIMIT) || 'Visual'
    return content ? { kind: 'visual', title, content, relation } : null
  }
  return null
}

/**
 * Where a card added to `parentId` goes, by its role: deeper cards in a column on the parent's
 * right, background in a column on its left, both starting level with its top; examples and
 * visuals below it, starting level with its left edge. Each moves down past whatever is
 * already there, earlier additions included (the settling tidy turns those below into a row). The sides stay clear of the parent's own growth,
 * since an answer only grows downward, and fitting an answer pushes what is below it down.
 */
export function spawnRect(
  cards: CanvasCard[],
  parentId: string,
  kind: CanvasSpawn['kind'],
  role: SpawnRole = kind === 'visual' ? 'visual' : 'deeper'
): CanvasRect | null {
  const parent = cards.find((card) => card.id === parentId)
  if (!parent) return null
  const size = SPAWN_SIZES[kind]
  const { x, y, w, h } = parent.rect
  const start =
    role === 'background'
      ? { x: x - SPAWN_REACH - size.w, y }
      : role === 'deeper'
        ? { x: x + w + SPAWN_REACH, y }
        : { x, y: y + h + SPAWN_REACH }
  return rectClearOf(
    { ...start, ...size },
    cards.map((card) => card.rect),
    SPAWN_GAP
  )
}

/**
 * The cards under `rootId` that the agent placed and the user has not moved since: the root's
 * children in `placed`, their children in `placed`, and so on. A card the user moved cuts off
 * everything under it, which then stays where it is too.
 */
export function untouchedSpawns(
  cards: CanvasCard[],
  rootId: string,
  placed: ReadonlySet<string>
): string[] {
  const found: string[] = []
  const reached = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const card of cards) {
      if (card.kind !== 'message' || reached.has(card.id) || !placed.has(card.id)) continue
      if (card.parentId === undefined || !reached.has(card.parentId)) continue
      reached.add(card.id)
      found.push(card.id)
      grew = true
    }
  }
  return found
}

/**
 * The tidy for an answer whose cards have settled: the answer and the cards the agent placed
 * under it that nobody moved, laid out as a tree that keeps each card on its side. The answer
 * itself stays exactly where it is, since the user is reading it; when the tree would then land
 * on anything else, nothing moves.
 */
export function settleSpawns(
  items: TidyItems,
  rootId: string,
  placed: ReadonlySet<string>
): CanvasArrangeResult {
  const root = items.cards.find((card) => card.id === rootId)
  const spawns = untouchedSpawns(items.cards, rootId, placed)
  if (!root || spawns.length === 0) return { ok: false }
  const tidied = tidySelection(items, new Set([rootId, ...spawns]))
  if (!tidied.ok) return tidied
  const rootMove = tidied.cards.find((update) => update.id === rootId)
  const dx = rootMove ? root.rect.x - rootMove.rect.x : 0
  const dy = rootMove ? root.rect.y - rootMove.rect.y : 0
  const shift = (rect: CanvasRect): CanvasRect => ({ ...rect, x: rect.x + dx, y: rect.y + dy })
  const cards = tidied.cards.map((update) => ({ ...update, rect: shift(update.rect) }))
  const frames = tidied.frames.map((update) => ({ ...update, rect: shift(update.rect) }))
  const moving = new Set(cards.map((update) => update.id))
  const others = cardRects(items.cards, moving)
  if (cards.some((update) => others.some((rect) => rectsOverlap(update.rect, rect)))) {
    return { ok: false }
  }
  const before = new Map(items.cards.map((card) => [card.id, card.rect]))
  const changed = cards.filter((update) => {
    const old = before.get(update.id)
    return !old || old.x !== update.rect.x || old.y !== update.rect.y
  })
  return changed.length > 0 ? { ok: true, cards: changed, frames } : { ok: false }
}
