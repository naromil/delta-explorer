/**
 * Edits to where things stand on the open canvas: moving, raising, notes, frames, links,
 * colour, collapsing and duplicating. Everything but raising and the viewport is one undo step.
 */
import { useCallback } from 'react'
import type { RefObject } from 'react'
import type {
  CanvasColor,
  CanvasLayout,
  CanvasLink,
  CanvasLinkContext,
  CanvasRect,
  CanvasViewport
} from '@delta/core/canvas'
import { QUOTE_TEXT_LIMIT, raisedStack, setCardCollapsed, withoutField } from '@delta/core/canvas'
import type { CanvasFrameUpdate } from '@delta/core/canvas-arrange'
import { duplicateSelection } from '@delta/core/canvas-arrange'
import { allocateTurnId } from './canvas-state'
import type { CanvasCardUpdate, CanvasDoc, PendingRequest } from './canvas-state'

export interface CanvasLayoutStore {
  /** The newest document, read at once by event handlers. */
  docRef: RefObject<CanvasDoc>
  /** Requests in flight: a turn still streaming is copied without its answer. */
  requestsRef: RefObject<Map<string, PendingRequest>>
  updateDoc: (change: (prev: CanvasDoc) => CanvasDoc) => void
  /** `touchContent` marks a change of content, which reorders recents and asks for curation. */
  requestSave: (touchContent: boolean) => void
  /** Runs `action` as one undo step named `label`. */
  recorded: (label: string, action: () => void) => void
}

export interface CanvasLayoutEdits {
  setViewport: (viewport: CanvasViewport) => void
  updateCards: (updates: CanvasCardUpdate[]) => void
  raiseCards: (ids: Iterable<string>) => void
  moveItems: (label: string, cards: CanvasCardUpdate[], frames?: CanvasFrameUpdate[]) => void
  addNote: (rect: CanvasRect, text: string) => string
  updateNote: (id: string, text: string) => void
  addFrame: (rect: CanvasRect, title: string) => string
  renameFrame: (id: string, title: string) => void
  addLink: (from: string, to: string, quote?: string) => string | null
  labelLink: (id: string, label: string) => void
  reverseLink: (id: string) => void
  setLinkContext: (id: string, context: CanvasLinkContext | undefined) => void
  setColor: (ids: ReadonlySet<string>, color: CanvasColor | undefined) => void
  setCollapsed: (ids: ReadonlySet<string>, collapsed: boolean) => void
  duplicate: (ids: ReadonlySet<string>) => string[]
}

