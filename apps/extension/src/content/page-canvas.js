/* The page canvas: the page's readable text as markdown, and the frame that shows the
 * extension's canvas page over the page. Classic script sharing the content scripts' scope.
 *
 * The page's links are kept as markdown links, so the model can hand them back when asked: in
 * the main content where they stand, and the rest of the page's (navigation, sidebars, footers)
 * in a compact list after it.
 *
 * Only the top frame opens it. The page text goes to the background under a single-use token
 * bound to this tab, and the canvas frame takes it back from there, so the frame's address
 * carries no page text. */

/** The main content; the list of the page's other links adds at most CANVAS_LINKS_LIMIT. */
var CANVAS_PAGE_TEXT_LIMIT = 16000;
var CANVAS_LINKS_LIMIT = 4000;
var CANVAS_LINKS_MAX = 80;
/** Longer addresses are mostly tracking parameters: their text is kept, the link is not. */
var CANVAS_URL_MAX = 500;
var CANVAS_OVERLAY_ID = 'delta-canvas-overlay';
var canvasOverlayEl = null;
var canvasOverlayFrame = null;
var canvasOverlayRestore = null;

var CANVAS_SKIP_TAGS = {
  SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1, EMBED: 1,
  VIDEO: 1, AUDIO: 1, MAP: 1, FORM: 1, BUTTON: 1, SELECT: 1, INPUT: 1, TEXTAREA: 1, DIALOG: 1, IMG: 1, PICTURE: 1
};
/** Page chrome rather than content, unless the content root itself is one. */
var CANVAS_CHROME_TAGS = { NAV: 1, ASIDE: 1, FOOTER: 1 };
var CANVAS_BLOCK_TAGS = {
  ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, DD: 1, DETAILS: 1, DIV: 1, DL: 1, DT: 1, FIELDSET: 1,
  FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1, HGROUP: 1,
  HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, SUMMARY: 1, TABLE: 1, UL: 1, TR: 1,
  TBODY: 1, THEAD: 1, TFOOT: 1, CAPTION: 1
};

