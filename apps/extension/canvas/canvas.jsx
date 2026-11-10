/* The canvas page: the shared canvas (@delta/ui) in one of three places.
 *
 *   Over a web page   `?overlay=1&seed=<token>` in the iframe the content script adds. The seed
 *                     (the page's title, address and text, stashed under a single-use token bound
 *                     to its tab) reopens the newest canvas made on that page, or starts one with
 *                     the page as its first card. Esc closes it by posting `delta-canvas-close`.
 *                     On a web chat (ChatGPT, Claude, Gemini) the seed is the chat's exchanges
 *                     instead: the canvas mirrors the chat as a line of cards and asks that chat,
 *                     through the tab, whatever is asked on it (src/ui/canvas/web-chat.js).
 *   In the dashboard  `?embed=dashboard`, the Canvas route's iframe. The dashboard routes with
 *                     `delta-canvas-open`; the frame asks it for search, chats and the address.
 *   In a tab          `?id=<id>` shows one canvas, no parameter the newest.
 *
 * The dashboard holds it in a frame because its chat still styles the same class names its own way. */

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasView, useCanvas } from '@delta/ui/canvas';
import { UiHostProvider } from '@delta/ui/host';
import { onBroadcast, rpc } from '../src/ui/api.js';
import { applyTheme } from '../src/ui/dom.js';
import { createWebChatAsker, createWebChatTransport, syncWebChat, webChatElsewhereNotice } from '../src/ui/canvas/web-chat.js';
import { createExtensionHost } from '../src/ui/ui-host.js';

const params = new URLSearchParams(location.search);
const framed = window.top !== window;
const mode = framed && params.get('overlay') === '1'
  ? 'overlay'
  : framed && params.get('embed') === 'dashboard'
    ? 'dashboard'
    : framed
      ? 'refused'
      : 'tab';

function toParent(message) {
  window.parent.postMessage(message, mode === 'dashboard' ? location.origin : '*');
}

function openInDashboard(hash) {
  return rpc('openDashboard', { hash }).catch(() => {});
}

const host = createExtensionHost({
  openConversation(target) {
    const hash = `${target.source === 'canvas' ? 'canvas' : 'chat'}/${target.id}`;
    if (mode === 'dashboard') toParent({ type: 'delta-open-conversation', target });
    else openInDashboard(hash);
  }
});

/** The newest canvas made on this page, if any. */
async function canvasForPage(url) {
  if (!url) return null;
  const list = await rpc('listConversations').catch(() => []);
  return list.find((meta) => meta.source === 'canvas' && meta.pageUrl === url) || null;
}

function Message({ title, text }) {
  return (
    <div className="canvas-app-message">
      <h1>{title}</h1>
      <p>{text}</p>
    </div>
  );
}

