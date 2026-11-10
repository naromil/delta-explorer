/**
 * Canvas state: one open canvas, its turns and layout, and its streams.
 *
 * It lives in `App` so answers keep streaming while another view is open. A
 * canvas is a conversation record with `source: 'canvas'`, so main and the
 * curator treat it as one. Unlike a chat, its turns are a pool rather than a
 * line: what a request sends is found by walking a card's session.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CanvasCard,
  CanvasColor,
  CanvasFrame,
  CanvasLayout,
  CanvasLink,
  CanvasLinkContext,
  CanvasMessageCard,
  CanvasRect,
  CanvasViewport,
  CanvasWebChat
} from '@delta/core/canvas'
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_VIEWPORT,
  cascadeCardIds,
  fitCardHeight,
  raisedStack,
  normalizeCanvasLayout,
  setCardCollapsed,
  withoutField
} from '@delta/core/canvas'
import type { CanvasFrameUpdate } from '@delta/core/canvas-arrange'
import { duplicateSelection } from '@delta/core/canvas-arrange'
import type { CanvasPatch, CanvasPatchDirection, CanvasSnapshot } from '@delta/core/canvas-history'
import { applyCanvasPatch, diffCanvas } from '@delta/core/canvas-history'
import type { CanvasContextLink } from '@delta/core/canvas-context'
import type { ConversationMeta, ProviderMessage, Turn } from '@delta/core/conversation'
import { CONVERSATION_TITLE_MAX_LENGTH, buildConversationTitle } from '@delta/core/conversation'
import { expansionCardRequest, messageCardRequest } from '@delta/core/canvas-request'
import type { ExpansionTarget } from '@delta/core/rich-text'
import {
  applyExpansionChunk,
  expansionMessageInput,
  expansionSubtreeIds,
  finalizeTurns,
  findExpansionInTurns,
  insertExpansionInTurns,
  maxExpansionId,
  removeExpansionInTurns,
  restartExpansion,
  updateExpansion
} from '@delta/core/rich-text'
import { isAnchoredRange } from '../lib/markdown'
import { generateRequestId } from '../lib/request-id'
import type { ExpandOutcome } from '../conversation/expand-outcome'
import { bodyCharWidth } from '../lib/char-width'
import { useUiHost } from '../host'
import type { ExportResult, StreamListener } from '../host'

const SAVE_DELAY_MS = 300
const UNTITLED = 'Untitled canvas'
const HISTORY_LIMIT = 100
/** Page text kept on a page card; every session that continues it sends this much. */
const PAGE_TEXT_LIMIT = 21_000

interface CanvasDoc {
  turns: Turn[]
  layout: CanvasLayout
}

interface CanvasMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  kbFed: boolean
  /** A record exists on disk, so an emptied canvas must be removed from there. */
  persisted: boolean
}

type PendingRequest = { kind: 'send'; turnId: number } | { kind: 'expand'; expansionId: number }

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

const emptyDoc = (): CanvasDoc => ({
  turns: [],
  layout: { cards: [], frames: [], links: [], stack: [], viewport: DEFAULT_VIEWPORT }
})

function snapshotOf({ turns, layout }: CanvasDoc): CanvasSnapshot {
  return { turns, cards: layout.cards, frames: layout.frames, links: layout.links }
}

