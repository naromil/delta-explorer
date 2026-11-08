/* ---- "Expand on…" prompt ----
 * A small floating panel: type a question (blank = a plain explanation), or
 * pick a one-click question. Editing an existing bubble's question reuses it
 * without the presets. */

function closePromptPanel() {
  if (promptInputEl) {
    removeEl(promptInputEl);
    promptInputEl = null;
  }
}

/** opts: { x, y, initialPrompt?, onSubmit(prompt) } */
function showPromptPanel(opts) {
  closePromptPanel();
  closeSelectionBar();
  var editing = typeof opts.initialPrompt === 'string';

  var el = document.createElement('div');
  el.id = 'delta-expandPrompt';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', editing ? 'Edit question' : 'Expand on');
  // Position inline: the content CSS may not apply in every frame.
  el.style.cssText = 'position:fixed;z-index:2147483647;left:' + Math.round(opts.x) + 'px;top:' + Math.round(opts.y) + 'px;';

  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'delta-expand-prompt-input';
  input.placeholder = editing ? 'Blank for a plain explanation' : 'Expand on…';
  input.autocomplete = 'off';
  if (editing) input.value = opts.initialPrompt;

  var done = false;
  function submit(value) {
    if (done) return;
    done = true;
    closePromptPanel();
    document.removeEventListener('mousedown', onDown, true);
    opts.onSubmit(String(value || ''));
  }

  input.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(input.value); }
    if (e.key === 'Escape') { e.preventDefault(); closePromptPanel(); }
  });

  el.appendChild(input);

  if (!editing) {
    var intents = document.createElement('div');
    intents.className = 'delta-expand-intents';
    EXPAND_INTENTS.forEach(function (intent) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'delta-expand-intent';
      btn.textContent = intent.label;
      btn.title = intent.prompt;
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
      btn.addEventListener('click', function (e) { e.stopPropagation(); submit(intent.prompt); });
      intents.appendChild(btn);
    });
    el.appendChild(intents);
  }

  document.body.appendChild(el);
  promptInputEl = el;

  // Keep the panel on screen.
  var rect = el.getBoundingClientRect();
  var left = Math.max(8, Math.min(opts.x, window.innerWidth - rect.width - 8));
  var top = Math.max(8, Math.min(opts.y, window.innerHeight - rect.height - 8));
  el.style.left = left + 'px';
  el.style.top = top + 'px';

  setTimeout(function () {
    input.focus();
    if (editing) input.select();
  }, 0);

  var onDown = function (e) {
    if (!el.contains(e.target)) {
      closePromptPanel();
      document.removeEventListener('mousedown', onDown, true);
    }
  };
  document.addEventListener('mousedown', onDown, true);
}

/** "Expand on…" for a captured selection. */
function showPromptInput(data, parentEntry) {
  var x = lastClickX || 0;
  var y = lastClickY || 0;
  try {
    var live = window.getSelection();
    var rect = live && live.rangeCount > 0 ? live.getRangeAt(0).getBoundingClientRect() : null;
    if (rect && (rect.width > 0 || rect.height > 0)) { x = rect.left; y = rect.bottom + 4; }
    else if (data.rect) { x = data.rect.left; y = data.rect.bottom + 4; }
  } catch (e) { /* ignore */ }
  showPromptPanel({
    x: x,
    y: y,
    onSubmit: function (prompt) { expandSelection(data, parentEntry, prompt); }
  });
}
