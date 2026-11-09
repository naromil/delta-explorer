/* Canvas view: an infinite plane of answer rectangles (src/ui/canvas/board.js).
 * Routes: #canvas (the newest canvas), #canvas/new, #canvas/<id>. */

import { CanvasBoard } from '../../src/ui/canvas/board.js';
import { CanvasStore } from '../../src/ui/canvas/store.js';
import { onBroadcast, rpc } from '../../src/ui/api.js';
import { toast } from '../../src/ui/dom.js';

export function createCanvasView(host, app) {
  host.classList.add('view--canvas');
  const store = new CanvasStore();
  store.onSaveError = (err) => toast(`This canvas could not be saved: ${err.message || err}`);
  const board = new CanvasBoard({
    host,
    store,
    onOpenSearch: () => app.search(),
    onOpenConversation: (meta) => app.openConversation(meta)
  });

  let shownId = null;
  // Keep the URL on the open canvas, once it is saved, without reloading it.
  store.subscribe((change) => {
    if (host.hidden || !(change.meta || change.replaced || change.content)) return;
    const id = store.meta.persisted || store.cards.length > 0 ? store.canvasId : null;
    if (id === shownId) return;
    shownId = id;
    history.replaceState(null, '', id ? `#canvas/${id}` : '#canvas');
  });

  async function open(arg) {
    if (arg === 'new') {
      if (store.cards.length > 0 || store.frames.length > 0 || !store.loaded) store.newCanvas();
      history.replaceState(null, '', '#canvas');
      return;
    }
    if (arg) {
      if (arg === store.canvasId && store.loaded) return;
      if (!(await store.openCanvas(arg))) {
        toast('That canvas no longer exists.');
        if (!store.loaded) store.newCanvas();
      } else {
        board.fitAll();
      }
      return;
    }
    if (store.loaded) return;
    const list = await rpc('listConversations').catch(() => []);
    const newest = list.find((item) => item.source === 'canvas');
    if (!newest || !(await store.openCanvas(newest.id))) store.newCanvas();
  }

  // Another tab deleted the canvas open here.
  onBroadcast('conversationsChanged', (msg) => {
    if (msg.deleted && msg.deleted === store.canvasId && store.meta.persisted) store.newCanvas();
  });

  window.addEventListener('pagehide', () => store.flushSave());

  return {
    show(arg) {
      board.setActive(true);
      open(arg);
    },
    hide() {
      board.setActive(false);
      store.flushSave();
    },
    currentId: () => (store.meta.persisted ? store.canvasId : null),
    handleExpandShortcut: (prompted) => board.handleExpandShortcut(prompted)
  };
}
