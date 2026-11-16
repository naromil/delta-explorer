/**
 * Cards the model adds beside its own answer through the canvas tools: an exploration card
 * asks a follow-up in its own space, a visual card shows a graph, chart or diagram the model
 * wrote. Both continue the answering card (`parentId`), with the relation on their line.
 * Main validates the tool input; this distrusts it again and places the cards.
 */
import type { CanvasCard, CanvasRect } from './canvas'
import { rectClearOf } from './canvas'

export type CanvasSpawn =
  | { kind: 'explore'; question: string; relation: string }
  | { kind: 'visual'; title: string; content: string; relation: string }

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
    return question ? { kind: 'explore', question, relation } : null
  }
  if (value.kind === 'visual' && typeof value.content === 'string') {
    const content = value.content.trim().slice(0, CONTENT_LIMIT)
    const title = clip(value.title, TITLE_LIMIT) || 'Visual'
    return content ? { kind: 'visual', title, content, relation } : null
  }
  return null
}

/**
 * Where a card added to `parentId` goes: a column on the parent's right, starting level with
 * its top and moving down past whatever is already there, earlier additions included. The
 * right stays clear of the parent's own growth, since an answer only grows downward.
 */
export function spawnRect(
  cards: CanvasCard[],
  parentId: string,
  kind: CanvasSpawn['kind']
): CanvasRect | null {
  const parent = cards.find((card) => card.id === parentId)
  if (!parent) return null
  const size = SPAWN_SIZES[kind]
  const start = {
    x: parent.rect.x + parent.rect.w + SPAWN_REACH,
    y: parent.rect.y,
    w: size.w,
    h: size.h
  }
  return rectClearOf(
    start,
    cards.map((card) => card.rect),
    SPAWN_GAP
  )
}
