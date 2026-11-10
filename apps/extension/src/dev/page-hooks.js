/* Development builds only (`npm run dev:extension`): the build appends this classic script to the
 * content scripts (scripts/build.mjs, `DEV_CONTENT_SCRIPT`), never in a release.
 *
 * Automation (Claude in Chrome, DevTools) drives the page, and cannot press the extension's own
 * shortcuts, popup or context menu. In the top frame this answers a `delta-dev` event on
 * `document`, whose `detail` is a JSON string `{ action }`, with a `delta-dev-result` event whose
 * `detail` is a JSON string `{ action, ok, result?, error? }`. Strings, because a detail object
 * would not cross from the content script's world to the page's.
 *
 *   read-web-chat   what the web chat adapter reads here (`readWebChat()`), plus its selector counts
 *   open-canvas     opens the page canvas, as Alt+Shift+C does
 *   canvas-state    whether the overlay is opening, held, and still in the page
 *   ask             `{ action, prompt }`: asks the chat as the canvas does (`webChatAsk` through a
 *                   stand-in port) and answers once it ends, with every message the canvas would
 *                   have received and what the page showed meanwhile. THIS SENDS A REAL MESSAGE.
 *
 * An action may return a Promise; the result event is sent when it settles.
 */

/** Buttons near the composer, described: how a site's Send and Stop buttons can be found again. */
function deltaDevComposerButtons() {
  var composer = document.querySelector('[contenteditable="true"], textarea');
  var scope = (composer && composer.closest('form')) || document;
  return Array.prototype.map.call(scope.querySelectorAll('button'), function (button) {
    var attrs = Array.prototype.filter.call(button.attributes, function (a) {
      return /^(id|type|aria-label|data-testid|disabled)$/.test(a.name);
    }).map(function (a) { return a.name + '=' + a.value; });
    return attrs.join(' ');
  });
}

/** Runs `webChatAsk` as the canvas would and resolves with its messages and the page's states. */
function deltaDevAsk(prompt) {
  var site = webChatSite();
  if (!site) throw new Error('Not a web chat.');
  if (typeof prompt !== 'string' || !prompt) throw new Error('`prompt` is required.');
  var started = Date.now();
  var messages = [];
  var pages = [];
  var lastGenerating = null;
  var watch = setInterval(function () {
    var generating = webChatGenerating(site);
    if (generating === lastGenerating) return;
    lastGenerating = generating;
    pages.push({ ms: Date.now() - started, generating: generating, buttons: deltaDevComposerButtons() });
  }, 250);
  return new Promise(function (resolve) {
    var state = { closed: false, finished: false, started: true };
    var finish = function (why) {
      clearInterval(watch);
      state.closed = true;
      resolve({ ended: why, ms: Date.now() - started, messages: messages, pages: pages });
    };
    var port = {
      postMessage: function (msg) {
        // Snapshots repeat the whole text: keep their length and the newest one's end.
        var entry = { ms: Date.now() - started };
        for (var key in msg) entry[key] = key === 'text' ? msg.text.length + ' chars: …' + msg.text.slice(-200) : msg[key];
        var previous = messages[messages.length - 1];
        if (previous && 'text' in msg && Object.keys(msg).length === 1 && previous.snapshot) {
          previous.count++;
          previous.last = entry;
        } else {
          messages.push(Object.keys(msg).length === 1 && 'text' in msg ? { snapshot: true, count: 1, first: entry, last: entry } : entry);
        }
        if (msg.done || msg.error) finish(msg.done ? 'done' : 'error');
      }
    };
    webChatAsk(port, prompt, state);
    setTimeout(function () { if (!state.closed) finish('timed out after 4 minutes'); }, 240000);
  });
}

var DELTA_DEV_ACTIONS = {
  'read-web-chat': function () {
    var site = webChatSite();
    if (!site) return { site: null };
    var count = function (selector) { return selector ? document.querySelectorAll(selector).length : null; };
    return {
      chat: readWebChat(),
      counts: {
        user: count(site.user),
        assistant: count(site.assistant),
        answerBody: count(site.answerBody),
        questionBody: count(site.questionBody),
        stop: site.stop.map(count),
        send: site.send.map(count),
        composer: site.composer.map(count)
      },
      generating: webChatGenerating(site),
      // Each message as the adapter sees it, to tell a selector problem from a converter one.
      messages: webChatMessages(site).map(function (message) {
        var bodies = message.role === 'assistant' && site.answerBody ? message.el.querySelectorAll(site.answerBody) : [];
        return {
          role: message.role,
          innerText: (message.el.innerText || '').length,
          bodies: bodies.length,
          bodyHidden: Array.prototype.map.call(bodies, canvasIsHidden),
          read: (message.role === 'user' ? webChatQuestionText(site, message.el) : webChatAnswerMarkdown(site, message.el)).length
        };
      })
    };
  },
  'open-canvas': function () {
    openPageCanvas();
    return true;
  },
  'read-web-chat-settled': function () {
    var started = Date.now();
    return readWebChatSettled().then(function (chat) {
      return {
        ms: Date.now() - started,
        exchanges: chat && chat.exchanges.map(function (exchange) {
          return { question: exchange.question.length, answer: exchange.answer.length, bold: (exchange.answer.match(/\*\*/g) || []).length / 2 };
        })
      };
    });
  },
  // The saved canvases over this page, summarized: what an import actually stored.
  'canvas-records': function () {
    var url = webChatSite() ? webChatUrl() : location.href;
    return browser.runtime.sendMessage({ type: 'listConversations' }).then(function (metas) {
      var mine = metas.filter(function (meta) { return meta.source === 'canvas' && meta.pageUrl === url; });
      return Promise.all(mine.map(function (meta) {
        return browser.runtime.sendMessage({ type: 'loadConversation', id: meta.id }).then(function (record) {
          var layout = record.canvas || {};
          return {
            id: record.id,
            updatedAt: record.updatedAt,
            cards: (layout.cards || []).map(function (card) { return card.kind + ' ' + Math.round(card.rect.w) + 'x' + Math.round(card.rect.h); }),
            turns: record.state.turns.map(function (turn) {
              return turn.role + ' ' + turn.content.length + ' chars, ' + ((turn.content.match(/\*\*/g) || []).length / 2) + ' bold';
            }),
            webChat: layout.webChat || null,
            viewport: layout.viewport
          };
        });
      }));
    });
  },
  ask: function (request) {
    return deltaDevAsk(request.prompt);
  },
  'canvas-state': function () {
    return {
      opening: canvasOverlayOpening,
      overlay: !!canvasOverlayEl,
      overlayInPage: !!canvasOverlayEl && canvasOverlayEl.isConnected,
      frameSrc: canvasOverlayFrame ? canvasOverlayFrame.src : null
    };
  }
};

if (window === window.top) {
  document.addEventListener('delta-dev', function (event) {
    var request = {};
    try { request = JSON.parse(event.detail); } catch (e) { /* answered below */ }
    var reply = { action: request.action, ok: false };
    var send = function () {
      document.dispatchEvent(new CustomEvent('delta-dev-result', { detail: JSON.stringify(reply) }));
    };
    var fail = function (err) {
      reply.error = (err && err.message) || String(err);
      send();
    };
    var action = DELTA_DEV_ACTIONS[request.action];
    if (!action) return fail('Unknown action; known: ' + Object.keys(DELTA_DEV_ACTIONS).join(', '));
    try {
      Promise.resolve(action(request)).then(function (result) {
        reply.result = result;
        reply.ok = true;
        send();
      }, fail);
    } catch (err) {
      fail(err);
    }
  });
}
