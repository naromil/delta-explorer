/* The web chat canvas, on the chat's side: reads a web chat (ChatGPT, Claude, Gemini) as
 * question/answer exchanges, and asks it what the canvas sends. Classic script sharing the
 * content scripts' scope; answers are read with page-canvas.js's markdown converter.
 *
 * The canvas frame connects a Port named `delta-web-chat` to the tab's top frame and posts
 * `{ type: 'ask', prompt }`. This side types the prompt into the chat's composer, sends it, and
 * answers `{ accepted }` once the question shows in the chat, `{ text }` snapshots while the
 * reply is written, then `{ done, text, url }` or `{ error, text }`. Disconnecting stops the
 * reply. One question at a time: the canvas queues the rest.
 *
 * Each site is an adapter of selectors. Chat sites change their markup without notice, so every
 * lookup tries several and a failure says what was not found. */

var WEB_CHAT_PORT = 'delta-web-chat';
var WEB_CHAT_ANSWER_LIMIT = 30000;
var WEB_CHAT_EXCHANGES_MAX = 200;
var WEB_CHAT_POLL_MS = 300;
/** A reply counts as finished once the site stops generating and the text holds this long. */
var WEB_CHAT_SETTLE_MS = 1200;
var WEB_CHAT_ACCEPT_MS = 20000;
var WEB_CHAT_FIRST_WORD_MS = 90000;
var WEB_CHAT_STALL_MS = 180000;
/** Once the site stops answering, how long to look for the reply before saying it cannot be read. */
var WEB_CHAT_NO_REPLY_MS = 20000;
/** Reading the chat waits until every answer has text that holds this long, at most the second. */
var WEB_CHAT_READ_STEADY_MS = 600;
var WEB_CHAT_READ_WAIT_MS = 8000;

var WEB_CHAT_SITES = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    // An address naming a saved conversation, whose messages are still on their way after load.
    conversationPath: /\/c\/[\w-]+/,
    // 2026-11 markup first (bubble / selection message id), then the older author-role one.
    user: '[data-user-message-bubble], [data-message-author-role="user"]',
    assistant: '[data-chatgpt-selection-message-id], [data-message-author-role="assistant"]',
    answerBody: '[data-markdown-copy="contents"], .markdown',
    questionBody: '.whitespace-pre-wrap',
    fillers: ['typing', 'paste'],
    composer: ['div.ProseMirror[contenteditable="true"]', '#prompt-textarea', 'form textarea'],
    send: ['form button[type="submit"][aria-label="Send"]', 'button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label*="Send"]'],
    stop: ['form button[aria-label="Stop"]', 'button[data-testid="stop-button"]', 'button[aria-label*="Stop"]']
  },
  {
    id: 'claude',
    name: 'Claude',
    hosts: ['claude.ai'],
    conversationPath: /^\/chat\/[\w-]+/,
    user: '[data-testid="user-message"]',
    assistant: '.font-claude-response, .font-claude-message',
    answerBody: null,
    questionBody: null,
    fillers: ['typing', 'paste'],
    composer: ['div.ProseMirror[contenteditable="true"]', '[data-testid="chat-input"] [contenteditable="true"]', 'fieldset [contenteditable="true"]'],
    send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'fieldset button[type="submit"]'],
    stop: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop"]'],
    streaming: '[data-is-streaming="true"]'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    hosts: ['gemini.google.com'],
    conversationPath: /^\/(app|gem\/[^/]+)\/\w+/,
    user: 'user-query',
    assistant: 'model-response',
    answerBody: '.markdown, message-content',
    questionBody: '.query-text',
    // Quill builds its model from its DOM, and typed paragraph breaks confuse it.
    fillers: ['paragraphs', 'typing'],
    composer: ['rich-textarea .ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]', '[contenteditable="true"][role="textbox"]'],
    send: ['button.send-button:not(.stop)', 'button[aria-label="Send message"]'],
    stop: ['button.send-button.stop', 'button[aria-label="Stop response"]']
  }
];

