/* ---- Inline bubbles ----
 * A bubble replaces the selected text in the page flow. Its answer streams in
 * as markdown; it can be folded back to a marker over the original text,
 * regenerated, re-asked, copied, sent to Chat, or dismissed. Sub-bubbles nest
 * inside a parent's answer. */

var SVG_NS = 'http://www.w3.org/2000/svg';
var ICONS = {
  regenerate: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3',
  edit: 'M10.5 2.5l3 3-8 8H2.5v-3z',
  copy: 'M5.5 5.5h8v8h-8zM2.5 10.5v-8h8',
  chat: 'M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6.5L4 13.5V11.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z',
  fold: 'M4 6l4 4 4-4',
  stop: 'M5 5h6v6H5z',
  close: 'M4 4l8 8M12 4l-8 8',
  check: 'M3 8.5l3 3 7-7'
};

function svgIcon(name) {
  var svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  var path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', name === 'stop' ? 'currentColor' : 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function actionButton(name, label, onClick) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'delta-bubble-action delta-bubble-action--' + name;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.appendChild(svgIcon(name));
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    onClick(btn);
  });
  // Clicking an action must not clear a selection or blur the page oddly.
  btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  return btn;
}

function bubbleTitleText(data) {
  var text = (data.prompt ? data.prompt + ' · ' : '') + (data.selection || '');
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

function flashButton(btn) {
  var original = btn.firstChild;
  btn.replaceChild(svgIcon('check'), original);
  btn.classList.add('delta-bubble-action--done');
  setTimeout(function () {
    if (btn.firstChild) btn.replaceChild(original, btn.firstChild);
    btn.classList.remove('delta-bubble-action--done');
  }, 1200);
}

/**
 * Creates a bubble in place of `opts.marker` (or appended to `opts.container`).
 * opts: { id?, range, data: { selection, context, prompt }, parent, marker, container, _savedXpath }
 */
function createBubble(opts) {
  var id = opts.id || genId();
  var data = opts.data || {};
  var parent = opts.parent || null;
  var marker = opts.marker || null;
  var container = opts.container || (marker ? marker.parentNode : null);

  var entry = {
    id: id,
    el: null,
    marker: null,
    range: opts.range,
    data: data,
    responseText: '',
    status: 'loading',
    error: '',
    children: new Map(),
    parent: parent,
    folded: false,
    port: null,
    _savedXpath: opts._savedXpath || null
  };

  var el = document.createElement('span');
  el.className = 'delta-bubble';
  el.setAttribute('data-bubble-id', id);
  el.setAttribute('role', 'note');

  var header = document.createElement('span');
  header.className = 'delta-bubble-header';

  var title = document.createElement('span');
  title.className = 'delta-bubble-title';
  title.textContent = bubbleTitleText(data);
  title.title = (data.prompt ? data.prompt + '\n' : '') + (data.selection || '') + '\n\nRight-click to fold';

  var actions = document.createElement('span');
  actions.className = 'delta-bubble-actions';

  var buttons = {
    stop: actionButton('stop', 'Stop', function () {
      stopBubbleStream(entry);
      finishBubble(entry, entry.responseText.trim() ? 'done' : 'error', entry.responseText.trim() ? '' : 'Generation stopped.');
    }),
    regenerate: actionButton('regenerate', 'Regenerate', function () { regenerateBubble(id); }),
    edit: actionButton('edit', 'Change the question', function (btn) { editBubbleQuestion(id, btn); }),
    copy: actionButton('copy', 'Copy answer', function (btn) {
      DeltaMarkdown.copyToClipboard(entry.responseText || '').then(function () { flashButton(btn); });
    }),
    chat: parent ? null : actionButton('chat', 'Continue in Chat', function (btn) {
      browser.runtime.sendMessage({
        type: 'transferExpansion',
        selection: entry.data.selection || '',
        context: entry.data.context || '',
        prompt: entry.data.prompt || '',
        response: entry.responseText || '',
        page: { title: document.title || '', url: location.href }
      }).then(function () { flashButton(btn); }).catch(function () {});
    }),
    fold: actionButton('fold', 'Fold (or right-click the title)', function () { foldBubble(id); }),
    close: actionButton('close', 'Remove', function () { dismissBubble(id); })
  };
  entry.buttons = buttons;
  ['stop', 'regenerate', 'edit', 'copy', 'chat', 'fold', 'close'].forEach(function (key) {
    if (buttons[key]) actions.appendChild(buttons[key]);
  });

  header.appendChild(title);
  header.appendChild(actions);
  header.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    foldBubble(id);
  });

  var body = document.createElement('span');
  body.className = 'delta-bubble-body delta-bubble-body--text-only';
  var content = document.createElement('span');
  content.className = 'delta-bubble-content';
  body.appendChild(content);

  el.appendChild(header);
  el.appendChild(body);
  entry.el = el;

  if (marker && container) {
    try {
      container.replaceChild(el, marker);
    } catch (err) {
      if (marker.parentNode) marker.parentNode.replaceChild(el, marker);
      else document.body.appendChild(el);
    }
  } else if (container) {
    container.appendChild(el);
  } else {
    document.body.appendChild(el);
  }

  hideAdjacentPunctuation(el);

  bubbles.set(id, entry);
  if (parent) {
    parent.children.set(id, entry);
    var parentBody = parent.el && parent.el.querySelector('.delta-bubble-body');
    if (parentBody) parentBody.classList.remove('delta-bubble-body--text-only');
  }

  renderBubbleAnswer(entry);
  updateBubbleActions(entry);
  persistBubble(entry);
  return entry;
}

