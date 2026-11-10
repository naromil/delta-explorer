import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageAttachment } from '@delta/core/attachments'
import type { Turn } from '@delta/core/conversation'
import type { ExpansionRange, ExpansionTarget } from '@delta/core/rich-text'
import {
  findExpansionInNodes,
  findExpansionInTurns,
  flattenMarkdown,
  isSameRange,
  validateExpansionTarget
} from '@delta/core/rich-text'
import { isTermSelection } from '@delta/core/prompts'
import { useUiHost } from '../host'
import { isEditableTarget } from '../lib/editable'
import { anchoredRange, isAnchoredRange } from '../lib/markdown'
import type { ContextMenuItem, ContextMenuState } from './ContextMenu'
import type { ExpandPromptState } from './ExpandPrompt'
import type { ExpandSelectionBarState } from './ExpandSelectionBar'
import type { FramePopupAt } from './ExpansionFrame'
import type { ExpandOutcome } from './expand-outcome'

export type { ExpansionTarget }

export type ExpandRequest = (
  turnId: number,
  target: ExpansionTarget,
  prompt?: string,
  attachments?: ImageAttachment[]
) => ExpandOutcome

interface SourceAnchor {
  offset: number
  frameId: number | null
}

interface SourceSelection {
  start: number
  end: number
  frameId: number | null
}

interface PendingSelection {
  turnId: number
  /** Cloned at menu-open so submit can re-resolve if the DOM is still alive. */
  range: Range | null
  selection: string
  /** Fallback computed at menu-open (used when the Range was detached). */
  target: ExpansionTarget | null
}

interface UseExpansionContextMenuOptions {
  turns: Turn[]
  onExpand: ExpandRequest
  onUnfold: (id: number) => void
  onRetryExpansion?: (id: number) => void
  onEditExpansion?: (id: number, prompt: string) => void
  onDismissExpansion?: (id: number) => void
  /** The prompt can attach images: only where the composer can. */
  allowImages?: boolean
  /** Which turns hold expandable text; answers by default, and a canvas adds its pages. */
  canExpandTurn?: (turn: Turn) => boolean
}

const isAnswer = (turn: Turn): boolean => turn.role === 'assistant'

/** A selection in an answer, with what it would expand if the user asks. */
interface LiveSelection {
  turnId: number
  range: Range
  text: string
  resolved: TargetResult
}

const FRAME_SELECTOR = '[data-expansion-id]'
const ATOM_SELECTOR = '[data-atom-start]'
const PILL_SELECTOR = '.queried[data-expansion-id]'
const OVERLAY_SELECTOR = '.expand-selection-bar, #expandPrompt, #ctxMenu'
const NOTICE_TIMEOUT_MS = 4000
const ANSWER_PREVIEW_LENGTH = 70

function frameIdOf(element: Element | null): number | null {
  const frame = element?.closest(FRAME_SELECTOR) as HTMLElement | null
  if (!frame) return null
  const id = Number(frame.dataset.expansionId)
  return Number.isFinite(id) ? id : null
}

/**
 * Maps a DOM text point to an absolute offset in its enclosing markdown source.
 * Every rendered markdown text node is a leaf `[data-src]` element, so the
 * mapping is exact arithmetic — no string search.
 */
function anchorOfText(text: Text, offset: number, prefer: 'start' | 'end'): SourceAnchor | null {
  const host = text.parentElement
  if (!host) return null
  if (!host.hasAttribute('data-src')) {
    // Code blocks and formulas have no per-character mapping: they count as a whole.
    const atom = host.closest(ATOM_SELECTOR)
    if (!atom) return null
    const edge = Number(atom.getAttribute(prefer === 'start' ? 'data-atom-start' : 'data-atom-end'))
    return Number.isFinite(edge) ? { offset: edge, frameId: frameIdOf(atom) } : null
  }
  const base = Number(host.getAttribute('data-src'))
  if (!Number.isFinite(base)) return null
  return { offset: base + offset, frameId: frameIdOf(host) }
}

function firstTextInside(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text
  return document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode() as Text | null
}

function lastTextInside(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  let current = walker.nextNode()
  while (current) {
    last = current as Text
    current = walker.nextNode()
  }
  return last
}

