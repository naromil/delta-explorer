import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { ConversationState, Turn } from '@delta/core/conversation'
import type { ExpansionNode } from '@delta/core/rich-text'
import { NO_ACTIVITY_LABELS } from '@delta/ui/conversation'
import type { ActivityLabels } from '@delta/ui/conversation'
import {
  clearRequests,
  createRequests,
  registerExpand,
  registerSend
} from '../../src/renderer/src/hooks/chat/requests'
import type { RequestBookkeeping } from '../../src/renderer/src/hooks/chat/requests'
import { subscribeChatTransport } from '../../src/renderer/src/hooks/chat/transport'
import type { ChatTransportHandlers } from '../../src/renderer/src/hooks/chat/transport'

/* ---- A fake preload bridge that lets a test fire each channel ---- */

type Listener = (data: never) => void

const listeners = new Map<string, Listener>()
const unsubscribed: string[] = []

function channel(name: string): (cb: Listener) => () => void {
  return (cb: Listener): (() => void) => {
    listeners.set(name, cb)
    return () => {
      listeners.delete(name)
      unsubscribed.push(name)
    }
  }
}

function emit(name: string, data: unknown): void {
  const listener = listeners.get(name)
  if (!listener) throw new Error(`nothing listens on ${name}`)
  listener(data as never)
}

/* ---- A hook stand-in: state the transport writes through its setters ---- */

function resolve<T>(action: SetStateAction<T>, prev: T): T {
  return typeof action === 'function' ? (action as (p: T) => T)(prev) : action
}

function turn(
  id: number,
  role: Turn['role'],
  content: string,
  expansions: ExpansionNode[] = []
): Turn {
  return { id, role, content, expansions }
}

function expansion(id: number, overrides: Partial<ExpansionNode> = {}): ExpansionNode {
  return {
    id,
    start: 0,
    end: 5,
    originalText: 'Hello',
    answer: '',
    status: 'loading',
    folded: false,
    children: [],
    ...overrides
  }
}

interface Harness {
  state: ConversationState
  book: RequestBookkeeping
  labels: ActivityLabels
  loading: boolean
  saves: boolean[]
  handlers: ChatTransportHandlers
}

function harness(state: ConversationState, book: RequestBookkeeping): Harness {
  const h = {
    state,
    book,
    labels: NO_ACTIVITY_LABELS,
    loading: true,
    saves: [] as boolean[]
  } as Harness
  h.handlers = {
    role: 'chat',
    getRequests: () => h.book,
    setRequests: (next) => {
      h.book = next
    },
    setState: (action) => {
      h.state = resolve(action, h.state)
    },
    setActivityLabels: (action) => {
      h.labels = resolve(action, h.labels)
    },
    setLoading: (loading) => {
      h.loading = loading
    },
    setContextReady: () => {},
    requestSave: (touchContent) => {
      h.saves.push(touchContent)
    }
  }
  return h
}

let unsubscribe: () => void = () => {}

beforeEach(() => {
  listeners.clear()
  unsubscribed.length = 0
  vi.stubGlobal('window', {
    api: {
      chatOnActivity: channel('activity'),
      chatOnChunk: channel('chunk'),
      chatOnResponse: channel('response'),
      chatOnError: channel('error'),
      chatOnExpandChunk: channel('expand-chunk'),
      chatOnReplaceConversation: channel('replace'),
      lookupOnContext: (cb: Listener) => listeners.set('lookup-context', cb),
      lookupOnGrow: (cb: Listener) => listeners.set('lookup-grow', cb)
    }
  })
})

afterEach(() => {
  unsubscribe()
  unsubscribe = () => {}
  vi.unstubAllGlobals()
})

function chatWithAnswer(answer = ''): ConversationState {
  return { context: '', turns: [turn(1, 'user', 'Hi'), turn(2, 'assistant', answer)] }
}