/** Re-renders the answer. Never call with sub-bubbles inside: they live in this DOM. */
function renderBubbleAnswer(entry) {
  if (!entry || !entry.el) return;
  var content = entry.el.querySelector('.delta-bubble-content');
  if (!content) return;
  while (content.firstChild) content.removeChild(content.firstChild);
  entry.el.classList.toggle('delta-bubble--loading', entry.status === 'loading');
  entry.el.classList.toggle('delta-bubble--error', entry.status === 'error');

  if (entry.responseText) {
    content.appendChild(DeltaMarkdown.render(entry.responseText, [], { inline: true, anchored: false }));
  } else if (entry.status === 'loading') {
    var spinner = document.createElement('span');
    spinner.className = 'delta-bubble-spinner';
    spinner.textContent = 'Thinking…';
    content.appendChild(spinner);
  }
  if (entry.status === 'error' && entry.error) {
    var error = document.createElement('span');
    error.className = 'delta-bubble-error';
    error.textContent = entry.error;
    content.appendChild(error);
  }
}

function updateBubbleActions(entry) {
  var b = entry.buttons;
  if (!b) return;
  var loading = entry.status === 'loading';
  b.stop.hidden = !loading;
  b.regenerate.hidden = loading;
  b.regenerate.title = entry.status === 'error' ? 'Retry' : 'Regenerate';
  b.regenerate.setAttribute('aria-label', b.regenerate.title);
  b.edit.hidden = loading;
  b.copy.hidden = loading || !entry.responseText;
  if (b.chat) b.chat.hidden = loading || entry.status !== 'done';
}

/* ---- Regenerate / edit ---- */

function confirmDroppingChildren(entry, action) {
  if (entry.children.size === 0) return true;
  return window.confirm(action + '? The expansions inside this answer will be removed.');
}

function dropChildren(entry) {
  Array.from(entry.children.values()).forEach(function (child) { dismissBubble(child.id); });
}

function regenerateBubble(id) {
  var entry = bubbles.get(id);
  if (!entry) return;
  if (!confirmDroppingChildren(entry, 'Regenerate this answer')) return;
  dropChildren(entry);
  startBubbleStream(entry);
  updateBubbleActions(entry);
}

function editBubbleQuestion(id, anchorEl) {
  var entry = bubbles.get(id);
  if (!entry) return;
  var rect = anchorEl.getBoundingClientRect();
  showPromptPanel({
    x: rect.left,
    y: rect.bottom + 4,
    initialPrompt: entry.data.prompt || '',
    onSubmit: function (prompt) {
      if (!confirmDroppingChildren(entry, 'Replace this answer')) return;
      dropChildren(entry);
      entry.data.prompt = prompt.trim() ? prompt.trim() : '';
      var title = entry.el.querySelector('.delta-bubble-title');
      if (title) title.textContent = bubbleTitleText(entry.data);
      startBubbleStream(entry);
      updateBubbleActions(entry);
    }
  });
}

/* ---- Starting an expansion ---- */

/**
 * Wraps the selection, creates the bubble and starts streaming.
 * `data` is from captureExpandData(); `parentEntry` is the bubble whose answer
 * holds the selection, if any.
 */
function expandSelection(data, parentEntry, prompt) {
  if (!data || !data.range) return null;
  if (parentEntry && isStreaming(parentEntry)) {
    showContentNotice('Wait for this answer to finish before expanding inside it.');
    return null;
  }
  var savedXpath = buildXPathFromNode(data.range.startContainer, data.range.startOffset, document);
  var marker = null;
  try { marker = wrapRangeWithMarker(data.range); } catch (err) { marker = null; }
  var container = marker ? marker.parentNode : null;
  if (!marker && parentEntry) {
    container = parentEntry.el.querySelector('.delta-bubble-content');
  }
  var entry = createBubble({
    range: data.range,
    data: {
      selection: data.selection,
      context: parentEntry ? '' : data.context,
      prompt: prompt && prompt.trim() ? prompt.trim() : ''
    },
    parent: parentEntry || null,
    marker: marker,
    container: container,
    _savedXpath: savedXpath
  });
  window.getSelection() && window.getSelection().removeAllRanges();
  startBubbleStream(entry);
  return entry;
}

/* ---- Fold / re-expand ---- */

