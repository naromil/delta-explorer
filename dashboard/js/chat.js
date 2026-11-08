/* Chat view: toolbar (new, search, export, delete, rename) over a ConversationView. */

import { onBroadcast, rpc } from '../../src/ui/api.js';
import { ConversationView } from '../../src/ui/conversation-view.js';
import { downloadText, h, icon, keyLabel, toast } from '../../src/ui/dom.js';
import { exportFileName, renderConversationMarkdown, CONVERSATION_TITLE_MAX_LENGTH } from '../../src/shared/conversation.js';

const SUGGESTIONS = [
  'What have I been learning recently?',
  'Quiz me on something from my history',
  'Explain a concept step by step'
];

export function createChatView(host, app) {
  const titleSlot = h('div.chat-title-slot');
  const exportBtn = h('button.btn.btn--ghost.btn--sm', { type: 'button', title: 'Export as markdown', hidden: true, on: { click: exportConversation } }, icon('download', 15), 'Export');
  const deleteBtn = h('button.btn.btn--ghost.btn--sm', { type: 'button', title: 'Delete conversation', hidden: true, on: { click: deleteConversation } }, icon('trash', 15), 'Delete');
  const toolbar = h('div.chat-toolbar',
    h('button.btn.btn--ghost.btn--sm', { type: 'button', title: `New chat (${keyLabel('Ctrl+Shift+O')})`, on: { click: () => app.newChat() } }, icon('plus', 15), 'New chat'),
    h('button.btn.btn--ghost.btn--sm', { type: 'button', title: `Search (${keyLabel('Ctrl+K')})`, on: { click: () => app.search() } }, icon('search', 15), 'Search'),
    exportBtn,
    deleteBtn,
    titleSlot);
  const convHost = h('div.chat-conversation');
  host.append(toolbar, convHost);

  let loadedId = null;

  const view = new ConversationView({
    host: convHost,
    role: 'chat',
    allowImages: true,
    placeholder: 'Message Delta Explorer…',
    emptyState: (fill) => h('div.empty-state',
      h('h1.empty-title', { text: 'Grow with me' }),
      h('p.empty-subtitle', { text: 'Ask anything, or start from one of these. Delta Explorer remembers what matters from every conversation.' }),
      h('div.empty-suggestions', SUGGESTIONS.map((s) => h('button.empty-suggestion', { type: 'button', text: s, on: { click: () => fill(s) } })))),
    onMetaChange: (meta) => {
      if (meta && loadedId !== meta.id) {
        loadedId = meta.id;
        // Keep the URL on the open conversation without reloading it.
        history.replaceState(null, '', `#chat/${meta.id}`);
      }
      renderToolbar();
    }
  });

  function renderToolbar() {
    const meta = view.meta;
    exportBtn.hidden = !meta;
    deleteBtn.hidden = !meta;
    titleSlot.replaceChildren();
    if (!meta) return;
    const titleBtn = h('button.chat-title', { type: 'button', title: `${meta.title}\nClick to rename`, text: meta.title, on: { click: beginRename } });
    titleSlot.appendChild(titleBtn);
  }

  function beginRename() {
    const meta = view.meta;
    if (!meta) return;
    const input = h('input.chat-title-input.input', { value: meta.title, maxLength: CONVERSATION_TITLE_MAX_LENGTH, 'aria-label': 'Conversation title' });
    let settled = false;
    const commit = async () => {
      if (settled) return;
      settled = true;
      await view.rename(input.value);
      renderToolbar();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); settled = true; renderToolbar(); }
    });
    input.addEventListener('blur', commit);
    titleSlot.replaceChildren(input);
    input.focus();
    input.select();
  }

  function exportConversation() {
    const record = view.snapshot();
    if (!record) return;
    downloadText(exportFileName(record), renderConversationMarkdown(record));
  }

  async function deleteConversation() {
    const meta = view.meta;
    if (!meta) return;
    if (!window.confirm(`Delete “${meta.title}”? This cannot be undone.`)) return;
    view.stopAll();
    try {
      await rpc('deleteConversation', { id: meta.id });
      loadedId = null;
      app.newChat();
    } catch (err) {
      toast(`Failed to delete: ${err.message || err}`);
    }
  }

  async function open(id) {
    if (id === 'new' || !id) {
      if (view.meta || view.turns.length) view.load(null);
      loadedId = null;
      history.replaceState(null, '', '#chat');
      renderToolbar();
      view.focusComposer();
      return;
    }
    if (id === loadedId && view.meta) return;
    try {
      const record = await rpc('loadConversation', { id });
      if (!record) {
        toast('That conversation no longer exists.');
        app.newChat();
        return;
      }
      loadedId = id;
      view.load(record);
      renderToolbar();
      view.focusComposer();
    } catch (err) {
      toast(`Could not open the conversation: ${err.message || err}`);
    }
  }

  // Another tab deleted the conversation open here.
  onBroadcast('conversationsChanged', (msg) => {
    if (msg.deleted && msg.deleted === loadedId && !host.hidden) {
      loadedId = null;
      view.load(null);
      renderToolbar();
    }
  });

  view.load(null);
  renderToolbar();

  return {
    show(arg) { open(arg); },
    hide() { view.closeSelectionBar(); view.closeOverlay(); },
    currentId: () => (view.meta ? view.meta.id : null),
    handleExpandShortcut: (prompted) => view.handleExpandShortcut(prompted)
  };
}
