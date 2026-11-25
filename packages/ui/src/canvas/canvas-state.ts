/**
 * The open canvas's data and the hook's interface: what `useCanvas` holds (`CanvasDoc`,
 * `CanvasMeta`), what it returns (`CanvasState`), and the plain helpers around them.
 */
import type {
  CanvasCard,
  CanvasColor,
  CanvasFrame,
  CanvasLayout,
  CanvasLink,
  CanvasLinkContext,
  CanvasRect,
  CanvasViewport,
  CanvasWebChat
} from '@delta/core/canvas'
import { DEFAULT_VIEWPORT } from '@delta/core/canvas'
import type { CanvasFrameUpdate } from '@delta/core/canvas-arrange'
import type { CanvasSnapshot } from '@delta/core/canvas-history'
import type { CanvasContextLink } from '@delta/core/canvas-context'
import type { ConversationMeta, Turn } from '@delta/core/conversation'
import type { ExpansionRange, ExpansionTarget } from '@delta/core/rich-text'
import type { ExpandOutcome } from '../conversation/expand-outcome'
import type { ExportResult } from '../host'
import type { ToolActivity } from '../lib/tool-activity'

export const SAVE_DELAY_MS = 300
export const UNTITLED = 'Untitled canvas'
export const HISTORY_LIMIT = 100
/** Page text kept on a page card; every session that continues it sends this much. */
export const PAGE_TEXT_LIMIT = 21_000

export interface CanvasDoc {
  turns: Turn[]
  layout: CanvasLayout
}

export interface CanvasMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  kbFed: boolean
  /** A record exists on disk, so an emptied canvas must be removed from there. */
  persisted: boolean
}

export type PendingRequest =
  { kind: 'send'; turnId: number } | { kind: 'expand'; expansionId: number }

/** A card the model added through a canvas tool, rather than one the user asked. */
export interface CanvasSpawnedForm {
  relation?: string
  spawned?: boolean
}

export interface CanvasCardUpdate {
  id: string
  rect: CanvasRect
}

/** What undo or redo did, with the reason when it could not. */
export type CanvasHistoryStep = { ok: true; label: string } | { ok: false; reason: string }

/** A web page to put on the canvas as a card (the extension's page canvas). */
export interface CanvasPageInput {
  text: string
  title: string
  url: string
}

export interface CanvasExpandPlacement {
  hostId: string
  rect: CanvasRect
}

/** A question for a `CanvasAsker`, which builds what it sends from the canvas when it is free. */
export type CanvasAskRequest =
  | { kind: 'send'; cardId: string }
  | {
      kind: 'expand'
      cardId: string
      turnId: number
      target: ExpansionTarget
      prompt: string | undefined
      rect: CanvasRect
      caption: string
    }

/** How an asker reports back; anything after the request was dropped is ignored. */
export interface CanvasAskEvents {
  /** Whether the canvas still waits for this answer. */
  live: () => boolean
  /** The whole answer so far. */
  text: (full: string) => void
  done: (text: string, cancelled: boolean) => void
  error: (message: string, partial: string) => void
}

/**
 * Another assistant that answers a canvas instead of the host's model, such as the web chat
 * the extension's canvas mirrors. `handles` decides per canvas; `ask` returns a stop handle,
 * and a stopped question still ends with `done(partial, true)` or `error`.
 */
export interface CanvasAsker {
  handles: (layout: CanvasLayout) => boolean
  ask: (
    request: CanvasAskRequest,
    read: () => CanvasDocView,
    events: CanvasAskEvents
  ) => { stop: () => void }
}

export interface CanvasDocView {
  turns: Turn[]
  layout: CanvasLayout
}

export interface CanvasImport {
  turns: Turn[]
  cards: CanvasCard[]
  webChat?: CanvasWebChat
}

/** What the board does once a canvas opens: fit everything, say something, open the composer. */
export interface CanvasOpening {
  fit?: boolean
  notice?: string
  /** Continue this card, or start a new session for null; undefined opens no composer. */
  continueId?: string | null
}

let nextTurnId = Date.now()

/** A turn id no other turn in this window holds, for turns made outside the hook. */
export function allocateTurnId(): number {
  return nextTurnId++
}

export const emptyDoc = (): CanvasDoc => ({
  turns: [],
  layout: { cards: [], frames: [], links: [], stack: [], viewport: DEFAULT_VIEWPORT }
})

export function snapshotOf({ turns, layout }: CanvasDoc): CanvasSnapshot {
  return { turns, cards: layout.cards, frames: layout.frames, links: layout.links }
}

export function newMeta(): CanvasMeta {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    title: UNTITLED,
    createdAt: now,
    updatedAt: now,
    kbFed: false,
    persisted: false
  }
}

export function requestBelongsTo(request: PendingRequest, card: CanvasCard): boolean {
  if (card.kind === 'note' || card.kind === 'page') return false
  return card.kind === 'message'
    ? request.kind === 'send' && request.turnId === card.turnId
    : request.kind === 'expand' && request.expansionId === card.expansionId
}

