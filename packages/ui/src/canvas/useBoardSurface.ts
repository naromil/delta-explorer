/**
 * What the board's surface does on its own, outside any gesture: the wheel pans or zooms the
 * plane (a card with text left to scroll takes it first), and focus never scrolls the plane.
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'
import type { CanvasCard, CanvasRect } from '@delta/core/canvas'
import { zoomAt, wheelZoomFactor } from '@delta/core/canvas'
import type { ViewportMotion } from '../lib/viewport-motion'
import { WHEEL_LATCH_MS } from './board-model'
import { canScrollBy, wheelPanDelta } from './board-helpers'

/** Ctrl or a pinch zooms at the pointer; otherwise the wheel pans, and either lets go of following. */
export function useWheelOnPlane(
  surfaceRef: RefObject<HTMLDivElement | null>,
  followRef: RefObject<boolean>,
  motionRef: RefObject<ViewportMotion | null>
): void {
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    let latch: { target: Element | 'plane'; at: number } | null = null
    const handleWheel = (e: WheelEvent): void => {
      const held = latch && e.timeStamp - latch.at < WHEEL_LATCH_MS ? latch.target : null
      const { deltaX, deltaY } = wheelPanDelta(e)
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        followRef.current = false
        latch = { target: 'plane', at: e.timeStamp }
        const box = surface.getBoundingClientRect()
        const anchor = { x: e.clientX - box.left, y: e.clientY - box.top }
        const factor = wheelZoomFactor(e.deltaY)
        motionRef.current?.steer((view) => zoomAt(view, anchor, view.zoom * factor))
        return
      }
      if (held instanceof Element) {
        // A card scrolled to its end stops there rather than dragging the plane after it.
        latch = { target: held, at: e.timeStamp }
        if (!canScrollBy(held, deltaX, deltaY)) e.preventDefault()
        return
      }
      const body = held ? null : (e.target as Element).closest('.canvas-card-body')
      if (body && canScrollBy(body, deltaX, deltaY)) {
        latch = { target: body, at: e.timeStamp }
        return
      }
      e.preventDefault()
      followRef.current = false
      latch = { target: 'plane', at: e.timeStamp }
      motionRef.current?.steer((view) => ({ ...view, x: view.x - deltaX, y: view.y - deltaY }))
    }
    surface.addEventListener('wheel', handleWheel, { passive: false })
    return () => surface.removeEventListener('wheel', handleWheel)
  }, [followRef, motionRef, surfaceRef])
}

export interface FocusOnPlane {
  cardsRef: RefObject<CanvasCard[]>
  selectedRef: RefObject<ReadonlySet<string>>
  /** The card Enter replies to; focusing a card makes it that one. */
  currentIdRef: RefObject<string | null>
  followRef: RefObject<boolean>
  select: (ids: Iterable<string>) => void
  revealOnScreen: (rect: CanvasRect) => void
}

export function useFocusOnPlane(
  surfaceRef: RefObject<HTMLDivElement | null>,
  { cardsRef, selectedRef, currentIdRef, followRef, select, revealOnScreen }: FocusOnPlane
): void {
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    // Focus scrolls the nearest clipped ancestor, but only the viewport may move the plane.
    const handleScroll = (): void => {
      if (surface.scrollTop !== 0) surface.scrollTop = 0
      if (surface.scrollLeft !== 0) surface.scrollLeft = 0
    }
    // Tabbing to a card off screen brings it on screen; a click lands where it already is.
    const handleFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement
      const cardEl = target.closest<HTMLElement>('[data-canvas-card]')
      if (!cardEl) return
      const card = cardsRef.current.find((item) => item.id === cardEl.dataset.canvasCard)
      if (!card) return
      currentIdRef.current = card.id
      if (!target.matches(':focus-visible')) return
      followRef.current = false
      if (target === cardEl && !selectedRef.current.has(card.id)) select([card.id])
      revealOnScreen(card.rect)
    }
    surface.addEventListener('scroll', handleScroll)
    surface.addEventListener('focusin', handleFocusIn)
    return () => {
      surface.removeEventListener('scroll', handleScroll)
      surface.removeEventListener('focusin', handleFocusIn)
    }
  }, [cardsRef, currentIdRef, followRef, revealOnScreen, select, selectedRef, surfaceRef])
}