/** The adapter for this page, or null when it is no web chat the canvas knows. */
function webChatSite() {
  if (window !== window.top) return null;
  var host = location.hostname.replace(/^www\./, '');
  for (var i = 0; i < WEB_CHAT_SITES.length; i++) {
    if (WEB_CHAT_SITES[i].hosts.indexOf(host) !== -1) return WEB_CHAT_SITES[i];
  }
  return null;
}

function webChatFirst(selectors) {
  for (var i = 0; i < selectors.length; i++) {
    var all = document.querySelectorAll(selectors[i]);
    for (var j = 0; j < all.length; j++) if (!canvasIsHidden(all[j])) return all[j];
  }
  return null;
}

/** Selectors any chat's message box is likely to match, after the site's own. */
var WEB_CHAT_GENERIC_COMPOSERS = ['form [contenteditable="true"]', '[contenteditable="true"][role="textbox"]', 'form textarea', 'main textarea'];

/**
 * The message box: a visible one first, else one the visibility check doubts (a page may hide
 * it from that check while showing it), else a generic match. Throws with what each selector found.
 */
function webChatComposer(site) {
  var selectors = site.composer.concat(WEB_CHAT_GENERIC_COMPOSERS);
  var visible = webChatFirst(selectors);
  if (visible) return visible;
  var report = [];
  for (var i = 0; i < selectors.length; i++) {
    var all = document.querySelectorAll(selectors[i]);
    if (all.length) return all[0];
    report.push(selectors[i]);
  }
  throw new Error('Could not find ' + site.name + '’s message box: nothing on the page matches ' + report.join(', ') +
    '. Is the chat open and signed in?');
}

/** The conversation's address without query or hash, which name the same chat. */
function webChatUrl() {
  return location.origin + location.pathname;
}

/** Every message in document order, outermost only: `{ role, el }`. */
function webChatMessages(site) {
  var nodes = document.querySelectorAll(site.user + ', ' + site.assistant);
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var role = el.matches(site.user) ? 'user' : 'assistant';
    var outer = el.parentElement && el.parentElement.closest(role === 'user' ? site.user : site.assistant);
    if (outer) continue;
    out.push({ role: role, el: el });
  }
  return out;
}

/** The text a reader sees: hidden and screen-reader-only labels ("You said") left out. */
function webChatVisibleText(node) {
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType !== 1 || CANVAS_SKIP_TAGS[node.tagName] || canvasIsHidden(node)) return '';
  if (node.tagName === 'BR') return '\n';
  var text = '';
  for (var child = node.firstChild; child; child = child.nextSibling) text += webChatVisibleText(child);
  return CANVAS_BLOCK_TAGS[node.tagName] ? '\n' + text + '\n' : text;
}

function webChatQuestionText(site, el) {
  var body = (site.questionBody && el.querySelector(site.questionBody)) || el;
  return webChatVisibleText(body).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function webChatAnswerMarkdown(site, el) {
  var bodies = site.answerBody ? el.querySelectorAll(site.answerBody) : [];
  var roots = bodies.length ? Array.prototype.slice.call(bodies) : [el];
  var blocks = [];
  var budget = { left: WEB_CHAT_ANSWER_LIMIT };
  for (var i = 0; i < roots.length; i++) {
    // A body nested in another found one is already read.
    if (i > 0 && roots[i - 1].contains(roots[i])) continue;
    try { canvasBlocks(roots[i], roots[i], blocks, budget, ''); } catch (e) { /* unusual markup */ }
  }
  var markdown = blocks.join('\n\n').trim();
  if (!markdown) markdown = (el.innerText || '').trim();
  return markdown.length > WEB_CHAT_ANSWER_LIMIT ? markdown.slice(0, WEB_CHAT_ANSWER_LIMIT) + '\n\n…' : markdown;
}

/** The chat as question/answer pairs, in order. */
function readWebChatExchanges(site) {
  var messages = webChatMessages(site);
  var exchanges = [];
  var current = null;
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];
    if (message.role === 'user') {
      current = { question: webChatQuestionText(site, message.el), answer: '' };
      exchanges.push(current);
    } else {
      var answer = webChatAnswerMarkdown(site, message.el);
      if (!current) {
        current = { question: '', answer: '' };
        exchanges.push(current);
      }
      current.answer = current.answer ? current.answer + '\n\n' + answer : answer;
    }
  }
  return exchanges.slice(-WEB_CHAT_EXCHANGES_MAX);
}