function foldBubble(id) {
  var entry = bubbles.get(id);
  if (!entry || entry.folded) return;

  if (isStreaming(entry)) {
    stopBubbleStream(entry);
    entry.status = entry.responseText.trim() ? 'done' : 'error';
    entry.error = entry.responseText.trim() ? '' : 'Generation stopped.';
    renderBubbleAnswer(entry);
    updateBubbleActions(entry);
  }

  entry.children.forEach(function (child) { if (!child.folded) foldBubble(child.id); });

  var isLight = document.documentElement.classList.contains('delta-theme-light');
  var markerBg = isLight ? 'rgba(74,111,165,0.15)' : 'rgba(138,160,184,0.28)';
  var markerBgHover = isLight ? 'rgba(74,111,165,0.32)' : 'rgba(138,160,184,0.50)';
  var markerBorder = isLight ? '#4a6fa5' : '#8aa0b8';

  var marker = document.createElement('span');
  marker.className = 'delta-bubble-marker delta-bubble-pill';
  marker.setAttribute('role', 'button');
  marker.setAttribute('tabindex', '0');
  marker.title = (entry.data.prompt ? entry.data.prompt + ' — ' : '') + 'Click to expand again';
  // Inline styles keep the marker visible where the content CSS does not apply.
  marker.style.cssText =
    'display:inline;background:' + markerBg + ';border-bottom:1px dashed ' + markerBorder + ';' +
    'border-radius:3px;padding:0 3px;margin:0 1px;cursor:pointer;vertical-align:baseline;user-select:text;';
  marker.appendChild(document.createTextNode(entry.data.selection || ''));
  marker.addEventListener('mouseenter', function () { marker.style.background = markerBgHover; });
  marker.addEventListener('mouseleave', function () { marker.style.background = markerBg; });

  if (entry.el && entry.el.parentNode) {
    entry.el.parentNode.insertBefore(marker, entry.el);
    entry.el.parentNode.removeChild(entry.el);
  } else if (entry.marker && entry.marker.parentNode) {
    entry.marker.parentNode.replaceChild(marker, entry.marker);
  } else {
    document.body.appendChild(marker);
  }

  var reopen = function (e) {
    e.preventDefault();
    e.stopPropagation();
    reexpandBubble(id);
  };
  marker.addEventListener('click', reopen);
  marker.addEventListener('contextmenu', reopen);
  marker.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') reopen(e);
  });

  entry.marker = marker;
  entry.folded = true;
  hideAdjacentPunctuation(marker);
  persistBubble(entry);
}

function reexpandBubble(id) {
  var entry = bubbles.get(id);
  if (!entry || !entry.folded) return;
  if (!entry.el) {
    entry.folded = false;
    entry.marker = null;
    return;
  }
  var marker = entry.marker;
  if (marker && marker.parentNode) {
    marker.parentNode.replaceChild(entry.el, marker);
  } else {
    var target = entry.parent && entry.parent.el ? entry.parent.el.querySelector('.delta-bubble-content') : null;
    (target || document.body).appendChild(entry.el);
  }
  entry.marker = null;
  entry.folded = false;
  hideAdjacentPunctuation(entry.el);

  // Folded before any answer arrived: ask again.
  if (!entry.responseText && !isStreaming(entry)) startBubbleStream(entry);
  persistBubble(entry);
}

/* ---- Dismiss ---- */

function dismissBubble(id) {
  var entry = bubbles.get(id);
  if (!entry) return;
  stopBubbleStream(entry);
  entry.children.forEach(function (child) { dismissBubble(child.id); });

  if (entry.el) restoreAdjacentPunctuation(entry.el);
  if (entry.marker) restoreAdjacentPunctuation(entry.marker);

  if (entry.marker) {
    var markerParent = entry.marker.parentNode;
    if (markerParent) markerParent.replaceChild(document.createTextNode(entry.data.selection || ''), entry.marker);
    entry.marker = null;
  }
  if (entry.el) {
    var container = entry.el.parentNode;
    if (container) container.replaceChild(document.createTextNode(entry.data.selection || ''), entry.el);
    entry.el = null;
  }

  bubbles.delete(id);
  if (entry.parent) {
    entry.parent.children.delete(id);
    if (entry.parent.children.size === 0 && entry.parent.el) {
      var pbody = entry.parent.el.querySelector('.delta-bubble-body');
      if (pbody) pbody.classList.add('delta-bubble-body--text-only');
    }
  }
  removePersistedBubble(id);
}

/** Esc folds the most recently created open bubble. */
function foldTopBubble() {
  var lastId = null;
  bubbles.forEach(function (entry) { if (!entry.folded && entry.el && entry.el.isConnected) lastId = entry.id; });
  if (lastId) foldBubble(lastId);
}

/* ---- Notices ---- */

var noticeTimer = null;
function showContentNotice(text) {
  var notice = document.getElementById('delta-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'delta-notice';
    notice.setAttribute('role', 'status');
    notice.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;left:50%;transform:translateX(-50%);';
    notice.addEventListener('click', function () { removeEl(notice); });
    document.body.appendChild(notice);
  }
  notice.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(function () { removeEl(notice); }, 4000);
}
