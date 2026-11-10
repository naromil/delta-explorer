/* The canvas's line to a web chat (ChatGPT and the like) in the tab it is open over. The chat
 * answers one question at a time, so questions wait in a queue; each is built only when its
 * turn comes, so it can tell what the chat's latest reply is by then.
 *
 * Each question is one Port, relayed by the background to the content script of this tab's top
 * frame (src/background/web-chat-relay.js, src/content/web-chat.js); disconnecting stops the
 * reply there. */

import { allocateTurnId } from '@delta/ui/canvas';
import { bodyCharWidth } from '@delta/ui/lib/char-width';
import { importWebChatExchanges, webChatExpansionPrompt, webChatMessagePrompt } from '../../shared/web-chat-request.js';

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

/** Whether `chat` is the one this tab holds, so questions can go to it. */
function bound(transport, chat) {
  return chat !== undefined && chat.site === transport.site && chat.url === transport.url;
}

/**
 * The shared canvas's `CanvasAsker` for a web chat: while the canvas mirrors the chat in this tab,
 * its questions go there instead of the user's model. `setWebChat` is the canvas's, for the
 * exchange a question claims once the chat takes it and the address a new chat gets.
 */
export function createWebChatAsker(transport, setWebChat) {
  /** The chat took a question for `cardId` (null when its card is gone): it now holds that exchange. */
  function claim(cardId) {
    setWebChat((chat) => chat && {
      ...chat,
      exchanges: [...chat.exchanges.map((id) => (id !== null && id === cardId ? null : id)), cardId]
    });
  }

  /** A new chat gets its own address once it is first asked. */
  function noteUrl(url) {
    setWebChat((chat) => {
      if (!chat || typeof url !== 'string' || !url || url === chat.url) return chat;
      if (transport.url === chat.url) transport.url = url;
      return { ...chat, url };
    });
  }

  return {
    handles: (layout) => bound(transport, layout.webChat),
    ask(request, read, events) {
      let last = '';
      const build = () => {
        const { turns, layout } = read();
        if (!layout.webChat) return null;
        if (request.kind === 'send') {
          const card = layout.cards.find((item) => item.id === request.cardId);
          if (!card) return null;
          return webChatMessagePrompt(layout.cards, layout.links, turns, layout.webChat, card, bodyCharWidth());
        }
        const turn = turns.find((item) => item.id === request.turnId);
        if (!turn) return null;
        return webChatExpansionPrompt(
          layout.cards, layout.links, turns, layout.webChat, turn,
          request.target, request.prompt, request.rect, request.caption, bodyCharWidth()
        );
      };
      return transport.ask(build, {
        // The question is in the chat now, whatever becomes of this card.
        onAccepted: () => claim(events.live() ? request.cardId : null),
        onText: (text) => {
          last = text;
          events.text(text);
        },
        onDone: (text, info) => {
          if (events.live() && info?.url) noteUrl(info.url);
          events.done(text, false);
        },
        onError: (message, partial, cancelled) => {
          if (cancelled) events.done(partial || last, true);
          else events.error(message, partial || last);
        }
      });
    }
  };
}

/**
 * Brings the open canvas up to date with the web chat `chat` (`{ site, url, exchanges }` as the
 * content script read it): binds it, and adds what was said there since as cards. Returns how
 * many exchanges were added, or -1 when the chat has fewer than the canvas knew of (edited or
 * deleted there), in which case later ones are matched from where it stands now.
 */
export function syncWebChat(canvas, chat) {
  let shrunk = false;
  const imported = canvas.addImported(({ layout }) => {
    const known = layout.webChat;
    const binding = known && known.site === chat.site
      ? { ...known, url: chat.url }
      : { site: chat.site, url: chat.url, exchanges: [] };
    shrunk = chat.exchanges.length < binding.exchanges.length;
    if (shrunk) binding.exchanges = binding.exchanges.slice(0, chat.exchanges.length);
    const added = importWebChatExchanges(layout.cards, binding, chat.exchanges, {
      newId: () => crypto.randomUUID(),
      newTurnId: allocateTurnId
    });
    return { turns: added.turns, cards: added.cards, webChat: { ...binding, exchanges: added.exchanges } };
  });
  return {
    added: shrunk ? -1 : imported.cards.length,
    tailId: imported.webChat?.exchanges.at(-1) ?? null
  };
}