/** What the canvas seed carries for a web chat. */
function readWebChat() {
  var site = webChatSite();
  if (!site) return null;
  return { site: site.id, name: site.name, url: webChatUrl(), exchanges: readWebChatExchanges(site) };
}

function webChatGenerating(site) {
  if (site.streaming && document.querySelector(site.streaming)) return true;
  return !!webChatFirst(site.stop);
}

/**
 * `readWebChat()` once the page shows every answer. A chat may render loaded answers hidden and
 * then reveal them gradually (ChatGPT, for about 4 s after the page loads), which would import
 * empty or cut-off cards; so this waits until no answer is empty, except one still being written,
 * and the text holds `WEB_CHAT_READ_STEADY_MS`. On a saved conversation's address
 * (`conversationPath`) an empty page means the messages have not arrived yet. After `WEB_CHAT_READ_WAIT_MS` it reads what is
 * there, since an answer can be empty for good (a failed reply). Resolves null off a web chat.
 */
function readWebChatSettled() {
  var site = webChatSite();
  if (!site) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var started = Date.now();
    var saved = !!site.conversationPath && site.conversationPath.test(location.pathname);
    var last = null;
    var steadySince = started;
    (function poll() {
      var chat = readWebChat();
      var now = Date.now();
      var key = JSON.stringify(chat.exchanges);
      if (key !== last) {
        last = key;
        steadySince = now;
      }
      var generating = webChatGenerating(site);
      var missing = (saved && chat.exchanges.length === 0) || chat.exchanges.some(function (exchange, i) {
        var writing = generating && i === chat.exchanges.length - 1;
        return !exchange.answer && !writing;
      });
      var steady = !missing && now - steadySince >= WEB_CHAT_READ_STEADY_MS;
      if (steady || now - started >= WEB_CHAT_READ_WAIT_MS) return resolve(chat);
      setTimeout(poll, WEB_CHAT_POLL_MS);
    })();
  });
}


function webChatComposerText(el) {
  return el.tagName === 'TEXTAREA' ? el.value : el.innerText || '';
}

function webChatSelectAll(composer) {
  var selection = window.getSelection();
  var range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
}

function webChatParagraphs(text) {
  return text.split('\n').map(function (line) {
    var p = document.createElement('p');
    if (line) p.textContent = line;
    else p.appendChild(document.createElement('br'));
    return p;
  });
}

