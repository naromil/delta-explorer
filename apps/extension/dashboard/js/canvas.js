/* Canvas view: the canvas page (canvas/canvas.html, the shared React canvas) in a frame.
 * Routes: #canvas (the newest canvas), #canvas/new, #canvas/<id>.
 *
 * A frame, because the shared canvas styles the same class names (`.frame`, `.md-*`, menus)
 * as this page's chat, in its own way. The two talk by `postMessage` on this extension's origin:
 * the dashboard sends `delta-canvas-open`; the frame asks for search, a conversation or a
 * dashboard shortcut, and says which canvas it shows. */

import { h, toast } from '../../src/ui/dom.js';

export function createCanvasView(host, app) {
  host.classList.add('view--canvas');
  let shownId = null;
  let loaded = false;
  let pendingArg = null;

  const frame = h('iframe.canvas-frame', { title: 'Canvas', src: '../canvas/canvas.html?embed=dashboard' });
  host.appendChild(frame);

  function post(message) {
    frame.contentWindow?.postMessage(message, location.origin);
  }

  function open(arg) {
    // The frame opens the newest canvas itself on its first load.
    if (!loaded) {
      pendingArg = arg;
      return;
    }
    if (arg === 'new') history.replaceState(null, '', '#canvas');
    if (arg) post({ type: 'delta-canvas-open', arg });
  }

  frame.addEventListener('load', () => {
    loaded = true;
    if (pendingArg) open(pendingArg);
    pendingArg = null;
  });

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const msg = e.data || {};
    if (msg.type === 'delta-canvas-shown') {
      shownId = msg.id || null;
      if (!host.hidden) history.replaceState(null, '', shownId ? `#canvas/${shownId}` : '#canvas');
    } else if (msg.type === 'delta-canvas-missing') {
      toast('That canvas no longer exists.');
    } else if (msg.type === 'delta-open-search') {
      app.search();
    } else if (msg.type === 'delta-open-conversation') {
      app.openConversation(msg.target);
    } else if (msg.type === 'delta-dashboard-key') {
      if (msg.key === 'k') app.search();
      else if (msg.key === 'o') app.newChat();
      else if (msg.key === ',') app.navigate('settings');
    }
  });

  return {
    show(arg) {
      open(arg);
      frame.focus();
    },
    hide() {},
    currentId: () => shownId,
    // The frame hears the shortcut itself (src/ui/ui-host.js).
    handleExpandShortcut() {}
  };
}
