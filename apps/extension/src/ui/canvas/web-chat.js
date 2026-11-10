/* The canvas's line to a web chat (ChatGPT and the like) in the tab it is open over. The chat
 * answers one question at a time, so questions wait in a queue; each is built only when its
 * turn comes, so it can tell what the chat's latest reply is by then.
 *
 * Each question is one Port, relayed by the background to the content script of this tab's top
 * frame (src/background/web-chat-relay.js, src/content/web-chat.js); disconnecting stops the
 * reply there. */

const PORT_NAME = 'delta-web-chat';
const SITE_NAMES = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };

/** What a canvas over a web chat says where that chat cannot be asked (a tab, the dashboard). */
export function webChatElsewhereNotice(site) {
  const name = SITE_NAMES[site] || 'web';
  return `This canvas mirrors a ${name} chat. Here your own model answers; open the canvas over that chat to ask it there.`;
}

/**
 * `ask(build, handlers)` queues a question. `build()` returns the prompt, or null when there is
 * nothing to ask any more. handlers: `{ onAccepted(), onText(full), onDone(text, { url }),
 * onError(message, partial, cancelled) }`. Returns `{ stop() }`, like `openStream`.
 */
export function createWebChatTransport(chat) {
  const siteName = chat.name || SITE_NAMES[chat.site] || 'The chat';
  let chain = Promise.resolve();

  function connect() {
    return browser.runtime.connect({ name: PORT_NAME });
  }

  function run(build, handlers, job) {
    return new Promise((resolve) => {
      if (job.settled) return resolve();
      const prompt = build();
      if (!prompt) {
        job.settle();
        handlers.onError?.('Nothing to ask any more.', '', true);
        return resolve();
      }
      let port;
      try {
        port = connect();
      } catch (err) {
        job.settle();
        handlers.onError?.(`Could not reach ${siteName}: ${err?.message || err}`, '', false);
        return resolve();
      }
      let text = '';
      job.port = port;
      job.finish = resolve;
      port.onMessage.addListener((msg) => {
        if (job.settled) return;
        if (msg.accepted) {
          handlers.onAccepted?.();
        } else if (typeof msg.text === 'string' && !msg.done && !msg.error) {
          text = msg.text;
          handlers.onText?.(text);
        } else if (msg.done) {
          job.settle();
          handlers.onDone?.(msg.text || text, { url: msg.url });
        } else if (msg.error) {
          job.settle();
          handlers.onError?.(msg.error, msg.text || text, false);
        }
      });
      port.onDisconnect.addListener(() => {
        if (job.settled) return;
        job.settle();
        handlers.onError?.(`${siteName} stopped answering. Reload the chat page and open the canvas again.`, text, false);
      });
      port.postMessage({ type: 'ask', prompt });
    });
  }

  return {
    site: chat.site,
    /** The chat's address; a new chat gets one once it is first asked. */
    url: chat.url,
    siteName,
    /** The chat as it stands now: `{ site, name, url, exchanges }`, or null. */
    read() {
      return new Promise((resolve) => {
        let port;
        try {
          port = connect();
        } catch {
          return resolve(null);
        }
        port.onMessage.addListener((msg) => {
          resolve(msg.chat || null);
          try { port.disconnect(); } catch { /* gone */ }
        });
        port.onDisconnect.addListener(() => resolve(null));
        port.postMessage({ type: 'read' });
      });
    },
    ask(build, handlers) {
      const job = {
        settled: false,
        port: null,
        finish: null,
        settle() {
          if (job.settled) return;
          job.settled = true;
          try { job.port?.disconnect(); } catch { /* gone */ }
          job.finish?.();
        }
      };
      chain = chain.then(() => run(build, handlers, job));
      return {
        stop() {
          if (job.settled) return;
          job.settle();
          handlers.onError?.('Generation stopped.', '', true);
        }
      };
    }
  };
}
