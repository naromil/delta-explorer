/**
 * What the shared UI needs from the app it runs in.
 *
 * The desktop answers over IPC, the extension over runtime messages and Ports. Streams
 * are keyed by a `requestId` the UI chooses: the host reports every event with it, and
 * the UI drops events for an id it no longer holds, so a late chunk cannot land on a
 * card that is gone.
 */
import { createContext, createElement, useContext } from 'react'
import type { ReactNode } from 'react'
import type {
  ConversationMeta,
  ConversationRecord,
  ConversationTarget,
  ProviderMessage
} from '@delta/core/conversation'

export type ImageSupport = 'yes' | 'no' | 'unknown'

export interface StreamRequest {
  requestId: string
  messages: ProviderMessage[]
  role: 'chat' | 'lookup'
}

export interface ExpandChunkEvent {
  requestId: string
  delta?: string
  text?: string
  error?: string
  done?: boolean
  cancelled?: boolean
}

/** Every stream event; a send ends with `response` or `error`, an expand with `done` or `error`. */
export interface StreamListener {
  chunk: (data: { requestId: string; delta: string }) => void
  response: (data: { requestId: string; text: string; cancelled?: boolean }) => void
  error: (data: { requestId: string; error: string }) => void
  expandChunk: (data: ExpandChunkEvent) => void
}

export type ExportResult = { ok: true; path: string } | { ok: false; error: string }

export interface UiHost {
  listConversations: () => Promise<ConversationMeta[]>
  loadConversation: (id: string) => Promise<ConversationRecord | null>
  saveConversation: (record: ConversationRecord) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  /** Writes the stored record somewhere the user chooses; the newest state must be saved first. */
  exportConversation: (id: string) => Promise<ExportResult>
  /** Shows a conversation from a history list in whatever view its type opens in. */
  openConversation: (target: ConversationTarget) => void
  imageSupport: (role: 'chat' | 'lookup') => Promise<ImageSupport>
  send: (request: StreamRequest) => void
  expand: (request: StreamRequest) => void
  /** Stops a stream; it still ends with its terminal event, carrying the partial text. */
  cancel: (requestId: string) => void
  subscribe: (listener: StreamListener) => () => void
  /**
   * Reports Ctrl/Cmd+E (`prompted` with Shift) where the app takes the key before the page
   * sees it, as the extension's commands do. The desktop leaves it out: the page gets the key.
   */
  onExpandShortcut?: (listener: (prompted: boolean) => void) => () => void
}

const HostContext = createContext<UiHost | null>(null)

export function UiHostProvider({
  host,
  children
}: {
  host: UiHost
  children: ReactNode
}): React.JSX.Element {
  return createElement(HostContext.Provider, { value: host }, children)
}

export function useUiHost(): UiHost {
  const host = useContext(HostContext)
  if (!host) throw new Error('useUiHost needs a UiHostProvider above it.')
  return host
}