function resolveAnchor(node: Node, offset: number, prefer: 'start' | 'end'): SourceAnchor | null {
  if (node.nodeType === Node.TEXT_NODE) return anchorOfText(node as Text, offset, prefer)

  const children = Array.from((node as Element).childNodes)
  if (prefer === 'start') {
    for (const child of children.slice(offset)) {
      const text = firstTextInside(child)
      const anchor = text ? anchorOfText(text, 0, prefer) : null
      if (anchor) return anchor
    }
    return null
  }
  for (const child of children.slice(0, offset).reverse()) {
    const text = lastTextInside(child)
    const anchor = text ? anchorOfText(text, text.length, prefer) : null
    if (anchor) return anchor
  }
  return null
}

function anchorsFromRange(range: Range): SourceSelection | null {
  const start = resolveAnchor(range.startContainer, range.startOffset, 'start')
  const end = resolveAnchor(range.endContainer, range.endOffset, 'end')
  if (!start || !end) return null
  if (start.frameId !== end.frameId) return null
  if (end.offset <= start.offset) return null
  return { start: start.offset, end: end.offset, frameId: start.frameId }
}

function sourceFor(
  turn: Turn,
  frameId: number | null
): { source: string; siblings: Turn['expansions']; parentExpansionId?: number } | null {
  if (frameId === null) return { source: turn.content, siblings: turn.expansions }
  const parent = findExpansionInNodes(turn.expansions, frameId)
  if (!parent) return null
  return {
    source: parent.node.answer,
    siblings: parent.node.children,
    parentExpansionId: parent.node.id
  }
}

type TargetResult = { ok: true; target: ExpansionTarget } | { ok: false; reason: string }

/**
 * Resolves a DOM selection against the *current* turn state and validates it
 * with the same rules `expand()` enforces, so the menu and the commit cannot
 * disagree. Edges inside an element that cannot be split widen to cover it.
 */
function resolveTarget(turn: Turn, selection: SourceSelection, selectedText: string): TargetResult {
  const scope = sourceFor(turn, selection.frameId)
  if (!scope) return { ok: false, reason: 'parent-not-found' }

  const range: ExpansionRange = { start: selection.start, end: selection.end }
  const anchored = anchoredRange(scope.source, range)
  if (!anchored) return { ok: false, reason: 'not-anchored' }

  // Rendered text equals the source only inside one text node. Anywhere else the
  // target was widened or holds markers, so it is checked against its own slice.
  const comparesRendered = anchored.kind === 'text' && isSameRange(anchored, range)
  const target: ExpansionTarget = {
    start: anchored.start,
    end: anchored.end,
    selection: comparesRendered ? selectedText : scope.source.slice(anchored.start, anchored.end),
    ...(anchored.kind === 'atom' ? { atomic: true } : {}),
    ...(scope.parentExpansionId !== undefined ? { parentExpansionId: scope.parentExpansionId } : {})
  }

  const refusal = validateExpansionTarget(scope.source, scope.siblings, target)
  if (refusal !== null) return { ok: false, reason: refusal }
  return { ok: true, target }
}

function refusalMessage(reason: string): string {
  switch (reason) {
    case 'selection-mismatch':
      return 'The text changed while the menu was open. Select it again.'
    case 'overlaps-expansion':
    case 'inside-expansion':
      return 'That range overlaps an existing expansion.'
    case 'cross-block':
      return 'Select text inside one paragraph, list item or heading.'
    case 'blank-selection':
    case 'empty-range':
      return 'Select some text to expand.'
    case 'out-of-bounds':
      return 'The selection is no longer available.'
    case 'parent-not-found':
    case 'turn-not-found':
      return 'That message is no longer on screen.'
    case 'not-anchored':
      return 'Select text inside one paragraph, list item or heading.'
    default:
      return 'The selection cannot be expanded.'
  }
}

async function copyText(text: string): Promise<void> {
  if (text === '') return
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    /* fall through to the selection-based fallback */
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  document.body.removeChild(area)
}