function CanvasApp({ seed, transport }) {
  // The asker needs the canvas's setter, and the canvas needs the asker.
  const setWebChatRef = useRef(null);
  const [asker] = useState(() => (transport
    ? createWebChatAsker(transport, (change) => setWebChatRef.current?.(change))
    : null));
  const canvas = useCanvas(asker);
  useEffect(() => {
    setWebChatRef.current = canvas.setWebChat;
  }, [canvas.setWebChat]);
  const [ready, setReady] = useState(false);
  const { openCanvas, newCanvas, startFromPage, beginAt, canvasId, cards, streamingTurnIds, webChat } = canvas;

  /** Opens this chat's canvas, or starts one, and brings it up to date with the chat. */
  async function startFromWebChat(chat) {
    // A chat with nothing in it yet has no address of its own, so it shares no canvas.
    const previous = chat.exchanges.length > 0 ? await canvasForPage(chat.url) : null;
    if (previous && (await openCanvas(previous.id))) {
      const { added, tailId } = syncWebChat(canvas, chat);
      const notice = added === -1
        ? `${transport.siteName} has fewer messages than this canvas remembers, so new ones are matched from where it stands now.`
        : added > 0
          ? `Your canvas for this chat, with ${added} new message${added === 1 ? '' : 's'} from ${transport.siteName}.`
          : 'Your canvas for this chat. The history menu starts a new one.';
      beginAt({ fit: true, notice, continueId: tailId });
    } else {
      newCanvas();
      beginAt({ fit: true, continueId: syncWebChat(canvas, chat).tailId });
    }
  }

  /** A fresh canvas holding the chat as it stands now. */
  async function restartFromWebChat() {
    const chat = (await transport.read()) || seed.webChat;
    transport.url = chat.url;
    newCanvas();
    beginAt({ fit: true, continueId: syncWebChat(canvas, chat).tailId });
  }

  // Decided before the view mounts, or the view would open the newest canvas over it.
  useEffect(() => {
    let live = true;
    (async () => {
      if (seed?.webChat) {
        await startFromWebChat(seed.webChat);
      } else if (seed) {
        const previous = await canvasForPage(seed.url);
        if (!(previous && (await openCanvas(previous.id)))) startFromPage(seed);
      } else if (params.get('id')) {
        if (!(await openCanvas(params.get('id')))) newCanvas();
      }
      if (live) setReady(true);
    })();
    return () => {
      live = false;
    };
    // Once, on load: not StrictMode, which would run this twice and start two canvases.
  }, []);

  // A canvas mirroring a web chat, open where that chat cannot be asked, says who answers here.
  const mirrorsElsewhere = webChat !== undefined && !(asker && asker.handles({ webChat }));
  useEffect(() => {
    if (ready && mirrorsElsewhere) beginAt({ notice: webChatElsewhereNotice(webChat.site) });
    // Once per canvas opened.
  }, [ready, canvasId, mirrorsElsewhere]);

  // The dashboard routes here: `arg` is '', 'new' or a canvas id.
  useEffect(() => {
    if (mode !== 'dashboard') return undefined;
    const handle = async (e) => {
      if (e.source !== window.parent || e.origin !== location.origin) return;
      if (e.data?.type !== 'delta-canvas-open') return;
      const arg = e.data.arg || '';
      if (arg === 'new') newCanvas();
      else if (arg && arg !== canvasId && !(await openCanvas(arg))) {
        toParent({ type: 'delta-canvas-missing' });
      }
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [canvasId, newCanvas, openCanvas]);

  // The dashboard's address follows the open canvas once it holds something.
  const shownId = cards.length > 0 ? canvasId : null;
  useEffect(() => {
    if (mode === 'dashboard') toParent({ type: 'delta-canvas-shown', id: shownId });
  }, [shownId]);

  // Another tab deleted the canvas open here.
  useEffect(
    () => onBroadcast('conversationsChanged', (msg) => {
      if (msg.deleted && msg.deleted === canvasId) newCanvas();
    }),
    [canvasId, newCanvas]
  );

  const close = () => {
    if (streamingTurnIds.size > 0 && !window.confirm('An answer is still being written. Close the canvas and stop it?')) return;
    toParent({ type: 'delta-canvas-close' });
  };

  // The page around the overlay was clicked.
  useEffect(() => {
    if (mode !== 'overlay') return undefined;
    const handle = (e) => {
      if (e.source === window.parent && e.data?.type === 'delta-canvas-request-close') close();
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  });

  const openInTab = async () => {
    await canvas.flushSave();
    await openInDashboard(cards.length > 0 ? `canvas/${canvasId}` : 'canvas');
  };

  if (!ready) return null;
  return (
    <CanvasView
      canvas={canvas}
      onOpenSearch={mode === 'dashboard' ? () => toParent({ type: 'delta-open-search' }) : undefined}
      historyExtras={seed ? [seed.webChat ? {
        label: 'New canvas from this chat',
        detail: seed.title || seed.url,
        onSelect: () => void restartFromWebChat()
      } : {
        label: 'New canvas from this page',
        detail: seed.title || seed.url,
        onSelect: () => startFromPage(seed)
      }] : undefined}
      onEscapeIdle={mode === 'overlay' ? close : undefined}
      toolbarExtras={mode === 'overlay' ? (
        <>
          <button type="button" className="canvas-tool" title="Continue this canvas in the dashboard" onClick={() => void openInTab()}>
            Open in tab
          </button>
          <button type="button" className="canvas-tool canvas-tool--close" title="Close the canvas (Esc)" aria-label="Close the canvas" onClick={close}>
            ×
          </button>
        </>
      ) : undefined}
    />
  );
}

/** In the dashboard, its own shortcuts still work while the canvas has focus. */
function forwardDashboardKeys() {
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if ((key === 'k' && !e.shiftKey) || (key === 'o' && e.shiftKey) || key === ',') {
      e.preventDefault();
      toParent({ type: 'delta-dashboard-key', key, shift: e.shiftKey });
    }
  });
}

async function start() {
  document.documentElement.classList.toggle('is-overlay', mode === 'overlay');
  try {
    applyTheme((await rpc('getSettings')).theme);
  } catch { /* system theme */ }
  onBroadcast('settingsChanged', (msg) => applyTheme(msg.settings?.theme));

  const root = createRoot(document.getElementById('canvas-app'));
  if (mode === 'refused') {
    root.render(<Message title="Canvas unavailable" text="Open the canvas from the Delta Explorer menu." />);
    return;
  }
  let seed = null;
  if (mode === 'overlay') {
    const token = params.get('seed');
    seed = token ? await rpc('takeCanvasSeed', { token }).catch(() => null) : null;
    if (!seed) {
      // Embedded without a seed from this tab: show nothing of the user's canvases.
      root.render(<Message title="Canvas unavailable" text="Open the canvas again from the page’s right-click menu or the toolbar look-up." />);
      return;
    }
  }
  if (mode === 'dashboard') forwardDashboardKeys();
  const transport = seed?.webChat ? createWebChatTransport(seed.webChat) : null;
  root.render(
    <UiHostProvider host={host}>
      <CanvasApp seed={seed} transport={transport} />
    </UiHostProvider>
  );
}

start();