/** Characters the canvas's markdown would read as syntax. */
function canvasEscapeInline(text) {
  return text.replace(/[\\`*_[\]<>$~|]/g, '\\$&');
}

/** A paragraph must not begin like a heading, list item or quote. */
function canvasEscapeLineStart(text) {
  return text.replace(/^(\s*)(#{1,6}(?=\s)|[-+](?=\s)|\d+(?=[.)]\s)|>)/, function (_m, space, marker) {
    return space + (/^\d/.test(marker) ? marker.replace(/(\d+)$/, '$1\\') : '\\' + marker);
  });
}

var CANVAS_SCREEN_READER_ONLY = /(^|\s)(sr-only|visually-hidden|cdk-visually-hidden|screen-reader-only|screenreader-only)(\s|$)/;

/** Text kept for screen readers only ("You said", "Copy code"): visible to checkVisibility, not to the eye. */
function canvasIsScreenReaderOnly(el) {
  if (typeof el.className === 'string' && CANVAS_SCREEN_READER_ONLY.test(el.className)) return true;
  var rect = el.getBoundingClientRect();
  return rect.width <= 1 && rect.height <= 1 && el.childNodes.length > 0 && getComputedStyle(el).overflow === 'hidden';
}

function canvasIsHidden(el) {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
  if (canvasIsScreenReaderOnly(el)) return true;
  if (typeof el.checkVisibility === 'function') return !el.checkVisibility({ visibilityProperty: true });
  return el.getClientRects().length === 0;
}

function canvasSkipped(el, root) {
  if (CANVAS_SKIP_TAGS[el.tagName]) return true;
  if (el !== root && CANVAS_CHROME_TAGS[el.tagName]) return true;
  if (el.id === CANVAS_OVERLAY_ID || (el.className && typeof el.className === 'string' && el.className.indexOf('delta-bubble') !== -1)) return true;
  return canvasIsHidden(el);
}

/** A link's address as a markdown destination, or null for one not worth keeping. */
function canvasLinkUrl(anchor) {
  var href = anchor.href;
  if (typeof href !== 'string' || !/^https?:\/\//i.test(href) || href.length > CANVAS_URL_MAX) return null;
  // A jump within this page is no address to hand back.
  if (href.split('#')[0] === location.href.split('#')[0] && href.indexOf('#') !== -1) return null;
  return href.replace(/[\s()<>]/g, function (ch) { return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'); });
}

/** A KaTeX formula (web chats render math with it) as its TeX source, or null for anything else. */
function canvasMathTex(el) {
  var classes = el.classList;
  if (!classes || !(classes.contains('katex') || classes.contains('katex-display'))) return null;
  var annotation = el.querySelector('annotation[encoding="application/x-tex"]');
  var tex = annotation ? (annotation.textContent || '').trim() : '';
  if (!tex) return '';
  return classes.contains('katex-display') || el.closest('.katex-display') ? ' $$' + tex + '$$ ' : '$' + tex + '$';
}

/** The inline markdown of a run of nodes: emphasis, code, formulas and links kept. */
function canvasInline(node, root) {
  if (node.nodeType === 3) return canvasEscapeInline(node.nodeValue.replace(/\s+/g, ' '));
  if (node.nodeType !== 1 || canvasSkipped(node, root)) return '';
  var tex = canvasMathTex(node);
  if (tex !== null) return tex;
  if (node.tagName === 'BR') return ' ';
  var inner = '';
  for (var child = node.firstChild; child; child = child.nextSibling) {
    var part = canvasInline(child, root);
    // Blocks inside inline content (a card-like link, say) must not run their words together.
    inner += child.nodeType === 1 && CANVAS_BLOCK_TAGS[child.tagName] ? ' ' + part + ' ' : part;
  }
  var trimmed = inner.trim();
  if (!trimmed) return inner;
  var lead = inner.match(/^\s*/)[0] ? ' ' : '';
  var tail = inner.match(/\s*$/)[0] ? ' ' : '';
  switch (node.tagName) {
    case 'STRONG': case 'B': return lead + '**' + trimmed + '**' + tail;
    case 'EM': case 'I': return lead + '*' + trimmed + '*' + tail;
    case 'CODE': case 'KBD': case 'SAMP': {
      var code = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!code) return '';
      var fence = code.indexOf('`') === -1 ? '`' : '``';
      return lead + fence + code + fence + tail;
    }
    case 'A': {
      var url = canvasLinkUrl(node);
      // Nested links are invalid markdown, so an inner one keeps its text only.
      if (!url || /\]\(https?:/.test(trimmed)) return inner;
      return lead + '[' + trimmed.replace(/\s+/g, ' ') + '](' + url + ')' + tail;
    }
    default: return inner;
  }
}

/** The page's links that the main content left out, as one compact list. */
function canvasOtherLinks(kept) {
  var lines = [];
  var seen = {};
  var left = CANVAS_LINKS_LIMIT;
  var anchors = document.querySelectorAll('a[href]');
  for (var i = 0; i < anchors.length && lines.length < CANVAS_LINKS_MAX && left > 0; i++) {
    var anchor = anchors[i];
    var url = canvasLinkUrl(anchor);
    if (!url || seen[url] || kept.indexOf('](' + url + ')') !== -1) continue;
    if (anchor.closest('#' + CANVAS_OVERLAY_ID + ', .delta-bubble') || canvasIsHidden(anchor)) continue;
    var text = (anchor.innerText || anchor.getAttribute('aria-label') || anchor.title || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) continue;
    seen[url] = true;
    var line = '- [' + canvasEscapeInline(text) + '](' + url + ')';
    left -= line.length + 1;
    if (left > 0) lines.push(line);
  }
  return lines.length ? '## Other links on this page\n\n' + lines.join('\n') : '';
}

function canvasTable(table, root) {
  var rows = [];
  var all = table.rows || [];
  for (var i = 0; i < all.length && rows.length < 60; i++) {
    var cells = [];
    for (var j = 0; j < all[i].cells.length; j++) cells.push(canvasInline(all[i].cells[j], root).trim().replace(/\n/g, ' '));
    if (cells.some(function (cell) { return cell; })) rows.push(cells);
  }
  if (rows.length === 0) return '';
  var width = Math.max.apply(null, rows.map(function (row) { return row.length; }));
  var line = function (row) {
    var padded = row.slice();
    while (padded.length < width) padded.push('');
    return '| ' + padded.join(' | ') + ' |';
  };
  var out = [line(rows[0]), '|' + new Array(width + 1).join(' --- |')];
  for (var k = 1; k < rows.length; k++) out.push(line(rows[k]));
  return out.join('\n');
}

/** Block markdown for `el` and what it holds, pushed onto `out` until `budget.left` runs out. */
function canvasBlocks(el, root, out, budget, indent) {
  var push = function (text) {
    if (budget.left <= 0) return;
    var value = text.replace(/[ \t]+$/gm, '');
    if (!value.trim()) return;
    budget.left -= value.length + 2;
    out.push(value);
  };
  var tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) {
    var heading = canvasInline(el, root).trim();
    if (heading) push(indent + new Array(Number(tag[1]) + 1).join('#') + ' ' + heading);
    return;
  }
  if (tag === 'PRE') {
    // Web chats put a language label and buttons around the code element.
    var codeEl = el.querySelector('code') || el;
    var language = (String(codeEl.className || '').match(/language-([\w+#.-]+)/) || [])[1] || '';
    var code = (codeEl.textContent || '').replace(/\s+$/, '');
    if (code.trim()) push(indent + '```' + language + '\n' + code.replace(/```/g, '``​`') + '\n' + indent + '```');
    return;
  }
  if (tag === 'HR') { push(indent + '---'); return; }
  if (tag === 'TABLE') { push(canvasTable(el, root)); return; }
  if (tag === 'UL' || tag === 'OL') {
    var n = 1;
    for (var item = el.firstElementChild; item && budget.left > 0; item = item.nextElementSibling) {
      if (item.tagName !== 'LI' || canvasSkipped(item, root)) continue;
      var marker = tag === 'OL' ? n++ + '. ' : '- ';
      var parts = [];
      canvasChildren(item, root, parts, budget, '');
      if (parts.length === 0) continue;
      refund(budget, parts);
      var pad = new Array(marker.length + 1).join(' ');
      push(indent + marker + parts.join('\n').split('\n').join('\n' + indent + pad));
    }
    return;
  }
  if (tag === 'BLOCKQUOTE') {
    var quoted = [];
    canvasChildren(el, root, quoted, budget, '');
    refund(budget, quoted);
    if (quoted.length) push(quoted.join('\n\n').split('\n').map(function (line) { return indent + '> ' + line; }).join('\n'));
    return;
  }
  canvasChildren(el, root, out, budget, indent);
}

/** Parts gathered to be pushed again as one block are counted once. */
function refund(budget, parts) {
  for (var i = 0; i < parts.length; i++) budget.left += parts[i].length + 2;
}

/** An element's block children stand alone, and the inline runs between them are paragraphs. */
function canvasChildren(el, root, out, budget, indent) {
  var push = function (text) {
    if (budget.left <= 0) return;
    var value = text.replace(/[ \t]+$/gm, '');
    if (!value.trim()) return;
    budget.left -= value.length + 2;
    out.push(value);
  };
  var run = '';
  var flush = function () {
    var text = run.trim();
    run = '';
    if (text) push(indent + canvasEscapeLineStart(text));
  };
  for (var child = el.firstChild; child && budget.left > 0; child = child.nextSibling) {
    if (child.nodeType === 1 && (CANVAS_BLOCK_TAGS[child.tagName] || child.tagName === 'LI')) {
      flush();
      if (!canvasSkipped(child, root)) canvasBlocks(child, root, out, budget, indent);
    } else {
      run += canvasInline(child, root);
    }
  }
  flush();
}

/** The page's main content as markdown: the article when there is one. */
function readablePageMarkdown() {
  var candidates = ['article', 'main', '[role="main"]'];
  var root = null;
  for (var i = 0; i < candidates.length && !root; i++) {
    var found = document.querySelector(candidates[i]);
    if (found && (found.innerText || '').trim().length > 200) root = found;
  }
  root = root || document.body;
  if (!root) return '';
  var blocks = [];
  try {
    canvasBlocks(root, root, blocks, { left: CANVAS_PAGE_TEXT_LIMIT }, '');
  } catch (e) {
    blocks = [];
  }
  var markdown = blocks.join('\n\n').trim();
  if (markdown.length < 200) {
    // Unusual markup: fall back to the plain readable text, one paragraph per line.
    var plain = readablePageText();
    markdown = plain.split(/\n+/).map(function (line) { return canvasEscapeLineStart(canvasEscapeInline(line.trim())); })
      .filter(Boolean).join('\n\n');
  }
  if (markdown.length > CANVAS_PAGE_TEXT_LIMIT) {
    // Cut between blocks, never inside a link.
    var cut = markdown.lastIndexOf('\n\n', CANVAS_PAGE_TEXT_LIMIT);
    markdown = markdown.slice(0, cut > 0 ? cut : CANVAS_PAGE_TEXT_LIMIT) + '\n\n…';
  }
  var others = '';
  try { others = canvasOtherLinks(markdown); } catch (e) { others = ''; }
  return others ? markdown + '\n\n' + others : markdown;
}

/* ---- The overlay ---- */

function closePageCanvas() {
  if (!canvasOverlayEl) return;
  canvasOverlayEl.remove();
  canvasOverlayEl = null;
  canvasOverlayFrame = null;
  if (canvasOverlayRestore) canvasOverlayRestore();
  canvasOverlayRestore = null;
}

function openPageCanvas() {
  if (window !== window.top) return;
  if (canvasOverlayEl) {
    canvasOverlayFrame.focus();
    return;
  }
  // On a web chat the canvas mirrors the conversation (web-chat.js) instead of reading the page.
  var chat = readWebChat();
  var seed = chat
    ? { title: document.title || '', url: chat.url, text: '', webChat: chat }
    : { title: document.title || '', url: location.href, text: readablePageMarkdown() };
  browser.runtime.sendMessage({ type: 'stashCanvasSeed', seed: seed }).then(function (token) {
    if (canvasOverlayEl || !token) return;
    var overlay = document.createElement('div');
    overlay.id = CANVAS_OVERLAY_ID;
    // Inline and important: the page's own styles must not reach the frame.
    overlay.setAttribute('style', [
      'all: initial !important', 'position: fixed !important', 'inset: 0 !important', 'z-index: 2147483647 !important',
      'display: block !important', 'background: rgba(10, 12, 18, 0.45) !important'
    ].join('; '));
    var frame = document.createElement('iframe');
    frame.src = browser.runtime.getURL('canvas/canvas.html') + '?overlay=1&seed=' + encodeURIComponent(token);
    frame.title = 'Delta Explorer canvas';
    frame.setAttribute('allow', 'clipboard-write');
    frame.setAttribute('style', [
      'all: initial !important', 'position: absolute !important', 'top: 12px !important', 'left: 12px !important',
      'width: calc(100% - 24px) !important', 'height: calc(100% - 24px) !important', 'border: 0 !important',
      'border-radius: 12px !important', 'box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45) !important',
      'background: transparent !important', 'color-scheme: normal !important', 'display: block !important'
    ].join('; '));
    overlay.appendChild(frame);
    // A press on the dimmed page around the frame asks it to close, as Esc does inside it.
    overlay.addEventListener('mousedown', function (e) {
      if (e.target !== overlay || !frame.contentWindow) return;
      e.preventDefault();
      frame.contentWindow.postMessage({ type: 'delta-canvas-request-close' }, '*');
    });
    var html = document.documentElement;
    var previousOverflow = html.style.getPropertyValue('overflow');
    var previousPriority = html.style.getPropertyPriority('overflow');
    html.style.setProperty('overflow', 'hidden', 'important');
    canvasOverlayRestore = function () {
      if (previousOverflow) html.style.setProperty('overflow', previousOverflow, previousPriority);
      else html.style.removeProperty('overflow');
    };
    html.appendChild(overlay);
    canvasOverlayEl = overlay;
    canvasOverlayFrame = frame;
    frame.addEventListener('load', function () { frame.focus(); });
  }).catch(function () { /* the background is unavailable */ });
}

window.addEventListener('message', function (e) {
  if (!canvasOverlayFrame || e.source !== canvasOverlayFrame.contentWindow) return;
  if (e.data && e.data.type === 'delta-canvas-close') closePageCanvas();
});