function selectAllInTurn(turnEl: HTMLElement): void {
  const content = turnEl.querySelector('.message-content')
  if (!content) return
  const range = document.createRange()
  range.selectNodeContents(content)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function selectionBarPosition(range: Range): { x: number; y: number; bottom: number } | null {
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { x: rect.left + rect.width / 2, y: rect.top, bottom: rect.bottom }
}

function readLiveSelection(
  turns: Turn[],
  canExpandTurn: (turn: Turn) => boolean
): LiveSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = selection.toString()
  if (text.trim() === '') return null

  const range = selection.getRangeAt(0)
  const container = range.commonAncestorContainer
  const element =
    container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement
  const turnEl = element?.closest('[data-turn-id]') as HTMLElement | null
  if (!turnEl) return null
  const turnId = Number(turnEl.dataset.turnId)
  const turn = turns.find((item) => item.id === turnId)
  if (!turn || !canExpandTurn(turn)) return null

  const anchors = anchorsFromRange(range)
  const resolved: TargetResult = anchors
    ? resolveTarget(turn, anchors, text)
    : { ok: false, reason: 'not-anchored' }
  return { turnId, range, text, resolved }
}

/** Addresses the range of an existing expansion, to ask about it again. */
function targetOfExpansion(turns: Turn[], id: number): PendingSelection | null {
  const location = findExpansionInTurns(turns, id)
  if (!location) return null
  const { node, parent, turn } = location
  const source = parent ? parent.answer : turn.content
  const anchored = anchoredRange(source, node)
  return {
    turnId: turn.id,
    range: null,
    selection: node.originalText,
    target: {
      start: node.start,
      end: node.end,
      selection: node.originalText,
      ...(anchored?.kind === 'atom' ? { atomic: true } : {}),
      ...(parent ? { parentExpansionId: parent.id } : {})
    }
  }
}

function answerLabel(node: Turn['expansions'][number]): string {
  const question = node.prompt?.trim()
  if (question) return question
  return isTermSelection(node.originalText) ? 'Definition' : 'Explanation'
}

function answerDetail(node: Turn['expansions'][number]): string {
  if (node.status === 'error') return node.error ?? 'Failed'
  if (node.answer === '') return 'Thinking…'
  return flattenMarkdown(node.answer).replace(/\s+/g, ' ').trim().slice(0, ANSWER_PREVIEW_LENGTH)
}

