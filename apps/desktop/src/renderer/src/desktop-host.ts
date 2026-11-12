/**
 * The shared UI's host in the desktop app: every call goes to main over the preload
 * bridge. Stream events arrive on four IPC channels for the whole window, so a listener
 * receives every request's events and keeps only the ids it holds.
 */
import type { UiHost } from '@delta/ui/host'

export const desktopHost: UiHost = {
  listConversations: () => window.api.listConversations(),
  loadConversation: (id) => window.api.loadConversation(id),
  saveConversation: (record) => window.api.saveConversation(record),
  deleteConversation: (id) => window.api.deleteConversation(id),
  exportConversation: (id) => window.api.exportConversation(id),
  openConversation: (target) => window.api.openConversation(target),
  generateTitle: (firstMessage) => window.api.generateConversationTitle(firstMessage),
  imageSupport: (role) => window.api.chatImageSupport(role),
  send: (request) => window.api.chatSend(request),
  expand: (request) => window.api.chatExpand(request),
  cancel: (requestId) => window.api.chatCancel(requestId),
  subscribe: (listener) => {
    const unsubs = [
      window.api.chatOnChunk(listener.chunk),
      window.api.chatOnResponse(listener.response),
      window.api.chatOnError(listener.error),
      window.api.chatOnExpandChunk(listener.expandChunk)
    ]
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }
}
