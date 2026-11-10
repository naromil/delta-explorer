/* The canvas page. Opened over a web page (an iframe the content script adds, with
 * `?overlay=1&seed=<token>`), it turns that page into a canvas whose first card is the page's
 * text, or brings back the canvas made on it before. Opened in a tab, `?id=<id>` shows one
 * canvas, and no parameter shows the newest.
 *
 * The seed is the page's title, address and readable text, stashed by the content script in
 * the background under a single-use token bound to its tab. On a web chat (ChatGPT, Claude,
 * Gemini) it is the chat's exchanges instead: the canvas mirrors the chat as a line of cards and
 * asks that chat, through the tab, whatever is asked on it. */

import { CanvasBoard } from '../src/ui/canvas/board.js';
import { CanvasStore } from '../src/ui/canvas/store.js';
import { onBroadcast, rpc } from '../src/ui/api.js';
import { createWebChatTransport } from '../src/ui/canvas/web-chat.js';
import { applyTheme, h, toast } from '../src/ui/dom.js';

const params = new URLSearchParams(location.search);
const overlay = params.get('overlay') === '1' && window.top !== window;
const seedToken = params.get('seed');
const app = document.getElementById('canvas-app');
document.documentElement.classList.toggle('is-overlay', overlay);

let pageSeed = null;

function showMessage(title, text) {
  app.replaceChildren(h('div.canvas-app-message', h('h1', { text: title }), h('p', { text })));
}

const store = new CanvasStore();
store.onSaveError = (err) => toast(`This canvas could not be saved: ${err.message || err}`);

let closing = false;

function close() {
  if (closing) return;
  if (store.streamingTurnIds.size > 0 && !window.confirm('An answer is still being written. Close the canvas and stop it?')) return;
  closing = true;
  store.dispose();
  window.parent.postMessage({ type: 'delta-canvas-close' }, '*');
}

async function openInDashboard() {
  await store.flushSave();
  const hash = store.meta.persisted ? `canvas/${store.canvasId}` : 'canvas';
  await rpc('openDashboard', { hash }).catch(() => {});
}

const extras = overlay
  ? [
    h('button.canvas-tool', { type: 'button', title: 'Continue this canvas in the dashboard', text: 'Open in tab', on: { click: openInDashboard } }),
    h('button.canvas-tool.canvas-tool--close', { type: 'button', title: 'Close the canvas (Esc)', 'aria-label': 'Close the canvas', text: '×', on: { click: close } })
  ]
  : [];

let board = null;

function mountBoard() {
  board = new CanvasBoard({
    host: app,
    store,
    toolbarExtras: extras,
    historyExtras: () => {
      if (!pageSeed) return [];
      if (pageSeed.webChat) {
        return [{ label: 'New canvas from this chat', detail: pageSeed.title || pageSeed.url, onSelect: () => restartFromWebChat() }];
      }
      return [{ label: 'New canvas from this page', detail: pageSeed.title || pageSeed.url, onSelect: () => board.startFromPage(pageSeed) }];
    },
    onOpenConversation: (meta) => rpc('openDashboard', { hash: `chat/${meta.id}` }).catch(() => {}),
    onEscapeIdle: overlay ? close : undefined
  });
  board.setActive(true);
}

/** A fresh canvas holding the chat as it stands now. */
async function restartFromWebChat() {
  const chat = (await store.webChat.read()) || pageSeed.webChat;
  store.webChat.url = chat.url;
  store.newCanvas();
  store.syncWebChat(chat);
  board.fitAll();
  board.startWebChat(store.doc.layout.webChat.exchanges.at(-1));
}

/** Opens this chat's canvas, or starts one, and brings it up to date with the chat. */
async function startFromWebChat(chat) {
  // A chat with nothing in it yet has no address of its own, so it shares no canvas.
  const previous = chat.exchanges.length > 0 ? await canvasForPage(chat.url) : null;
  if (previous && (await store.openCanvas(previous.id))) {
    const added = store.syncWebChat(chat);
    board.fitAll();
    board.showNotice(added === -1
      ? `${store.webChat.siteName} has fewer messages than this canvas remembers, so new ones are matched from where it stands now.`
      : added > 0
        ? `Your canvas for this chat, with ${added} new message${added === 1 ? '' : 's'} from ${store.webChat.siteName}.`
        : 'Your canvas for this chat. The history menu (▾) starts a new one.');
  } else {
    store.newCanvas();
    store.syncWebChat(chat);
    board.fitAll();
  }
  board.startWebChat(store.doc.layout.webChat.exchanges.at(-1));
}

/** The newest canvas made on this page, if any. */
async function canvasForPage(url) {
  if (!url) return null;
  const list = await rpc('listConversations').catch(() => []);
  return list.find((meta) => meta.source === 'canvas' && meta.pageUrl === url) || null;
}

async function start() {
  try {
    applyTheme((await rpc('getSettings')).theme);
  } catch { /* system theme */ }
  onBroadcast('settingsChanged', (msg) => applyTheme(msg.settings?.theme));

  if (window.top !== window && !overlay) {
    showMessage('Canvas unavailable', 'Open the canvas from the Delta Explorer menu.');
    return;
  }
  if (overlay) {
    pageSeed = seedToken ? await rpc('takeCanvasSeed', { token: seedToken }).catch(() => null) : null;
    if (!pageSeed) {
      // Embedded without a seed from this tab: show nothing of the user's canvases.
      showMessage('Canvas unavailable', 'Open the canvas again from the page’s right-click menu or the toolbar look-up.');
      return;
    }
    if (pageSeed.webChat) store.webChat = createWebChatTransport(pageSeed.webChat);
  }

  mountBoard();
  // The surface has its size once it is laid out.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  board.measureSurface();

  if (pageSeed?.webChat) {
    await startFromWebChat(pageSeed.webChat);
    return;
  }
  if (pageSeed) {
    const previous = await canvasForPage(pageSeed.url);
    if (previous && (await store.openCanvas(previous.id))) {
      board.fitAll();
      board.showNotice('Your canvas for this page. The history menu (▾) starts a new one.');
    } else {
      board.startFromPage(pageSeed);
    }
    return;
  }
  const id = params.get('id');
  if (id && (await store.openCanvas(id))) {
    board.fitAll();
    return;
  }
  const list = await rpc('listConversations').catch(() => []);
  const newest = list.find((meta) => meta.source === 'canvas');
  if (!newest || !(await store.openCanvas(newest.id))) store.newCanvas();
}

// Ctrl+E is an extension command, so the browser takes the key before this page sees it.
onBroadcast('expandShortcut', (msg) => {
  if (board && document.hasFocus()) board.handleExpandShortcut(!!msg.prompted);
});

window.addEventListener('pagehide', () => store.dispose());

// The page around the frame was clicked.
window.addEventListener('message', (e) => {
  if (overlay && e.source === window.parent && e.data?.type === 'delta-canvas-request-close') close();
});

start();