/** What `useCanvas` returns: the open canvas and everything that changes it. */
export interface CanvasState {
  loaded: boolean
  /** Every conversation, of every type, newest first. */
  sessions: ConversationMeta[]
  canvasId: string
  title: string
  turns: Turn[]
  cards: CanvasCard[]
  frames: CanvasFrame[]
  links: CanvasLink[]
  /** Which cards are on top where they overlap: see `cardStackRanks`. */
  stack: string[]
  viewport: CanvasViewport
  /** What undo and redo would do next; null when there is nothing. */
  undoLabel: string | null
  redoLabel: string | null
  /** Assistant turns with a request in flight. */
  streamingTurnIds: ReadonlySet<number>
  /** What each streaming card's model is doing with its tools, until it answers. */
  toolActivity: ToolActivity
  /** Cards whose height should be fitted to their answer the next time they are on screen. */
  fitCardIds: ReadonlySet<string>
  /** The page `startFromPage` just put down, until the board has opened a question beside it. */
  startedPageId: string | null
  /** What `beginAt` asked of the board, until the board has done it. */
  opening: CanvasOpening | null
  /** The web chat this canvas mirrors, if any (the extension's). */
  webChat: CanvasWebChat | undefined
  ensureLoaded: () => void
  refreshSessions: () => Promise<ConversationMeta[]>
  newCanvas: () => void
  /** A fresh canvas holding a web page; the board then opens a question beside it. */
  startFromPage: (page: CanvasPageInput) => void
  clearStartedPage: () => void
  beginAt: (opening: CanvasOpening) => void
  clearOpening: () => void
  /** Rebinds the mirrored web chat; a layout change only. */
  setWebChat: (change: (prev: CanvasWebChat | undefined) => CanvasWebChat | undefined) => void
  /**
   * Adds answered cards made elsewhere (a mirrored chat's exchanges), built from the canvas as
   * it stands and fitted once on screen; a `webChat` given replaces the binding.
   */
  addImported: (build: (current: CanvasDocView) => CanvasImport) => CanvasImport
  /** Resolves false when there is no such canvas, which leaves the open one as it was. */
  openCanvas: (id: string) => Promise<boolean>
  /** Writes pending changes now, before something else reads the stored record. */
  flushSave: () => Promise<void>
  deleteCanvas: () => void
  rename: (title: string) => void
  setViewport: (viewport: CanvasViewport) => void
  /** Moves cards and frames as one undoable step. */
  moveItems: (label: string, cards: CanvasCardUpdate[], frames?: CanvasFrameUpdate[]) => void
  /** Puts cards on top of what they overlap. */
  raiseCards: (ids: Iterable<string>) => void
  undo: () => CanvasHistoryStep | null
  redo: () => CanvasHistoryStep | null
  addNote: (rect: CanvasRect, text: string) => string
  updateNote: (id: string, text: string) => void
  addFrame: (rect: CanvasRect, title: string) => string
  renameFrame: (id: string, title: string) => void
  /** A `quote` makes it a context link that sends only that passage of `from`. */
  addLink: (from: string, to: string, quote?: string) => string | null
  /** Toggles a highlight on a passage of a turn, or of an expansion's answer. */
  toggleHighlight: (turnId: number, range: ExpansionRange, parentExpansionId?: number) => void
  labelLink: (id: string, label: string) => void
  reverseLink: (id: string) => void
  /** What this link sends to the branch it points at; undefined makes it a plain arrow again. */
  setLinkContext: (id: string, context: CanvasLinkContext | undefined) => void
  setColor: (ids: ReadonlySet<string>, color: CanvasColor | undefined) => void
  setCollapsed: (ids: ReadonlySet<string>, collapsed: boolean) => void
  /** Returns the new items' ids; empty when nothing could be copied. */
  duplicate: (ids: ReadonlySet<string>) => string[]
  requestFit: (id: string) => void
  /** `null` means there was nothing to measure, so the card stays as it is. */
  fitCard: (id: string, contentHeight: number | null) => void
  exportCanvas: () => Promise<ExportResult>
  /** Returns the new card's id. */
  ask: (
    rect: CanvasRect,
    question: string,
    parentId: string | undefined,
    sources?: readonly string[],
    context?: readonly CanvasContextLink[],
    spawned?: CanvasSpawnedForm
  ) => string
  /** Asks a suggestion offered under `cardId` as its own card; null when it is gone. */
  askSuggestion: (cardId: string, question: string) => string | null
  /** Puts a page on the canvas as the first context of every session continuing it. */
  addPage: (rect: CanvasRect | undefined, page: CanvasPageInput) => string
  expand: (
    turnId: number,
    target: ExpansionTarget,
    prompt: string | undefined,
    placement: CanvasExpandPlacement
  ) => ExpandOutcome
  stopCard: (id: string) => void
  regenerateCard: (id: string) => void
  editCard: (id: string, question: string) => void
  /** Removes cards with what depends on them, frames (not what they hold) and links. */
  removeItems: (ids: ReadonlySet<string>) => void
}
