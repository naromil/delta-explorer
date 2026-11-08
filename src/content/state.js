/* Shared state for content script modules (classic scripts sharing one scope).
 * Guarded so a second evaluation cannot reset it. */
if (!window.__deltaStateLoaded) {
  window.__deltaStateLoaded = true;

  var bubbles = new Map(); // bubbleId -> entry
  var promptInputEl = null;
  var selectionBarEl = null;
  var lastClickX = 0;
  var lastClickY = 0;
  var lastExpandData = null;
  var lastSubParentEntry = null; // bubble whose body holds the selection for the next sub-expand
  var idCounter = 0;
  var currentUrl = (typeof location !== 'undefined' && location.href) || '';
  var isRestoring = false;
  var pendingFolds = [];
  var deltaSettings = { pageSelectionBar: false };

  /* Mirrors EXPAND_INTENTS in src/shared/prompts.js (content scripts cannot import modules). */
  var EXPAND_INTENTS = [
    { label: 'Simpler', prompt: 'Explain this more simply' },
    { label: 'Example', prompt: 'Give a concrete example' },
    { label: 'Why', prompt: 'Why is this so?' },
    { label: 'Compare', prompt: 'Compare this with similar or related ideas' },
    { label: 'Deeper', prompt: 'Go deeper on this' }
  ];
}