export function useCanvasLayout({
  docRef,
  requestsRef,
  updateDoc,
  requestSave,
  recorded
}: CanvasLayoutStore): CanvasLayoutEdits {
  const setViewport = useCallback(
    (viewport: CanvasViewport): void => {
      updateDoc((prev) => ({ ...prev, layout: { ...prev.layout, viewport } }))
      requestSave(false)
    },
    [requestSave, updateDoc]
  )

  const updateCards = useCallback(
    (updates: CanvasCardUpdate[]): void => {
      const byId = new Map(updates.map((update) => [update.id, update]))
      updateDoc((prev) => ({
        ...prev,
        layout: {
          ...prev.layout,
          cards: prev.layout.cards.map((card) => {
            const update = byId.get(card.id)
            return update ? { ...card, rect: update.rect } : card
          })
        }
      }))
      requestSave(false)
    },
    [requestSave, updateDoc]
  )

  /** Going on top is not an edit: it joins no undo step and leaves the recents order alone. */
  const raiseCards = useCallback(
    (ids: Iterable<string>): void => {
      const { cards, stack } = docRef.current.layout
      const next = raisedStack(cards, stack, ids)
      if (next === stack) return
      updateDoc((prev) => ({ ...prev, layout: { ...prev.layout, stack: next } }))
      requestSave(false)
    },
    [docRef, requestSave, updateDoc]
  )

  const moveItems = useCallback(
    (label: string, cards: CanvasCardUpdate[], frames: CanvasFrameUpdate[] = []): void => {
      const rects = new Map(frames.map((frame) => [frame.id, frame.rect]))
      recorded(label, () => {
        updateCards(cards)
        if (rects.size === 0) return
        updateDoc((prev) => ({
          ...prev,
          layout: {
            ...prev.layout,
            frames: prev.layout.frames.map((frame) => {
              const rect = rects.get(frame.id)
              return rect ? { ...frame, rect } : frame
            })
          }
        }))
      })
      raiseCards(cards.map((card) => card.id))
    },
    [raiseCards, recorded, updateCards, updateDoc]
  )

  /** A change to the layout alone: never a change of content, so recents keep their order. */
  const editLayout = useCallback(
    (label: string, change: (layout: CanvasLayout) => CanvasLayout): void => {
      recorded(label, () => {
        updateDoc((prev) => ({ ...prev, layout: change(prev.layout) }))
      })
      requestSave(false)
    },
    [recorded, requestSave, updateDoc]
  )

  const addNote = useCallback(
    (rect: CanvasRect, text: string): string => {
      const id = crypto.randomUUID()
      editLayout('Add note', (layout) => ({
        ...layout,
        cards: [...layout.cards, { kind: 'note', id, rect, text }]
      }))
      return id
    },
    [editLayout]
  )

  const updateNote = useCallback(
    (id: string, text: string): void => {
      editLayout('Edit note', (layout) => ({
        ...layout,
        cards: layout.cards.map((card) =>
          card.id === id && card.kind === 'note' && card.text !== text ? { ...card, text } : card
        )
      }))
    },
    [editLayout]
  )

  const addFrame = useCallback(
    (rect: CanvasRect, title: string): string => {
      const id = crypto.randomUUID()
      editLayout('Add frame', (layout) => ({
        ...layout,
        frames: [...layout.frames, { id, rect, title }]
      }))
      return id
    },
    [editLayout]
  )

  const renameFrame = useCallback(
    (id: string, title: string): void => {
      editLayout('Rename frame', (layout) => ({
        ...layout,
        frames: layout.frames.map((frame) =>
          frame.id === id && frame.title !== title ? { ...frame, title } : frame
        )
      }))
    },
    [editLayout]
  )

  const addLink = useCallback(
    (from: string, to: string, quote?: string): string | null => {
      const { cards, links } = docRef.current.layout
      const known = (id: string): boolean => cards.some((card) => card.id === id)
      if (from === to || !known(from) || !known(to)) return null
      const passage = quote?.trim().slice(0, QUOTE_TEXT_LIMIT)
      const existing = links.find(
        (link) => link.from === from && link.to === to && link.quote === (passage || undefined)
      )
      if (existing) return existing.id
      const id = crypto.randomUUID()
      const link: CanvasLink = passage
        ? { id, from, to, context: 'card', quote: passage }
        : { id, from, to }
      editLayout(passage ? 'Link passage' : 'Connect', (layout) => ({
        ...layout,
        links: [...layout.links, link]
      }))
      return id
    },
    [docRef, editLayout]
  )

  const editLink = useCallback(
    (label: string, id: string, change: (link: CanvasLink) => CanvasLink): void => {
      editLayout(label, (layout) => ({
        ...layout,
        links: layout.links.map((link) => (link.id === id ? change(link) : link))
      }))
    },
    [editLayout]
  )

  const labelLink = useCallback(
    (id: string, label: string): void => {
      const text = label.trim()
      editLink('Label connection', id, (link) => {
        if ((link.label ?? '') === text) return link
        return text === '' ? withoutField(link, 'label') : { ...link, label: text }
      })
    },
    [editLink]
  )

  const reverseLink = useCallback(
    (id: string): void => {
      editLink('Reverse connection', id, (link) => ({ ...link, from: link.to, to: link.from }))
    },
    [editLink]
  )

  const setLinkContext = useCallback(
    (id: string, context: CanvasLinkContext | undefined): void => {
      editLink(context ? 'Send context' : 'Stop sending context', id, (link) => {
        if (link.context === context) return link
        return context ? { ...link, context } : withoutField(link, 'context')
      })
    },
    [editLink]
  )

  const setColor = useCallback(
    (ids: ReadonlySet<string>, color: CanvasColor | undefined): void => {
      const paint = <T extends { id: string; color?: CanvasColor }>(item: T): T => {
        if (!ids.has(item.id) || item.color === color) return item
        return color === undefined ? withoutField(item, 'color') : { ...item, color }
      }
      editLayout('Colour', (layout) => ({
        ...layout,
        cards: layout.cards.map(paint),
        frames: layout.frames.map(paint)
      }))
    },
    [editLayout]
  )

  const setCollapsed = useCallback(
    (ids: ReadonlySet<string>, collapsed: boolean): void => {
      editLayout(collapsed ? 'Collapse' : 'Expand', (layout) => ({
        ...layout,
        cards: [...ids].reduce((cards, id) => setCardCollapsed(cards, id, collapsed), layout.cards)
      }))
    },
    [editLayout]
  )

  const duplicate = useCallback(
    (ids: ReadonlySet<string>): string[] => {
      const { turns, layout } = docRef.current
      const copy = duplicateSelection(layout, turns, ids, {
        newId: () => crypto.randomUUID(),
        newTurnId: allocateTurnId,
        streamingTurnIds: new Set(
          [...requestsRef.current.values()].flatMap((request) =>
            request.kind === 'send' ? [request.turnId] : []
          )
        )
      })
      if (!copy) return []
      recorded('Duplicate', () => {
        updateDoc((prev) => ({
          turns: [...prev.turns, ...copy.turns],
          layout: {
            ...prev.layout,
            cards: [...prev.layout.cards, ...copy.cards],
            frames: [...prev.layout.frames, ...copy.frames],
            links: [...prev.layout.links, ...copy.links]
          }
        }))
      })
      requestSave(copy.turns.length > 0)
      return copy.ids
    },
    [docRef, recorded, requestSave, requestsRef, updateDoc]
  )

  return {
    setViewport,
    updateCards,
    raiseCards,
    moveItems,
    addNote,
    updateNote,
    addFrame,
    renameFrame,
    addLink,
    labelLink,
    reverseLink,
    setLinkContext,
    setColor,
    setCollapsed,
    duplicate
  }
}