/** Empties the composer, so a failed attempt leaves nothing behind for the next. */
function webChatReset(composer) {
  if (composer.tagName === 'TEXTAREA') {
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(composer, '');
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (!webChatComposerText(composer).trim()) return;
  composer.focus();
  webChatSelectAll(composer);
  document.execCommand('delete');
  if (!webChatComposerText(composer).trim()) return;
  composer.replaceChildren.apply(composer, webChatParagraphs(''));
  composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
}

/*
 * Ways to put text in an empty composer. Each editor (ProseMirror on ChatGPT and Claude, Quill on
 * Gemini) notices a different one, so a site names its order (`fillers`), and the text is checked
 * before anything is sent.
 */
var WEB_CHAT_FILLERS = {
  typing: function (composer, text) {
    if (composer.tagName === 'TEXTAREA') {
      var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(composer, text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // Line by line: editors read a newline in inserted text differently, a paragraph break alike.
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) document.execCommand('insertParagraph');
      if (lines[i]) document.execCommand('insertText', false, lines[i]);
    }
  },
  paste: function (composer, text) {
    var data = new DataTransfer();
    data.setData('text/plain', text);
    composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  },
  paragraphs: function (composer, text) {
    // The editor watches its DOM, so whole paragraphs written in and an input event reach it.
    composer.replaceChildren.apply(composer, webChatParagraphs(text));
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
};

function webChatSameText(a, b) {
  var flat = function (text) { return String(text || '').replace(/\s+/g, ' ').trim(); };
  return flat(a) === flat(b);
}

function webChatSendButton(site) {
  var button = webChatFirst(site.send);
  return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
}

function webChatPressEnter(composer) {
  var init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  composer.dispatchEvent(new KeyboardEvent('keydown', init));
  composer.dispatchEvent(new KeyboardEvent('keypress', init));
  composer.dispatchEvent(new KeyboardEvent('keyup', init));
}

/** Resolves when `test()` is truthy (with its value), or null after `ms`. */
function webChatWaitFor(test, ms, isCancelled) {
  return new Promise(function (resolve) {
    var started = Date.now();
    (function poll() {
      if (isCancelled()) return resolve(null);
      var value = test();
      if (value) return resolve(value);
      if (Date.now() - started > ms) return resolve(null);
      setTimeout(poll, WEB_CHAT_POLL_MS);
    })();
  });
}

/** Your messages on the page: how many, and the newest one's text. */
function webChatUserState(site) {
  var users = webChatMessages(site).filter(function (message) { return message.role === 'user'; });
  var newest = users[users.length - 1];
  return { count: users.length, newest: newest ? webChatQuestionText(site, newest.el) : null };
}

/** The newest reply on the page, as element and markdown; what `before` remembers. */
function webChatNewestReply(site) {
  var replies = webChatMessages(site).filter(function (message) { return message.role === 'assistant'; });
  var newest = replies[replies.length - 1];
  return newest ? { el: newest.el, text: webChatAnswerMarkdown(site, newest.el) } : { el: null, text: '' };
}

/**
 * The answer to the question just sent: every reply after the newest question when the page has
 * them in that order, else the newest reply if it is not the one there before sending (a page
 * may keep replies apart from questions, or take older turns away).
 */
function webChatLatestAnswer(site, before) {
  var messages = webChatMessages(site);
  var parts = [];
  for (var i = messages.length - 1; i >= 0 && messages[i].role === 'assistant'; i--) {
    parts.unshift(webChatAnswerMarkdown(site, messages[i].el));
  }
  var text = parts.join('\n\n').trim();
  if (text) return text;
  var newest = webChatNewestReply(site);
  return newest.el && (newest.el !== before.el || newest.text !== before.text) ? newest.text : '';
}

/**
 * Types `prompt` and sends it once the composer holds exactly that text, trying the site's
 * fillers in order. Resolves true once the question shows in the chat; rejects with what was
 * tried when it never does. Nothing is sent that does not read back as the prompt.
 */
function webChatSubmit(site, composer, prompt, cancelled) {
  var before = webChatUserState(site);
  var tried = [];
  var typedExactly = function () { return webChatSameText(webChatComposerText(composer), prompt); };
  /*
   * Sent once the chat shows a new message of yours, or its newest one changes to the prompt, or
   * the box emptied and an answer started. Counting alone fails where a long chat takes older
   * turns off the page.
   */
  var sent = function () {
    var now = webChatUserState(site);
    if (now.count > before.count) return true;
    if (now.newest !== before.newest && webChatSameText(now.newest, prompt)) return true;
    return !webChatComposerText(composer).trim() && webChatGenerating(site);
  };
  var report = function (what) {
    var button = webChatFirst(site.send);
    var state = !button ? 'no Send button found' : webChatSendButton(site) ? 'Send button enabled' : 'Send button disabled';
    return new Error(site.name + ' ' + what + ' (tried ' + tried.join(', ') + '; ' + state + '). Reload the chat page and try again.');
  };
  var attempt = function (index) {
    if (cancelled()) return Promise.resolve(false);
    var name = site.fillers[index];
    if (!name) {
      webChatReset(composer);
      return Promise.reject(report('did not take the typed question exactly, so nothing was sent'));
    }
    tried.push(name);
    webChatReset(composer);
    composer.focus();
    try { WEB_CHAT_FILLERS[name](composer, prompt); } catch (e) { /* the next filler */ }
    // Editors settle asynchronously: wait for the exact text and an enabled Send button together.
    return webChatWaitFor(function () { return typedExactly() && webChatSendButton(site); }, 2000, cancelled).then(function (button) {
      if (cancelled()) return false;
      if (!typedExactly()) return attempt(index + 1);
      if (button) {
        tried.push('clicking Send');
        button.click();
      } else {
        tried.push('pressing Enter');
        webChatPressEnter(composer);
      }
      return webChatWaitFor(sent, WEB_CHAT_ACCEPT_MS, cancelled).then(function (ok) {
        if (ok || cancelled()) return !!ok;
        throw report('did not take the question');
      });
    });
  };
  return attempt(0);
}

function webChatAsk(port, prompt, state) {
  var site = webChatSite();
  var post = function (msg) {
    if (state.closed) return;
    try { port.postMessage(msg); } catch (e) { state.closed = true; }
  };
  var cancelled = function () { return state.closed; };
  if (!site) return post({ error: 'This page is no longer the chat.' });
  var before = { el: null, text: '' };

  webChatWaitFor(function () { return !webChatGenerating(site); }, WEB_CHAT_FIRST_WORD_MS, cancelled).then(function (idle) {
    if (cancelled()) return null;
    if (!idle) throw new Error(site.name + ' is still answering something else.');
    var composer = webChatComposer(site);
    before = webChatNewestReply(site);
    return webChatSubmit(site, composer, prompt, cancelled);
  }).then(function (accepted) {
    if (cancelled() || !accepted) return;
    post({ accepted: true });
    var started = Date.now();
    var lastText = '';
    var lastChange = Date.now();
    (function poll() {
      if (cancelled()) return;
      var text = webChatLatestAnswer(site, before);
      var now = Date.now();
      if (text !== lastText) {
        lastText = text;
        lastChange = now;
        post({ text: text });
      }
      var generating = webChatGenerating(site);
      if (!generating && text && now - lastChange >= WEB_CHAT_SETTLE_MS) {
        state.finished = true;
        return post({ done: true, text: text, url: webChatUrl() });
      }
      if (!text && !generating && now - started > WEB_CHAT_NO_REPLY_MS) {
        state.finished = true;
        var messages = webChatMessages(site);
        var replies = messages.filter(function (message) { return message.role === 'assistant'; }).length;
        return post({
          error: 'Could not read ' + site.name + '’s answer (the page shows ' + (messages.length - replies) + ' of your messages and ' +
            replies + ' replies to the canvas, and nothing new after your question).',
          text: ''
        });
      }
      if (now - lastChange > WEB_CHAT_STALL_MS) {
        state.finished = true;
        return post({ error: site.name + '’s answer stopped arriving.', text: text });
      }
      setTimeout(poll, WEB_CHAT_POLL_MS);
    })();
  }).catch(function (err) {
    state.finished = true;
    post({ error: (err && err.message) || String(err), text: '' });
  });
}

function initWebChat() {
  if (!webChatSite()) return;
  browser.runtime.onConnect.addListener(function (port) {
    if (port.name !== WEB_CHAT_PORT) return;
    var state = { closed: false, finished: false, started: false };
    port.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'read') {
        readWebChatSettled().then(function (chat) {
          try { port.postMessage({ chat: chat }); } catch (e) { /* gone */ }
        });
        return;
      }
      if (!msg || msg.type !== 'ask' || state.started || typeof msg.prompt !== 'string') return;
      state.started = true;
      webChatAsk(port, msg.prompt, state);
    });
    // The canvas stopped the answer or went away: the chat stops writing too.
    port.onDisconnect.addListener(function () {
      state.closed = true;
      var site = webChatSite();
      if (!state.finished && state.started && site) {
        var stop = webChatFirst(site.stop);
        if (stop) stop.click();
      }
    });
  });
}
