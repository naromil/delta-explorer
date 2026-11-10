/* The shared UI's host in the extension (`UiHost` in packages/ui/src/host.ts): conversations
 * through background requests, streams through `delta-stream` Ports.
 *
 * The UI keys every stream by a `requestId` and expects the desktop's event shapes, so each
 * Port's callbacks are turned into those events here. A stopped stream reports what it had
 * written, as the desktop's main process does. Requests are built with the shared system
 * prompt; the extension's own wording replaces it before anything is sent. */

import { onBroadcast, openStream, rpc } from './api.js';
import { downloadText, toast } from './dom.js';
import { exportFileName, renderConversationMarkdown } from '../shared/conversation.js';
import { getSystemPrompt } from '../shared/prompts.js';

/** Swaps the shared system prompt for the extension's (the assistant lives in a browser). */
function withExtensionSystemPrompt(messages, role) {
  return messages.map((message, index) =>
    index === 0 && message.role === 'system' ? { ...message, content: getSystemPrompt(role) } : message
  );
}

/**
 * options: {
 *   openConversation(target),   // a chat, look-up or canvas chosen from a history list
 * }
 */
export function createExtensionHost(options) {
  const listeners = new Set();
  const streams = new Map();
  const emit = (event, data) => {
    for (const listener of listeners) listener[event](data);
  };

  function start(kind, { requestId, messages, role }) {
    let written = '';
    const finish = () => streams.delete(requestId);
    const handlers = kind === 'send'
      ? {
        onDelta: (delta) => {
          written += delta;
          emit('chunk', { requestId, delta });
        },
        onDone: (text) => {
          finish();
          emit('response', { requestId, text });
        },
        onError: (error, partial, cancelled) => {
          finish();
          if (cancelled) emit('response', { requestId, text: partial || written, cancelled: true });
          else emit('error', { requestId, error });
        }
      }
      : {
        onDelta: (delta) => {
          written += delta;
          emit('expandChunk', { requestId, delta });
        },
        onDone: (text) => {
          finish();
          emit('expandChunk', { requestId, text, done: true });
        },
        onError: (error, partial, cancelled) => {
          finish();
          emit('expandChunk', cancelled
            ? { requestId, text: partial || written, done: true, cancelled: true }
            : { requestId, error, text: partial || written });
        }
      };
    const stream = openStream(
      { kind: 'chat', role, messages: withExtensionSystemPrompt(messages, role) },
      handlers
    );
    streams.set(requestId, stream);
  }

  return {
    listConversations: () => rpc('listConversations'),
    loadConversation: (id) => rpc('loadConversation', { id }),
    async saveConversation(record) {
      try {
        await rpc('saveConversation', { record });
      } catch (err) {
        toast(`This canvas could not be saved: ${err?.message || err}`);
        throw err;
      }
    },
    deleteConversation: async (id) => {
      await rpc('deleteConversation', { id });
    },
    async exportConversation(id) {
      const record = await rpc('loadConversation', { id }).catch(() => null);
      if (!record) return { ok: false, error: 'Nothing to export yet.' };
      const name = exportFileName(record);
      downloadText(name, renderConversationMarkdown(record));
      return { ok: true, path: name };
    },
    openConversation: (target) => options.openConversation(target),
    imageSupport: (role) => rpc('imageSupport', { role }).catch(() => 'unknown'),
    send: (request) => start('send', request),
    expand: (request) => start('expand', request),
    cancel: (requestId) => streams.get(requestId)?.stop(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Ctrl+E is an extension command, so the browser takes the key before the page sees it.
    onExpandShortcut(listener) {
      return onBroadcast('expandShortcut', (msg) => {
        if (document.hasFocus()) listener(!!msg.prompted);
      });
    }
  };
}
