/**
 * Moving between cards: jumps that focus a card and bring it on screen, returning from an
 * expansion to its term, following links, zooming to items, and the Alt+Left/Right view history.
 * Each jump that lands on something flashes it (`pulseId`, or `pulseTerm` for one term).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type {
  CanvasCard,
  CanvasFrame,
  CanvasPoint,
  CanvasRect,
  CanvasViewport
} from '@delta/core/canvas'
import {
  FAR_ZOOM,
  clampPointInside,
  fitViewport,
  fitsOnScreen,
  revealRect,
  sourceCardId
} from '@delta/core/canvas'
import { OUTLINE_WIDTH, PULSE_MS, READING_ZOOM, VIEW_HISTORY_LIMIT } from './board-model'
import { scrollIntoBody, termPoint } from './board-helpers'

export interface BoardNavigationInput {
  surfaceRef: RefObject<HTMLDivElement | null>
  /** The live viewport, ahead of React while the plane moves. */
  viewportRef: RefObject<CanvasViewport>
  /** The outline covers the left of the surface, so jumps land beside it. */
  outlineOpenRef: RefObject<boolean>
  cardsRef: RefObject<CanvasCard[]>
  framesRef: RefObject<CanvasFrame[]>
  selectedRef: RefObject<ReadonlySet<string>>
  currentIdRef: RefObject<string | null>
  followRef: RefObject<boolean>
  surfaceSize: () => { width: number; height: number }
  glideTo: (next: CanvasViewport) => void
  unfollow: () => void
  pointerInWorld: (e: { clientX: number; clientY: number }) => CanvasPoint
  select: (ids: Iterable<string>) => void
}

export interface BoardNavigation {
  /** The card or frame flashing after a jump. */
  pulseId: string | null
  /** One expanded term flashing inside its card. */
  pulseTerm: { cardId: string; expansionId: number } | null
  /** The part of the surface a jump lands in: not behind the outline. */
  openArea: () => { left: number; width: number; height: number }
  revealOnScreen: (rect: CanvasRect) => void
  rememberView: () => void
  travelViewHistory: (direction: 'back' | 'forward') => void
  flash: (cardId: string, expansionId?: number) => void
  focusCard: (id: string, pulse?: boolean, extend?: boolean) => void
  revealWholeCard: (rect: CanvasRect, focus: CanvasPoint) => void
  returnToTerm: (id: string) => void
  goToSource: (id: string) => void
  handleOpenExpansion: (expansionId: number) => void
  handleFollowLink: (e: React.MouseEvent, id: string, start: CanvasPoint) => void
  handleFollowRelation: (e: React.MouseEvent, from: string, to: string) => void
  zoomToRects: (rects: CanvasRect[]) => void
  zoomToItem: (id: string) => void
  goToItem: (id: string) => void
}

