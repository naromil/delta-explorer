/* Relays a web chat canvas to the chat it is open over. The canvas frame is an extension page
 * inside the chat's tab and cannot reach that tab's content script by itself, so it connects
 * a `delta-web-chat` Port here and this pipes it to the tab's top frame
 * (src/content/web-chat.js), both ways. Only the canvas page may connect, and only to the tab
 * it is in. A reply can take minutes, so the relay keeps the background awake meanwhile. */

import { keepAlive } from './keep-alive.js';

export const WEB_CHAT_PORT = 'delta-web-chat';

function isCanvasPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(browser.runtime.getURL('canvas/canvas.html'));
}

export function handleWebChatPort(port) {
  const sender = port.sender || {};
  const tabId = sender.tab?.id;
  if (!isCanvasPage(sender) || typeof tabId !== 'number') {
    port.disconnect();
    return;
  }
  let chat;
  try {
    chat = browser.tabs.connect(tabId, { frameId: 0, name: WEB_CHAT_PORT });
  } catch (err) {
    port.postMessage({ error: `Could not reach the chat in this tab: ${err?.message || err}` });
    port.disconnect();
    return;
  }
  const release = keepAlive();
  let closed = false;
  const close = (other, error) => {
    if (closed) return;
    closed = true;
    release();
    if (error && other === port) {
      try { port.postMessage({ error }); } catch { /* gone */ }
    }
    try { other.disconnect(); } catch { /* gone */ }
  };
  chat.onMessage.addListener((msg) => {
    try { port.postMessage(msg); } catch { close(chat); }
  });
  port.onMessage.addListener((msg) => {
    try { chat.postMessage(msg); } catch { close(port, 'The chat page stopped listening. Reload it and open the canvas again.'); }
  });
  chat.onDisconnect.addListener(() => {
    // No content script answered: the page was loaded before the extension, or is no chat.
    const reason = chat.error?.message;
    close(port, reason ? `The chat page did not answer (${reason}). Reload it and open the canvas again.` : null);
  });
  port.onDisconnect.addListener(() => close(chat));
}
