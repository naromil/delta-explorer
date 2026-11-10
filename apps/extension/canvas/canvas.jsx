/* The canvas page: the shared canvas (@delta/ui) in one of three places.
 *
 *   Over a web page   `?overlay=1&seed=<token>` in the iframe the content script adds. The seed
 *                     (the page's title, address and text, stashed under a single-use token bound
 *                     to its tab) reopens the newest canvas made on that page, or starts one with
 *                     the page as its first card. Esc closes it by posting `delta-canvas-close`.
 *   In the dashboard  `?embed=dashboard`, the Canvas route's iframe. The dashboard routes with
 *                     `delta-canvas-open`; the frame asks it for search, chats and the address.
 *   In a tab          `?id=<id>` shows one canvas, no parameter the newest.
 *
 * The dashboard holds it in a frame because its chat still styles the same class names its own way. */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasView, useCanvas } from '@delta/ui/canvas';
import { UiHostProvider } from '@delta/ui/host';
import { onBroadcast, rpc } from '../src/ui/api.js';
import { applyTheme } from '../src/ui/dom.js';
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

function CanvasApp({ seed }) {
  const canvas = useCanvas();
  const [ready, setReady] = useState(false);
  const { openCanvas, newCanvas, startFromPage, canvasId, cards, streamingTurnIds } = canvas;

  // Decided before the view mounts, or the view would open the newest canvas over it.
  useEffect(() => {
    let live = true;
    (async () => {
      if (seed) {
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
      historyExtras={seed ? [{
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
  root.render(
    <UiHostProvider host={host}>
      <CanvasApp seed={seed} />
    </UiHostProvider>
  );
}

start();
