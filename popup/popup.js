/* The toolbar look-up: ask about the page you are on. The browser-side
 * counterpart of Delta Explorer's hotkey popup; page text replaces screen OCR. */

import { onBroadcast, rpc } from '../src/ui/api.js';
import { ConversationView } from '../src/ui/conversation-view.js';
import { applyTheme, h, icon } from '../src/ui/dom.js';

const LAST_LOOKUP_KEY = 'deltaLastLookup';
const RESUME_WINDOW_MS = 10 * 60_000;

const actions = document.getElementById('header-actions');
const setup = document.getElementById('lookup-setup');
const title = document.getElementById('lookup-title');

let pageInfo = null;

const openInChat = h('button.btn.btn--sm', { type: 'button', hidden: true, title: 'Continue this look-up in Chat', on: { click: transferToChat } }, icon('external', 14), 'Open in Chat');
const resumeBtn = h('button.icon-btn', { type: 'button', hidden: true, title: 'Resume your last look-up', 'aria-label': 'Resume your last look-up' }, icon('history', 16));
const newBtn = h('button.icon-btn', { type: 'button', hidden: true, title: 'New look-up', 'aria-label': 'New look-up', on: { click: () => startFresh() } }, icon('plus', 16));
const dashboardBtn = h('button.icon-btn', { type: 'button', title: 'Open the dashboard', 'aria-label': 'Open the dashboard', on: { click: () => openDashboard('home') } }, icon('home', 16));
actions.append(openInChat, resumeBtn, newBtn, dashboardBtn);

const view = new ConversationView({
  host: document.getElementById('lookup-conversation'),
  role: 'lookup',
  allowImages: false,
  compact: true,
  placeholder: 'Ask about this page…',
  emptyState: () => h('div.lookup-empty',
    h('p', { text: view.context
      ? 'Ask about the text above, or press Enter to summarize it.'
      : 'Ask anything. Select text on the page first to ask about it.' })),
  onClearContext: () => view.renderEmpty(),
  onMetaChange: (meta) => {
    if (!meta) return;
    openInChat.hidden = false;
    newBtn.hidden = false;
    title.textContent = meta.title;
    browser.storage.local.set({ [LAST_LOOKUP_KEY]: { id: meta.id, at: Date.now() } }).catch(() => {});
  }
});

async function openDashboard(hash) {
  await rpc('openDashboard', { hash });
  window.close();
}

async function transferToChat() {
  if (!view.conversationId) return;
  view.flushSave();
  // Let the save land before the dashboard loads the record.
  await new Promise((resolve) => setTimeout(resolve, 150));
  openDashboard(`chat/${view.conversationId}`);
}

async function readPageContext(mode) {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { context: '', page: null };
    pageInfo = { title: tab.title || '', url: tab.url || '' };
    if (mode === 'none') return { context: '', page: pageInfo };
    const result = await browser.tabs.sendMessage(tab.id, { type: 'getPageContext' }, { frameId: 0 });
    if (!result) return { context: '', page: pageInfo };
    pageInfo = { title: result.title || pageInfo.title, url: result.url || pageInfo.url };
    const context = result.selection || (mode === 'page' ? result.text : '');
    return { context, page: pageInfo };
  } catch {
    // Restricted pages (about:, the add-ons store) have no content script.
    return { context: '', page: pageInfo };
  }
}

let settings = null;

async function startFresh() {
  const { context, page } = await readPageContext(settings?.pageContext || 'selection');
  title.textContent = 'Look-up';
  openInChat.hidden = true;
  newBtn.hidden = true;
  view.load(null, { context, page });
  view.focusComposer();
}

async function offerResume() {
  try {
    const obj = await browser.storage.local.get(LAST_LOOKUP_KEY);
    const last = obj[LAST_LOOKUP_KEY];
    if (!last || Date.now() - last.at > RESUME_WINDOW_MS) return;
    resumeBtn.hidden = false;
    resumeBtn.onclick = async () => {
      const record = await rpc('loadConversation', { id: last.id }).catch(() => null);
      if (!record) { resumeBtn.hidden = true; return; }
      view.load(record);
      title.textContent = record.title;
      openInChat.hidden = false;
      newBtn.hidden = false;
      resumeBtn.hidden = true;
      view.focusComposer();
    };
  } catch { /* ignore */ }
}

async function checkSetup() {
  const config = await rpc('getModelConfig');
  const role = config.roles.lookup;
  const ready = role.connectionId && role.model && config.connections[role.connectionId];
  setup.hidden = !!ready;
  if (!ready) {
    setup.replaceChildren(
      h('p', { text: 'Assign a model to the Look-up role to start. Delta Explorer works with your own API key or a local Ollama model.' }),
      h('button.btn.btn--primary.btn--sm', { type: 'button', text: 'Open model settings', on: { click: () => openDashboard('settings/models') } }));
  }
}

onBroadcast('expandShortcut', (msg) => {
  if (document.hasFocus()) view.handleExpandShortcut(!!msg.prompted);
});

(async () => {
  try {
    settings = await rpc('getSettings');
    applyTheme(settings.theme);
  } catch { /* defaults */ }
  checkSetup().catch(() => {});
  offerResume();
  await startFresh();
})();