describe('subscribeChatTransport sends', () => {
  it('appends chunks to the pending turn and settles it with the final text', () => {
    const h = harness(chatWithAnswer(), registerSend(createRequests(), 'send-1', 2))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('chunk', { requestId: 'send-1', delta: 'Hel' })
    emit('chunk', { requestId: 'send-1', delta: 'lo' })
    expect(h.state.turns[1].content).toBe('Hello')

    emit('response', { requestId: 'send-1', text: 'Hello there' })
    expect(h.state.turns[1].content).toBe('Hello there')
    expect(h.book.pending.size).toBe(0)
    expect(h.book.activeSendId).toBeNull()
    expect(h.loading).toBe(false)
    expect(h.saves).toEqual([true])
  })

  it('drops chunks, responses and errors for an id the book no longer holds', () => {
    const book = registerSend(createRequests(), 'send-1', 2)
    const h = harness(chatWithAnswer('Partial'), clearRequests(book).book)
    unsubscribe = subscribeChatTransport(h.handlers)
    const before = h.state

    emit('chunk', { requestId: 'send-1', delta: ' late' })
    emit('response', { requestId: 'send-1', text: 'Late final' })
    emit('error', { requestId: 'send-1', error: 'Late failure' })

    expect(h.state).toBe(before)
    expect(h.loading).toBe(true)
    expect(h.saves).toEqual([])
  })

  it('ignores a stale id while a newer send streams into its own turn', () => {
    const state: ConversationState = {
      context: '',
      turns: [turn(1, 'user', 'Hi'), turn(4, 'user', 'Again'), turn(5, 'assistant', '')]
    }
    const h = harness(state, registerSend(createRequests(), 'send-2', 5))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('chunk', { requestId: 'send-1', delta: 'old' })
    emit('chunk', { requestId: 'send-2', delta: 'new' })

    expect(h.state.turns.map((t) => t.content)).toEqual(['Hi', 'Again', 'new'])
    expect(h.book.activeSendId).toBe('send-2')
  })

  it('leaves the state alone when the pending turn was already removed', () => {
    const h = harness(
      { context: '', turns: [turn(1, 'user', 'Hi')] },
      registerSend(createRequests(), 'send-1', 2)
    )
    unsubscribe = subscribeChatTransport(h.handlers)
    const before = h.state

    emit('chunk', { requestId: 'send-1', delta: 'Hello' })

    expect(h.state).toBe(before)
  })

  it('removes the placeholder turn when a stop arrives before the first token', () => {
    const h = harness(chatWithAnswer(), registerSend(createRequests(), 'send-1', 2))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('response', { requestId: 'send-1', text: '  ', cancelled: true })

    expect(h.state.turns.map((t) => t.id)).toEqual([1])
    expect(h.saves).toEqual([true])
  })

  it('keeps the partial text of a stopped answer', () => {
    const h = harness(chatWithAnswer('Half'), registerSend(createRequests(), 'send-1', 2))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('response', { requestId: 'send-1', text: 'Half an answer', cancelled: true })

    expect(h.state.turns[1].content).toBe('Half an answer')
  })

  it('marks a failed answer as an error turn and saves it for Retry', () => {
    const h = harness(chatWithAnswer('Par'), registerSend(createRequests(), 'send-1', 2))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('error', { requestId: 'send-1', error: 'Rate limited' })

    expect(h.state.turns[1]).toMatchObject({ content: 'Rate limited', error: true })
    expect(h.book.pending.size).toBe(0)
    expect(h.loading).toBe(false)
    expect(h.saves).toEqual([true])
  })

  it('does not settle a send on an expand chunk with the same id', () => {
    const h = harness(chatWithAnswer(), registerSend(createRequests(), 'send-1', 2))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('expand-chunk', { requestId: 'send-1', done: true, text: 'x' })

    expect(h.book.activeSendId).toBe('send-1')
    expect(h.saves).toEqual([])
  })
})