export function useBoardNavigation({
  surfaceRef,
  viewportRef,
  outlineOpenRef,
  cardsRef,
  framesRef,
  selectedRef,
  currentIdRef,
  followRef,
  surfaceSize,
  glideTo,
  unfollow,
  pointerInWorld,
  select
}: BoardNavigationInput): BoardNavigation {
  const [pulseId, setPulseId] = useState<string | null>(null)
  const [pulseTerm, setPulseTerm] = useState<{ cardId: string; expansionId: number } | null>(null)
  const pulseTimerRef = useRef<number | null>(null)
  const viewBackRef = useRef<CanvasViewport[]>([])
  const viewForwardRef = useRef<CanvasViewport[]>([])

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current)
    }
  }, [])

  /** The part of the surface a jump should land in: not behind the outline. */
  const openArea = useCallback((): { left: number; width: number; height: number } => {
    const { width, height } = surfaceSize()
    const left = outlineOpenRef.current ? OUTLINE_WIDTH : 0
    return { left, width: width - left, height }
  }, [outlineOpenRef, surfaceSize])

  /** The smallest glide that brings a rectangle on screen; none when it already is. */
  const revealOnScreen = useCallback(
    (rect: CanvasRect): void => {
      const { left, width, height } = openArea()
      const view = viewportRef.current
      const moved = revealRect({ ...view, x: view.x - left }, rect, { width, height })
      const next = { ...moved, x: moved.x + left }
      if (next.x !== view.x || next.y !== view.y) glideTo(next)
    },
    [glideTo, openArea, viewportRef]
  )

  /** Remembers where the view is, before a jump, for Alt+Left. */
  const rememberView = useCallback((): void => {
    viewBackRef.current = [...viewBackRef.current, viewportRef.current].slice(-VIEW_HISTORY_LIMIT)
    viewForwardRef.current = []
  }, [viewportRef])

  const travelViewHistory = useCallback(
    (direction: 'back' | 'forward'): void => {
      const [from, to] =
        direction === 'back' ? [viewBackRef, viewForwardRef] : [viewForwardRef, viewBackRef]
      const next = from.current.at(-1)
      if (!next) return
      from.current = from.current.slice(0, -1)
      to.current = [...to.current, viewportRef.current]
      followRef.current = false
      glideTo(next)
    },
    [followRef, glideTo, viewportRef]
  )

  /** Flashes a card, or one expanded term inside it. */
  const flash = useCallback((cardId: string, expansionId?: number): void => {
    setPulseId(expansionId === undefined ? cardId : null)
    setPulseTerm(expansionId === undefined ? null : { cardId, expansionId })
    if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current)
    pulseTimerRef.current = window.setTimeout(() => {
      setPulseId(null)
      setPulseTerm(null)
    }, PULSE_MS)
  }, [])

  /** Every keyboard and link jump lands here: the card gets focus and comes on screen. */
  const focusCard = useCallback(
    (id: string, pulse = false, extend = false): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      unfollow()
      currentIdRef.current = id
      select(extend ? [...selectedRef.current, id] : [id])
      revealOnScreen(card.rect)
      surfaceRef.current
        ?.querySelector<HTMLElement>(`[data-canvas-card="${id}"]`)
        ?.focus({ preventScroll: true })
      if (pulse) flash(id)
    },
    [cardsRef, currentIdRef, flash, revealOnScreen, select, selectedRef, surfaceRef, unfollow]
  )

  /**
   * Brings all of a card on screen, zooming out only when it would not fit otherwise. Past
   * the zoom where cards become titles its text would be gone, so a card too tall for that
   * is centred on `focus` instead.
   */
  const revealWholeCard = useCallback(
    (rect: CanvasRect, focus: CanvasPoint): void => {
      const { left, width, height } = openArea()
      const { zoom } = viewportRef.current
      if (zoom >= FAR_ZOOM && fitsOnScreen(rect, zoom, { width, height })) {
        revealOnScreen(rect)
        return
      }
      const fit = fitViewport([rect], { width, height })
      glideTo(
        fit.zoom >= FAR_ZOOM
          ? { ...fit, x: fit.x + left }
          : {
              x: left + width / 2 - focus.x * FAR_ZOOM,
              y: height / 2 - focus.y * FAR_ZOOM,
              zoom: FAR_ZOOM
            }
      )
    },
    [glideTo, openArea, revealOnScreen, viewportRef]
  )

  /** From an expansion back to the card its term is in: all of it, with the term flashed. */
  const returnToTerm = useCallback(
    (id: string): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (card?.kind !== 'expansion') return
      const host = cardsRef.current.find((item) => item.id === card.hostId)
      const hostEl = surfaceRef.current?.querySelector<HTMLElement>(
        `[data-canvas-card="${card.hostId}"] .canvas-card-surface`
      )
      const term = hostEl?.querySelector<HTMLElement>(`[data-canvas-terms~="${card.expansionId}"]`)
      if (!host || !hostEl || !term) {
        focusCard(card.hostId, true)
        return
      }
      unfollow()
      const scale = hostEl.getBoundingClientRect().width / host.rect.w
      scrollIntoBody(term, scale)
      const hostBox = hostEl.getBoundingClientRect()
      const point = termPoint(term)
      // First: after a key press this focus reveals the card by itself, which must not win.
      term.focus({ preventScroll: true })
      revealWholeCard(host.rect, {
        x: host.rect.x + (point.x - hostBox.left) / scale,
        y: host.rect.y + (point.y - hostBox.top) / scale
      })
      currentIdRef.current = host.id
      flash(host.id, card.expansionId)
    },
    [cardsRef, currentIdRef, flash, focusCard, revealWholeCard, surfaceRef, unfollow]
  )

  const goToSource = useCallback(
    (id: string): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      rememberView()
      if (card.kind === 'expansion') {
        returnToTerm(id)
        return
      }
      const source = sourceCardId(card)
      if (source !== undefined) focusCard(source, true)
    },
    [cardsRef, focusCard, rememberView, returnToTerm]
  )

  const handleOpenExpansion = useCallback(
    (expansionId: number): void => {
      const card = cardsRef.current.find(
        (item) => item.kind === 'expansion' && item.expansionId === expansionId
      )
      if (!card) return
      rememberView()
      focusCard(card.id, true)
    },
    [cardsRef, focusCard, rememberView]
  )

  /** A link click travels to whichever end is farther from where it was clicked. */
  const handleFollowLink = useCallback(
    (e: React.MouseEvent, id: string, start: CanvasPoint): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      const at = pointerInWorld(e)
      const onCard = clampPointInside(at, card.rect)
      const toCard = Math.hypot(at.x - onCard.x, at.y - onCard.y)
      const toStart = Math.hypot(at.x - start.x, at.y - start.y)
      if (toStart < toCard) {
        rememberView()
        focusCard(id, true)
      } else goToSource(id)
    },
    [cardsRef, focusCard, goToSource, pointerInWorld, rememberView]
  )

  /** A click on a card asked about's faint line goes to whichever card is farther away. */
  const handleFollowRelation = useCallback(
    (e: React.MouseEvent, from: string, to: string): void => {
      const all = cardsRef.current
      const start = all.find((card) => card.id === from)
      const end = all.find((card) => card.id === to)
      if (!start || !end) return
      const at = pointerInWorld(e)
      const distance = (rect: CanvasRect): number => {
        const edge = clampPointInside(at, rect)
        return Math.hypot(at.x - edge.x, at.y - edge.y)
      }
      rememberView()
      focusCard(distance(start.rect) > distance(end.rect) ? from : to, true)
    },
    [cardsRef, focusCard, pointerInWorld, rememberView]
  )

  const zoomToRects = useCallback(
    (rects: CanvasRect[]): void => {
      if (rects.length === 0) return
      unfollow()
      rememberView()
      const { left, width, height } = openArea()
      const fit = fitViewport(rects, { width, height })
      glideTo({ ...fit, x: fit.x + left })
    },
    [glideTo, openArea, rememberView, unfollow]
  )

  const zoomToItem = useCallback(
    (id: string): void => {
      const item = [...cardsRef.current, ...framesRef.current].find((other) => other.id === id)
      if (item) zoomToRects([item.rect])
    },
    [cardsRef, framesRef, zoomToRects]
  )

  /** From the outline or search: the item is selected and brought somewhere it can be read. */
  const goToItem = useCallback(
    (id: string): void => {
      const frame = framesRef.current.find((item) => item.id === id)
      if (frame) {
        select([id])
        zoomToRects([frame.rect])
        flash(id)
        return
      }
      const all = cardsRef.current
      const card = all.find((item) => item.id === id)
      if (!card) return
      rememberView()
      if (viewportRef.current.zoom < FAR_ZOOM) {
        // Too far out to read it, so the jump also comes in close enough.
        const { left, width, height } = openArea()
        const fit = fitViewport([card.rect], { width, height })
        const zoom = Math.max(Math.min(READING_ZOOM, fit.zoom), FAR_ZOOM)
        const center = { x: card.rect.x + card.rect.w / 2, y: card.rect.y + card.rect.h / 2 }
        const close = {
          x: left + width / 2 - center.x * zoom,
          y: height / 2 - center.y * zoom,
          zoom
        }
        unfollow()
        glideTo(close)
        // React has not painted it yet, and focusCard below reveals from where this lands.
        viewportRef.current = close
      }
      focusCard(id, true)
    },
    [
      cardsRef,
      flash,
      focusCard,
      framesRef,
      glideTo,
      openArea,
      rememberView,
      select,
      unfollow,
      viewportRef,
      zoomToRects
    ]
  )

  return {
    pulseId,
    pulseTerm,
    openArea,
    revealOnScreen,
    rememberView,
    travelViewHistory,
    flash,
    focusCard,
    revealWholeCard,
    returnToTerm,
    goToSource,
    handleOpenExpansion,
    handleFollowLink,
    handleFollowRelation,
    zoomToRects,
    zoomToItem,
    goToItem
  }
}