const WORD_CHAR = /[\p{L}\p{N}_'’-]/u

/** Where a point lands in the text: `caretRangeFromPoint` (Chromium, newer Firefox) or the standard API. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(x, y)
    return range ? { node: range.startContainer, offset: range.startOffset } : null
  }
  const position = document.caretPositionFromPoint?.(x, y)
  return position ? { node: position.offsetNode, offset: position.offset } : null
}

/**
 * The word under a point. Chromium widens a caret with `Range.expand('word')`; where that is
 * missing (Firefox), the word is read from the caret's text node.
 */
function wordRangeAt(x: number, y: number): Range | null {
  const caret = caretAt(x, y)
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null
  const range = document.createRange()
  range.setStart(caret.node, caret.offset)
  // Range.expand() is Chromium-only and absent from lib.dom.d.ts.
  const expandable = range as unknown as { expand?: (unit: string) => void }
  if (typeof expandable.expand === 'function') {
    try {
      expandable.expand('word')
    } catch {
      /* expand('word') can throw on an empty text node */
    }
    return range
  }
  const text = (caret.node as Text).data
  let start = caret.offset
  let end = caret.offset
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1
  while (end < text.length && WORD_CHAR.test(text[end])) end += 1
  if (start === end) return null
  range.setStart(caret.node, start)
  range.setEnd(caret.node, end)
  return range
}

export function useExpansionContextMenu(options: UseExpansionContextMenuOptions): {
  ctxMenu: ContextMenuState | null
  expandPrompt: ExpandPromptState | null
  selectionBar: ExpandSelectionBarState | null
  notice: string | null
  handleContextMenu: (e: React.MouseEvent) => void
  regenerateExpansion: (id: number) => void
  editExpansion: (id: number, at: FramePopupAt) => void
  removeExpansion: (id: number) => void
  askAnotherExpansion: (id: number, at: FramePopupAt) => void
  pickExpansionAnswer: (id: number, at: FramePopupAt) => void
  closeContextMenu: () => void
  closeExpandPrompt: () => void
  dismissNotice: () => void
} {
  const host = useUiHost()
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [expandPrompt, setExpandPrompt] = useState<ExpandPromptState | null>(null)
  const [selectionBar, setSelectionBar] = useState<ExpandSelectionBarState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { turns, onExpand, onUnfold, onRetryExpansion, onEditExpansion, onDismissExpansion } =
    options
  const { allowImages = false, canExpandTurn = isAnswer } = options

  // Submits happen after the menu opened; read the newest turns, not the
  // closure captured when the menu rendered.
  const turnsRef = useRef(turns)
  const canExpandTurnRef = useRef(canExpandTurn)
  useEffect(() => {
    turnsRef.current = turns
    canExpandTurnRef.current = canExpandTurn
  }, [turns, canExpandTurn])

  const pendingRef = useRef<PendingSelection | null>(null)
  const barRangeRef = useRef<Range | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS)
  }, [])

  const dismissNotice = useCallback(() => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    setNotice(null)
  }, [])

  const submit = useCallback(
    (prompt?: string, attachments?: ImageAttachment[]) => {
      const pending = pendingRef.current
      if (!pending) return

      const turn = turnsRef.current.find((item) => item.id === pending.turnId)
      if (!turn) {
        showNotice(refusalMessage('turn-not-found'))
        return
      }

      let target: ExpansionTarget | null = null
      const range = pending.range
      if (range && range.startContainer.isConnected) {
        const anchors = anchorsFromRange(range)
        // Re-validate against the live source; a detached Range falls back to
        // the snapshot, which is re-validated below.
        if (anchors) {
          const resolved = resolveTarget(turn, anchors, pending.selection)
          if (!resolved.ok) {
            showNotice(refusalMessage(resolved.reason))
            return
          }
          target = resolved.target
        }
      }

      if (!target) target = pending.target
      if (!target) {
        showNotice(refusalMessage('selection-mismatch'))
        return
      }

      const scope = sourceFor(turn, target.parentExpansionId ?? null)
      if (!scope || !isAnchoredRange(scope.source, target)) {
        showNotice(refusalMessage('not-anchored'))
        return
      }
      const refusal = validateExpansionTarget(scope.source, scope.siblings, target)
      if (refusal !== null) {
        showNotice(refusalMessage(refusal))
        return
      }

      const outcome = onExpand(pending.turnId, target, prompt, attachments)
      if (!outcome.ok) showNotice(refusalMessage(outcome.reason))
    },
    [onExpand, showNotice]
  )

  const openPrompt = useCallback(
    (pending: PendingSelection, at: FramePopupAt) => {
      pendingRef.current = pending
      setSelectionBar(null)
      setExpandPrompt({
        x: at.x,
        y: at.y,
        allowImages,
        onSubmit: (prompt, attachments) => submit(prompt, attachments)
      })
    },
    [allowImages, submit]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isEditableTarget(e.target)) return
      e.preventDefault()
      setSelectionBar(null)

      const turnEl = e.currentTarget as HTMLElement
      const turnId = Number(turnEl.dataset.turnId)
      const turn = Number.isFinite(turnId) ? turns.find((item) => item.id === turnId) : undefined
      if (!turn) return

      const at = { x: e.clientX, y: e.clientY }
      const openExpandMenu = (
        pending: PendingSelection,
        target: ExpansionTarget | null,
        hint: string | undefined,
        copied: string
      ): void => {
        pendingRef.current = pending
        setCtxMenu({
          ...at,
          canExpand: target !== null,
          hint,
          onExpand: () => submit(),
          onExpandPrompted: () => {
            if (target) openPrompt(pending, at)
          },
          onCopy: () => void copyText(copied),
          onSelectAll: () => selectAllInTurn(turnEl)
        })
      }

      const selection = window.getSelection()
      let selectedText = selection?.toString() ?? ''

      if (selectedText.trim() !== '' && selection && selection.rangeCount > 0) {
        // Drop a stale selection left over from a previous interaction.
        if (!selection.getRangeAt(0).intersectsNode(e.target as Node)) {
          selection.removeAllRanges()
          selectedText = ''
        }
      }

      // Questions get Copy / Select All only: they are not text to explore.
      if (!canExpandTurn(turn)) {
        pendingRef.current = null
        setCtxMenu({
          ...at,
          canExpand: false,
          onExpand: () => {},
          onExpandPrompted: () => {},
          onCopy: () => void copyText(selectedText),
          onSelectAll: () => selectAllInTurn(turnEl)
        })
        return
      }

      // A folded pill holds no anchored text; it stands for its expansion's range,
      // so the menu asks about that range again.
      const pill = (e.target as Element).closest?.(PILL_SELECTOR) as HTMLElement | null
      const pillId = pill ? Number(pill.dataset.expansionId) : NaN
      const pillPending = Number.isFinite(pillId) ? targetOfExpansion(turns, pillId) : null
      if (pillPending) {
        openExpandMenu(
          pillPending,
          pillPending.target,
          undefined,
          flattenMarkdown(pillPending.selection)
        )
        return
      }

      if (selectedText.trim() !== '' && selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        const anchors = anchorsFromRange(range)
        const resolved = anchors ? resolveTarget(turn, anchors, selectedText) : null
        const target = resolved?.ok ? resolved.target : null
        const hint = target
          ? undefined
          : refusalMessage(resolved && !resolved.ok ? resolved.reason : 'not-anchored')
        openExpandMenu(
          { turnId, range: range.cloneRange(), selection: selectedText, target },
          target,
          hint,
          selectedText
        )
        return
      }

      // Single-word right-click: the word under the pointer, as if it were selected.
      const wordRange = wordRangeAt(e.clientX, e.clientY)
      if (wordRange && turnEl.contains(wordRange.startContainer)) {
        const wordText = wordRange.toString()
        if (wordText.trim() !== '') {
          const anchors = anchorsFromRange(wordRange)
          const resolved = anchors ? resolveTarget(turn, anchors, wordText) : null
          const target = resolved?.ok ? resolved.target : null
          const hint = target
            ? undefined
            : refusalMessage(resolved && !resolved.ok ? resolved.reason : 'not-anchored')

          // Select the word so the menu's Copy/Expand act on what was clicked.
          selection?.removeAllRanges()
          selection?.addRange(wordRange.cloneRange())

          openExpandMenu(
            { turnId, range: wordRange.cloneRange(), selection: wordText, target },
            target,
            hint,
            wordText
          )
          return
        }
      }

      // A formula's glyphs yield no word under the caret, but the formula is a target.
      const atom = (e.target as Element).closest?.(ATOM_SELECTOR)
      if (atom) {
        const atomRange = document.createRange()
        atomRange.selectNodeContents(atom)
        const anchors = anchorsFromRange(atomRange)
        const resolved = anchors ? resolveTarget(turn, anchors, '') : null
        if (resolved?.ok) {
          openExpandMenu(
            {
              turnId,
              range: atomRange,
              selection: resolved.target.selection ?? '',
              target: resolved.target
            },
            resolved.target,
            undefined,
            resolved.target.selection ?? ''
          )
          return
        }
      }

      // Nothing targeted, but Copy / Select All must still be reachable.
      pendingRef.current = null
      setCtxMenu({
        ...at,
        canExpand: false,
        onExpand: () => {},
        onExpandPrompted: () => {},
        onCopy: () => void copyText(selectedText),
        onSelectAll: () => selectAllInTurn(turnEl)
      })
    },
    [canExpandTurn, turns, submit, openPrompt]
  )

  /* ---- Selection bar and shortcuts ---- */

  const pendingFromLive = useCallback((live: LiveSelection): PendingSelection => {
    return {
      turnId: live.turnId,
      range: live.range.cloneRange(),
      selection: live.text,
      target: live.resolved.ok ? live.resolved.target : null
    }
  }, [])

  const submitLive = useCallback(
    (pending: PendingSelection, prompt?: string) => {
      pendingRef.current = pending
      submit(prompt)
      window.getSelection()?.removeAllRanges()
      setSelectionBar(null)
    },
    [submit]
  )

  const refreshSelectionBar = useCallback(() => {
    const live = readLiveSelection(turnsRef.current, canExpandTurnRef.current)
    const position = live?.resolved.ok ? selectionBarPosition(live.range) : null
    if (!live || !position) {
      barRangeRef.current = null
      setSelectionBar(null)
      return
    }
    const pending = pendingFromLive(live)
    barRangeRef.current = live.range
    setSelectionBar({
      ...position,
      onExpand: (prompt) => submitLive(pending, prompt),
      onAsk: () => openPrompt(pending, { x: position.x, y: position.bottom + 6 })
    })
  }, [pendingFromLive, submitLive, openPrompt])

  useEffect(() => {
    const isOverlay = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest(OVERLAY_SELECTOR) !== null

    const handleMouseUp = (e: MouseEvent): void => {
      if (e.button !== 0 || isOverlay(e.target)) return
      // The selection settles only after this event finishes.
      window.setTimeout(refreshSelectionBar, 0)
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Shift' || e.shiftKey) refreshSelectionBar()
    }

    const handleSelectionChange = (): void => {
      if (window.getSelection()?.isCollapsed ?? true) setSelectionBar(null)
    }

    const handleScroll = (): void => {
      const range = barRangeRef.current
      const position = range ? selectionBarPosition(range) : null
      setSelectionBar((prev) => (prev && position ? { ...prev, ...position } : null))
    }

    /** Ctrl/Cmd+E expands the selection; with Shift it asks first. Returns whether it acted. */
    const runShortcut = (prompted: boolean): boolean => {
      const live = readLiveSelection(turnsRef.current, canExpandTurnRef.current)
      if (!live) return false
      if (!live.resolved.ok) {
        showNotice(refusalMessage(live.resolved.reason))
        return true
      }
      const pending = pendingFromLive(live)
      if (prompted) {
        const position = selectionBarPosition(live.range)
        openPrompt(pending, { x: position?.x ?? 8, y: (position?.bottom ?? 8) + 6 })
      } else {
        submitLive(pending)
      }
      return true
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'e') return
      if (runShortcut(e.shiftKey)) e.preventDefault()
    }

    // Where the app takes the key itself (the extension's commands), it reports it instead.
    const stopShortcuts = host.onExpandShortcut?.((prompted) => void runShortcut(prompted))

    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('keyup', handleKeyUp)
    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('scroll', handleScroll, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('keyup', handleKeyUp)
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('keydown', handleKeyDown)
      stopShortcuts?.()
    }
  }, [host, refreshSelectionBar, pendingFromLive, submitLive, openPrompt, showNotice])

  /* ---- Frame actions ---- */

  const confirmDroppingNested = useCallback((id: number, action: string): boolean => {
    const nested = findExpansionInTurns(turnsRef.current, id)?.node.children.length ?? 0
    if (nested === 0) return true
    return window.confirm(`${action}? The expansions inside this answer will be removed.`)
  }, [])

  const regenerateExpansion = useCallback(
    (id: number) => {
      if (confirmDroppingNested(id, 'Regenerate this answer')) onRetryExpansion?.(id)
    },
    [confirmDroppingNested, onRetryExpansion]
  )

  const editExpansion = useCallback(
    (id: number, at: FramePopupAt) => {
      const node = findExpansionInTurns(turnsRef.current, id)?.node
      if (!node) return
      setSelectionBar(null)
      setExpandPrompt({
        x: at.x,
        y: at.y,
        initialPrompt: node.prompt ?? '',
        onSubmit: (prompt) => {
          if (confirmDroppingNested(id, 'Replace this answer')) onEditExpansion?.(id, prompt)
        }
      })
    },
    [confirmDroppingNested, onEditExpansion]
  )

  const removeExpansion = useCallback(
    (id: number) => {
      if (confirmDroppingNested(id, 'Remove this answer')) onDismissExpansion?.(id)
    },
    [confirmDroppingNested, onDismissExpansion]
  )

  const askAnotherExpansion = useCallback(
    (id: number, at: FramePopupAt) => {
      const pending = targetOfExpansion(turnsRef.current, id)
      if (pending) openPrompt(pending, at)
    },
    [openPrompt]
  )

  const pickExpansionAnswer = useCallback(
    (id: number, at: FramePopupAt) => {
      const location = findExpansionInTurns(turnsRef.current, id)
      if (!location) return
      const items: ContextMenuItem[] = location.siblings
        .filter((node) => isSameRange(node, location.node))
        .map((node) => ({
          label: answerLabel(node),
          detail: answerDetail(node),
          onSelect: () => onUnfold(node.id)
        }))
      items.push({ label: 'Ask another…', onSelect: () => askAnotherExpansion(id, at) })
      setCtxMenu({ ...at, items })
    },
    [askAnotherExpansion, onUnfold]
  )

  const closeContextMenu = useCallback(() => {
    setCtxMenu(null)
  }, [])

  const closeExpandPrompt = useCallback(() => {
    setExpandPrompt(null)
  }, [])

  return {
    ctxMenu,
    expandPrompt,
    selectionBar,
    notice,
    handleContextMenu,
    regenerateExpansion,
    editExpansion,
    removeExpansion,
    askAnotherExpansion,
    pickExpansionAnswer,
    closeContextMenu,
    closeExpandPrompt,
    dismissNotice
  }
}