function newMeta(): CanvasMeta {
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

function requestBelongsTo(request: PendingRequest, card: CanvasCard): boolean {
  if (card.kind === 'note' || card.kind === 'page') return false
  return card.kind === 'message'
    ? request.kind === 'send' && request.turnId === card.turnId
    : request.kind === 'expand' && request.expansionId === card.expansionId
}

export function useCanvas(asker?: CanvasAsker | null): {
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
  addLink: (from: string, to: string) => string | null
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
    context?: readonly CanvasContextLink[]
  ) => string
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
} {
  const host = useUiHost()
  const [doc, setDoc] = useState<CanvasDoc>(emptyDoc)
  const [loaded, setLoaded] = useState(false)
  const [sessions, setSessions] = useState<ConversationMeta[]>([])
  const [meta, setMeta] = useState<CanvasMeta>(newMeta)
  const [streamingTurnIds, setStreamingTurnIds] = useState<ReadonlySet<number>>(new Set())
  const [fitCardIds, setFitCardIds] = useState<ReadonlySet<string>>(new Set())
  const [startedPageId, setStartedPageId] = useState<string | null>(null)
  const [opening, setOpening] = useState<CanvasOpening | null>(null)

  // Requests start from event handlers and must see the newest state at once.
  const docRef = useRef(doc)
  const metaRef = useRef(meta)
  const requestsRef = useRef(new Map<string, PendingRequest>())
  const askerRef = useRef(asker ?? null)
  /** Stop handles of the requests an asker took instead of the host. */
  const askerStopsRef = useRef(new Map<string, () => void>())
  /** The stream listener, which an asker's events go through as the host's do. */
  const listenerRef = useRef<StreamListener | null>(null)
  const expansionCounterRef = useRef(1)
  const saveTimerRef = useRef<number | null>(null)
  const loadStartedRef = useRef(false)
  const undoStackRef = useRef<CanvasPatch[]>([])
  const redoStackRef = useRef<CanvasPatch[]>([])
  const [historyLabels, setHistoryLabels] = useState<{
    undo: string | null
    redo: string | null
  }>({ undo: null, redo: null })

  const updateDoc = useCallback((change: (prev: CanvasDoc) => CanvasDoc): void => {
    docRef.current = change(docRef.current)
    setDoc(docRef.current)
  }, [])

  const updateMeta = useCallback((patch: Partial<CanvasMeta>): void => {
    metaRef.current = { ...metaRef.current, ...patch }
    setMeta(metaRef.current)
  }, [])

  const refreshSessions = useCallback((): Promise<ConversationMeta[]> => {
    return host.listConversations().then(
      (list) => {
        setSessions(list)
        return list
      },
      (err: unknown) => {
        console.warn('Failed to list conversations:', err)
        return []
      }
    )
  }, [host])

  /* ---- Persistence ---- */

  const flushSave = useCallback((): Promise<void> => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    const current = metaRef.current
    const { turns, layout } = docRef.current
    const onFailure = (err: unknown): void => console.warn('Failed to save canvas:', err)

    if (layout.cards.length === 0 && layout.frames.length === 0) {
      if (!current.persisted) return Promise.resolve()
      updateMeta({ persisted: false })
      return host.deleteConversation(current.id).then(() => {
        void refreshSessions()
      }, onFailure)
    }
    const firstSave = !current.persisted
    updateMeta({ persisted: true })
    return host
      .saveConversation({
        id: current.id,
        title: current.title,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        source: 'canvas',
        kbFed: current.kbFed,
        state: { turns: finalizeTurns(turns) },
        canvas: layout
      })
      .then(() => {
        if (firstSave) void refreshSessions()
      }, onFailure)
  }, [host, refreshSessions, updateMeta])

  /** `touchContent` is for content only: moving or panning never reorders the canvas list. */
  const requestSave = useCallback(
    (touchContent: boolean): void => {
      if (touchContent) updateMeta({ updatedAt: new Date().toISOString(), kbFed: false })
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => void flushSave(), SAVE_DELAY_MS)
    },
    [flushSave, updateMeta]
  )

  /* ---- Undo and redo ---- */

  const syncHistory = useCallback((): void => {
    setHistoryLabels({
      undo: undoStackRef.current.at(-1)?.label ?? null,
      redo: redoStackRef.current.at(-1)?.label ?? null
    })
  }, [])

  /** Runs one user action and remembers what it changed, so it can be taken back. */
  const recorded = useCallback(
    (label: string, action: () => void): void => {
      const before = snapshotOf(docRef.current)
      action()
      const patch = diffCanvas(label, before, snapshotOf(docRef.current))
      if (!patch) return
      undoStackRef.current = [...undoStackRef.current, patch].slice(-HISTORY_LIMIT)
      redoStackRef.current = []
      syncHistory()
    },
    [syncHistory]
  )

  const stepHistory = useCallback(
    (direction: CanvasPatchDirection): CanvasHistoryStep | null => {
      const undoing = direction === 'undo'
      const from = undoing ? undoStackRef : redoStackRef
      const to = undoing ? redoStackRef : undoStackRef
      const patch = from.current.at(-1)
      if (!patch) return null
      const result = applyCanvasPatch(snapshotOf(docRef.current), patch, direction)
      if (!result.ok) {
        // That answer has moved on, so this step can never apply again.
        from.current = from.current.slice(0, -1)
        syncHistory()
        return { ok: false, reason: `“${patch.label}” can no longer be taken back.` }
      }
      from.current = from.current.slice(0, -1)
      to.current = [...to.current, patch]
      const { turns, cards, frames, links } = result.snapshot
      updateDoc((prev) => ({ turns, layout: { ...prev.layout, cards, frames, links } }))
      requestSave(patch.turns.length > 0)
      syncHistory()
      return { ok: true, label: patch.label }
    },
    [requestSave, syncHistory, updateDoc]
  )

  const undo = useCallback(() => stepHistory('undo'), [stepHistory])
  const redo = useCallback(() => stepHistory('redo'), [stepHistory])

  /* ---- Requests ---- */

  const syncStreaming = useCallback((): void => {
    const ids = new Set<number>()
    for (const request of requestsRef.current.values()) {
      if (request.kind === 'send') ids.add(request.turnId)
    }
    setStreamingTurnIds(ids)
  }, [])

  const cancelStream = useCallback(
    (requestId: string): void => {
      const stop = askerStopsRef.current.get(requestId)
      if (stop) stop()
      else host.cancel(requestId)
    },
    [host]
  )

  const cancelRequests = useCallback(
    (matches: (request: PendingRequest) => boolean): void => {
      for (const [requestId, request] of [...requestsRef.current]) {
        if (!matches(request)) continue
        // Forgotten first, so a late chunk cannot land on what is being removed.
        requestsRef.current.delete(requestId)
        cancelStream(requestId)
        askerStopsRef.current.delete(requestId)
      }
      syncStreaming()
    },
    [cancelStream, syncStreaming]
  )

  /** Whether this canvas's questions go to the asker rather than the host. */
  const asksElsewhere = useCallback((): boolean => {
    const current = askerRef.current
    return current !== null && current.handles(docRef.current.layout)
  }, [])

  /** Hands a request to the asker; its events reach the canvas as the host's would. */
  const askElsewhere = useCallback(
    (requestId: string, request: CanvasAskRequest): void => {
      const current = askerRef.current
      if (!current) return
      const send = request.kind === 'send'
      const listener = (): StreamListener | null => listenerRef.current
      const handle = current.ask(request, () => docRef.current, {
        live: () => requestsRef.current.has(requestId),
        text: (full) => {
          const pending = requestsRef.current.get(requestId)
          if (!pending) return
          if (pending.kind === 'send') {
            updateDoc((prev) => ({
              ...prev,
              turns: prev.turns.map((turn) =>
                turn.id === pending.turnId ? { ...turn, content: full } : turn
              )
            }))
          } else {
            listener()?.expandChunk({ requestId, text: full })
          }
        },
        done: (text, cancelled) => {
          if (send) listener()?.response({ requestId, text, cancelled })
          else listener()?.expandChunk({ requestId, text, done: true, cancelled })
        },
        error: (message, partial) => {
          if (send) listener()?.error({ requestId, error: message })
          else listener()?.expandChunk({ requestId, error: message, text: partial })
        }
      })
      // An asker may settle at once; only a request still waiting keeps its handle.
      if (requestsRef.current.has(requestId)) askerStopsRef.current.set(requestId, handle.stop)
    },
    [updateDoc]
  )

  const startSend = useCallback(
    (card: CanvasMessageCard, messages: ProviderMessage[] | null): void => {
      const requestId = generateRequestId()
      requestsRef.current.set(requestId, { kind: 'send', turnId: card.turnId })
      syncStreaming()
      if (messages) host.send({ messages, requestId, role: 'chat' })
      else askElsewhere(requestId, { kind: 'send', cardId: card.id })
    },
    [askElsewhere, host, syncStreaming]
  )

  const sendCard = useCallback(
    (card: CanvasCard): void => {
      if (card.kind !== 'message') return
      if (asksElsewhere()) {
        startSend(card, null)
        return
      }
      const { turns, layout } = docRef.current
      startSend(card, messageCardRequest(layout.cards, layout.links, turns, card, bodyCharWidth()))
    },
    [asksElsewhere, startSend]
  )

  /** An expansion's request, to the asker or the host. */
  const startExpand = useCallback(
    (
      expansionId: number,
      messages: ProviderMessage[] | null,
      asked: Extract<CanvasAskRequest, { kind: 'expand' }>
    ): void => {
      const requestId = generateRequestId()
      requestsRef.current.set(requestId, { kind: 'expand', expansionId })
      if (messages) host.expand({ messages, requestId, role: 'chat' })
      else askElsewhere(requestId, asked)
    },
    [askElsewhere, host]
  )

  const expansionMessages = useCallback(
    (
      turn: Turn,
      target: ExpansionTarget,
      prompt: string | undefined,
      rect: CanvasRect,
      caption: string
    ): ProviderMessage[] | null => {
      const { turns, layout } = docRef.current
      return expansionCardRequest(
        layout.cards,
        layout.links,
        turns,
        turn,
        target,
        prompt,
        rect,
        caption,
        bodyCharWidth()
      )
    },
    []
  )

  const expand = useCallback(
    (
      turnId: number,
      target: ExpansionTarget,
      prompt: string | undefined,
      placement: CanvasExpandPlacement
    ): ExpandOutcome => {
      const turn = docRef.current.turns.find((item) => item.id === turnId)
      if (!turn) return { ok: false, reason: 'turn-not-found' }
      const input = expansionMessageInput(turn, target.parentExpansionId, target)
      if (!input) return { ok: false, reason: 'out-of-bounds' }
      if (!isAnchoredRange(input.answer, target)) return { ok: false, reason: 'not-anchored' }

      const expansionId = expansionCounterRef.current
      const insertion = insertExpansionInTurns(
        docRef.current.turns,
        turnId,
        target,
        expansionId,
        prompt
      )
      if (!insertion.ok) return { ok: false, reason: insertion.reason }
      const elsewhere = asksElsewhere()
      const messages = elsewhere
        ? null
        : expansionMessages(turn, target, prompt, placement.rect, input.selection)
      if (!elsewhere && !messages) return { ok: false, reason: 'turn-not-found' }

      expansionCounterRef.current += 1
      const cardId = crypto.randomUUID()
      updateDoc((prev) => ({
        turns: insertion.turns,
        layout: {
          ...prev.layout,
          cards: [
            ...prev.layout.cards,
            {
              kind: 'expansion',
              id: cardId,
              rect: placement.rect,
              turnId,
              expansionId,
              hostId: placement.hostId
            }
          ]
        }
      }))
      startExpand(expansionId, messages, {
        kind: 'expand',
        cardId,
        turnId,
        target,
        prompt,
        rect: placement.rect,
        caption: input.selection
      })
      requestSave(true)
      return { ok: true }
    },
    [asksElsewhere, expansionMessages, requestSave, startExpand, updateDoc]
  )

  const ask = useCallback(
    (
      rect: CanvasRect,
      question: string,
      parentId: string | undefined,
      sources: readonly string[] = [],
      context: readonly CanvasContextLink[] = []
    ): string => {
      const userTurnId = nextTurnId++
      const turnId = nextTurnId++
      const card: CanvasCard = {
        kind: 'message',
        id: crypto.randomUUID(),
        rect,
        userTurnId,
        turnId,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(sources.length > 0 ? { sources: [...sources] } : {})
      }
      if (metaRef.current.title === UNTITLED) {
        updateMeta({ title: buildConversationTitle(question) })
      }
      updateDoc((prev) => ({
        turns: [
          ...prev.turns,
          { id: userTurnId, role: 'user', content: question, expansions: [] },
          { id: turnId, role: 'assistant', content: '', expansions: [] }
        ],
        layout: {
          ...prev.layout,
          cards: [...prev.layout.cards, card],
          links: [
            ...prev.layout.links,
            ...context.map((link): CanvasLink => ({
              ...link,
              id: crypto.randomUUID(),
              to: card.id
            }))
          ]
        }
      }))
      sendCard(card)
      requestSave(true)
      return card.id
    },
    [requestSave, sendCard, updateDoc, updateMeta]
  )

  const addPage = useCallback(
    (rect: CanvasRect | undefined, page: CanvasPageInput): string => {
      const turnId = nextTurnId++
      const card: CanvasCard = {
        kind: 'page',
        id: crypto.randomUUID(),
        rect: rect ?? { x: 0, y: 0, ...DEFAULT_PAGE_SIZE },
        turnId,
        title: page.title.slice(0, 300),
        url: page.url.slice(0, 2000)
      }
      if (metaRef.current.title === UNTITLED) {
        updateMeta({ title: buildConversationTitle(card.title || card.url || 'Web page') })
      }
      recorded('Add page', () => {
        updateDoc((prev) => ({
          turns: [
            ...prev.turns,
            {
              id: turnId,
              role: 'user',
              content: page.text.slice(0, PAGE_TEXT_LIMIT),
              expansions: []
            }
          ],
          layout: { ...prev.layout, cards: [...prev.layout.cards, card] }
        }))
      })
      requestSave(true)
      return card.id
    },
    [recorded, requestSave, updateDoc, updateMeta]
  )

  const stopCard = useCallback(
    (id: string): void => {
      const card = docRef.current.layout.cards.find((item) => item.id === id)
      if (!card) return
      // Stays in the book: main answers with the partial text, which settles it.
      for (const [requestId, request] of [...requestsRef.current]) {
        if (requestBelongsTo(request, card)) cancelStream(requestId)
      }
    },
    [cancelStream]
  )

  const removeCards = useCallback(
    (doomed: ReadonlySet<string>): void => {
      const { turns, layout } = docRef.current
      const doomedCards = layout.cards.filter((card) => doomed.has(card.id))
      const doomedTurns = new Set<number>()
      const doomedExpansions = new Set<number>()
      for (const card of doomedCards) {
        if (card.kind === 'note') continue
        if (card.kind === 'message') {
          doomedTurns.add(card.userTurnId)
          doomedTurns.add(card.turnId)
          continue
        }
        if (card.kind === 'page') {
          doomedTurns.add(card.turnId)
          continue
        }
        const location = findExpansionInTurns(turns, card.expansionId)
        if (location) {
          for (const nodeId of expansionSubtreeIds(location.node)) doomedExpansions.add(nodeId)
        }
      }
      cancelRequests((request) =>
        request.kind === 'send'
          ? doomedTurns.has(request.turnId)
          : doomedExpansions.has(request.expansionId)
      )
      updateDoc((prev) => {
        let nextTurns = prev.turns.filter((turn) => !doomedTurns.has(turn.id))
        for (const card of doomedCards) {
          if (card.kind === 'expansion') {
            nextTurns = removeExpansionInTurns(nextTurns, card.expansionId)
          }
        }
        return {
          turns: nextTurns,
          layout: {
            ...prev.layout,
            cards: prev.layout.cards.filter((card) => !doomed.has(card.id)),
            links: prev.layout.links.filter(
              (link) => !doomed.has(link.from) && !doomed.has(link.to)
            )
          }
        }
      })
    },
    [cancelRequests, updateDoc]
  )

  const removeItems = useCallback(
    (ids: ReadonlySet<string>): void => {
      const { cards } = docRef.current.layout
      const doomed = new Set<string>()
      for (const card of cards) {
        if (ids.has(card.id)) {
          for (const id of cascadeCardIds(cards, card.id)) doomed.add(id)
        }
      }
      recorded('Delete', () => {
        if (doomed.size > 0) removeCards(doomed)
        updateDoc((prev) => ({
          ...prev,
          layout: {
            ...prev.layout,
            frames: prev.layout.frames.filter((frame) => !ids.has(frame.id)),
            links: prev.layout.links.filter((link) => !ids.has(link.id))
          }
        }))
      })
      requestSave(doomed.size > 0)
    },
    [recorded, removeCards, requestSave, updateDoc]
  )

  /**
   * A fresh answer sized by the card as it is now, for Retry and Regenerate alike.
   * What depends on the old answer goes first: expansions are anchored in its text
   * and continuations were written after it.
   */
  const regenerateCard = useCallback(
    (id: string): void => {
      const { turns, layout } = docRef.current
      const card = layout.cards.find((item) => item.id === id)
      if (!card || card.kind === 'note' || card.kind === 'page') return
      const dependents = cascadeCardIds(layout.cards, id)
      dependents.delete(id)

      if (card.kind === 'message') {
        removeCards(dependents)
        cancelRequests((request) => requestBelongsTo(request, card))
        updateDoc((prev) => ({
          ...prev,
          turns: prev.turns.map((turn) => {
            if (turn.id !== card.turnId) return turn
            return { id: turn.id, role: turn.role, content: '', expansions: [] }
          })
        }))
        sendCard(card)
      } else {
        const location = findExpansionInTurns(turns, card.expansionId)
        if (!location) return
        const target: ExpansionTarget = {
          start: location.node.start,
          end: location.node.end,
          ...(location.parent ? { parentExpansionId: location.parent.id } : {})
        }
        const elsewhere = asksElsewhere()
        const messages = elsewhere
          ? null
          : expansionMessages(
              location.turn,
              target,
              location.node.prompt,
              card.rect,
              location.node.originalText
            )
        if (!elsewhere && !messages) return
        removeCards(dependents)
        cancelRequests((request) => requestBelongsTo(request, card))
        updateDoc((prev) => ({ ...prev, turns: restartExpansion(prev.turns, card.expansionId) }))
        startExpand(card.expansionId, messages, {
          kind: 'expand',
          cardId: card.id,
          turnId: location.turn.id,
          target,
          prompt: location.node.prompt,
          rect: card.rect,
          caption: location.node.originalText
        })
      }
      requestSave(true)
    },
    [
      asksElsewhere,
      cancelRequests,
      expansionMessages,
      removeCards,
      requestSave,
      sendCard,
      startExpand,
      updateDoc
    ]
  )

  const editCard = useCallback(
    (id: string, question: string): void => {
      const card = docRef.current.layout.cards.find((item) => item.id === id)
      if (!card || card.kind === 'note' || card.kind === 'page') return
      updateDoc((prev) => ({
        ...prev,
        turns:
          card.kind === 'expansion'
            ? updateExpansion(prev.turns, card.expansionId, { prompt: question })
            : prev.turns.map((turn) =>
                turn.id === card.userTurnId ? { ...turn, content: question } : turn
              )
      }))
      regenerateCard(id)
    },
    [regenerateCard, updateDoc]
  )

  /* ---- Layout ---- */

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
    [requestSave, updateDoc]
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
    (from: string, to: string): string | null => {
      const { cards, links } = docRef.current.layout
      const known = (id: string): boolean => cards.some((card) => card.id === id)
      if (from === to || !known(from) || !known(to)) return null
      const existing = links.find((link) => link.from === from && link.to === to)
      if (existing) return existing.id
      const id = crypto.randomUUID()
      editLayout('Connect', (layout) => ({
        ...layout,
        links: [...layout.links, { id, from, to }]
      }))
      return id
    },
    [editLayout]
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
        newTurnId: () => nextTurnId++,
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
    [recorded, requestSave, updateDoc]
  )

  const requestFit = useCallback((id: string): void => {
    setFitCardIds((prev) => new Set(prev).add(id))
  }, [])

  const fitCard = useCallback(
    (id: string, contentHeight: number | null): void => {
      setFitCardIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (contentHeight === null) return
      const updates = fitCardHeight(docRef.current.layout.cards, id, contentHeight)
      if (updates.length > 0) updateCards(updates)
    },
    [updateCards]
  )

  const exportCanvas = useCallback(async (): Promise<ExportResult> => {
    // The host reads the stored record, so the newest state has to be there first.
    await flushSave()
    return host.exportConversation(metaRef.current.id)
  }, [flushSave, host])

  const rename = useCallback(
    (title: string): void => {
      const next = title.trim().slice(0, CONVERSATION_TITLE_MAX_LENGTH)
      if (next === '' || next === metaRef.current.title) return
      updateMeta({ title: next })
      requestSave(false)
    },
    [requestSave, updateMeta]
  )

  /* ---- Opening canvases ---- */

  const replaceDoc = useCallback(
    (nextDoc: CanvasDoc, nextMeta: CanvasMeta): void => {
      if (saveTimerRef.current !== null) void flushSave()
      cancelRequests(() => true)
      setFitCardIds(new Set())
      undoStackRef.current = []
      redoStackRef.current = []
      syncHistory()
      metaRef.current = nextMeta
      setMeta(nextMeta)
      docRef.current = nextDoc
      setDoc(nextDoc)
      expansionCounterRef.current = maxExpansionId(nextDoc.turns) + 1
    },
    [cancelRequests, flushSave, syncHistory]
  )

  const newCanvas = useCallback((): void => {
    // Counts as loaded: the newest canvas must not be opened over it.
    loadStartedRef.current = true
    replaceDoc(emptyDoc(), newMeta())
    setLoaded(true)
    void refreshSessions()
  }, [refreshSessions, replaceDoc])

  const beginAt = useCallback((next: CanvasOpening): void => setOpening(next), [])
  const clearOpening = useCallback((): void => setOpening(null), [])

  const setWebChat = useCallback(
    (change: (prev: CanvasWebChat | undefined) => CanvasWebChat | undefined): void => {
      updateDoc((prev) => {
        const webChat = change(prev.layout.webChat)
        const rest = withoutField(prev.layout, 'webChat')
        return { ...prev, layout: webChat ? { ...rest, webChat } : rest }
      })
      requestSave(false)
    },
    [requestSave, updateDoc]
  )

  const addImported = useCallback(
    (build: (current: CanvasDocView) => CanvasImport): CanvasImport => {
      const imported = build(docRef.current)
      const { turns, cards, webChat } = imported
      const firstQuestion = turns.find((turn) => turn.role === 'user')
      if (metaRef.current.title === UNTITLED && firstQuestion) {
        updateMeta({ title: buildConversationTitle(firstQuestion.content) })
      }
      updateDoc((prev) => ({
        turns: [...prev.turns, ...turns],
        layout: {
          ...prev.layout,
          cards: [...prev.layout.cards, ...cards],
          ...(webChat ? { webChat } : {})
        }
      }))
      if (cards.length > 0) {
        setFitCardIds((prev) => {
          const next = new Set(prev)
          for (const card of cards) next.add(card.id)
          return next
        })
      }
      requestSave(cards.length > 0)
      return imported
    },
    [requestSave, updateDoc, updateMeta]
  )

  const startFromPage = useCallback(
    (page: CanvasPageInput): void => {
      // Counts as loaded: the newest canvas must not be opened over it.
      loadStartedRef.current = true
      replaceDoc(emptyDoc(), newMeta())
      setStartedPageId(addPage(undefined, page))
      setLoaded(true)
      void refreshSessions()
    },
    [addPage, refreshSessions, replaceDoc]
  )

  const clearStartedPage = useCallback((): void => setStartedPageId(null), [])

  const openCanvas = useCallback(
    (id: string): Promise<boolean> => {
      // Opened from another view's history: the first visit must not pick the newest instead.
      if (!loadStartedRef.current) {
        loadStartedRef.current = true
        void refreshSessions()
      }
      return host.loadConversation(id).then((record) => {
        if (!record || record.source !== 'canvas') {
          void refreshSessions()
          setLoaded(true)
          return false
        }
        const turns = finalizeTurns(record.state.turns)
        replaceDoc(
          { turns, layout: normalizeCanvasLayout(record.canvas, turns) },
          {
            id: record.id,
            title: record.title,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            kbFed: record.kbFed,
            persisted: true
          }
        )
        setLoaded(true)
        return true
      })
    },
    [host, refreshSessions, replaceDoc]
  )

  const deleteCanvas = useCallback((): void => {
    const { id, persisted } = metaRef.current
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    replaceDoc(emptyDoc(), newMeta())
    if (persisted) void host.deleteConversation(id).then(refreshSessions)
  }, [host, refreshSessions, replaceDoc])

  const ensureLoaded = useCallback((): void => {
    if (loadStartedRef.current) return
    loadStartedRef.current = true
    void host
      .listConversations()
      .then((list) => {
        setSessions(list)
        const newest = list.find((item) => item.source === 'canvas')
        if (newest) void openCanvas(newest.id)
        else setLoaded(true)
      })
      .catch((err: unknown) => {
        console.warn('Failed to load canvases:', err)
        setLoaded(true)
      })
  }, [host, openCanvas])

  /* ---- Streaming ---- */

  useEffect(() => {
    askerRef.current = asker ?? null
  }, [asker])

  useEffect(() => {
    const settle = (requestId: string): void => {
      requestsRef.current.delete(requestId)
      askerStopsRef.current.delete(requestId)
      syncStreaming()
      requestSave(true)
    }
    const fitAnswered = (matches: (card: CanvasCard) => boolean): void => {
      const card = docRef.current.layout.cards.find(matches)
      if (card) requestFit(card.id)
    }
    const editTurn = (turnId: number, change: (turn: Turn) => Turn): void => {
      updateDoc((prev) => ({
        ...prev,
        turns: prev.turns.map((turn) => (turn.id === turnId ? change(turn) : turn))
      }))
    }

    const listener: StreamListener = {
      chunk: ({ requestId, delta }) => {
        const request = requestsRef.current.get(requestId)
        if (request?.kind !== 'send') return
        editTurn(request.turnId, (turn) => ({ ...turn, content: turn.content + delta }))
      },
      response: ({ requestId, text, cancelled }) => {
        const request = requestsRef.current.get(requestId)
        if (request?.kind !== 'send') return
        editTurn(request.turnId, (turn) => ({ ...turn, content: text }))
        settle(requestId)
        // A stopped answer is not what the rectangle was for, so it keeps its size.
        if (!cancelled && text.trim() !== '') {
          fitAnswered((card) => card.kind === 'message' && card.turnId === request.turnId)
        }
      },
      error: ({ requestId, error }) => {
        const request = requestsRef.current.get(requestId)
        if (request?.kind !== 'send') return
        editTurn(request.turnId, (turn) => ({ ...turn, content: error, error: true }))
        settle(requestId)
      },
      expandChunk: (data) => {
        const request = requestsRef.current.get(data.requestId)
        if (request?.kind !== 'expand') return
        const { delta, text, done, error, cancelled } = data
        updateDoc((prev) => ({
          ...prev,
          turns: applyExpansionChunk(prev.turns, request.expansionId, {
            ...(delta !== undefined ? { delta } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(done !== undefined ? { done } : {}),
            ...(error !== undefined ? { error } : {})
          })
        }))
        if (error !== undefined || done) settle(data.requestId)
        if (done && error === undefined && !cancelled) {
          fitAnswered(
            (card) => card.kind === 'expansion' && card.expansionId === request.expansionId
          )
        }
      }
    }
    listenerRef.current = listener
    const unsubscribe = host.subscribe(listener)
    return () => {
      unsubscribe()
      listenerRef.current = null
    }
  }, [host, requestFit, requestSave, syncStreaming, updateDoc])

  return {
    loaded,
    sessions,
    canvasId: meta.id,
    title: meta.title,
    turns: doc.turns,
    cards: doc.layout.cards,
    frames: doc.layout.frames,
    links: doc.layout.links,
    stack: doc.layout.stack,
    viewport: doc.layout.viewport,
    undoLabel: historyLabels.undo,
    redoLabel: historyLabels.redo,
    streamingTurnIds,
    fitCardIds,
    startedPageId,
    opening,
    webChat: doc.layout.webChat,
    ensureLoaded,
    refreshSessions,
    newCanvas,
    startFromPage,
    clearStartedPage,
    beginAt,
    clearOpening,
    setWebChat,
    addImported,
    openCanvas,
    flushSave,
    deleteCanvas,
    rename,
    setViewport,
    moveItems,
    raiseCards,
    undo,
    redo,
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
    duplicate,
    requestFit,
    fitCard,
    exportCanvas,
    ask,
    addPage,
    expand,
    stopCard,
    regenerateCard,
    editCard,
    removeItems
  }
}
