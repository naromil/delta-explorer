/**
 * The board's working types and fixed numbers: gestures under way, the composer draft, a term
 * waiting for its rectangle, notices, and the limits and wording the board uses.
 */
import type { CanvasPoint, CanvasRect, CanvasSide, CanvasViewport } from '@delta/core/canvas'
import type { CanvasContextLink } from '@delta/core/canvas-context'
import type { ExpansionTarget } from '@delta/core/rich-text'
import type { CanvasTool } from './CanvasToolRail'
import type { useCanvas } from './useCanvas'

export type Canvas = ReturnType<typeof useCanvas>
export type DrawKind = 'answer' | 'note' | 'frame'

export type Gesture =
  | { type: 'pan'; pointer: CanvasPoint; origin: CanvasViewport }
  | {
      type: 'draw'
      what: DrawKind
      start: CanvasPoint
      end: CanvasPoint
      /** The card this rectangle follows, wherever it ends up. */
      continues?: string
      /** Sizing after a `+` was dropped: it tracks the pointer until the next click. */
      unheld?: boolean
    }
  | {
      type: 'marquee'
      start: CanvasPoint
      end: CanvasPoint
      /** What stays selected whatever the box catches: Shift adds to the selection. */
      base: ReadonlySet<string>
    }
  | {
      type: 'drag'
      /** The card or frame under the pointer. */
      id: string
      ids: Set<string>
      frameIds: Set<string>
      /** Snaps the moving bounds rather than one card, since several things were chosen. */
      group: boolean
      /** A press that never moves selects just this item. */
      plainPress: boolean
      /** Shift+drag carries what is joined, so Shift+click only decides once it is let go. */
      shiftPress: boolean
      start: CanvasPoint
      pointer: CanvasPoint
    }
  | { type: 'resize'; id: string; start: CanvasPoint; pointer: CanvasPoint }
  | { type: 'frameResize'; id: string; start: CanvasPoint; pointer: CanvasPoint }
  | { type: 'connect'; from: string; pointer: CanvasPoint }
  /** A card's `+` on its way somewhere: a click continues on its side. */
  | { type: 'extend'; from: string; side: CanvasSide; start: CanvasPoint; pointer: CanvasPoint }
  | {
      type: 'draftResize'
      side: CanvasSide | undefined
      rect: CanvasRect
      start: CanvasPoint
      pointer: CanvasPoint
    }

/** One chip per source, and one per passage quoted from it. */
export function draftLinkKey(link: CanvasContextLink): string {
  return link.quote ? `${link.from}\u0000${link.quote}` : link.from
}

/** A rectangle waiting for its question: the canvas's composer. */
export interface Draft {
  /** A fresh draft is a fresh composer, so typed text never carries over. */
  key: number
  /** Where it stands, or only its size when it is kept against `side` of its parent. */
  rect: CanvasRect
  parentId?: string
  /** Kept against this side of its parent, so the parent growing or moving carries it along. */
  side?: CanvasSide
  /** The cards it could continue, newest first; the user picks one in the draft. */
  sessions: string[]
  /** Cards the question is about: their text goes along, not their history. */
  sourceIds?: string[]
  /** What it links into its branch; these become context links when it is sent. */
  context?: CanvasContextLink[]
}

/** A chosen expansion waiting for the rectangle that decides its size. */
export interface Placing {
  turnId: number
  target: ExpansionTarget
  prompt?: string
  hostId: string
  label: string
}

export interface CanvasNotice {
  text: string
  /** The notice offers to take back what it reports. */
  undoable?: boolean
}

export interface DrawOutcome {
  rect: CanvasRect
  guidesX: number[]
  guidesY: number[]
  /** Why this rectangle cannot be used; null when it can. */
  refusal: string | null
}

export const SNAP_SCREEN_PX = 10
export const VIEWPORT_TRANSITION_MS = 360
export const PULSE_MS = 900
export const NOTICE_MS = 4000
/** Below this width the centred selection bar would reach the zoom controls (`canvas.css`). */
export const NARROW_VIEW_PX = 1000
export const EXPORT_SAVED_MS = 2000

export const REFUSE_TOO_SMALL: Readonly<Record<DrawKind, string>> = {
  answer: 'That rectangle is too small to hold an answer. Draw a larger one.',
  note: 'That rectangle is too small to hold a note. Draw a larger one.',
  frame: 'That frame is too small. Draw a larger one.'
}
export const REFUSE_ARRANGE = 'Other cards are in the way of that arrangement.'
export const ALREADY_TIDY = 'Already tidy.'
export const NO_CARD_TO_CONNECT = 'Start a connection on a card.'
export const CONNECT_ANOTHER = 'Drag to a different card to connect them.'
export const PASSAGE_PICK_TARGET = 'Click the card that should receive this passage. Esc cancels.'
export const PASSAGE_NO_TARGET = 'No card there, so the passage was not linked.'
export const PASSAGE_ANOTHER = 'Click a different card to send this passage to.'
export const PASSAGE_SOURCE_GONE = 'The card holding this passage is gone.'
export const NO_CONTINUE_FAILED = 'Retry this answer before continuing it.'
export const WAITING_PARENT = 'Waiting for the answer it continues…'
export const FAILED_PARENT = 'The answer it continues failed. Retry it first.'
export const WAITING_CONTEXT = 'Waiting for a linked answer…'
export const LINK_IN_HISTORY = 'That card is already in this conversation.'
export const EXTEND_HINT =
  'Let go in open space to place the next message, or on a new message to link.'
export const SIZE_HINT =
  'Move to size the next message, then click. A click right away uses the default.'

export const TOOL_HINTS: Readonly<Partial<Record<CanvasTool, string>>> = {
  answer: 'Draw a rectangle for the answer, or click for the default size.',
  note: 'Draw where the note goes, or click for the default size.',
  frame: 'Draw a region. Whatever stands inside it moves with it.',
  connect: 'Drag from one card to another.',
  hand: 'Drag anywhere to pan.'
}

/** Below this much pointer travel on screen, a press is a click rather than a drag. */
export const DRAG_START_PX = 3
export const DOUBLE_PRESS_MS = 400
export const NUDGE = 10
export const NUDGE_LARGE = 50
/** Room left around what a new frame wraps, and the size of one made with a click. */
export const FRAME_PADDING = 32
export const DEFAULT_FRAME_SIZE = { w: 520, h: 360 }
/** How much of the surface the open outline covers, rail included. */
export const OUTLINE_WIDTH = 344
/** Where a jump lands if the view is too far out to read what it was looking for. */
export const READING_ZOOM = 0.8
export const VIEW_HISTORY_LIMIT = 50

/** Space kept around a new session opened from the keyboard. */
export const NEW_SESSION_GAP = 48
/** How much of the plane around a term is brought on screen when returning to it. */

export const ARROW_SIDES: Readonly<Record<string, CanvasSide>> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowDown: 'bottom',
  ArrowUp: 'top'
}

/** Keeps a run of wheel events on what it started moving as things pass under the pointer. */
export const WHEEL_LATCH_MS = 160
