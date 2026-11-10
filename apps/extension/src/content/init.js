/* Initialization and event wiring for the content script.
 * Called once from content.js after the double-injection guard passes. */

var PAGE_TEXT_LIMIT = 12000;

/** Readable text of the page for the look-up: the main article when there is one. */
function readablePageText() {
  var candidates = ['article', 'main', '[role="main"]'];
  var root = null;
  for (var i = 0; i < candidates.length && !root; i++) {
    var found = document.querySelector(candidates[i]);
    if (found && (found.innerText || '').trim().length > 200) root = found;
  }
  root = root || document.body;
  var text = (root && root.innerText ? root.innerText : '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > PAGE_TEXT_LIMIT ? text.slice(0, PAGE_TEXT_LIMIT) + '…' : text;
}

function selectionParentEntry(data) {
  if (!data || !data.range) return null;
  return hostEntryOf(data.range.startContainer);
}

var IS_CHROME = browser.runtime.getURL('').indexOf('chrome-extension:') === 0;

/** Expands this frame's selection from a keyboard shortcut; false when it holds none. */
function expandFromShortcut(prompted) {
  var data = captureExpandData();
  if (!data || isOwnChrome(data.range.startContainer)) return false;
  var parent = selectionParentEntry(data);
  lastSubParentEntry = null;
  if (prompted) showPromptInput(data, parent);
  else expandSelection(data, parent, '');
  return true;
}

function loadContentSettings() {
  browser.storage.local.get('deltaSettings').then(function (obj) {
    var s = obj && obj.deltaSettings;
    deltaSettings.pageSelectionBar = !!(s && s.pageSelectionBar);
  }).catch(function () {});
}

function initContentScript() {

  /* ---- Selection tracking (passive) ---- */

  document.addEventListener('contextmenu', function (e) {
    lastClickX = e.clientX;
    lastClickY = e.clientY;
    lastExpandData = captureExpandData() || null;
    lastSubParentEntry = selectionParentEntry(lastExpandData);
  }, true);

  document.addEventListener('mouseup', function (e) {
    lastClickX = e.clientX;
    lastClickY = e.clientY;
  }, true);

  /* ---- Esc: close the prompt, then the bar, then fold the newest bubble ---- */

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (promptInputEl) { closePromptPanel(); return; }
    if (selectionBarEl) { closeSelectionBar(); return; }
    if (isEditable(document.activeElement)) return;
    foldTopBubble();
  });

  /* ---- Ctrl+E on Chrome ----
   * Chrome keeps Ctrl+E for itself, so it cannot be the default of the `expand` command there; the
   * page takes the key instead (Ctrl+Shift+E asks first, as in the desktop app). In Firefox the
   * command consumes the key before the page sees it. */

  if (IS_CHROME) {
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'e') return;
      if (isEditable(e.target)) return;
      if (expandFromShortcut(e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  initSelectionBar();

  /* ---- Messages from the background and the popup ---- */

  browser.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === 'pageExpandCommand') {
      if (msg.fromShortcut) {
        // The shortcut reaches every frame; only the one holding the selection acts.
        expandFromShortcut(msg.prompted);
        return;
      }
      var data = lastExpandData;
      var parent = lastSubParentEntry;
      lastSubParentEntry = null;
      if (!data) return;
      if (isOwnChrome(data.range.startContainer)) return;
      if (msg.prompted) showPromptInput(data, parent);
      else expandSelection(data, parent, '');
      return;
    }
    if (msg.type === 'openPageCanvas') {
      openPageCanvas();
      return;
    }
    if (msg.type === 'getPageContext') {
      if (window !== window.top) return;
      var sel = window.getSelection();
      return Promise.resolve({
        title: document.title || '',
        url: location.href,
        selection: sel ? sel.toString().trim().slice(0, PAGE_TEXT_LIMIT) : '',
        text: readablePageText()
      });
    }
  });

  /* ---- Settings ---- */

  loadContentSettings();
  browser.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.deltaSettings) loadContentSettings();
  });

  /* ---- Theme ---- */

  applyPageTheme();
  window.addEventListener('pageshow', applyPageTheme);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') applyPageTheme();
  });

  /* ---- SPA route handling ----
   * pushState/replaceState/popstate change the URL without a load; bubbles for
   * the new URL are rehydrated. Old bubbles stay under their old key and expire. */
  function onRouteChange() {
    var newUrl = (typeof location !== 'undefined' && location.href) || '';
    if (newUrl === currentUrl) return;
    currentUrl = newUrl;
    rehydrateFromStorage();
  }

  (function patchHistory() {
    if (!window.history) return;
    var origPush = window.history.pushState;
    var origReplace = window.history.replaceState;
    if (typeof origPush === 'function') {
      window.history.pushState = function () {
        var rv = origPush.apply(this, arguments);
        onRouteChange();
        return rv;
      };
    }
    if (typeof origReplace === 'function') {
      window.history.replaceState = function () {
        var rv = origReplace.apply(this, arguments);
        onRouteChange();
        return rv;
      };
    }
    window.addEventListener('popstate', onRouteChange);
    // Page scripts call their own pushState (the patch above only covers this
    // content script's view of `history` under Firefox's Xray wrappers), so
    // also notice URL changes by looking.
    setInterval(onRouteChange, 1000);
  })();

  rehydrateFromStorage();

  /* ---- Cleanup on unload: stop every stream ---- */
  window.addEventListener('pagehide', function () {
    bubbles.forEach(function (entry) { stopBubbleStream(entry); });
  });
}