describe('subscribeChatTransport expansions', () => {
  function chatWithExpansion(node: ExpansionNode = expansion(7)): ConversationState {
    return {
      context: '',
      turns: [turn(1, 'user', 'Hi'), turn(2, 'assistant', 'Hello world', [node])]
    }
  }

  it('streams into the expansion and settles it when done', () => {
    const h = harness(chatWithExpansion(), registerExpand(createRequests(), 'exp-1', 2, 7))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('expand-chunk', { requestId: 'exp-1', delta: 'A greeting' })
    expect(h.state.turns[1].expansions[0]).toMatchObject({
      answer: 'A greeting',
      status: 'loading'
    })
    expect(h.saves).toEqual([])

    emit('expand-chunk', { requestId: 'exp-1', text: 'A greeting.', done: true })
    expect(h.state.turns[1].expansions[0]).toMatchObject({ answer: 'A greeting.', status: 'done' })
    expect(h.book.pending.size).toBe(0)
    expect(h.saves).toEqual([true])
  })

  it('records an expand error and settles the request', () => {
    const h = harness(chatWithExpansion(), registerExpand(createRequests(), 'exp-1', 2, 7))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('expand-chunk', { requestId: 'exp-1', error: 'Timed out' })

    expect(h.state.turns[1].expansions[0]).toMatchObject({ status: 'error', error: 'Timed out' })
    expect(h.book.pending.size).toBe(0)
    expect(h.saves).toEqual([true])
  })

  it('drops chunks for a discarded expand, so a regenerated frame keeps its new answer', () => {
    const node = expansion(7, { answer: 'Fresh', status: 'loading' })
    const h = harness(chatWithExpansion(node), registerExpand(createRequests(), 'exp-2', 2, 7))
    unsubscribe = subscribeChatTransport(h.handlers)
    const before = h.state

    emit('expand-chunk', { requestId: 'exp-1', delta: ' stale' })
    emit('expand-chunk', { requestId: 'exp-1', text: 'Stale', done: true })

    expect(h.state).toBe(before)
    expect(h.book.pending.has('exp-2')).toBe(true)
    expect(h.saves).toEqual([])
  })

  it('does not treat a send response as the end of an expand', () => {
    const h = harness(chatWithExpansion(), registerExpand(createRequests(), 'exp-1', 2, 7))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('response', { requestId: 'exp-1', text: 'Wrong channel' })

    expect(h.book.pending.has('exp-1')).toBe(true)
    expect(h.state.turns[1].content).toBe('Hello world')
  })
})

describe('subscribeChatTransport activity', () => {
  it('shows a tool label on the pending turn until text arrives', () => {
    const h = harness(chatWithAnswer(), registerSend(createRequests(), 'send-1', 2))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('activity', { requestId: 'send-1', label: 'Reading your notes' })
    expect(h.labels.get('send-1')).toEqual({
      label: 'Reading your notes',
      target: { turnId: 2 }
    })

    emit('chunk', { requestId: 'send-1', delta: 'Hi' })
    expect(h.labels.has('send-1')).toBe(false)
  })

  it('points an expand label at its expansion', () => {
    const h = harness(chatWithAnswer(), registerExpand(createRequests(), 'exp-1', 2, 7))
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('activity', { requestId: 'exp-1', label: 'Searching' })

    expect(h.labels.get('exp-1')?.target).toEqual({ expansionId: 7 })
  })

  it('ignores activity for a dropped request', () => {
    const h = harness(chatWithAnswer(), createRequests())
    unsubscribe = subscribeChatTransport(h.handlers)

    emit('activity', { requestId: 'send-1', label: 'Reading your notes' })

    expect(h.labels).toBe(NO_ACTIVITY_LABELS)
  })
})

describe('subscribeChatTransport wiring', () => {
  it('hands a transferred conversation to the hook', () => {
    const h = harness(chatWithAnswer(), createRequests())
    const onReplaceConversation = vi.fn()
    unsubscribe = subscribeChatTransport({ ...h.handlers, onReplaceConversation })
    const payload = {
      state: chatWithAnswer('Moved'),
      conversationId: 'conv-1',
      conversationTitle: 'Moved',
      conversationCreatedAt: '2026-01-01T00:00:00.000Z'
    }

    emit('replace', payload)

    expect(onReplaceConversation).toHaveBeenCalledWith(payload)
  })

  it('listens for the popup channels only in the look-up window', () => {
    const chat = harness(chatWithAnswer(), createRequests())
    unsubscribe = subscribeChatTransport(chat.handlers)
    expect(listeners.has('lookup-context')).toBe(false)
    unsubscribe()

    const setContextReady = vi.fn()
    const onGrown = vi.fn()
    const lookup = harness(chatWithAnswer(), createRequests())
    unsubscribe = subscribeChatTransport({
      ...lookup.handlers,
      role: 'lookup',
      setContextReady,
      onGrown
    })

    emit('lookup-context', { status: 'ready', text: '', hint: '' })
    emit('lookup-context', { status: 'loading', text: '', hint: '' })
    emit('lookup-grow', 840)
    expect(setContextReady.mock.calls).toEqual([[true], [false]])
    expect(onGrown).toHaveBeenCalledOnce()
  })

  it('unsubscribes every chat channel', () => {
    const h = harness(chatWithAnswer(), createRequests())
    subscribeChatTransport(h.handlers)()

    expect(unsubscribed.sort()).toEqual(
      ['activity', 'chunk', 'error', 'expand-chunk', 'replace', 'response'].sort()
    )
    expect(listeners.has('chunk')).toBe(false)
  })
})
