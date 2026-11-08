/* The dashboard and popup's bridge to the background: request/response
 * messages, streaming ports, and broadcasts. */

export async function rpc(type, payload = {}) {
  return browser.runtime.sendMessage({ type, ...payload });
}

/**
 * Opens a stream. handlers: { onDelta(text), onDone(text), onError(message, partialText, cancelled) }.
 * Returns `{ stop() }`; stopping disconnects, which aborts generation.
 */
export function openStream(request, handlers) {
  const port = browser.runtime.connect({ name: 'delta-stream' });
  let settled = false;
  const settle = () => { settled = true; };
  port.onMessage.addListener((msg) => {
    if (settled) return;
    if (typeof msg.delta === 'string') {
      handlers.onDelta?.(msg.delta);
    } else if (msg.done) {
      settle();
      handlers.onDone?.(msg.text || '');
    } else if (msg.error) {
      settle();
      handlers.onError?.(msg.error, msg.text || '', !!msg.cancelled);
    }
  });
  port.onDisconnect.addListener(() => {
    if (settled) return;
    settle();
    handlers.onError?.('Response interrupted.', '', false);
  });
  port.postMessage({ type: 'start', ...request });
  return {
    stop() {
      if (settled) return;
      settle();
      try { port.disconnect(); } catch { /* gone */ }
      handlers.onError?.('Generation stopped.', '', true);
    }
  };
}

/** Listens for background broadcasts of one type; returns an unsubscribe function. */
export function onBroadcast(type, listener) {
  const handler = (msg) => {
    if (msg && msg.type === type) listener(msg);
  };
  browser.runtime.onMessage.addListener(handler);
  return () => browser.runtime.onMessage.removeListener(handler);
}
