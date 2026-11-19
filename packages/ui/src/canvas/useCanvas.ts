/**
 * Canvas state: one open canvas, its turns and layout, and its streams.
 *
 * It lives in `App` so answers keep streaming while another view is open. A
 * canvas is a conversation record with `source: 'canvas'`, so main and the
 * curator treat it as one. Unlike a chat, its turns are a pool rather than a
 * line: what a request sends is found by walking a card's session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CanvasCard,
  CanvasLink,
  CanvasMessageCard,
  CanvasRect,
  CanvasWebChat
} from '@delta/core/canvas'
import {
  DEFAULT_PAGE_SIZE,
  cascadeCardIds,
  fitCardHeight,
  normalizeCanvasLayout,
  withoutField
} from '@delta/core/canvas'
import type { CanvasPatch, CanvasPatchDirection } from '@delta/core/canvas-history'
import { applyCanvasPatch, diffCanvas } from '@delta/core/canvas-history'
import type { CanvasContextLink } from '@delta/core/canvas-context'
import type { ConversationMeta, ProviderMessage, Turn } from '@delta/core/conversation'
import { CONVERSATION_TITLE_MAX_LENGTH, buildConversationTitle } from '@delta/core/conversation'
import { expansionCardRequest, messageCardRequest } from '@delta/core/canvas-request'
import type { CanvasSpawn } from '@delta/core/canvas-spawn'
import { soundSpawn, spawnRect } from '@delta/core/canvas-spawn'
import type { ExpansionRange, ExpansionTarget } from '@delta/core/rich-text'
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
  toggleHighlightInTurns,
  updateExpansion
} from '@delta/core/rich-text'
import { isAnchoredRange } from '../lib/markdown'
import { generateRequestId } from '../lib/request-id'
import type { ExpandOutcome } from '../conversation/expand-outcome'
import { bodyCharWidth } from '../lib/char-width'
import { useUiHost } from '../host'
import type { ExportResult, StreamListener } from '../host'
import type { ActivityLabels, ToolActivity } from '../lib/tool-activity'
import {
  HISTORY_LIMIT,
  PAGE_TEXT_LIMIT,
  SAVE_DELAY_MS,
  UNTITLED,
  allocateTurnId,
  emptyDoc,
  newMeta,
  requestBelongsTo,
  snapshotOf
} from './canvas-state'
import type {
  CanvasAskRequest,
  CanvasAsker,
  CanvasDoc,
  CanvasDocView,
  CanvasExpandPlacement,
  CanvasHistoryStep,
  CanvasImport,
  CanvasMeta,
  CanvasOpening,
  CanvasPageInput,
  CanvasSpawnedForm,
  CanvasState,
  PendingRequest
} from './canvas-state'
import { useCanvasLayout } from './useCanvasLayout'
import {
  NO_ACTIVITY_LABELS,
  liveActivityLabels,
  resolveToolActivity,
  withActivityLabel,
  withoutActivityLabel
} from '../lib/tool-activity'

export function useCanvas(asker?: CanvasAsker | null): CanvasState {
  const host = useUiHost()
  const [doc, setDoc] = useState<CanvasDoc>(emptyDoc)
  const [loaded, setLoaded] = useState(false)
  const [sessions, setSessions] = useState<ConversationMeta[]>([])
  const [meta, setMeta] = useState<CanvasMeta>(newMeta)
  const [streamingTurnIds, setStreamingTurnIds] = useState<ReadonlySet<number>>(new Set())
  const [fitCardIds, setFitCardIds] = useState<ReadonlySet<string>>(new Set())
  const [startedPageId, setStartedPageId] = useState<string | null>(null)
  const [opening, setOpening] = useState<CanvasOpening | null>(null)
  const [activityLabels, setActivityLabels] = useState<ActivityLabels>(NO_ACTIVITY_LABELS)

  // Requests start from event handlers and must see the newest state at once.
  const docRef = useRef(doc)
  const metaRef = useRef(meta)
  const requestsRef = useRef(new Map<string, PendingRequest>())
  const askerRef = useRef(asker ?? null)
  /** Stop handles of the requests an asker took instead of the host. */
  const askerStopsRef = useRef(new Map<string, () => void>())
  /** The stream listener, which an asker's events go through as the host's do. */
  const listenerRef = useRef<StreamListener | null>(null)
  /** Exploration cards an answer asked for, held until it finishes so they see all of it. */
  const pendingExploresRef = useRef(new Map<number, Extract<CanvasSpawn, { kind: 'explore' }>[]>())
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
    // A settled or dropped request's label must not outlive it.
    const live = new Set(requestsRef.current.keys())
    setActivityLabels((prev) => liveActivityLabels(prev, (requestId) => live.has(requestId)))
  }, [])

  const toolActivity = useMemo(
    (): ToolActivity => resolveToolActivity(activityLabels),
    [activityLabels]
  )

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
      if (messages) {
        // A card the model added may still draw, but does not branch further on its own.
        host.send({ messages, requestId, role: 'chat', canvas: { explore: !card.spawned } })
      } else {
        askElsewhere(requestId, { kind: 'send', cardId: card.id })
      }
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

  /** A highlight is content for the curator; like an expansion it is not an undo step. */
  const toggleHighlight = useCallback(
    (turnId: number, range: ExpansionRange, parentExpansionId?: number): void => {
      updateDoc((prev) => ({
        ...prev,
        turns: toggleHighlightInTurns(prev.turns, turnId, range, parentExpansionId)
      }))
      requestSave(true)
    },
    [requestSave, updateDoc]
  )

  /** Swaps the title cut from the first question for a model-written one, unless renamed since. */
  const nameCanvas = useCallback(
    (question: string): void => {
      const fallback = buildConversationTitle(question)
      updateMeta({ title: fallback })
      if (!host.generateTitle || question.trim() === '') return
      const id = metaRef.current.id
      void host.generateTitle(question).then(
        (generated) => {
          if (!generated || metaRef.current.id !== id || metaRef.current.title !== fallback) return
          updateMeta({ title: generated })
          requestSave(false)
        },
        (err: unknown) => console.warn('Could not generate a canvas title:', err)
      )
    },
    [host, requestSave, updateMeta]
  )

  const ask = useCallback(
    (
      rect: CanvasRect,
      question: string,
      parentId: string | undefined,
      sources: readonly string[] = [],
      context: readonly CanvasContextLink[] = [],
      spawned: CanvasSpawnedForm = {}
    ): string => {
      const userTurnId = allocateTurnId()
      const turnId = allocateTurnId()
      const card: CanvasCard = {
        kind: 'message',
        id: crypto.randomUUID(),
        rect,
        userTurnId,
        turnId,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(sources.length > 0 ? { sources: [...sources] } : {}),
        ...(spawned.spawned ? { spawned: true as const } : {}),
        ...(spawned.relation ? { relation: spawned.relation } : {})
      }
      if (metaRef.current.title === UNTITLED) nameCanvas(question)
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
    [nameCanvas, requestSave, sendCard, updateDoc]
  )
  // The stream listener asks exploration cards; it reads `ask` through this.
  const askRef = useRef(ask)
  useEffect(() => {
    askRef.current = ask
  }, [ask])

  const addPage = useCallback(
    (rect: CanvasRect | undefined, page: CanvasPageInput): string => {
      const turnId = allocateTurnId()
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

  const {
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
  } = useCanvasLayout({ docRef, requestsRef, updateDoc, requestSave, recorded })

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
    const answeringCard = (turnId: number): CanvasCard | undefined =>
      docRef.current.layout.cards.find((card) => card.kind === 'message' && card.turnId === turnId)
    /** A visual card holds what the model wrote, so it stands finished the moment it arrives. */
    const addVisual = (
      parent: CanvasCard,
      spawn: Extract<CanvasSpawn, { kind: 'visual' }>
    ): void => {
      const rect = spawnRect(docRef.current.layout.cards, parent.id, 'visual')
      if (!rect) return
      const userTurnId = allocateTurnId()
      const turnId = allocateTurnId()
      const card: CanvasCard = {
        kind: 'message',
        id: crypto.randomUUID(),
        rect,
        userTurnId,
        turnId,
        parentId: parent.id,
        spawned: true,
        ...(spawn.relation ? { relation: spawn.relation } : {})
      }
      updateDoc((prev) => ({
        turns: [
          ...prev.turns,
          { id: userTurnId, role: 'user', content: spawn.title, expansions: [] },
          { id: turnId, role: 'assistant', content: spawn.content, expansions: [] }
        ],
        layout: { ...prev.layout, cards: [...prev.layout.cards, card] }
      }))
      requestFit(card.id)
      requestSave(true)
    }
    /** Once the answer is whole, each exploration it asked for gets its card and its question. */
    const growExplores = (turnId: number): void => {
      const explores = pendingExploresRef.current.get(turnId) ?? []
      pendingExploresRef.current.delete(turnId)
      const parent = answeringCard(turnId)
      if (!parent) return
      for (const spawn of explores) {
        const rect = spawnRect(docRef.current.layout.cards, parent.id, 'explore')
        if (!rect) return
        askRef.current(rect, spawn.question, parent.id, [], [], {
          spawned: true,
          ...(spawn.relation ? { relation: spawn.relation } : {})
        })
      }
    }
    const editTurn = (turnId: number, change: (turn: Turn) => Turn): void => {
      updateDoc((prev) => ({
        ...prev,
        turns: prev.turns.map((turn) => (turn.id === turnId ? change(turn) : turn))
      }))
    }

    // Text means the model is answering again, so whatever it was doing is over.
    const clearActivity = (requestId: string): void =>
      setActivityLabels((prev) => withoutActivityLabel(prev, requestId))

    const listener: StreamListener = {
      activity: ({ requestId, label }) => {
        const request = requestsRef.current.get(requestId)
        if (!request) return
        const target =
          request.kind === 'send'
            ? { turnId: request.turnId }
            : { expansionId: request.expansionId }
        setActivityLabels((prev) => withActivityLabel(prev, requestId, label, target))
      },
      chunk: ({ requestId, delta }) => {
        const request = requestsRef.current.get(requestId)
        if (request?.kind !== 'send') return
        clearActivity(requestId)
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
          growExplores(request.turnId)
        } else {
          pendingExploresRef.current.delete(request.turnId)
        }
      },
      error: ({ requestId, error }) => {
        const request = requestsRef.current.get(requestId)
        if (request?.kind !== 'send') return
        editTurn(request.turnId, (turn) => ({ ...turn, content: error, error: true }))
        pendingExploresRef.current.delete(request.turnId)
        settle(requestId)
      },
      card: ({ requestId, card: raw }) => {
        const request = requestsRef.current.get(requestId)
        if (request?.kind !== 'send') return
        const spawn = soundSpawn(raw)
        const parent = answeringCard(request.turnId)
        if (!spawn || !parent) return
        if (spawn.kind === 'visual') {
          addVisual(parent, spawn)
          return
        }
        const held = pendingExploresRef.current.get(request.turnId) ?? []
        pendingExploresRef.current.set(request.turnId, [...held, spawn])
      },
      expandChunk: (data) => {
        const request = requestsRef.current.get(data.requestId)
        if (request?.kind !== 'expand') return
        const { delta, text, done, error, cancelled } = data
        clearActivity(data.requestId)
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
    toolActivity,
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
    toggleHighlight,
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
