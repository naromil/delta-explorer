/* ---- Selection bar ----
 * Floats over a selection so expanding takes one click: Expand, the one-click
 * questions, and Ask…. It always shows inside an answer; over ordinary page
 * text only when "Show the Expand bar on web pages" is on in Settings. */

var BAR_GAP = 6;

function closeSelectionBar() {
  if (selectionBarEl) {
    removeEl(selectionBarEl);
    selectionBarEl = null;
  }
}

function isEditable(node) {
  var el = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!el || !el.closest) return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/** The bubble whose answer holds this node, if any. */
function hostEntryOf(node) {
  var el = node && (node.nodeType === 1 ? node : node.parentElement);
  var content = el && el.closest ? el.closest('.delta-bubble-content') : null;
  if (!content) return null;
  var bubbleEl = content.closest('.delta-bubble');
  return bubbleEl ? bubbles.get(bubbleEl.getAttribute('data-bubble-id')) || null : null;
}

/** Whether the selection sits on our own controls (header, prompt, bar). */
function isOwnChrome(node) {
  var el = node && (node.nodeType === 1 ? node : node.parentElement);
  return !!(el && el.closest && el.closest('.delta-bubble-header, #delta-expandPrompt, #delta-selection-bar, .delta-bubble-pill'));
}

function showSelectionBar() {
  closeSelectionBar();
  var sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  var text = sel.toString().trim();
  if (!text) return;
  var range = sel.getRangeAt(0);
  if (isEditable(range.commonAncestorContainer) || isOwnChrome(range.startContainer) || isOwnChrome(range.endContainer)) return;

  var host = hostEntryOf(range.startContainer);
  var endHost = hostEntryOf(range.endContainer);
  if (host !== endHost) return;
  if (!host && !deltaSettings.pageSelectionBar) return;

  var data = captureExpandData();
  if (!data) return;
  var rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  var bar = document.createElement('div');
  bar.id = 'delta-selection-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Expand selection');
  bar.style.cssText = 'position:fixed;z-index:2147483647;visibility:hidden;left:0;top:0;';
  // Clicking the bar must not clear the selection it acts on.
  bar.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });

  function addButton(label, title, primary, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'delta-expand-intent' + (primary ? ' delta-expand-intent--primary' : '');
    btn.textContent = label;
    if (title) btn.title = title;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeSelectionBar();
      onClick();
    });
    bar.appendChild(btn);
  }

  addButton('Expand', 'Define or explain the selection', true, function () { expandSelection(data, host, ''); });
  EXPAND_INTENTS.forEach(function (intent) {
    addButton(intent.label, intent.prompt, false, function () { expandSelection(data, host, intent.prompt); });
  });
  addButton('Ask…', 'Ask your own question about the selection', false, function () {
    showPromptPanel({
      x: rect.left + rect.width / 2 - 120,
      y: rect.bottom + BAR_GAP,
      onSubmit: function (prompt) { expandSelection(data, host, prompt); }
    });
  });

  document.body.appendChild(bar);
  selectionBarEl = bar;
  var barRect = bar.getBoundingClientRect();
  var above = rect.top - barRect.height - BAR_GAP;
  bar.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - barRect.width / 2, window.innerWidth - barRect.width - 8)) + 'px';
  bar.style.top = (above >= 8 ? above : rect.bottom + BAR_GAP) + 'px';
  bar.style.visibility = 'visible';
}

function initSelectionBar() {
  document.addEventListener('mouseup', function (e) {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('#delta-selection-bar, #delta-expandPrompt')) return;
    setTimeout(showSelectionBar, 0);
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === 'Shift' || e.shiftKey) setTimeout(showSelectionBar, 0);
  });
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) closeSelectionBar();
  });
  window.addEventListener('scroll', closeSelectionBar, true);
  window.addEventListener('blur', closeSelectionBar);
}
