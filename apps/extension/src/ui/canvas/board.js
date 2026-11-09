/* The canvas board: pointer gestures, keys, drafts, cards, links and chrome. Ported from
 * Delta Explorer's views/canvas/CanvasView.tsx and its card, note, frame, draft and link views.
 *
 * There is no framework: the board keeps its own state, derives what is on screen from it and
 * the store on every render, and updates DOM it keeps by id. A card's text is rebuilt only when
 * it changed, so a selection being made in one card survives answers streaming into another. */

import { rpc } from '../api.js';
import { downloadText, formatRelativeTime, h } from '../dom.js';
import {
  adjacentSlot,
  askedAboutRelations,
  canvasContinuations,
  cardRects,
  cardStackRanks,
  cascadeCardIds,
  clampPointInside,
  CLICK_DRAG_LIMIT,
  connectorGeometry,
  containsPoint,
  continuationCandidates,
  continueHandleBlocked,
  DEFAULT_EXPANSION_SIZE,
  DEFAULT_MESSAGE_SIZE,
  DEFAULT_NOTE_SIZE,
  DEFAULT_PAGE_SIZE,
  draftGrowth,
  estimateWords,
  FAR_ZOOM,
  fitsOnScreen,
  fitViewport,
  gridSpacing,
  linkPath,
  MIN_EXPANSION_SIZE,
  MIN_FRAME_SIZE,
  MIN_MESSAGE_SIZE,
  MIN_NOTE_SIZE,
  nearestCardInDirection,
  openCardSize,
  rectAgainst,
  rectCenteredAt,
  rectClearOf,
  rectFromCorner,
  rectFromPoints,
  rectsOverlap,
  resizeCard,
  resizeDraftRect,
  resizeFollowerIds,
  resolveMove,
  revealRect,
  screenToWorld,
  sessionCardIds,
  snapEdges,
  snapMove,
  sourceCardId,
  turnsThroughCard,
  unionRect,
  visibleWorldRect,
  wheelZoomFactor,
  zoomAt
} from '../../shared/canvas.js';
import { alignSelection, distributeSelection, selectionBlockCount } from '../../shared/canvas-arrange.js';
import { contextExcerpts, sessionContextLinks } from '../../shared/canvas-context.js';
import { canvasOutline } from '../../shared/canvas-outline.js';
import {
  boundsOf,
  cardAtPoint,
  cardsInsideFrame,
  marqueeHits,
  movingBounds,
  movingForSelection,
  selectedCards,
  selectionMarkdown,
  sessionAncestorIds,
  sharedColor
} from '../../shared/canvas-selection.js';
import { tidySelection } from '../../shared/canvas-tidy.js';
import { estimateTokens } from '../../shared/context-budget.js';
import { CONVERSATION_SOURCE_LABELS, exportFileName, renderConversationMarkdown } from '../../shared/conversation.js';
import { LOOKUP_DEFAULT_QUERY } from '../../shared/prompts.js';
import { findExpansionInNodes, flattenMarkdown, validateExpansionTarget } from '../../shared/rich-text.js';
import {
  bodyCharWidth,
  canScrollBy,
  canvasIcon,
  cardContent,
  confirmCascade,
  createRightDrag,
  createViewportMotion,
  deletedNotice,
  dependentsPhrase,
  isTyping,
  measureCardHeight,
  ownsKeys,
  readMinimapPreference,
  releaseFocus,
  saveMinimapPreference,
  scrollIntoBody,
  svgEl,
  termPoint,
  wheelPanDelta
} from './helpers.js';
import { Minimap, Outline, selectionBar, shortcutsPanel, ToolRail } from './panels.js';
import { CanvasPopups } from './popups.js';

const MD = globalThis.DeltaMarkdown;

const SNAP_SCREEN_PX = 10;
const VIEWPORT_TRANSITION_MS = 360;
const PULSE_MS = 900;
const NOTICE_MS = 4000;
const COPIED_MS = 1500;
const HISTORY_OTHERS_LIMIT = 8;

const REFUSE_TOO_SMALL = 'That rectangle is too small to hold an answer. Draw a larger one.';
const REFUSE_ARRANGE = 'Other cards are in the way of that arrangement.';
const ALREADY_TIDY = 'Already tidy.';
const NO_CARD_TO_CONNECT = 'Start a connection on a card.';
const CONNECT_ANOTHER = 'Drag to a different card to connect them.';
const NO_CONTINUE_FAILED = 'Retry this answer before continuing it.';
const WAITING_PARENT = 'Waiting for the answer it continues…';
const FAILED_PARENT = 'The answer it continues failed. Retry it first.';
const WAITING_CONTEXT = 'Waiting for a linked answer…';
const LINK_IN_HISTORY = 'That card is already in this conversation.';
const EXTEND_HINT = 'Let go in open space to place the next message, or on a new message to link.';
const SIZE_HINT = 'Move to size the next message, then click. A click right away uses the default.';

const TOOL_HINTS = {
  answer: 'Draw a rectangle for the answer, or click for the default size.',
  note: 'Draw where the note goes, or click for the default size.',
  frame: 'Draw a region. Whatever stands inside it moves with it.',
  connect: 'Drag from one card to another.',
  hand: 'Drag anywhere to pan.'
};

/** Below this much pointer travel on screen, a press is a click rather than a drag. */
const DRAG_START_PX = 3;
const DOUBLE_PRESS_MS = 400;
const NUDGE = 10;
const NUDGE_LARGE = 50;
/** Room left around what a new frame wraps, and the size of one made with a click. */
const FRAME_PADDING = 32;
const DEFAULT_FRAME_SIZE = { w: 520, h: 360 };
/** How much of the surface the open outline covers, rail included. */
const OUTLINE_WIDTH = 344;
/** Where a jump lands if the view is too far out to read what it was looking for. */
const READING_ZOOM = 0.8;
const VIEW_HISTORY_LIMIT = 50;
/** Space kept around a new session opened from the keyboard. */
const NEW_SESSION_GAP = 48;
/** Keeps a run of wheel events on what it started moving as things pass under the pointer. */
const WHEEL_LATCH_MS = 160;
export const ZOOM_STEP = 1.25;
const PAN_STEP = 80;
const PAN_STEP_LARGE = 320;
/** How far Alt+arrow resizes a draft, in world pixels. */
const DRAFT_RESIZE_STEP = 40;
const DRAFT_LABEL_CHARS = 32;
/** The band along the edge of the view that pans it while something is being dragged. */
const EDGE_BAND_PX = 40;
const EDGE_SPEED_PX = 14;
const EDGE_MOVED_PX = 4;
/** A streaming answer follows its newest line while the reader is this close to it. */
const PIN_PX = 24;

const ARROW_SIDES = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'bottom', ArrowUp: 'top' };
const TOOL_KEYS = { v: 'select', h: 'hand', r: 'answer', t: 'note', c: 'connect', f: 'frame' };
const SIDE_ANGLE = { right: 0, bottom: 90, left: 180, top: 270 };
const ARROW = 'M -8 -4.5 L 0 0 L -8 4.5 Z';
const CHEVRON = 'M -1.75 -3.5 L 1.75 0 L -1.75 3.5';

function refusalMessage(reason) {
  switch (reason) {
    case 'overlaps-expansion':
    case 'inside-expansion': return 'That range overlaps an existing expansion.';
    case 'cross-block':
    case 'not-anchored': return 'Select text inside one paragraph, list item or heading.';
    case 'blank-selection':
    case 'empty-range': return 'Select some text to expand.';
    case 'out-of-bounds': return 'The selection is no longer available.';
    case 'parent-not-found':
    case 'turn-not-found': return 'That card is no longer on the canvas.';
    case 'streaming': return 'Wait for this answer to finish before expanding inside it.';
    default: return 'The selection cannot be expanded.';
  }
}

function shortLabel(label) {
  const flat = String(label || '').replace(/\s+/g, ' ').trim();
  return flat.length > DRAFT_LABEL_CHARS ? `${flat.slice(0, DRAFT_LABEL_CHARS - 1)}…` : flat || 'Untitled';
}

function formatTokens(tokens) {
  return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
}

function place(el, rect) {
  el.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  el.style.width = `${rect.w}px`;
  el.style.height = `${rect.h}px`;
}

function setPathD(path, d) {
  path.setAttribute('d', d);
  path.style.setProperty('d', `path("${d}")`);
}

function pointerTransform(at, side) {
  return `translate(${at.x}px, ${at.y}px) rotate(${SIDE_ANGLE[side]}deg) scale(calc(1 / var(--canvas-zoom)))`;
}

function isSafeUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

/** Word under a point, for a right-click without a selection. */
function wordRangeAtPoint(x, y) {
  const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
  if (!pos || !pos.offsetNode || pos.offsetNode.nodeType !== Node.TEXT_NODE) return null;
  const text = pos.offsetNode.nodeValue || '';
  let start = pos.offset;
  let end = pos.offset;
  const word = /[\p{L}\p{N}_'’-]/u;
  while (start > 0 && word.test(text[start - 1])) start--;
  while (end < text.length && word.test(text[end])) end++;
  if (start === end) return null;
  const range = document.createRange();
  range.setStart(pos.offsetNode, start);
  range.setEnd(pos.offsetNode, end);
  return range;
}

/** Keeps a container's children in `items` order, creating and dropping them by key. */
function syncKeyed(parent, cache, items) {
  const seen = new Set();
  let prev = null;
  for (const item of items) {
    seen.add(item.key);
    let el = cache.get(item.key);
    if (!el) {
      el = item.create();
      cache.set(item.key, el);
    }
    item.update?.(el);
    const next = prev ? prev.nextSibling : parent.firstChild;
    if (next !== el) parent.insertBefore(el, next);
    prev = el;
  }
  for (const [key, el] of cache) {
    if (!seen.has(key)) {
      el.remove();
      cache.delete(key);
    }
  }
}

function linkLine(d, { arrow = false, dashed = false } = {}) {
  const path = svgEl('path', { class: 'canvas-link-line' });
  // A normalised length is only for the draw-in animation; it would stretch real dashes.
  if (!dashed) path.setAttribute('pathLength', '1');
  if (arrow) path.setAttribute('marker-end', 'url(#canvas-arrow)');
  setPathD(path, d);
  return path;
}

function hitPath(d, title, on) {
  const path = svgEl('path', { class: 'canvas-link-hit', d });
  const tip = svgEl('title');
  tip.textContent = title;
  path.appendChild(tip);
  for (const [event, fn] of Object.entries(on)) path.addEventListener(event, fn);
  return path;
}

export class CanvasBoard {
  /**
   * options: {
   *   host, store,
   *   toolbarExtras?: Node[],            // appended to the title toolbar
   *   historyExtras?(): menu items,      // added to the history menu
   *   onOpenSearch?(),                   // "Search all conversations…"
   *   onOpenConversation?(meta),         // a chat or look-up chosen from the history menu
   *   onEscapeIdle?()                    // Esc with nothing left to cancel
   * }
   */
  constructor(options) {
    this.options = options;
    this.store = options.store;
    this.popups = new CanvasPopups();
    this.rightDrag = createRightDrag();
    this.active = false;

    this.tool = 'select';
    this.gesture = null;
    this.draft = null;
    this.placing = null;
    this.notice = null;
    this.selected = new Set();
    this.noteDraft = null;
    this.editingNoteId = null;
    this.editingFrameId = null;
    this.editingLinkId = null;
    this.editingCardId = null;
    this.outlineOpen = false;
    this.searchMatches = null;
    this.minimapOpen = readMinimapPreference();
    this.hoverCardId = null;
    this.pulseId = null;
    this.pulseTerm = null;
    this.spaceHeld = false;
    this.helpOpen = false;
    this.surfaceBox = { width: 0, height: 0 };
    this.copiedCardId = null;

    this.viewport = this.store.viewport;
    this.follow = true;
    this.followKey = '';
    this.currentId = null;
    this.viewBack = [];
    this.viewForward = [];
    this.lastPointer = null;
    this.press = null;
    this.lastPress = null;
    this.doublePressed = false;
    this.claimedPress = false;
    this.lastCopy = null;
    this.draftKey = 0;
    this.followRect = null;
    this.termOffsets = {};
    this.pins = new Map();

    this.cardEls = new Map();
    this.frameEls = new Map();
    this.linkCaches = { under: new Map(), over: new Map(), seams: new Map(), labels: new Map() };

    this.build();
    this.motion = createViewportMotion({
      read: () => this.viewport,
      paint: (next) => this.paintViewport(next),
      commit: (next) => this.store.setViewport(next),
      setMoving: (moving) => this.surface.toggleAttribute('data-moving', moving)
    });
    this.bindEvents();
    this.unsubscribe = this.store.subscribe((change) => this.handleStoreChange(change));
    this.handleStoreChange({ replaced: true, viewport: true });
  }

  /* ================= Structure ================= */

  build() {
    const host = this.options.host;
    this.framesLayer = h('div.canvas-layer');
    this.cardsLayer = h('div.canvas-layer');
    this.svgUnder = svgEl('svg', { class: 'canvas-links canvas-links--under', 'aria-hidden': 'true' });
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'canvas-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.appendChild(svgEl('path', { d: 'M1 1.5L9 5l-8 3.5z', fill: 'context-stroke' }));
    defs.appendChild(marker);
    this.underGroup = svgEl('g');
    this.svgUnder.append(defs, this.underGroup);
    this.svgOver = svgEl('svg', { class: 'canvas-links canvas-links--over', 'aria-hidden': 'true' });
    this.overGroup = svgEl('g');
    this.svgOver.appendChild(this.overGroup);
    this.svgSeams = svgEl('svg', { class: 'canvas-links canvas-links--seams', 'aria-hidden': 'true' });
    this.seamGroup = svgEl('g');
    this.svgSeams.appendChild(this.seamGroup);
    this.labelsLayer = h('div.canvas-layer');
    this.draftLayer = h('div.canvas-layer');
    this.aidsLayer = h('div.canvas-layer');
    this.world = h('div.canvas-world', this.framesLayer, this.cardsLayer, this.svgUnder, this.svgOver, this.svgSeams,
      this.labelsLayer, this.draftLayer, this.aidsLayer);
    this.emptyEl = h('div.canvas-empty',
      h('h2', { text: 'Draw a rectangle' }),
      h('p', { text: 'Delta writes an answer sized to fit it. Draw against a side to continue the same conversation, or anywhere else to start a new one.' }),
      h('ul.canvas-empty-keys',
        h('li', h('kbd', { text: 'N' }), ' type a question'),
        h('li', h('kbd', { text: 'T' }), ' write a note'),
        h('li', h('kbd', { text: '?' }), ' every shortcut')));
    this.surface = h('div.canvas-surface', this.world, this.emptyEl);

    this.rail = new ToolRail({
      onTool: (tool) => this.chooseTool(tool),
      onUndo: () => this.handleUndo('undo'),
      onRedo: () => this.handleUndo('redo'),
      onToggleOutline: () => (this.outlineOpen ? this.setOutline(false) : this.openOutline())
    });
    this.outline = new Outline({
      onSearchMatches: (ids) => { this.searchMatches = ids; this.schedule(); },
      onGoTo: (id) => this.goToItem(id),
      onClose: () => this.setOutline(false)
    });
    this.minimap = new Minimap((point, dragging) => this.navigateFromMinimap(point, dragging));

    this.titleInput = h('input.canvas-title', {
      'aria-label': 'Canvas name',
      on: {
        blur: () => this.store.rename(this.titleInput.value),
        keydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') this.titleInput.blur(); if (e.key === 'Escape') { this.titleInput.value = this.store.title; this.titleInput.blur(); } }
      }
    });
    this.newBtn = h('button.canvas-tool', { type: 'button', title: 'Start a new, empty canvas', text: 'New', on: { click: () => this.store.newCanvas() } });
    this.exportBtn = h('button.canvas-tool', { type: 'button', title: 'Save this canvas as markdown', text: 'Export', on: { click: () => this.exportCanvas() } });
    this.titleBar = h('div.canvas-toolbar.canvas-toolbar--title', this.titleInput,
      h('button.canvas-tool', { type: 'button', 'aria-haspopup': 'menu', title: 'History: canvases, chats and look-ups', text: '▾', on: { click: (e) => this.openHistoryMenu(e) } }),
      this.newBtn, this.exportBtn, ...(this.options.toolbarExtras || []));

    this.zoomValue = h('span');
    this.mapBtn = h('button.canvas-tool.canvas-tool--icon', { type: 'button', 'aria-label': 'Map (M)', title: 'Show or hide the map (M)', on: { click: () => this.toggleMinimap() } }, canvasIcon('map'));
    this.helpBtn = h('button.canvas-tool', { type: 'button', 'aria-label': 'Keyboard shortcuts (?)', title: 'Keyboard shortcuts (?)', text: '?', on: { click: () => this.toggleHelp() } });
    this.zoomBar = h('div.canvas-toolbar.canvas-toolbar--zoom', { role: 'toolbar', 'aria-label': 'Zoom' },
      h('button.canvas-tool', { type: 'button', 'aria-label': 'Zoom out (−)', title: 'Zoom out (−)', text: '−', on: { click: () => this.zoomBy(1 / ZOOM_STEP) } }),
      h('button.canvas-tool.canvas-zoom-value', { type: 'button', title: 'Reset to 100%', on: { click: () => this.zoomBy(1 / this.viewport.zoom) } }, this.zoomValue),
      h('button.canvas-tool', { type: 'button', 'aria-label': 'Zoom in (+)', title: 'Zoom in (+)', text: '+', on: { click: () => this.zoomBy(ZOOM_STEP) } }),
      h('button.canvas-tool', { type: 'button', title: 'Show everything (0)', text: 'Fit', on: { click: () => this.showEverything() } }),
      this.mapBtn, this.helpBtn);

    this.hintEl = h('div.canvas-hint', { role: 'status' });
    this.jumpBtn = h('button.canvas-jump', {
      type: 'button', title: 'Bring your question box back into view (Enter)', text: 'Back to your question',
      on: { click: () => { this.refollow(); this.focusDraftInput(); } }
    });
    this.barSlot = h('div.canvas-bar-slot');
    this.bottom = h('div.canvas-bottom', this.hintEl, this.jumpBtn, this.barSlot);
    this.helpSlot = h('div.canvas-help-slot');
    this.srStatus = h('div.sr-only', { role: 'status', 'aria-live': 'polite' });

    this.root = h('div.canvas-view', this.surface, this.rail.el, this.titleBar, this.zoomBar, this.bottom, this.helpSlot, this.srStatus);
    host.replaceChildren(this.root);
  }

  /* ================= Lifecycle ================= */

  setActive(active) {
    this.active = active;
    if (!active) {
      this.popups.close();
      this.popups.closeBar();
      this.spaceHeld = false;
    } else {
      this.measureSurface();
      this.schedule();
    }
  }

  destroy() {
    this.unsubscribe();
    this.motion.cancel();
    this.popups.destroy();
    this.resizeObserver?.disconnect();
    for (const [target, type, fn, opts] of this.globalListeners) target.removeEventListener(type, fn, opts);
    cancelAnimationFrame(this.edgeFrame);
  }

  handleStoreChange(change) {
    if (change.replaced) {
      this.gesture = null;
      this.draft = null;
      this.placing = null;
      this.noteDraft = null;
      this.editingNoteId = this.editingFrameId = this.editingLinkId = this.editingCardId = null;
      this.selected = new Set();
      this.currentId = null;
      this.viewBack = [];
      this.viewForward = [];
      this.tool = this.store.cards.length === 0 ? 'answer' : 'select';
      this.follow = true;
      this.followKey = '';
      this.pins = new Map();
      this.titleInput.value = this.store.title;
      this.popups.close();
      this.popups.closeBar();
    }
    if (change.meta && document.activeElement !== this.titleInput) this.titleInput.value = this.store.title;
    if (change.viewport) {
      this.paintViewport(this.store.viewport);
      this.world.style.setProperty('--canvas-zoom', String(this.store.viewport.zoom));
      this.surface.toggleAttribute('data-far', this.store.viewport.zoom < FAR_ZOOM);
    }
    if (change.layout || change.replaced) {
      // Undo, a cascade or a canvas load can take away what was selected.
      const known = new Set([...this.store.cards.map((c) => c.id), ...this.store.frames.map((f) => f.id), ...this.store.links.map((l) => l.id)]);
      const kept = [...this.selected].filter((id) => known.has(id));
      if (kept.length !== this.selected.size) this.selected = new Set(kept);
    }
    this.schedule();
  }

  /* ================= Viewport ================= */

  paintViewport(next) {
    this.viewport = next;
    const { x, y, zoom } = next;
    const grid = gridSpacing(zoom);
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.surface.style.backgroundSize = `${grid}px ${grid}px`;
    this.surface.style.backgroundPosition = `${x}px ${y}px`;
    this.zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    if (this.minimapOpen) this.minimap.paint(next);
  }

  /** Eases to a viewport; panning and wheel zoom go through `motion` instead. */
  glideTo(next) {
    this.motion.settle();
    this.world.classList.add('is-animating');
    this.surface.classList.add('is-animating');
    this.store.setViewport(next);
    clearTimeout(this.animationTimer);
    this.animationTimer = setTimeout(() => {
      this.world.classList.remove('is-animating');
      this.surface.classList.remove('is-animating');
      this.schedule();
    }, VIEWPORT_TRANSITION_MS);
  }

  measureSurface() {
    const box = this.surface.getBoundingClientRect();
    if (box.width === this.surfaceBox.width && box.height === this.surfaceBox.height) return;
    this.surfaceBox = { width: box.width, height: box.height };
    this.schedule();
  }

  surfaceSize() {
    const box = this.surface.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }

  pointerOnSurface(e) {
    const box = this.surface.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  pointerInWorld(e) {
    return screenToWorld(this.viewport, this.pointerOnSurface(e));
  }

  unfollow() {
    this.follow = false;
  }

  /* ================= Notices ================= */

  showNotice(text, undoable = false) {
    this.notice = { text, undoable };
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice = null; this.schedule(); }, NOTICE_MS);
    this.schedule();
  }

  /* ================= Selection ================= */

  select(ids) {
    this.selected = new Set(ids);
    // However a card came to be chosen, by key, outline or marquee, it should be visible.
    this.store.raiseCards(this.selected);
    this.schedule();
  }

  /* ================= Events ================= */

  bindEvents() {
    const s = this.surface;
    s.addEventListener('pointerdown', (e) => this.handleSizingPress(e), true);
    s.addEventListener('pointerdown', (e) => this.handleSurfaceDown(e));
    s.addEventListener('mousedown', (e) => this.handleSurfaceMouseDown(e));
    s.addEventListener('pointermove', (e) => this.handleSurfaceMove(e));
    s.addEventListener('pointerup', (e) => this.handleSurfaceUp(e));
    s.addEventListener('pointercancel', () => { this.rightDrag.onCancel(); this.setGesture(null); });
    s.addEventListener('contextmenu', (e) => this.rightDrag.onContextMenuCapture(e), true);
    s.addEventListener('contextmenu', (e) => this.openPlaneMenu(e));
    s.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
    // Focus scrolls the nearest clipped ancestor, but only the viewport may move the plane.
    s.addEventListener('scroll', () => {
      if (s.scrollTop !== 0) s.scrollTop = 0;
      if (s.scrollLeft !== 0) s.scrollLeft = 0;
    });
    // A card body scrolling moves the terms its links start from.
    s.addEventListener('scroll', (e) => { if (e.target !== s) this.scheduleLinks(); }, true);
    s.addEventListener('focusin', (e) => this.handleFocusIn(e));
    this.resizeObserver = new ResizeObserver(() => this.measureSurface());
    this.resizeObserver.observe(s);

    const listen = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.globalListeners.push([target, type, fn, opts]);
    };
    this.globalListeners = [];
    listen(window, 'keydown', (e) => { if (this.active) this.handleKeyDown(e); });
    listen(window, 'keyup', (e) => {
      if (!this.active) return;
      if (e.key === ' ' && this.spaceHeld) { this.spaceHeld = false; this.schedule(); }
      if (e.key === 'Shift' || e.shiftKey) this.refreshSelectionBar();
    });
    listen(window, 'paste', (e) => this.handlePaste(e));
    listen(document, 'mouseup', (e) => {
      if (!this.active || e.button !== 0 || this.popups.isPopup(e.target)) return;
      setTimeout(() => this.refreshSelectionBar(), 0);
    });
    listen(document, 'selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) this.popups.closeBar();
    });
  }

  handleFocusIn(e) {
    const target = e.target;
    const cardEl = target.closest?.('[data-canvas-card]');
    if (!cardEl) return;
    const card = this.store.cards.find((item) => item.id === cardEl.dataset.canvasCard);
    if (!card) return;
    this.currentId = card.id;
    if (!target.matches(':focus-visible')) return;
    // Tabbing to a card off screen brings it on screen; a click lands where it already is.
    this.follow = false;
    if (target === cardEl && !this.selected.has(card.id)) this.select([card.id]);
    this.revealOnScreen(card.rect);
  }

  handlePaste(e) {
    if (!this.active || isTyping(e.target)) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text.trim() === '') return;
    e.preventDefault();
    // Pasting what was just copied from here means the cards themselves.
    if (this.lastCopy?.text === text) this.handleDuplicate(this.lastCopy.ids);
    else this.pasteAsNote(text);
  }

  handleWheel(e) {
    const held = this.wheelLatch && e.timeStamp - this.wheelLatch.at < WHEEL_LATCH_MS ? this.wheelLatch.target : null;
    const { deltaX, deltaY } = wheelPanDelta(e);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.follow = false;
      this.wheelLatch = { target: 'plane', at: e.timeStamp };
      const box = this.surface.getBoundingClientRect();
      const anchor = { x: e.clientX - box.left, y: e.clientY - box.top };
      const factor = wheelZoomFactor(deltaY);
      this.motion.steer((view) => zoomAt(view, anchor, view.zoom * factor));
      return;
    }
    if (held instanceof Element) {
      // A card scrolled to its end stops there rather than dragging the plane after it.
      this.wheelLatch = { target: held, at: e.timeStamp };
      if (!canScrollBy(held, deltaX, deltaY)) e.preventDefault();
      return;
    }
    const body = held ? null : e.target.closest?.('.canvas-card-body, .canvas-outline-list');
    if (body && canScrollBy(body, deltaX, deltaY)) {
      this.wheelLatch = { target: body, at: e.timeStamp };
      return;
    }
    e.preventDefault();
    this.follow = false;
    this.wheelLatch = { target: 'plane', at: e.timeStamp };
    this.motion.steer((view) => ({ ...view, x: view.x - deltaX, y: view.y - deltaY }));
  }

  /* ================= Gestures ================= */

  setGesture(gesture) {
    const wasEdge = this.edgePanning();
    this.gesture = gesture;
    if (!wasEdge && this.edgePanning()) this.startEdgePan();
    this.schedule();
  }

  edgePanning() {
    return this.gesture !== null && this.gesture.type !== 'pan' && this.gesture.type !== 'frameResize';
  }

  /** Something dragged near the edge of the view pans the view towards it. */
  startEdgePan() {
    let moved = false;
    const speed = (near, far) => {
      if (near < EDGE_BAND_PX) return EDGE_SPEED_PX * (1 - Math.max(near, 0) / EDGE_BAND_PX);
      if (far < EDGE_BAND_PX) return -EDGE_SPEED_PX * (1 - Math.max(far, 0) / EDGE_BAND_PX);
      return 0;
    };
    const step = () => {
      if (!this.edgePanning()) return;
      this.edgeFrame = requestAnimationFrame(step);
      const box = this.surface.getBoundingClientRect();
      const at = this.lastPointer;
      const press = this.press;
      if (!at || !press) return;
      moved ||= Math.hypot(at.clientX - press.clientX, at.clientY - press.clientY) >= EDGE_MOVED_PX;
      if (!moved) return;
      const dx = speed(at.clientX - box.left, box.right - at.clientX);
      const dy = speed(at.clientY - box.top, box.bottom - at.clientY);
      if (dx === 0 && dy === 0) return;
      this.follow = false;
      this.motion.steer((view) => ({ ...view, x: view.x + dx, y: view.y + dy }), true);
      const world = this.pointerInWorld(at);
      const g = this.gesture;
      if (g.type === 'draw' || g.type === 'marquee') this.gesture = { ...g, end: world };
      else this.gesture = { ...g, pointer: world };
      this.schedule();
    };
    cancelAnimationFrame(this.edgeFrame);
    this.edgeFrame = requestAnimationFrame(step);
  }

  /*
   * A gesture owns its press from here. It cannot cancel pointerdown for that: doing so also
   * suppresses mousedown, which is how open menus and prompts notice an outside click.
   */
  claimPress(e) {
    this.claimedPress = true;
    this.press = { clientX: e.clientX, clientY: e.clientY };
    this.lastPointer = this.press;
    this.motion.settle();
    try { this.surface.setPointerCapture(e.pointerId); } catch { /* already released */ }
  }

  // Stops text selection and middle-click autoscroll, and releases focus.
  handleSurfaceMouseDown(e) {
    if (this.doublePressed) {
      // The press already opened an editor; focusing what it landed on would close it.
      this.doublePressed = false;
      e.preventDefault();
      return;
    }
    if (!this.claimedPress) return;
    this.claimedPress = false;
    e.preventDefault();
    releaseFocus(e.target);
  }

  /** Whether this press and the one before it, on the same thing, make a double click. */
  isDoublePress(key, at) {
    const last = this.lastPress;
    const double = last !== null && last.key === key && at - last.at < DOUBLE_PRESS_MS;
    this.lastPress = double ? null : { key, at };
    this.doublePressed = double;
    return double;
  }

  get drawKind() {
    return this.tool === 'answer' || this.tool === 'note' || this.tool === 'frame' ? this.tool : null;
  }

  get isDrawMode() {
    return this.drawKind !== null || this.placing !== null;
  }

  /** A press on a card that something covers brings it forward, whatever it goes on to do. */
  raisePressedCard(e) {
    if (this.tool !== 'select' || this.placing || this.spaceHeld || e.button === 1) return;
    const id = e.target.closest?.('[data-canvas-card]')?.getAttribute('data-canvas-card');
    if (id) this.store.raiseCards([id]);
  }

  /* While a dropped `+` is being sized, a press belongs to it whatever it lands on. */
  handleSizingPress(e) {
    this.raisePressedCard(e);
    const g = this.gesture;
    if (g?.type !== 'draw' || !g.unheld) return;
    if (e.button !== 0) {
      this.setGesture(null);
      return;
    }
    e.stopPropagation();
    this.claimPress(e);
    this.setGesture({ type: 'draw', what: g.what, start: g.start, end: this.pointerInWorld(e), ...(g.continues ? { continues: g.continues } : {}) });
  }

  handleSurfaceDown(e) {
    this.rightDrag.onPress(e);
    const target = e.target;
    const startPan = e.button === 1 || (e.button === 0 && (this.spaceHeld || this.tool === 'hand'));
    if (startPan) {
      window.getSelection()?.removeAllRanges();
      this.claimPress(e);
      this.unfollow();
      this.setGesture({ type: 'pan', pointer: this.pointerOnSurface(e), origin: this.viewport });
      return;
    }
    if (e.button !== 0) return;
    if (target.closest('.canvas-toolbar, .canvas-rail, .canvas-bottom, .canvas-minimap, .canvas-outline, .canvas-shortcuts')) return;
    if (this.isDrawMode) {
      const start = this.pointerInWorld(e);
      this.claimPress(e);
      this.setGesture({ type: 'draw', what: this.placing ? 'answer' : this.drawKind, start, end: start });
      return;
    }
    if (this.tool === 'connect') {
      const start = this.pointerInWorld(e);
      const from = cardAtPoint(this.store.cards, start, this.store.stack);
      if (!from) {
        this.showNotice(NO_CARD_TO_CONNECT);
        return;
      }
      this.claimPress(e);
      this.setGesture({ type: 'connect', from: from.id, pointer: start });
      return;
    }
    // Links, labels, cards and frame titles each deal with their own press.
    if (target.closest('.canvas-link-hit, .canvas-connector-label, .canvas-card, .canvas-frame-title, .canvas-frame-resize')) return;
    const start = this.pointerInWorld(e);
    window.getSelection()?.removeAllRanges();
    if (this.isDoublePress('plane', e.timeStamp)) {
      this.askAt(start);
      return;
    }
    this.claimPress(e);
    this.setGesture({ type: 'marquee', start, end: start, base: e.shiftKey || e.ctrlKey || e.metaKey ? this.selected : new Set() });
  }

  moveGesture(at) {
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pan') {
      const pointer = this.pointerOnSurface(at);
      const next = { ...g.origin, x: g.origin.x + pointer.x - g.pointer.x, y: g.origin.y + pointer.y - g.pointer.y };
      this.motion.steer(() => next, true);
    } else if (g.type === 'draw' || g.type === 'marquee') {
      this.gesture = { ...g, end: this.pointerInWorld(at) };
      this.schedule();
    } else {
      this.gesture = { ...g, pointer: this.pointerInWorld(at) };
      this.schedule();
    }
  }

  handleSurfaceMove(e) {
    this.lastPointer = { clientX: e.clientX, clientY: e.clientY };
    const rightPress = this.rightDrag.onMove(e);
    if (rightPress) {
      window.getSelection()?.removeAllRanges();
      this.motion.settle();
      try { this.surface.setPointerCapture(rightPress.pointerId); } catch { /* gone */ }
      this.unfollow();
      this.setGesture({ type: 'pan', pointer: this.pointerOnSurface(rightPress), origin: this.viewport });
      return;
    }
    if (this.gesture) {
      this.moveGesture(e);
    } else if (this.tool === 'connect') {
      const id = cardAtPoint(this.store.cards, this.pointerInWorld(e), this.store.stack)?.id ?? null;
      if (id !== this.hoverCardId) {
        this.hoverCardId = id;
        this.schedule();
      }
    }
  }

  handleSurfaceUp(e) {
    this.rightDrag.onRelease(e);
    this.claimedPress = false;
    const g = this.gesture;
    if (!g || (g.type === 'draw' && g.unheld)) return;
    const d = this.derive();
    this.gesture = null;
    this.schedule();
    if (g.type === 'draw') {
      this.finishDraw(g.what, g.start, g.end, g.continues);
    } else if (g.type === 'extend') {
      this.finishExtend(g, d);
    } else if (g.type === 'marquee') {
      this.select(d.marqueeSelection ?? []);
    } else if (g.type === 'connect') {
      this.finishConnect(g.from, g.pointer);
    } else if (g.type === 'draftResize') {
      if (d.resizedDraft && this.draft) this.draft = { ...this.draft, rect: d.resizedDraft.rect };
      this.focusDraftInput();
    } else if (g.type === 'frameResize') {
      if (d.resizedFrameRect) this.store.moveItems('Resize frame', [], [{ id: g.id, rect: d.resizedFrameRect }]);
    } else if (g.type === 'drag') {
      if (d.dragDelta.dx === 0 && d.dragDelta.dy === 0) {
        if (g.plainPress) {
          this.select([g.id]);
          this.focusCardElement(g.id);
        } else if (g.shiftPress) {
          const next = new Set(this.selected);
          if (!next.delete(g.id)) next.add(g.id);
          this.select(next);
        }
        return;
      }
      if (d.overDraft) {
        // Everything chosen goes along, and the cards return to where they stood.
        this.linkToDraft(this.selected.has(g.id)
          ? this.store.cards.map((card) => card.id).filter((id) => this.selected.has(id))
          : [g.id]);
        return;
      }
      if (g.shiftPress && !this.selected.has(g.id)) this.select([g.id]);
      if (!d.dragResult) return;
      const frameUpdates = this.store.frames
        .filter((frame) => g.frameIds.has(frame.id))
        .map((frame) => ({ id: frame.id, rect: { ...frame.rect, x: frame.rect.x + d.dragDelta.dx, y: frame.rect.y + d.dragDelta.dy } }));
      this.store.moveItems('Move', d.dragResult, frameUpdates);
    } else if (g.type === 'resize' && d.resizedRect) {
      if (d.resizeUpdates) this.store.moveItems('Resize', d.resizeUpdates);
    }
  }

  handleDragStart(e, id) {
    const target = e.target;
    if (e.button !== 0 || (target.closest('button, a') && !target.closest('.canvas-frame-handle'))) return;
    if (this.tool !== 'select' || this.placing || this.spaceHeld) return;
    if (this.isDoublePress(id, e.timeStamp)) {
      if (this.store.frames.some((frame) => frame.id === id)) this.editFrame(id);
      else if (this.store.cards.some((card) => card.id === id && card.kind === 'note')) this.editNote(id);
      else this.zoomToItem(id);
      return;
    }
    const start = this.pointerInWorld(e);
    const items = { cards: this.store.cards, frames: this.store.frames };
    const additive = e.ctrlKey || e.metaKey;
    const shiftPress = e.shiftKey && !additive;
    const carrying = e.altKey ? 'pulled' : e.shiftKey ? 'joined' : 'detached';
    let chosen = this.selected;
    if (additive) {
      const next = new Set(chosen);
      if (!next.delete(id)) next.add(id);
      chosen = next;
      this.select(next);
      if (!next.has(id)) return;
    } else if (!chosen.has(id)) {
      chosen = new Set([id]);
      if (!shiftPress) this.select(chosen);
    }
    const moving = movingForSelection(items, chosen, carrying);
    this.claimPress(e);
    this.currentId = id;
    this.setGesture({
      type: 'drag', id, ids: moving.cards, frameIds: moving.frames,
      group: chosen.size > 1 || moving.frames.size > 0,
      plainPress: !additive && !shiftPress, shiftPress, start, pointer: start
    });
  }

  handleResizeStart(e, id, type = 'resize') {
    if (e.button !== 0) return;
    e.stopPropagation();
    const start = this.pointerInWorld(e);
    this.claimPress(e);
    this.setGesture({ type, id, start, pointer: start });
  }

  handleContinueStart(e, id, side) {
    // Other tools and panning treat a press here like one anywhere else.
    if (e.button !== 0 || this.tool !== 'select' || this.placing || this.spaceHeld) return;
    const start = this.pointerInWorld(e);
    this.claimPress(e);
    this.currentId = id;
    this.setGesture({ type: 'extend', from: id, side, start, pointer: start });
  }

  /** A `+` let go: a click continues on its side, a drag places the next message there. */
  finishExtend(extend, d) {
    const travel = Math.hypot(extend.pointer.x - extend.start.x, extend.pointer.y - extend.start.y);
    if (travel * this.viewport.zoom < DRAG_START_PX) {
      this.continueCard(extend.from, [extend.side]);
    } else if (d.overDraft) {
      this.linkToDraft([extend.from]);
    } else {
      this.setGesture({ type: 'draw', what: 'answer', start: extend.pointer, end: extend.pointer, continues: extend.from, unheld: true });
    }
  }

  finishConnect(from, at) {
    const target = cardAtPoint(this.store.cards, at, this.store.stack);
    if (!target || target.id === from) {
      this.showNotice(CONNECT_ANOTHER);
      return;
    }
    const id = this.store.addLink(from, target.id);
    if (id === null) return;
    this.select([id]);
    this.editingLinkId = id;
    this.tool = 'select';
    this.schedule();
  }

  /* ================= Drawing ================= */

  drawnRect(what, start, end) {
    const threshold = SNAP_SCREEN_PX / this.viewport.zoom;
    const others = cardRects(this.store.cards);
    const raw = rectFromPoints(start, end);
    const isClick = raw.w < CLICK_DRAG_LIMIT && raw.h < CLICK_DRAG_LIMIT;
    if (what === 'frame') {
      const snapped = snapEdges(isClick ? rectFromCorner(start, DEFAULT_FRAME_SIZE) : raw, others, threshold);
      const tooSmall = snapped.rect.w < MIN_FRAME_SIZE.w || snapped.rect.h < MIN_FRAME_SIZE.h;
      return { ...snapped, refusal: tooSmall ? REFUSE_TOO_SMALL : null };
    }
    const min = this.placing ? MIN_EXPANSION_SIZE : what === 'note' ? MIN_NOTE_SIZE : MIN_MESSAGE_SIZE;
    const clickSize = this.placing ? DEFAULT_EXPANSION_SIZE : what === 'note' ? DEFAULT_NOTE_SIZE : DEFAULT_MESSAGE_SIZE;
    const snapped = snapEdges(isClick ? rectFromCorner(start, clickSize) : raw, others, threshold);
    const tooSmall = snapped.rect.w < min.w || snapped.rect.h < min.h;
    return { ...snapped, refusal: tooSmall ? REFUSE_TOO_SMALL : null };
  }

  finishDraw(what, start, end, continues) {
    const outcome = this.drawnRect(what, start, end);
    if (outcome.refusal) {
      this.showNotice(outcome.refusal);
      return;
    }
    if (what === 'frame') {
      const id = this.store.addFrame(outcome.rect, '');
      this.select([id]);
      this.editingFrameId = id;
      this.tool = 'select';
      this.schedule();
      return;
    }
    if (what === 'note') {
      this.noteDraft = { key: ++this.draftKey, rect: outcome.rect };
      this.tool = 'select';
      this.schedule();
      return;
    }
    if (this.placing) {
      const placing = this.placing;
      this.placing = null;
      this.tool = 'select';
      const result = this.store.expand(placing.turnId, placing.target, placing.prompt, { hostId: placing.hostId, rect: outcome.rect });
      if (!result.ok) this.showNotice(result.reason === 'turn-not-found' || result.reason === 'out-of-bounds'
        ? 'That selection is no longer available. Select it again.'
        : refusalMessage(result.reason));
      else this.currentId = result.id;
      this.schedule();
      return;
    }
    const touching = continuationCandidates(outcome.rect, this.store.cards).map((card) => card.id);
    const sessions = continues ? [continues, ...touching.filter((id) => id !== continues)] : touching;
    this.openDraft({ rect: outcome.rect, ...(sessions.length > 0 ? { parentId: sessions[0] } : {}), sessions });
  }

  /* ================= Expansions: choose a term, then draw its size ================= */

  sourceFor(turn, frameId) {
    if (frameId === null) return { source: turn.content, siblings: turn.expansions };
    const parent = findExpansionInNodes(turn.expansions, frameId);
    if (!parent) return null;
    return { source: parent.node.answer, siblings: parent.node.children, parentExpansionId: parent.node.id, parent: parent.node };
  }

  /** A selection inside a card's text, with what it would expand. */
  readSelection(range) {
    if (!range) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || sel.toString().trim() === '') return null;
      range = sel.getRangeAt(0);
    }
    const container = range.commonAncestorContainer;
    const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const body = element?.closest('.canvas-card-body[data-turn-id]');
    if (!body || !this.world.contains(body)) return null;
    const turnId = Number(body.dataset.turnId);
    const turn = this.store.turns.find((item) => item.id === turnId);
    if (!turn) return null;
    const card = this.store.cards.find((item) => item.id === body.closest('[data-canvas-card]')?.dataset.canvasCard);
    if (!card) return null;
    const content = cardContent(card, this.store.turns, this.store.streamingTurnIds);
    if (content.status === 'streaming') return { range, turnId, resolved: { ok: false, reason: 'streaming' } };
    if (content.status === 'failed') return { range, turnId, resolved: { ok: false, reason: 'not-anchored' } };
    const anchors = MD.anchorsFromRange(range);
    if (!anchors) return { range, turnId, resolved: { ok: false, reason: 'not-anchored' } };
    const scope = this.sourceFor(turn, anchors.frameId);
    if (!scope) return { range, turnId, resolved: { ok: false, reason: 'parent-not-found' } };
    if (scope.parent && scope.parent.status === 'loading') return { range, turnId, resolved: { ok: false, reason: 'streaming' } };
    const anchored = MD.anchoredRange(scope.source, { start: anchors.start, end: anchors.end });
    if (!anchored) return { range, turnId, resolved: { ok: false, reason: 'not-anchored' } };
    const target = {
      start: anchored.start,
      end: anchored.end,
      selection: scope.source.slice(anchored.start, anchored.end),
      ...(anchored.kind === 'atom' ? { atomic: true } : {}),
      ...(scope.parentExpansionId !== undefined ? { parentExpansionId: scope.parentExpansionId } : {})
    };
    const refusal = validateExpansionTarget(scope.source, scope.siblings, target);
    if (refusal) return { range, turnId, resolved: { ok: false, reason: refusal } };
    return { range, turnId, resolved: { ok: true, target } };
  }

  beginPlacing(turnId, target, prompt) {
    const host = this.store.cards.find((card) => (target.parentExpansionId !== undefined
      ? card.kind === 'expansion' && card.expansionId === target.parentExpansionId
      : (card.kind === 'message' || card.kind === 'page') && card.turnId === turnId));
    if (!host) {
      this.showNotice(refusalMessage('turn-not-found'));
      return;
    }
    window.getSelection()?.removeAllRanges();
    this.popups.closeBar();
    this.draft = null;
    this.placing = { turnId, target, ...(prompt !== undefined ? { prompt } : {}), hostId: host.id, label: flattenMarkdown(target.selection || '').slice(0, 40) };
    this.schedule();
  }

  refreshSelectionBar() {
    if (!this.active || this.popups.open || this.gesture) return;
    const live = this.readSelection();
    if (!live || !live.resolved.ok) {
      this.popups.closeBar();
      return;
    }
    const { turnId, range } = live;
    const target = live.resolved.target;
    this.popups.showBar(range, (prompt) => this.beginPlacing(turnId, target, prompt));
  }

  /** Ctrl+E places an expansion of the selection; with Shift it asks first. Returns whether it acted. */
  handleExpandShortcut(prompted) {
    if (!this.active) return false;
    const live = this.readSelection();
    if (!live) return false;
    if (!live.resolved.ok) {
      this.showNotice(refusalMessage(live.resolved.reason));
      return true;
    }
    const { turnId, range } = live;
    const target = live.resolved.target;
    if (prompted) {
      const rect = range.getBoundingClientRect();
      this.popups.prompt({ x: rect.left, y: rect.bottom + 6 }, { onSubmit: (prompt) => this.beginPlacing(turnId, target, prompt) });
    } else {
      this.beginPlacing(turnId, target);
    }
    return true;
  }

  /** The right-click menu inside a card's text: expand the selection or the word under the pointer. */
  handleBodyMenu(e, bodyEl) {
    e.preventDefault();
    e.stopPropagation();
    this.popups.closeBar();
    const at = { x: e.clientX, y: e.clientY };
    const selection = window.getSelection();
    let copied = selection ? selection.toString() : '';
    let live = null;
    if (copied.trim() && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(e.target)) {
      live = this.readSelection(selection.getRangeAt(0));
    } else {
      const word = wordRangeAtPoint(e.clientX, e.clientY);
      if (word && bodyEl.contains(word.startContainer)) {
        live = this.readSelection(word);
        if (live) {
          selection.removeAllRanges();
          selection.addRange(word);
          copied = word.toString();
        }
      }
    }
    const resolved = live ? live.resolved : { ok: false, reason: 'blank-selection' };
    const target = resolved.ok ? resolved.target : null;
    const turnId = live?.turnId;
    const selectAll = () => {
      const range = document.createRange();
      range.selectNodeContents(bodyEl.querySelector('.message-content') || bodyEl);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const cardId = bodyEl.closest('[data-canvas-card]')?.dataset.canvasCard;
    this.popups.menu(at, [
      { label: 'Expand', shortcut: 'Ctrl+E', disabled: !target, onSelect: () => this.beginPlacing(turnId, target) },
      { label: 'Expand on…', disabled: !target, onSelect: () => this.popups.prompt(at, { onSubmit: (prompt) => this.beginPlacing(turnId, target, prompt) }) },
      resolved.ok || !live ? null : { hint: refusalMessage(resolved.reason) },
      'separator',
      { label: 'Copy', disabled: !copied.trim(), onSelect: () => MD.copyToClipboard(copied) },
      { label: 'Select All', onSelect: selectAll },
      cardId ? 'separator' : null,
      cardId ? { label: 'Card…', onSelect: () => this.openCardMenuAt(at, cardId) } : null
    ], 'Text actions');
  }

  /* ================= Card actions ================= */

  /** Deletes, asking only about cards it would take along that were not chosen. */
  deleteItems(ids) {
    if (ids.size === 0) return;
    const all = this.store.cards;
    const takenAlong = new Set();
    for (const id of ids) {
      if (all.some((card) => card.id === id)) {
        for (const dependent of cascadeCardIds(all, id)) if (!ids.has(dependent)) takenAlong.add(dependent);
      }
    }
    const confirmed = takenAlong.size === 0 || confirmCascade(`Delete this and ${dependentsPhrase(takenAlong.size)}?`, takenAlong.size, true);
    if (!confirmed) return;
    this.store.removeItems(ids);
    this.select([]);
    this.showNotice(deletedNotice(ids.size + takenAlong.size), true);
  }

  handleDelete(id) {
    this.deleteItems(this.selected.has(id) ? this.selected : new Set([id]));
  }

  confirmReplacing(id) {
    const dependents = cascadeCardIds(this.store.cards, id).size - 1;
    if (dependents === 0) return true;
    return confirmCascade(`This replaces the answer and removes ${dependentsPhrase(dependents)}. Continue?`, dependents, false);
  }

  handleRegenerate(id) {
    if (!this.confirmReplacing(id)) return;
    // The rectangle decides the answer's length, so it needs its real height back.
    this.store.setCollapsed(new Set([id]), false);
    this.store.regenerateCard(id);
  }

  handleEdit(id, question) {
    if (!this.confirmReplacing(id)) return false;
    this.store.editCard(id, question);
    return true;
  }

  handleUndo(direction) {
    const result = direction === 'undo' ? this.store.undo() : this.store.redo();
    if (result && !result.ok) this.showNotice(result.reason);
  }

  handleCollapse(ids) {
    const chosen = this.store.cards.filter((card) => ids.has(card.id) && card.kind !== 'note');
    const allCollapsed = chosen.every((card) => card.collapsedFrom !== undefined);
    this.store.setCollapsed(ids, !allCollapsed);
  }

  applyArrangement(label, result) {
    if (result.ok) this.store.moveItems(label, result.cards, result.frames);
    else this.showNotice(REFUSE_ARRANGE);
  }

  applyTidy(result) {
    if (result.ok) this.store.moveItems('Tidy up', result.cards, result.frames);
    else this.showNotice(ALREADY_TIDY);
  }

  handleDuplicate(ids) {
    const copies = this.store.duplicate(ids);
    if (copies.length > 0) this.select(copies);
    else this.showNotice('Nothing here can be copied yet.');
  }

  handleCopy(ids) {
    const items = { cards: this.store.cards, frames: this.store.frames };
    const covered = new Set(selectedCards(items, ids).map((card) => card.id));
    const text = selectionMarkdown(items.cards, this.store.turns, covered);
    if (text === '') return;
    this.lastCopy = { text, ids };
    navigator.clipboard.writeText(text).then(
      () => this.showNotice('Copied as markdown.'),
      () => this.showNotice('The clipboard is not available.')
    );
  }

  copyAnswer(id, text) {
    MD.copyToClipboard(text).then(() => {
      this.copiedCardId = id;
      this.schedule();
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => { this.copiedCardId = null; this.schedule(); }, COPIED_MS);
    });
  }

  /** A frame around the selection, with its title ready to type. */
  frameSelection(ids) {
    const bounds = boundsOf([...this.store.cards, ...this.store.frames].filter((item) => ids.has(item.id)).map((item) => item.rect));
    if (!bounds) return;
    const id = this.store.addFrame({ x: bounds.x - FRAME_PADDING, y: bounds.y - FRAME_PADDING, w: bounds.w + FRAME_PADDING * 2, h: bounds.h + FRAME_PADDING * 2 }, '');
    this.select([id]);
    this.editingFrameId = id;
    this.schedule();
  }

  exportCanvas() {
    if (this.store.cards.length === 0) return;
    const record = this.store.snapshot();
    downloadText(exportFileName(record), renderConversationMarkdown(record));
  }

  editNote(id) { this.editingNoteId = id; this.schedule(); }
  editFrame(id) { this.editingFrameId = id; this.schedule(); }

  /* ================= Moving between cards ================= */

  /** The part of the surface a jump should land in: not behind the outline. */
  openArea() {
    const { width, height } = this.surfaceSize();
    const left = this.outlineOpen ? OUTLINE_WIDTH : 0;
    return { left, width: width - left, height };
  }

  /** The smallest glide that brings a rectangle on screen; none when it already is. */
  revealOnScreen(rect) {
    const { left, width, height } = this.openArea();
    const view = this.viewport;
    const moved = revealRect({ ...view, x: view.x - left }, rect, { width, height });
    const next = { ...moved, x: moved.x + left };
    if (next.x !== view.x || next.y !== view.y) this.glideTo(next);
  }

  /** Remembers where the view is, before a jump, for Alt+Left. */
  rememberView() {
    this.viewBack = [...this.viewBack, this.viewport].slice(-VIEW_HISTORY_LIMIT);
    this.viewForward = [];
  }

  travelViewHistory(direction) {
    const [from, to] = direction === 'back' ? ['viewBack', 'viewForward'] : ['viewForward', 'viewBack'];
    const next = this[from].at(-1);
    if (!next) return;
    this[from] = this[from].slice(0, -1);
    this[to] = [...this[to], this.viewport];
    this.follow = false;
    this.glideTo(next);
  }

  /** Flashes a card, or one expanded term inside it. */
  flash(cardId, expansionId) {
    this.pulseId = expansionId === undefined ? cardId : null;
    this.pulseTerm = expansionId === undefined ? null : { cardId, expansionId };
    clearTimeout(this.pulseTimer);
    this.pulseTimer = setTimeout(() => { this.pulseId = null; this.pulseTerm = null; this.schedule(); }, PULSE_MS);
    this.schedule();
  }

  focusCardElement(id) {
    this.surface.querySelector(`[data-canvas-card="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }

  /** Every keyboard and link jump lands here: the card gets focus and comes on screen. */
  focusCard(id, pulse = false, extend = false) {
    const card = this.store.cards.find((item) => item.id === id);
    if (!card) return;
    this.unfollow();
    this.currentId = id;
    this.select(extend ? [...this.selected, id] : [id]);
    this.revealOnScreen(card.rect);
    this.focusCardElement(id);
    if (pulse) this.flash(id);
  }

  /** Brings all of a card on screen, zooming out only when it would not fit otherwise. */
  revealWholeCard(rect, focus) {
    const { left, width, height } = this.openArea();
    const { zoom } = this.viewport;
    if (zoom >= FAR_ZOOM && fitsOnScreen(rect, zoom, { width, height })) {
      this.revealOnScreen(rect);
      return;
    }
    const fit = fitViewport([rect], { width, height });
    this.glideTo(fit.zoom >= FAR_ZOOM
      ? { ...fit, x: fit.x + left }
      : { x: left + width / 2 - focus.x * FAR_ZOOM, y: height / 2 - focus.y * FAR_ZOOM, zoom: FAR_ZOOM });
  }

  /** From an expansion back to the card its term is in: all of it, with the term flashed. */
  returnToTerm(id) {
    const card = this.store.cards.find((item) => item.id === id);
    if (card?.kind !== 'expansion') return;
    const host = this.store.cards.find((item) => item.id === card.hostId);
    const hostEl = this.surface.querySelector(`[data-canvas-card="${CSS.escape(card.hostId)}"] .canvas-card-surface`);
    const term = hostEl?.querySelector(`[data-canvas-terms~="${card.expansionId}"]`);
    if (!host || !hostEl || !term) {
      this.focusCard(card.hostId, true);
      return;
    }
    this.unfollow();
    const scale = hostEl.getBoundingClientRect().width / host.rect.w;
    scrollIntoBody(term, scale);
    const hostBox = hostEl.getBoundingClientRect();
    const point = termPoint(term);
    term.focus({ preventScroll: true });
    this.revealWholeCard(host.rect, { x: host.rect.x + (point.x - hostBox.left) / scale, y: host.rect.y + (point.y - hostBox.top) / scale });
    this.currentId = host.id;
    this.flash(host.id, card.expansionId);
  }

  goToSource(id) {
    const card = this.store.cards.find((item) => item.id === id);
    if (!card) return;
    this.rememberView();
    if (card.kind === 'expansion') {
      this.returnToTerm(id);
      return;
    }
    const source = sourceCardId(card);
    if (source !== undefined) this.focusCard(source, true);
  }

  openExpansion(expansionId) {
    const card = this.store.cards.find((item) => item.kind === 'expansion' && item.expansionId === expansionId);
    if (!card) return;
    this.rememberView();
    this.focusCard(card.id, true);
  }

  /** A link click travels to whichever end is farther from where it was clicked. */
  followLink(e, id, start) {
    const card = this.store.cards.find((item) => item.id === id);
    if (!card) return;
    const at = this.pointerInWorld(e);
    const onCard = clampPointInside(at, card.rect);
    const toCard = Math.hypot(at.x - onCard.x, at.y - onCard.y);
    const toStart = Math.hypot(at.x - start.x, at.y - start.y);
    if (toStart < toCard) {
      this.rememberView();
      this.focusCard(id, true);
    } else this.goToSource(id);
  }

  followRelation(e, from, to) {
    const all = this.store.cards;
    const start = all.find((card) => card.id === from);
    const end = all.find((card) => card.id === to);
    if (!start || !end) return;
    const at = this.pointerInWorld(e);
    const distance = (rect) => {
      const edge = clampPointInside(at, rect);
      return Math.hypot(at.x - edge.x, at.y - edge.y);
    };
    this.rememberView();
    this.focusCard(distance(start.rect) > distance(end.rect) ? from : to, true);
  }

  zoomToRects(rects) {
    if (rects.length === 0) return;
    this.unfollow();
    this.rememberView();
    const { left, width, height } = this.openArea();
    const fit = fitViewport(rects, { width, height });
    this.glideTo({ ...fit, x: fit.x + left });
  }

  zoomToItem(id) {
    const item = [...this.store.cards, ...this.store.frames].find((other) => other.id === id);
    if (item) this.zoomToRects([item.rect]);
  }

  /** From the outline or search: the item is selected and brought somewhere it can be read. */
  goToItem(id) {
    const frame = this.store.frames.find((item) => item.id === id);
    if (frame) {
      this.select([id]);
      this.zoomToRects([frame.rect]);
      this.flash(id);
      return;
    }
    const card = this.store.cards.find((item) => item.id === id);
    if (!card) return;
    this.rememberView();
    if (this.viewport.zoom < FAR_ZOOM) {
      // Too far out to read it, so the jump also comes in close enough.
      const { left, width, height } = this.openArea();
      const fit = fitViewport([card.rect], { width, height });
      const zoom = Math.max(Math.min(READING_ZOOM, fit.zoom), FAR_ZOOM);
      const center = { x: card.rect.x + card.rect.w / 2, y: card.rect.y + card.rect.h / 2 };
      const close = { x: left + width / 2 - center.x * zoom, y: height / 2 - center.y * zoom, zoom };
      this.unfollow();
      this.glideTo(close);
    }
    this.focusCard(id, true);
  }

  /* ================= The composer: drafts, and the conversation they follow ================= */

  openDraft(next) {
    this.follow = true;
    this.followKey = '';
    this.placing = null;
    this.tool = 'select';
    this.draft = { ...next, key: ++this.draftKey };
    this.schedule();
  }

  /** A draft against the first free side of `sides`, sized like the card it continues. */
  continueCard(id, sides) {
    const cards = this.store.cards;
    const card = cards.find((item) => item.id === id);
    if (!card) return;
    if (card.kind === 'note') {
      // A note holds no session to continue, so the next card is about it instead.
      const size = DEFAULT_MESSAGE_SIZE;
      const side = sides.find((item) => adjacentSlot(card, item, cards, size)) ?? sides[0];
      this.openDraft({ rect: rectAgainst(card.rect, side, size), sessions: [], sourceIds: [id] });
      return;
    }
    if (cardContent(card, this.store.turns, this.store.streamingTurnIds).status === 'failed') {
      this.showNotice(NO_CONTINUE_FAILED);
      return;
    }
    // A page is long; what follows it is a message of the usual size.
    const full = card.kind === 'page' ? DEFAULT_MESSAGE_SIZE : openCardSize(card);
    const side = sides.find((item) => adjacentSlot(card, item, cards, full) !== null) ?? sides[0];
    this.currentId = id;
    this.openDraft({ rect: { ...card.rect, ...full }, parentId: id, side, sessions: [id] });
  }

  /** A question about what is selected: a single answer simply continues; anything else goes along as text. */
  askAboutSelection() {
    const all = this.store.cards;
    const chosen = selectedCards({ cards: all, frames: this.store.frames }, this.selected);
    const only = chosen.length === 1 ? chosen[0] : undefined;
    if (only && only.kind !== 'note') {
      this.continueCard(only.id, ['bottom', 'right']);
      return;
    }
    const bounds = boundsOf(chosen.map((card) => card.rect));
    if (!bounds) return;
    const rect = rectClearOf({ x: bounds.x + bounds.w + NEW_SESSION_GAP, y: bounds.y, ...DEFAULT_MESSAGE_SIZE }, cardRects(all), NEW_SESSION_GAP / 2);
    this.openDraft({ rect, sessions: [], sourceIds: chosen.map((card) => card.id) });
  }

  /** A draft at a point on the plane, for a double-click or a menu. */
  askAt(point) {
    const rect = rectClearOf(rectFromCorner(point, DEFAULT_MESSAGE_SIZE), cardRects(this.store.cards), NEW_SESSION_GAP / 2);
    this.openDraft({ rect, sessions: [] });
  }

  /** A new session in open space near the middle of the screen. */
  newSession() {
    const size = this.surfaceSize();
    const center = screenToWorld(this.viewport, { x: size.width / 2, y: size.height / 2 });
    const rect = rectClearOf(rectCenteredAt(center, DEFAULT_MESSAGE_SIZE), cardRects(this.store.cards), NEW_SESSION_GAP);
    this.openDraft({ rect, sessions: [] });
  }

  pasteAsNote(text) {
    const point = this.lastPointer;
    const size = this.surfaceSize();
    const placed = point
      ? rectFromCorner(this.pointerInWorld(point), DEFAULT_NOTE_SIZE)
      : rectCenteredAt(screenToWorld(this.viewport, { x: size.width / 2, y: size.height / 2 }), DEFAULT_NOTE_SIZE);
    const rect = rectClearOf(placed, cardRects(this.store.cards), NEW_SESSION_GAP / 2);
    this.select([this.store.addNote(rect, text)]);
  }

  /** Adds cards to what the composer sends; one already in its history has nothing to add. */
  linkToDraft(ids) {
    if (!this.draft) return;
    const cards = this.store.cards;
    const context = this.draft.context ?? [];
    const history = sessionCardIds(cards, this.draft.parentId);
    if (ids.some((id) => history.includes(id))) this.showNotice(LINK_IN_HISTORY);
    const added = ids
      .filter((id) => !history.includes(id) && context.every((link) => link.from !== id))
      .map((from) => ({ from, context: cards.some((card) => card.id === from && card.kind === 'note') ? 'card' : 'branch' }));
    if (added.length > 0) this.draft = { ...this.draft, context: [...context, ...added] };
    this.schedule();
    this.focusDraftInput();
  }

  focusDraftInput() {
    setTimeout(() => this.surface.querySelector('.canvas-card--draft textarea')?.focus({ preventScroll: true }), 0);
  }

  /** Pins the view to the composer again and brings it on screen. */
  refollow() {
    this.follow = true;
    if (this.followRect) this.revealOnScreen(this.followRect);
  }

  /** Enter with no card focused: the composer if one is open, else a reply to the current card. */
  compose() {
    const input = this.surface.querySelector('[data-canvas-draft] textarea');
    if (input) {
      this.refollow();
      input.focus({ preventScroll: true });
      return;
    }
    const all = this.store.cards;
    const current = all.find((card) => card.id === this.currentId) ?? all.findLast((card) => card.kind === 'message' || card.kind === 'page');
    if (current) this.continueCard(current.id, ['bottom', 'right']);
    else this.newSession();
  }

  submitDraft(question) {
    const d = this.derive();
    if (!d.draftRect || !this.draft) return;
    const cards = this.store.cards;
    const known = new Set(cards.map((card) => card.id));
    const inHistory = sessionCardIds(cards, d.draftParent?.id);
    const id = this.store.ask(
      d.draftRect,
      question,
      d.draftParent?.id,
      this.draft.sourceIds,
      (this.draft.context || []).filter((link) => known.has(link.from) && !inHistory.includes(link.from))
    );
    this.currentId = id;
    this.draft = null;
    this.select([]);
  }

  cancelDraft() {
    const parentId = this.draft?.parentId;
    this.draft = null;
    this.schedule();
    if (parentId !== undefined) this.focusCard(parentId);
  }

  changeDraftParent(parentId, draftRect) {
    if (!this.draft || !draftRect) return;
    // Choosing another session pins the rectangle where it stands now.
    const { key, sessions, sourceIds, context } = this.draft;
    this.draft = { key, rect: draftRect, ...(parentId !== undefined ? { parentId } : {}), sessions, ...(sourceIds ? { sourceIds } : {}), ...(context ? { context } : {}) };
    this.schedule();
  }

  startDraftResize(e) {
    const d = this.derive();
    if (e.button !== 0 || !this.draft || !d.draftRect) return;
    e.stopPropagation();
    const start = this.pointerInWorld(e);
    this.claimPress(e);
    this.setGesture({ type: 'draftResize', side: d.draftParent ? this.draft.side : undefined, rect: d.draftRect, start, pointer: start });
  }

  resizeDraftBy(dw, dh) {
    const d = this.derive();
    if (!this.draft || !d.draftRect) return;
    const side = d.draftParent ? this.draft.side : undefined;
    const { rect } = resizeDraftRect(d.draftRect, side, { dw, dh }, cardRects(d.displayed), 0);
    this.draft = { ...this.draft, rect };
    this.schedule();
    this.refollow();
  }

  commitNoteDraft(text) {
    const draft = this.noteDraft;
    if (!draft) return;
    this.noteDraft = null;
    if (text.trim() !== '') this.select([this.store.addNote(draft.rect, text)]);
    else this.schedule();
  }

  /* ================= Keyboard ================= */

  chooseTool(next) {
    this.placing = null;
    this.hoverCardId = null;
    this.tool = next;
    this.schedule();
  }

  toggleMinimap() {
    this.minimapOpen = !this.minimapOpen;
    saveMinimapPreference(this.minimapOpen);
    this.schedule();
  }

  toggleHelp() {
    this.helpOpen = !this.helpOpen;
    this.schedule();
  }

  setOutline(open) {
    this.outlineOpen = open;
    if (!open) this.searchMatches = null;
    this.schedule();
  }

  openOutline() {
    this.outlineOpen = true;
    this.renderNow();
    this.outline.focus();
  }

  zoomBy(factor) {
    const { width, height } = this.surfaceSize();
    const current = this.viewport;
    this.unfollow();
    this.glideTo(zoomAt(current, { x: width / 2, y: height / 2 }, current.zoom * factor));
  }

  showEverything() {
    this.zoomToRects([...this.store.cards.map((card) => card.rect), ...this.store.frames.map((frame) => frame.rect)]);
  }

  zoomToSelection() {
    this.zoomToRects([...this.store.cards, ...this.store.frames].filter((item) => this.selected.has(item.id)).map((item) => item.rect));
  }

  selectEverything() {
    this.select([...this.store.cards.map((card) => card.id), ...this.store.frames.map((frame) => frame.id)]);
  }

  nudgeSelection(side, far) {
    const moving = movingForSelection({ cards: this.store.cards, frames: this.store.frames }, this.selected, 'detached');
    if (moving.cards.size === 0 && moving.frames.size === 0) return;
    const step = far ? NUDGE_LARGE : NUDGE;
    const dx = side === 'left' ? -step : side === 'right' ? step : 0;
    const dy = side === 'top' ? -step : side === 'bottom' ? step : 0;
    this.store.moveItems('Nudge', resolveMove(this.store.cards, moving.cards, dx, dy),
      this.store.frames.filter((frame) => moving.frames.has(frame.id)).map((frame) => ({ id: frame.id, rect: { ...frame.rect, x: frame.rect.x + dx, y: frame.rect.y + dy } })));
  }

  navigateFromMinimap(point, dragging) {
    const { width, height } = this.surfaceSize();
    const { zoom } = this.viewport;
    const next = { x: width / 2 - point.x * zoom, y: height / 2 - point.y * zoom, zoom };
    this.unfollow();
    if (dragging) this.motion.steer(() => next, true);
    else {
      this.rememberView();
      this.glideTo(next);
    }
  }

  handleCardKeyDown(e, id) {
    const side = ARROW_SIDES[e.key];
    if (side) {
      e.preventDefault();
      const next = nearestCardInDirection(this.store.cards, id, side);
      if (next) this.focusCard(next.id, false, e.shiftKey);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.continueCard(id, e.shiftKey ? ['right'] : ['bottom', 'right']);
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      this.goToSource(id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      this.handleDelete(id);
    }
  }

  /** Ctrl/Cmd keys. Returns whether the key was the canvas's to take. */
  handleModifierKey(e) {
    const key = e.key.toLowerCase();
    if (key === 'f') {
      this.openOutline();
      return true;
    }
    if (key === 'e') return this.handleExpandShortcut(e.shiftKey);
    if (isTyping(e.target)) return false;
    const side = ARROW_SIDES[e.key];
    if (key === 'z') {
      this.handleUndo(e.shiftKey ? 'redo' : 'undo');
      return true;
    }
    if (key === 'y') {
      this.handleUndo('redo');
      return true;
    }
    if (key === 'a') {
      this.selectEverything();
      return true;
    }
    if (side) {
      this.nudgeSelection(side, e.shiftKey);
      return true;
    }
    if (this.selected.size === 0) return false;
    if (key === 'd') this.handleDuplicate(this.selected);
    else if (key === 'g') this.frameSelection(this.selected);
    else if (key === 'c') {
      // Text selected inside an answer copies as text, as anywhere else.
      if (!(window.getSelection()?.isCollapsed ?? true)) return false;
      this.handleCopy(this.selected);
    } else return false;
    return true;
  }

  handleEscape() {
    if (this.gesture) { this.setGesture(null); return; }
    if (this.helpOpen) { this.helpOpen = false; this.schedule(); return; }
    if (this.placing) { this.placing = null; this.schedule(); return; }
    if (this.draft) { this.cancelDraft(); return; }
    if (this.noteDraft) { this.noteDraft = null; this.schedule(); return; }
    if (this.outlineOpen) { this.setOutline(false); return; }
    if (this.selected.size > 0) { this.select([]); return; }
    if (this.tool !== 'select') { this.chooseTool('select'); return; }
    this.options.onEscapeIdle?.();
  }

  /** Enter with nothing focused: a selected line or frame is edited, otherwise it is the composer. */
  handleEnter() {
    const only = this.selected.size === 1 ? [...this.selected][0] : undefined;
    if (only !== undefined && this.store.links.some((link) => link.id === only)) {
      this.editingLinkId = only;
      this.schedule();
    } else if (only !== undefined && this.store.frames.some((frame) => frame.id === only)) {
      this.editFrame(only);
    } else {
      this.compose();
    }
  }

  handlePlainKey(e) {
    const key = e.key.toLowerCase();
    const hasSelection = this.selected.size > 0;
    const tool = TOOL_KEYS[key];
    const side = ARROW_SIDES[e.key];
    if (e.key === ' ') {
      // Space still presses whatever button has focus.
      if (e.target.closest?.('button, [role="button"]')) return;
      e.preventDefault();
      if (!this.spaceHeld) { this.spaceHeld = true; this.schedule(); }
    } else if (e.key === '?') {
      e.preventDefault();
      this.toggleHelp();
    } else if (tool) {
      e.preventDefault();
      this.chooseTool(tool);
    } else if (key === 'o') {
      e.preventDefault();
      if (this.outlineOpen) this.setOutline(false);
      else this.openOutline();
    } else if (key === 'm') {
      this.toggleMinimap();
    } else if (key === 'z') {
      this.zoomToSelection();
    } else if (key === 'n') {
      e.preventDefault();
      this.newSession();
    } else if (key === 'a' && hasSelection) {
      e.preventDefault();
      this.askAboutSelection();
    } else if (e.key === '.' && hasSelection) {
      this.handleCollapse(this.selected);
    } else if (e.key === '+' || e.key === '=') {
      this.zoomBy(ZOOM_STEP);
    } else if (e.key === '-') {
      this.zoomBy(1 / ZOOM_STEP);
    } else if (e.key === '0') {
      this.showEverything();
    } else if (e.key === '1') {
      this.zoomBy(1 / this.viewport.zoom);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection) {
      e.preventDefault();
      this.deleteItems(this.selected);
    } else if (ownsKeys(e.target)) {
      return;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.handleEnter();
    } else if (side) {
      e.preventDefault();
      const step = e.shiftKey ? PAN_STEP_LARGE : PAN_STEP;
      const dx = side === 'left' ? step : side === 'right' ? -step : 0;
      const dy = side === 'top' ? step : side === 'bottom' ? -step : 0;
      this.unfollow();
      this.motion.steer((view) => ({ ...view, x: view.x + dx, y: view.y + dy }));
    }
  }

  handleKeyDown(e) {
    if (e.defaultPrevented) return;
    if (this.popups.open) return;
    if (e.ctrlKey || e.metaKey) {
      if (!e.altKey && this.handleModifierKey(e)) e.preventDefault();
      return;
    }
    if (e.altKey) {
      if (!isTyping(e.target) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        this.travelViewHistory(e.key === 'ArrowLeft' ? 'back' : 'forward');
      }
      return;
    }
    if (e.key === 'Escape') {
      if (isTyping(e.target) && e.target !== document.body) return;
      this.handleEscape();
      return;
    }
    if (!isTyping(e.target)) this.handlePlainKey(e);
  }

  /* ================= Menus ================= */

  openPlaneMenu(e) {
    if (e.defaultPrevented) return;
    if (e.target.closest('.canvas-card, .canvas-frame-title, .canvas-link-hit, .canvas-toolbar, .canvas-rail, .canvas-bottom, .canvas-outline, .canvas-minimap, .canvas-shortcuts')) return;
    e.preventDefault();
    const at = this.pointerInWorld(e);
    this.popups.menu({ x: e.clientX, y: e.clientY }, [
      { label: 'Ask here', shortcut: 'Double-click', onSelect: () => this.askAt(at) },
      {
        label: 'Note here', shortcut: 'T',
        onSelect: () => {
          this.noteDraft = { key: ++this.draftKey, rect: rectClearOf(rectFromCorner(at, DEFAULT_NOTE_SIZE), cardRects(this.store.cards), NEW_SESSION_GAP / 2) };
          this.schedule();
        }
      },
      { label: 'Select everything', shortcut: 'Ctrl+A', onSelect: () => this.selectEverything() },
      { label: 'Tidy up the canvas', onSelect: () => this.applyTidy(tidySelection({ cards: this.store.cards, frames: this.store.frames, links: this.store.links })) },
      { label: 'Show everything', shortcut: '0', onSelect: () => this.showEverything() }
    ], 'Canvas');
  }

  openCardMenu(e, id) {
    e.preventDefault();
    e.stopPropagation();
    this.openCardMenuAt({ x: e.clientX, y: e.clientY }, id);
  }

  openCardMenuAt(at, id) {
    const card = this.store.cards.find((item) => item.id === id);
    if (!card) return;
    const chosen = this.selected.has(id) ? this.selected : new Set([id]);
    if (chosen !== this.selected) this.select(chosen);
    this.popups.menu(at, [
      { label: 'Ask about this', shortcut: 'A', onSelect: () => this.askAboutSelection() },
      card.kind === 'page' ? null : { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: () => this.handleDuplicate(chosen) },
      { label: 'Copy as markdown', shortcut: 'Ctrl+C', onSelect: () => this.handleCopy(chosen) },
      card.kind === 'note' ? null : { label: card.collapsedFrom === undefined ? 'Collapse to title' : 'Expand', shortcut: '.', onSelect: () => this.handleCollapse(chosen) },
      { label: 'Put in a frame', shortcut: 'Ctrl+G', onSelect: () => this.frameSelection(chosen) },
      { label: 'Zoom to this', shortcut: 'Z', onSelect: () => this.zoomToItem(id) },
      { label: 'Delete', shortcut: 'Del', onSelect: () => this.deleteItems(chosen) }
    ], 'Card');
  }

  openFrameMenu(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const frame = this.store.frames.find((item) => item.id === id);
    if (!frame) return;
    const only = new Set([id]);
    this.select(only);
    this.popups.menu({ x: e.clientX, y: e.clientY }, [
      { label: 'Rename', shortcut: 'F2', onSelect: () => this.editFrame(id) },
      { label: 'Zoom to this', shortcut: 'Z', onSelect: () => this.zoomToItem(id) },
      { label: 'Select what is inside', onSelect: () => this.select(cardsInsideFrame(this.store.cards, frame).map((card) => card.id)) },
      { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: () => this.handleDuplicate(only) },
      { label: 'Remove frame, keep cards', onSelect: () => this.deleteItems(only) }
    ], 'Frame');
  }

  selectLink(e, id) {
    e.stopPropagation();
    const double = this.isDoublePress(id, e.timeStamp);
    // This is the click, so no mousedown follows for the double press to hold back.
    this.doublePressed = false;
    if (double) {
      this.editingLinkId = id;
      this.schedule();
    } else this.select([id]);
  }

  openLinkMenu(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const link = this.store.links.find((item) => item.id === id);
    if (!link) return;
    const only = new Set([id]);
    this.select(only);
    const from = this.store.cards.find((card) => card.id === link.from)?.kind;
    const to = this.store.cards.find((card) => card.id === link.to)?.kind;
    // Only an answer's branch can receive context, and a note has no branch of its own to send.
    const contextItems = [];
    if (to !== undefined && to !== 'note') {
      const asNote = from === 'note';
      if (link.context !== 'card') contextItems.push({ label: asNote ? 'Send this note to the branch' : 'Send this card to the branch', onSelect: () => this.store.setLinkContext(id, 'card') });
      if (link.context !== 'branch' && !asNote) contextItems.push({ label: 'Send its whole branch', onSelect: () => this.store.setLinkContext(id, 'branch') });
      if (link.context) contextItems.push({ label: 'Stop sending context', onSelect: () => this.store.setLinkContext(id, undefined) });
    }
    this.popups.menu({ x: e.clientX, y: e.clientY }, [
      { label: 'Label', shortcut: 'Enter', onSelect: () => { this.editingLinkId = id; this.schedule(); } },
      ...contextItems,
      { label: 'Reverse direction', onSelect: () => this.store.reverseLink(id) },
      { label: 'Go to the start', onSelect: () => this.goToItem(link.from) },
      { label: 'Go to the end', onSelect: () => this.goToItem(link.to) },
      { label: 'Delete', shortcut: 'Del', onSelect: () => this.deleteItems(only) }
    ], 'Connection');
  }

  /** A click that reached a card's body: it selects, unless it was the end of selecting text. */
  handleCardClick(e, id) {
    if (e.target.closest('button, a, input, select, textarea, [role="button"], header')) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const next = new Set(this.selected);
      if (!next.delete(id)) next.add(id);
      this.select(next);
    } else {
      this.select([id]);
    }
  }

  async openHistoryMenu(e) {
    const box = e.currentTarget.getBoundingClientRect();
    const sessions = await rpc('listConversations').catch(() => []);
    const others = sessions.filter((item) => item.source !== 'canvas');
    const canvases = sessions.filter((item) => item.source === 'canvas' && item.id !== this.store.canvasId);
    this.popups.menu({ x: box.left, y: box.bottom + 6 }, [
      { label: 'New canvas', onSelect: () => this.store.newCanvas() },
      ...(this.options.historyExtras?.() || []),
      ...canvases.map((item) => ({
        label: item.title,
        detail: formatRelativeTime(item.updatedAt),
        onSelect: () => this.store.openCanvas(item.id)
      })),
      ...(this.options.onOpenConversation
        ? others.slice(0, HISTORY_OTHERS_LIMIT).map((item) => ({
          label: item.title,
          detail: `${CONVERSATION_SOURCE_LABELS[item.source] || 'Chat'} · ${formatRelativeTime(item.updatedAt)}`,
          onSelect: () => this.options.onOpenConversation(item)
        }))
        : []),
      ...(this.options.onOpenSearch && others.length > HISTORY_OTHERS_LIMIT ? [{ label: 'Search all conversations…', onSelect: this.options.onOpenSearch }] : []),
      ...(this.store.cards.length > 0 ? [{
        label: 'Delete this canvas',
        onSelect: () => { if (window.confirm(`Delete “${this.store.title}”? This cannot be undone.`)) this.store.deleteCanvas(); }
      }] : [])
    ], 'History');
  }

  /* ================= Deriving what is on screen ================= */

  derive() {
    const store = this.store;
    const cards = store.cards;
    const frames = store.frames;
    const g = this.gesture;
    const zoom = this.viewport.zoom;
    const still = { dx: 0, dy: 0, guidesX: [], guidesY: [] };

    let dragDelta = still;
    if (g?.type === 'drag') {
      const items = { cards, frames };
      const single = cards.find((item) => item.id === g.id);
      const subject = g.group || !single ? movingBounds(items, { cards: g.ids, frames: g.frameIds }) : single.rect;
      const travelX = g.pointer.x - g.start.x;
      const travelY = g.pointer.y - g.start.y;
      if (subject && Math.hypot(travelX, travelY) * zoom >= DRAG_START_PX) {
        const moved = { ...subject, x: subject.x + travelX, y: subject.y + travelY };
        const snap = snapMove(moved, cardRects(cards, g.ids), SNAP_SCREEN_PX / zoom);
        dragDelta = { dx: snap.rect.x - subject.x, dy: snap.rect.y - subject.y, guidesX: snap.guidesX, guidesY: snap.guidesY };
      }
    }

    let resizedRect = null;
    if (g?.type === 'resize') {
      const card = cards.find((item) => item.id === g.id);
      if (card) {
        const min = card.kind === 'message' || card.kind === 'page' ? MIN_MESSAGE_SIZE : card.kind === 'note' ? MIN_NOTE_SIZE : MIN_EXPANSION_SIZE;
        const rect = {
          ...card.rect,
          w: Math.max(card.rect.w + g.pointer.x - g.start.x, min.w),
          h: Math.max(card.rect.h + g.pointer.y - g.start.y, min.h)
        };
        // A card that follows the moving edge is not a target: it would hold the edge in place.
        const carried = new Set([card.id, ...resizeFollowerIds(cards, card.id)]);
        const snapped = snapEdges(rect, cardRects(cards, carried), SNAP_SCREEN_PX / zoom).rect;
        resizedRect = { ...rect, w: snapped.x + snapped.w - rect.x, h: snapped.y + snapped.h - rect.y };
      }
    }

    let resizedDraft = null;
    if (g?.type === 'draftResize') {
      const grow = draftGrowth(g.side);
      resizedDraft = resizeDraftRect(g.rect, g.side, { dw: grow.x * (g.pointer.x - g.start.x), dh: grow.y * (g.pointer.y - g.start.y) }, cardRects(cards), SNAP_SCREEN_PX / zoom);
    }

    let resizedFrameRect = null;
    if (g?.type === 'frameResize') {
      const frame = frames.find((item) => item.id === g.id);
      if (frame) {
        resizedFrameRect = {
          ...frame.rect,
          w: Math.max(frame.rect.w + g.pointer.x - g.start.x, MIN_FRAME_SIZE.w),
          h: Math.max(frame.rect.h + g.pointer.y - g.start.y, MIN_FRAME_SIZE.h)
        };
      }
    }

    // What the box being dragged would select, shown live and committed when it is let go.
    const marqueeSelection = g?.type === 'marquee'
      ? new Set([...g.base, ...marqueeHits({ cards, frames }, rectFromPoints(g.start, g.end))])
      : null;
    const liveSelection = marqueeSelection ?? this.selected;
    const dragResult = g?.type === 'drag' ? resolveMove(cards, g.ids, dragDelta.dx, dragDelta.dy) : null;
    const resizeUpdates = g?.type === 'resize' && resizedRect ? resizeCard(cards, g.id, { w: resizedRect.w, h: resizedRect.h }) : null;

    let displayed = cards;
    if (g?.type === 'drag') {
      displayed = cards.map((card) => (g.ids.has(card.id)
        ? { ...card, rect: { ...card.rect, x: card.rect.x + dragDelta.dx, y: card.rect.y + dragDelta.dy } }
        : card));
    } else if (g?.type === 'resize' && resizedRect) {
      const moved = new Map((resizeUpdates || []).map((update) => [update.id, update.rect]));
      displayed = cards.map((card) => {
        const rect = moved.get(card.id);
        return rect ? { ...card, rect } : card;
      });
    }
    let displayedFrames = frames;
    if (g?.type === 'drag' && g.frameIds.size > 0) {
      displayedFrames = frames.map((frame) => (g.frameIds.has(frame.id)
        ? { ...frame, rect: { ...frame.rect, x: frame.rect.x + dragDelta.dx, y: frame.rect.y + dragDelta.dy } }
        : frame));
    } else if (g?.type === 'frameResize' && resizedFrameRect) {
      displayedFrames = frames.map((frame) => (frame.id === g.id ? { ...frame, rect: resizedFrameRect } : frame));
    }

    const draft = this.draft;
    const draftParent = draft?.parentId === undefined ? undefined : displayed.find((card) => card.id === draft.parentId);
    // A draft kept against its parent follows it as it grows or moves.
    let draftRect = null;
    if (draft) {
      draftRect = resizedDraft ? resizedDraft.rect : draft.side && draftParent ? rectAgainst(draftParent.rect, draft.side, draft.rect) : draft.rect;
    }
    // Held over the composer, a card or a `+` links rather than moves.
    const overDraft = draftRect !== null &&
      (g?.type === 'extend' || (g?.type === 'drag' && cards.some((card) => card.id === g.id))) &&
      containsPoint(draftRect, g.pointer);

    return {
      dragDelta, resizedRect, resizedDraft, resizedFrameRect, marqueeSelection, liveSelection,
      dragResult, resizeUpdates, displayed, displayedFrames, draftParent, draftRect, overDraft
    };
  }

  /* ================= Rendering ================= */

  schedule() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.renderNow();
    });
  }

  scheduleLinks() {
    if (this.linksPending || this.renderPending) return;
    this.linksPending = true;
    requestAnimationFrame(() => {
      this.linksPending = false;
      if (this.lastDerived) this.renderLinks(this.lastDerived, this.lastLinkInfo);
    });
  }

  renderNow() {
    const store = this.store;
    const cards = store.cards;
    const frames = store.frames;
    const g = this.gesture;
    const d = this.derive();
    this.lastDerived = d;
    const streamingTurnIds = store.streamingTurnIds;
    const contentOf = (card) => cardContent(card, store.turns, streamingTurnIds);

    /* ---- Surface classes ---- */
    const s = this.surface;
    s.classList.toggle('is-drawing', this.isDrawMode || this.tool === 'connect');
    s.classList.toggle('is-panning', this.tool === 'hand' || this.spaceHeld || g?.type === 'pan');
    s.classList.toggle('is-grabbing', g?.type === 'pan');
    s.classList.toggle('is-placing', !!this.placing);
    s.classList.toggle('is-linking', d.overDraft && g?.type === 'drag');

    /* ---- What feeds what ---- */
    const stackRanks = cardStackRanks(cards, store.stack);
    const pathIds = this.selected.size === 1 ? sessionAncestorIds(cards, [...this.selected][0]) : new Set();
    const drawing = g?.type === 'draw' ? this.drawnRect(g.what, g.start, g.end) : null;
    const drawsAnswer = g?.type === 'draw' && g.what === 'answer';
    const drawSessions = drawing && drawsAnswer && !this.placing && !drawing.refusal ? continuationCandidates(drawing.rect, cards) : [];
    const drawContinues = g?.type === 'draw' && g.continues ? cards.find((card) => card.id === g.continues) : undefined;
    const drawParent = drawContinues ?? drawSessions[0];
    const connectFromId = g?.type === 'connect' || g?.type === 'extend' ? g.from : null;
    let connectToId = null;
    if (g?.type === 'connect') {
      const target = cardAtPoint(cards, g.pointer, store.stack);
      connectToId = target && target.id !== g.from ? target.id : null;
    }
    const continuedId = drawing ? drawParent?.id : d.draftParent?.id;
    const draftOwnContext = (this.draft?.context || []).filter((link) => cards.some((card) => card.id === link.from));
    const pickedIds = new Set(draftOwnContext.map((link) => link.from));
    const dragging = (id) => (g?.type === 'drag' && g.ids.has(id)) ||
      (g?.type === 'resize' && (g.id === id || (d.resizeUpdates || []).some((update) => update.id === id)));

    /* ---- Frames ---- */
    syncKeyed(this.framesLayer, this.frameEls, d.displayedFrames.map((frame) => ({
      key: frame.id,
      create: () => this.createFrame(frame.id),
      update: (el) => this.updateFrame(el, frame, {
        editing: this.editingFrameId === frame.id,
        selected: d.liveSelection.has(frame.id),
        dragging: g?.type === 'drag' && g.frameIds.has(frame.id),
        pulsing: this.pulseId === frame.id,
        dimmed: this.searchMatches !== null && !this.searchMatches.has(frame.id)
      })
    })));

    /* ---- Cards ---- */
    syncKeyed(this.cardsLayer, this.cardEls, d.displayed.map((card) => ({
      key: card.id,
      create: () => (card.kind === 'note' ? this.createNote(card.id) : this.createCard(card)),
      update: (entry) => {
        const info = {
          dragging: dragging(card.id),
          stackLevel: (stackRanks.get(card.id) ?? 0) + 1,
          pulsing: this.pulseId === card.id,
          dimmed: this.placing ? this.placing.hostId !== card.id : this.searchMatches !== null && !this.searchMatches.has(card.id),
          selected: d.liveSelection.has(card.id),
          continued: continuedId === card.id || connectFromId === card.id || connectToId === card.id || pickedIds.has(card.id) ||
            (this.tool === 'connect' && !g && this.hoverCardId === card.id)
        };
        if (card.kind === 'note') this.updateNote(entry, card, info);
        else {
          this.updateCard(entry, card, {
            ...info,
            content: contentOf(card),
            onPath: pathIds.has(card.id),
            handleRight: !continueHandleBlocked(card, 'right', d.displayed),
            handleBottom: !continueHandleBlocked(card, 'bottom', d.displayed),
            pulseTermId: this.pulseTerm?.cardId === card.id ? this.pulseTerm.expansionId : null
          });
        }
      }
    })).map((item) => ({ ...item, create: () => { const entry = item.create(); entry.el.__entry = entry; return entry.el; }, update: (el) => item.update(el.__entry) })));

    /* ---- Draft and note draft ---- */
    this.renderDraft(d, contentOf);
    this.renderNoteDraft();

    /* ---- Links ---- */
    const draftLinks = d.draftRect === null ? [] : [
      ...draftOwnContext.flatMap((link) => {
        const from = d.displayed.find((card) => card.id === link.from);
        return from ? [{ id: link.from, from: from.rect, to: d.draftRect }] : [];
      }),
      // Placed away from what it continues, nothing else shows that it does.
      ...(d.draftParent && !continuationCandidates(d.draftRect, d.displayed).some((card) => card.id === d.draftParent.id)
        ? [{ id: `parent-${d.draftParent.id}`, from: d.draftParent.rect, to: d.draftRect }]
        : [])
    ];
    let pending = null;
    if (drawContinues && drawing) pending = { from: drawContinues.rect, to: drawing.rect };
    else if (g?.type === 'extend') {
      const from = cards.find((card) => card.id === g.from);
      if (from) pending = { from: from.rect, to: d.overDraft && d.draftRect ? d.draftRect : { x: g.pointer.x, y: g.pointer.y, w: 1, h: 1 } };
    } else if (g?.type === 'connect') {
      const from = cards.find((card) => card.id === g.from);
      const to = cards.find((card) => card.id === connectToId);
      if (from) pending = { from: from.rect, to: to?.rect ?? { x: g.pointer.x, y: g.pointer.y, w: 1, h: 1 } };
    }
    this.lastLinkInfo = { stackRanks, draftLinks, pending, dragging: g?.type === 'drag' || g?.type === 'resize' };
    this.renderLinks(d, this.lastLinkInfo);

    /* ---- Drawing aids ---- */
    const guides = g?.type === 'drag'
      ? { x: d.dragDelta.guidesX, y: d.dragDelta.guidesY }
      : drawing ? { x: drawing.guidesX, y: drawing.guidesY }
        : d.resizedDraft ? { x: d.resizedDraft.guidesX, y: d.resizedDraft.guidesY } : { x: [], y: [] };
    const aids = [
      ...guides.x.map((x) => h('span.canvas-guide.canvas-guide--x', { style: { left: `${x}px` } })),
      ...guides.y.map((y) => h('span.canvas-guide.canvas-guide--y', { style: { top: `${y}px` } }))
    ];
    if (drawing && g?.type === 'draw') {
      const words = drawsAnswer ? `≈ ${estimateWords(drawing.rect, this.placing?.label.length ?? 0, bodyCharWidth())} words` : '';
      const what = !drawsAnswer && g.what === 'note' ? 'Note' : !drawsAnswer && g.what === 'frame' ? 'Frame' : '';
      const continues = drawParent ? (drawSessions.length > 1 ? ` · continues the newest of ${drawSessions.length} sessions` : ' · continues session') : '';
      const rect = h('div.canvas-draw-rect' + (drawing.refusal ? '.is-invalid' : ''), h('span.canvas-draw-badge', { text: words + what + continues }));
      place(rect, drawing.rect);
      aids.push(rect);
    }
    if (g?.type === 'marquee') {
      const box = h('div.canvas-marquee');
      place(box, rectFromPoints(g.start, g.end));
      aids.push(box);
    }
    this.aidsLayer.replaceChildren(...aids);

    this.emptyEl.hidden = !(cards.length === 0 && frames.length === 0 && !this.draft && !this.noteDraft && !drawing);

    /* ---- Chrome ---- */
    this.rail.update({ tool: this.placing ? 'answer' : this.tool, undoLabel: store.undoLabel, redoLabel: store.redoLabel, outlineOpen: this.outlineOpen });
    this.newBtn.disabled = cards.length === 0 && frames.length === 0;
    this.exportBtn.disabled = cards.length === 0;
    this.mapBtn.classList.toggle('is-toggled', this.minimapOpen);
    this.mapBtn.setAttribute('aria-pressed', String(this.minimapOpen));
    this.helpBtn.classList.toggle('is-active', this.helpOpen);

    if (this.outlineOpen) {
      if (!this.outline.el.isConnected) this.root.insertBefore(this.outline.el, this.titleBar);
      this.outline.update({
        rows: canvasOutline({ cards, frames }, store.turns),
        selectedIds: this.selected,
        streamingIds: new Set(cards.filter((card) => contentOf(card).status === 'streaming').map((card) => card.id))
      });
    } else if (this.outline.el.isConnected) {
      this.outline.el.remove();
    }

    if (this.minimapOpen && cards.length + frames.length > 0) {
      if (!this.minimap.el.isConnected) this.root.insertBefore(this.minimap.el, this.zoomBar);
      this.minimap.update({ cards: d.displayed, frames: d.displayedFrames, selectedIds: d.liveSelection, size: this.surfaceBox, viewport: this.viewport });
    } else if (this.minimap.el.isConnected) {
      this.minimap.el.remove();
    }

    if (this.helpOpen && !this.helpSlot.firstChild) this.helpSlot.appendChild(shortcutsPanel(() => this.toggleHelp()));
    else if (!this.helpOpen && this.helpSlot.firstChild) this.helpSlot.replaceChildren();

    this.renderBottom(d);

    /* ---- Following the composer ---- */
    let followRect = null;
    if (d.draftRect) {
      if (!d.draftParent) followRect = d.draftRect;
      else {
        const both = unionRect(d.draftParent.rect, d.draftRect);
        followRect = fitsOnScreen(both, this.viewport.zoom, this.surfaceBox) ? both : d.draftRect;
      }
    }
    this.followRect = followRect;
    const followKey = followRect ? JSON.stringify(followRect) : '';
    if (followKey !== this.followKey && !g && this.surfaceBox.width > 0) {
      this.followKey = followKey;
      if (this.follow && followRect) this.revealOnScreen(followRect);
    }

    /* ---- Fitting heights to finished answers ---- */
    if (!g && store.fitCardIds.size > 0) {
      for (const id of [...store.fitCardIds]) store.fitCard(id, measureCardHeight(this.surface, id));
    }
  }

  renderBottom(d) {
    const g = this.gesture;
    const message = this.notice;
    const toolHint = g?.type === 'extend' ? EXTEND_HINT
      : g?.type === 'draw' && g.unheld ? SIZE_HINT
        : this.placing || g ? undefined : TOOL_HINTS[this.tool];
    let hint = null;
    if (message) {
      hint = [message.text, message.undoable ? h('button.canvas-hint-action', { type: 'button', text: 'Undo', on: { click: () => { this.notice = null; this.handleUndo('undo'); } } }) : null];
    } else if (this.placing) {
      hint = [`Draw a rectangle to size the answer to “${this.placing.label}”, or click for the default size. Esc cancels.`];
    } else if (toolHint) {
      hint = [toolHint];
    }
    const hintKey = JSON.stringify(hint && hint.map((part) => (typeof part === 'string' ? part : part ? 'undo' : '')));
    if (hintKey !== this.hintKey) {
      this.hintKey = hintKey;
      this.hintEl.hidden = !hint;
      this.hintEl.replaceChildren(...(hint || []).filter(Boolean));
    }
    const draftHidden = d.draftRect !== null && this.surfaceBox.width > 0 && !rectsOverlap(d.draftRect, visibleWorldRect(this.viewport, this.surfaceBox));
    this.jumpBtn.hidden = !draftHidden;

    const cards = this.store.cards;
    const frames = this.store.frames;
    const selected = this.selected;
    const chosenCards = cards.filter((card) => selected.has(card.id));
    const collapsibleCards = chosenCards.filter((card) => card.kind !== 'note');
    const selectedFrameCount = frames.filter((frame) => selected.has(frame.id)).length;
    // Off while a title or label is being typed: it could be sitting right over the field.
    const showBar = selected.size > 0 && !g && !this.placing && !this.noteDraft && !this.editingFrameId && !this.editingLinkId && !this.editingNoteId;
    if (!showBar) {
      if (this.barKey !== '') {
        this.barKey = '';
        this.barSlot.replaceChildren();
      }
      return;
    }
    const items = { cards, frames };
    const props = {
      count: selected.size,
      colorable: chosenCards.length + selectedFrameCount > 0,
      color: sharedColor(items, selected),
      askable: chosenCards.length + selectedFrameCount > 0,
      connectable: chosenCards.length === 2 && selected.size === 2,
      collapsible: collapsibleCards.length > 0,
      collapsed: collapsibleCards.length > 0 && collapsibleCards.every((card) => card.collapsedFrom !== undefined),
      blocks: selectionBlockCount(items, selected),
      linkOnly: selected.size === 1 && chosenCards.length === 0 && selectedFrameCount === 0
    };
    const key = JSON.stringify(props) + [...selected].join(',');
    if (key === this.barKey) return;
    this.barKey = key;
    this.barSlot.replaceChildren(selectionBar({
      ...props,
      onAsk: () => this.askAboutSelection(),
      onColor: (color) => this.store.setColor(this.selected, color),
      onAlign: (edge) => this.applyArrangement('Align', alignSelection(items, this.selected, edge)),
      onDistribute: (axis) => this.applyArrangement('Space evenly', distributeSelection(items, this.selected, axis)),
      onTidy: () => this.applyTidy(tidySelection({ cards: this.store.cards, frames: this.store.frames, links: this.store.links }, this.selected)),
      onConnect: () => {
        const [from, to] = chosenCards;
        const id = this.store.addLink(from.id, to.id);
        if (id !== null) {
          this.select([id]);
          this.editingLinkId = id;
          this.schedule();
        }
      },
      onCollapse: () => this.handleCollapse(this.selected),
      onFrame: () => this.frameSelection(this.selected),
      onDuplicate: () => this.handleDuplicate(this.selected),
      onCopy: () => this.handleCopy(this.selected),
      onZoom: () => this.zoomToSelection(),
      onDelete: () => this.deleteItems(this.selected),
      onLabelLink: () => { this.editingLinkId = [...this.selected][0]; this.schedule(); },
      onReverseLink: () => this.store.reverseLink([...this.selected][0])
    }));
  }

  /* ---- Frames ---- */

  createFrame(id) {
    const title = h('div.canvas-frame-title');
    const resize = h('span.canvas-frame-resize', { title: 'Drag to resize', on: { pointerdown: (e) => this.handleResizeStart(e, id, 'frameResize') } });
    const el = h('section.canvas-frame', { 'data-canvas-frame': id }, title, resize);
    el.__title = title;
    return el;
  }

  updateFrame(el, frame, info) {
    el.className = ['canvas-frame', info.selected && 'is-selected', info.dragging && 'is-dragging', info.pulsing && 'is-pulsing', info.dimmed && 'is-dimmed'].filter(Boolean).join(' ');
    if (frame.color) el.dataset.color = frame.color;
    else delete el.dataset.color;
    el.setAttribute('aria-label', `Frame: ${frame.title || 'Untitled'}`);
    place(el, frame.rect);
    const key = `${info.editing}|${frame.title}`;
    if (el.__key === key) return;
    el.__key = key;
    if (info.editing) {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (value !== null) this.store.renameFrame(frame.id, value.trim());
        this.editingFrameId = null;
        this.schedule();
      };
      const input = h('input.canvas-frame-input', {
        'aria-label': 'Frame title', value: frame.title,
        on: {
          blur: () => finish(input.value),
          pointerdown: (e) => e.stopPropagation(),
          keydown: (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(input.value);
            else if (e.key === 'Escape') finish(null);
          }
        }
      });
      el.__title.replaceChildren(input);
      setTimeout(() => { input.focus({ preventScroll: true }); input.select(); }, 0);
    } else {
      el.__title.replaceChildren(h('button.canvas-frame-handle', {
        type: 'button', title: 'Drag to move with what is inside. Double-click to rename.', text: frame.title || 'Untitled frame',
        on: {
          pointerdown: (e) => this.handleDragStart(e, frame.id),
          contextmenu: (e) => this.openFrameMenu(e, frame.id),
          keydown: (e) => {
            if (e.key === 'F2') { e.preventDefault(); this.editFrame(frame.id); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.zoomToItem(frame.id); }
          }
        }
      }));
    }
  }

  /* ---- Notes ---- */

  createNote(id) {
    const surface = h('div.canvas-card-surface');
    const el = h('article.canvas-card.canvas-card--note', {
      'data-canvas-card': id, tabindex: '0',
      on: {
        click: (e) => this.handleCardClick(e, id),
        contextmenu: (e) => this.openCardMenu(e, id),
        keydown: (e) => {
          if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key === 'e' || e.key === 'E' || e.key === 'F2') {
            e.preventDefault();
            this.editNote(id);
            return;
          }
          this.handleCardKeyDown(e, id);
        }
      }
    }, surface);
    return { el, surface, key: null };
  }

  noteEditor(text, onCommit, onCancel) {
    let finished = false;
    const finish = (action) => {
      if (finished) return;
      finished = true;
      action();
    };
    const input = h('textarea.canvas-note-input', {
      'aria-label': 'Note text', placeholder: 'Write a note…',
      on: {
        blur: () => finish(() => onCommit(input.value)),
        pointerdown: (e) => e.stopPropagation(),
        keydown: (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            finish(onCancel);
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            finish(() => onCommit(input.value));
          }
        }
      }
    });
    input.value = text;
    setTimeout(() => {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
    return input;
  }

  updateNote(entry, card, info) {
    const { el } = entry;
    const editing = this.editingNoteId === card.id;
    el.className = ['canvas-card', 'canvas-card--note', editing && 'is-editing', info.selected && 'is-selected', info.dragging && 'is-dragging',
      info.pulsing && 'is-pulsing', info.dimmed && 'is-dimmed', info.continued && 'is-continued'].filter(Boolean).join(' ');
    if (card.color) el.dataset.color = card.color;
    else delete el.dataset.color;
    el.setAttribute('aria-label', `Note: ${card.text.slice(0, 120)}`);
    place(el, card.rect);
    el.style.zIndex = info.dragging ? '' : String(info.stackLevel);
    const key = `${editing}|${card.text}`;
    if (entry.key === key) return;
    entry.key = key;
    if (editing) {
      const stop = () => {
        this.editingNoteId = null;
        this.schedule();
        el.focus({ preventScroll: true });
      };
      entry.surface.replaceChildren(this.noteEditor(card.text, (text) => { this.store.updateNote(card.id, text); stop(); }, stop));
      return;
    }
    const body = h('div.canvas-note-body', { title: 'Drag to move, double-click to edit', on: { pointerdown: (e) => this.handleDragStart(e, card.id) } },
      card.text.trim() === ''
        ? h('p.canvas-note-empty', { text: 'Double-click to write' })
        : h('div.message-content', MD.render(card.text, [], { inline: false, anchored: false })));
    entry.surface.replaceChildren(
      body,
      h('div.canvas-card-lod', { text: card.text, on: { pointerdown: (e) => this.handleDragStart(e, card.id) } }),
      h('span.canvas-card-resize', { title: 'Drag to resize', on: { pointerdown: (e) => this.handleResizeStart(e, card.id) } }));
  }

  renderNoteDraft() {
    const draft = this.noteDraft;
    if (!draft) {
      if (this.noteDraftEl) {
        this.noteDraftEl.remove();
        this.noteDraftEl = null;
      }
      return;
    }
    if (this.noteDraftEl?.__key !== draft.key) {
      this.noteDraftEl?.remove();
      const el = h('article.canvas-card.canvas-card--note.is-editing', { 'data-canvas-draft': '' },
        h('div.canvas-card-surface', this.noteEditor('', (text) => this.commitNoteDraft(text), () => { this.noteDraft = null; this.schedule(); })));
      el.__key = draft.key;
      this.noteDraftEl = el;
      this.draftLayer.appendChild(el);
    }
    place(this.noteDraftEl, draft.rect);
  }

  /* ---- Cards ---- */

  createCard(card) {
    const id = card.id;
    const caption = h('div.canvas-card-caption');
    const actions = h('div.canvas-card-actions');
    const header = h('header.canvas-card-header', {
      title: 'Drag to move, double-click to zoom',
      on: { pointerdown: (e) => this.handleDragStart(e, id), contextmenu: (e) => this.openCardMenu(e, id) }
    }, caption, actions);
    const content = h('div.message-content');
    const body = h('div.canvas-card-body', {
      on: {
        contextmenu: (e) => this.handleBodyMenu(e, body),
        scroll: () => {
          const pin = this.pins.get(id) || {};
          pin.pinned = body.scrollHeight - body.scrollTop - body.clientHeight < PIN_PX;
          this.pins.set(id, pin);
        }
      }
    }, content);
    const resize = h('span.canvas-card-resize', { title: 'Drag to resize', on: { pointerdown: (e) => this.handleResizeStart(e, id) } });
    const lod = h('div.canvas-card-lod', { on: { pointerdown: (e) => this.handleDragStart(e, id), contextmenu: (e) => this.openCardMenu(e, id) } });
    const surface = h('div.canvas-card-surface', header, h('div.canvas-card-progress', { 'aria-hidden': 'true' }), body, resize, lod);
    const continueButton = (side) => h(`button.canvas-continue.canvas-continue--${side}`, {
      type: 'button', text: '+',
      'aria-label': side === 'right' ? 'Continue on the right (Shift+Enter)' : 'Reply below (Enter)',
      title: `Click to continue here (${side === 'right' ? 'Shift+Enter' : 'Enter'}). Drag to place it, or onto a new message to link.`,
      on: {
        pointerdown: (e) => this.handleContinueStart(e, id, side),
        click: (e) => { if (e.detail === 0) this.continueCard(id, [side]); }
      }
    });
    const right = continueButton('right');
    const bottom = continueButton('bottom');
    const el = h('article', {
      'data-canvas-card': id, tabindex: '0',
      on: {
        click: (e) => this.handleCardClick(e, id),
        keydown: (e) => this.handleOwnCardKey(e, id)
      }
    }, surface, right, bottom);
    return { el, caption, actions, body, content, resize, lod, right, bottom, headerKey: null, bodyKey: null, mode: null };
  }

  handleOwnCardKey(e, id) {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    const card = this.store.cards.find((item) => item.id === id);
    if (!card) return;
    const entry = this.cardEls.get(id)?.__entry;
    const status = cardContent(card, this.store.turns, this.store.streamingTurnIds).status;
    if ((e.key === 'e' || e.key === 'E') && card.kind !== 'page' && status !== 'streaming' && card.collapsedFrom === undefined) {
      e.preventDefault();
      this.editingCardId = id;
      this.schedule();
      return;
    }
    // Arrows move between cards, so paging is how a long answer is read.
    if ((e.key === 'PageDown' || e.key === 'PageUp') && entry) {
      e.preventDefault();
      const page = entry.body.clientHeight * 0.85;
      entry.body.scrollBy({ top: e.key === 'PageDown' ? page : -page, behavior: 'smooth' });
      return;
    }
    this.handleCardKeyDown(e, id);
  }

  actionButton(icon, label, onClick) {
    return h('button.canvas-icon-btn', { type: 'button', 'aria-label': label, title: label, on: { click: onClick } }, canvasIcon(icon, 2, null));
  }

  renderTerm(node, group, pulseTermId) {
    const flat = flattenMarkdown(node.originalText).slice(0, 80);
    const open = () => this.openExpansion(node.id);
    return h('span.queried.canvas-term' + (group.some((item) => item.id === pulseTermId) ? '.is-pulsing' : ''), {
      'data-expansion-id': String(node.id),
      'data-canvas-terms': group.map((item) => item.id).join(' '),
      role: 'button', tabindex: '0',
      'aria-label': `Go to the expansion of ${flat}`,
      title: node.prompt?.trim() || 'Go to this expansion',
      on: {
        // A term inside a link's text goes to its expansion, not along the link.
        click: (e) => { e.preventDefault(); open(); },
        keydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          open();
        }
      }
    }, MD.isPlainMarkdown(node.originalText) ? node.originalText : MD.render(node.originalText, [], { inline: true, anchored: false }));
  }

  updateCard(entry, card, info) {
    const { el } = entry;
    const c = info.content;
    const collapsed = card.collapsedFrom !== undefined;
    const status = c.status;
    el.className = ['canvas-card', `canvas-card--${card.kind}`, collapsed && 'is-collapsed', info.selected && 'is-selected', info.onPath && 'is-on-path',
      status === 'streaming' && 'is-streaming', status === 'failed' && 'is-failed', info.dragging && 'is-dragging', info.pulsing && 'is-pulsing',
      info.dimmed && 'is-dimmed', info.continued && 'is-continued'].filter(Boolean).join(' ');
    if (card.color) el.dataset.color = card.color;
    else delete el.dataset.color;
    place(el, card.rect);
    el.style.zIndex = info.dragging ? '' : String(info.stackLevel);
    el.setAttribute('aria-busy', String(status === 'streaming'));
    const label = c.question ? `${c.caption}: ${c.question}` : c.caption;
    const kindLabel = card.kind === 'expansion' ? 'Expansion' : card.kind === 'page' ? 'Page' : 'Question';
    el.setAttribute('aria-label', `${kindLabel}: ${label.slice(0, 120)}`);

    const canContinue = status === 'done' && !collapsed;
    entry.right.hidden = !(canContinue && info.handleRight);
    entry.bottom.hidden = !(canContinue && info.handleBottom);
    entry.resize.hidden = collapsed;
    entry.lod.textContent = label;
    entry.body.dataset.turnId = String(card.turnId);
    if (card.kind === 'expansion') entry.body.dataset.expansionId = String(card.expansionId);

    const editing = this.editingCardId === card.id && status !== 'streaming';
    const copied = this.copiedCardId === card.id;
    const hasSource = card.kind === 'expansion' || card.parentId !== undefined;

    /* ---- Header ---- */
    const headerKey = JSON.stringify([label, c.question, status, hasSource, c.answer !== '', editing, collapsed, copied, card.url]);
    if (headerKey !== entry.headerKey) {
      entry.headerKey = headerKey;
      entry.caption.replaceChildren(...[
        card.kind === 'expansion' || card.kind === 'page' ? h('span.canvas-card-kind', { text: kindLabel }) : null,
        h('span', { title: c.question ?? c.caption, text: label })
      ].filter(Boolean));
      const buttons = [];
      if (hasSource) {
        const back = card.kind === 'expansion' ? 'Back to the term (B)' : 'Previous card (B)';
        buttons.push(this.actionButton('back', back, () => this.goToSource(card.id)));
      }
      if (card.kind === 'page' && isSafeUrl(card.url)) {
        buttons.push(h('a.canvas-icon-btn', { href: card.url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${card.url}`, 'aria-label': 'Open the page' }, canvasIcon('external', 2, null)));
      }
      if (status === 'streaming') buttons.push(h('button.canvas-icon-btn', { type: 'button', text: 'Stop', on: { click: () => this.store.stopCard(card.id) } }));
      if (status === 'failed' && !editing) buttons.push(h('button.canvas-icon-btn', { type: 'button', text: 'Retry', on: { click: () => this.handleRegenerate(card.id) } }));
      if (c.answer !== '') {
        buttons.push(this.actionButton(copied ? 'check' : 'copyCard', copied ? 'Copied' : card.kind === 'page' ? 'Copy the page text' : 'Copy answer', () => this.copyAnswer(card.id, c.answer)));
      }
      if (card.kind !== 'page' && status !== 'streaming' && !editing && !collapsed) {
        buttons.push(this.actionButton('edit', 'Edit and resend (E)', () => { this.editingCardId = card.id; this.schedule(); }));
      }
      if (card.kind === 'expansion' && status === 'done') {
        buttons.push(h('button.canvas-icon-btn', {
          type: 'button', text: 'Ask…', title: 'Ask something else about this; this answer stays',
          on: { click: (e) => { const box = e.currentTarget.getBoundingClientRect(); this.askAnotherExpansion(card.expansionId, { x: box.left, y: box.bottom + 4 }); } }
        }));
      }
      if (card.kind !== 'page' && status === 'done' && !editing && !collapsed) {
        buttons.push(this.actionButton('regenerate', 'Regenerate at this size', () => this.handleRegenerate(card.id)));
      }
      buttons.push(this.actionButton(collapsed ? 'expand' : 'collapse', collapsed ? 'Expand (.)' : 'Collapse to title (.)', () => this.handleCollapse(new Set([card.id]))));
      buttons.push(h('button.canvas-icon-btn.canvas-icon-btn--close', { type: 'button', 'aria-label': 'Delete (Delete)', title: 'Delete (Delete)', text: '×', on: { click: () => this.handleDelete(card.id) } }));
      entry.actions.replaceChildren(...buttons);
    }

    /* ---- Body ---- */
    const waiting = status === 'streaming' && c.answer === '';
    const mode = editing ? 'edit' : waiting ? 'wait' : status === 'failed' ? 'fail' : 'text';
    if (mode === 'edit') {
      if (entry.mode !== 'edit') {
        entry.mode = 'edit';
        entry.bodyKey = null;
        entry.body.replaceChildren(this.questionEditor(card, c, entry));
      }
      return;
    }
    if (entry.mode === 'edit' || !entry.body.contains(entry.content)) {
      entry.content = h('div.message-content');
      entry.body.replaceChildren(entry.content);
    }
    const pin = this.pins.get(card.id) || { pinned: true };
    if (status === 'streaming' && entry.status !== 'streaming') pin.pinned = true;
    this.pins.set(card.id, pin);
    entry.status = status;
    entry.mode = mode;
    const bodyKey = mode === 'text'
      ? `${c.answer}\u0000${JSON.stringify(c.expansions)}\u0000${info.pulseTermId}`
      : `${mode}\u0000${c.failure ?? ''}`;
    if (bodyKey === entry.bodyKey) return;
    entry.bodyKey = bodyKey;
    if (mode === 'wait') {
      entry.content.replaceChildren(h('div.canvas-skeleton', { 'aria-label': 'Writing an answer' },
        [0, 1, 2, 3].map((i) => h('span', { style: { animationDelay: `${i * 90}ms` } }))));
    } else if (mode === 'fail') {
      entry.content.replaceChildren(h('p.canvas-card-failure', { text: c.failure || 'The answer failed.' }));
    } else {
      entry.content.replaceChildren(MD.render(c.answer, c.expansions, {
        inline: false,
        renderExpansion: (node, group) => this.renderTerm(node, group, info.pulseTermId)
      }));
    }
    // An answer that outgrows its card while streaming follows its newest line, as a chat does.
    if (status === 'streaming' && pin.pinned) entry.body.scrollTop = entry.body.scrollHeight;
  }

  questionEditor(card, c, entry) {
    const area = h('textarea.canvas-draft-input', { 'aria-label': 'Edit question' });
    area.value = card.kind === 'expansion' ? (c.question ?? '') : c.caption;
    const finish = () => {
      this.editingCardId = null;
      entry.mode = null;
      this.schedule();
      entry.el.focus({ preventScroll: true });
    };
    const submit = () => {
      const question = area.value.trim();
      if (question === '') return;
      if (this.handleEdit(card.id, question)) finish();
    };
    const send = h('button.btn.btn--sm.btn--primary', { type: 'submit', text: 'Send', disabled: area.value.trim() === '' });
    area.addEventListener('input', () => { send.disabled = area.value.trim() === ''; });
    area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    setTimeout(() => area.focus({ preventScroll: true }), 0);
    return h('form.canvas-card-edit', { on: { submit: (e) => { e.preventDefault(); submit(); } } }, area,
      h('div.canvas-draft-actions', h('button.btn.btn--sm', { type: 'button', text: 'Cancel', on: { click: finish } }), send));
  }

  askAnotherExpansion(expansionId, at) {
    const card = this.store.cards.find((item) => item.kind === 'expansion' && item.expansionId === expansionId);
    if (!card) return;
    const location = this.store.turns.find((turn) => turn.id === card.turnId);
    if (!location) return;
    const node = findExpansionInNodes(location.expansions, expansionId);
    if (!node) return;
    const source = node.parent ? node.parent.answer : location.content;
    const anchored = MD.anchoredRange(source, node.node);
    const target = {
      start: node.node.start,
      end: node.node.end,
      selection: node.node.originalText,
      ...(anchored && anchored.kind === 'atom' ? { atomic: true } : {}),
      ...(node.parent ? { parentExpansionId: node.parent.id } : {})
    };
    this.popups.prompt(at, { onSubmit: (prompt) => this.beginPlacing(card.turnId, target, prompt) });
  }

  /* ---- Draft ---- */

  renderDraft(d, contentOf) {
    const draft = this.draft;
    if (!draft || !d.draftRect) {
      if (this.draftEl) {
        this.draftEl.el.remove();
        this.draftEl = null;
      }
      return;
    }
    if (this.draftEl?.key !== draft.key) {
      this.draftEl?.el.remove();
      this.draftEl = this.createDraft(draft.key);
      this.draftLayer.prepend(this.draftEl.el);
      setTimeout(() => this.draftEl?.input.focus({ preventScroll: true }), 0);
    }
    const view = this.draftEl;
    const cards = this.store.cards;
    const turns = this.store.turns;
    view.el.className = ['canvas-card', 'canvas-card--draft', this.gesture?.type === 'draftResize' && 'is-resizing', d.overDraft && 'is-link-target'].filter(Boolean).join(' ');
    place(view.el, d.draftRect);
    view.rect = d.draftRect;
    view.resize.dataset.side = d.draftParent ? draft.side || '' : '';
    if (!view.resize.dataset.side) delete view.resize.dataset.side;

    const parentContent = d.draftParent ? contentOf(d.draftParent) : null;
    view.onPage = d.draftParent?.kind === 'page';
    view.input.placeholder = view.onPage ? 'Ask about this page, or press Enter to summarize it' : 'What should go here?';

    // Which conversation it follows.
    const sessions = (draft.sessions || []).flatMap((id) => {
      const card = cards.find((item) => item.id === id);
      if (!card) return [];
      const content = contentOf(card);
      return [{ id, label: content.question ? `${content.caption}: ${content.question}` : content.caption }];
    });
    const sourceCount = draft.sourceIds?.length ?? 0;
    const metaKey = JSON.stringify([sessions, d.draftParent?.id, sourceCount]);
    if (metaKey !== view.metaKey) {
      view.metaKey = metaKey;
      let first;
      if (sessions.length === 0) {
        first = h('span', { text: sourceCount > 0 ? `About ${sourceCount === 1 ? 'this card' : `these ${sourceCount} cards`}` : 'New session' });
      } else {
        const select = h('select', {
          title: 'Which conversation this answer follows. Only that history is sent.',
          on: { change: () => this.changeDraftParent(select.value === '' ? undefined : select.value, view.rect) }
        }, sessions.map((session) => h('option', { value: session.id, text: shortLabel(session.label) })),
        h('option', { value: '', text: 'Nothing (new session)' }));
        select.value = d.draftParent?.id ?? '';
        first = h('label.canvas-draft-session', h('span', { text: 'Continues' }), select);
      }
      view.meta.replaceChildren(first, view.words);
    }
    view.updateWords();

    // What it sends besides the question.
    const own = (draft.context || []).filter((link) => cards.some((card) => card.id === link.from));
    const inherited = sessionContextLinks(cards, this.store.links, d.draftParent?.id).filter((link) => own.every((item) => item.from !== link.from));
    const all = [...own, ...inherited];
    let tokens = 0;
    let clipped = false;
    if (all.length > 0) {
      const history = d.draftParent ? turnsThroughCard(cards, turns, d.draftParent.id) : [];
      const result = contextExcerpts(cards, turns, all, history, draft.sourceIds ?? []);
      tokens = result.items.reduce((sum, item) => sum + estimateTokens(item.text), 0);
      clipped = result.clipped;
    }
    const chips = [...own.map((link) => ({ link, inherited: false })), ...inherited.map((link) => ({ link, inherited: true }))].flatMap(({ link, inherited: isInherited }) => {
      const card = cards.find((item) => item.id === link.from);
      if (!card) return [];
      const content = contentOf(card);
      return [{ id: link.from, label: card.kind === 'note' ? card.text : (content.question ?? content.caption), context: card.kind === 'note' ? undefined : link.context, inherited: isInherited }];
    });
    const chipsKey = JSON.stringify([chips, tokens, clipped]);
    if (chipsKey !== view.chipsKey) {
      view.chipsKey = chipsKey;
      view.context.hidden = chips.length === 0;
      view.context.replaceChildren(...chips.map((item) => this.contextChip(item)),
        ...(tokens > 0 ? [h('span.canvas-draft-context-size', {
          title: clipped ? 'This was too long to send whole, so the oldest or furthest part is left out.' : 'Roughly how much these links add to the request.',
          text: `≈ ${formatTokens(tokens)} tokens${clipped ? ' (cut to fit)' : ''}`
        })] : []));
    }

    const contextStreaming = own.some((link) => {
      const card = cards.find((item) => item.id === link.from);
      return card !== undefined && contentOf(card).status === 'streaming';
    });
    view.waiting = parentContent?.status === 'streaming' ? WAITING_PARENT
      : parentContent?.status === 'failed' ? FAILED_PARENT
        : contextStreaming ? WAITING_CONTEXT : null;
    view.waitingEl.hidden = !view.waiting;
    view.waitingEl.textContent = view.waiting || '';
    view.hint.textContent = d.overDraft ? 'Drop to link' : 'Drag a card or note here to link it';
    view.updateSend();
  }

  contextChip(item) {
    const label = shortLabel(item.label);
    if (item.inherited) {
      return h('span.canvas-draft-chip.is-inherited', { title: `Linked earlier: ${item.label}` }, h('span.canvas-draft-chip-label', { text: label }));
    }
    const next = item.context === 'branch' ? 'card' : 'branch';
    return h('span.canvas-draft-chip', { title: item.label },
      h('span.canvas-draft-chip-label', { text: label }),
      item.context ? h('button', {
        type: 'button', text: item.context === 'branch' ? 'Branch' : 'Card',
        title: item.context === 'branch'
          ? 'Sends the whole branch up to this card. Click to send only this card.'
          : 'Sends only this card. Click to send the whole branch up to it.',
        on: {
          click: () => {
            if (!this.draft) return;
            this.draft = { ...this.draft, context: this.draft.context?.map((link) => (link.from === item.id ? { ...link, context: next } : link)) };
            this.schedule();
          }
        }
      }) : null,
      h('button', {
        type: 'button', 'aria-label': `Remove ${label}`, text: '×',
        on: {
          click: () => {
            if (!this.draft) return;
            this.draft = { ...this.draft, context: this.draft.context?.filter((link) => link.from !== item.id) };
            this.schedule();
          }
        }
      }));
  }

  createDraft(key) {
    const view = { key, rect: null, waiting: null, onPage: false, metaKey: null, chipsKey: null };
    view.words = h('span', { title: "How long the answer will be. Drag the corner or press Alt+arrows to change it." });
    view.meta = h('div.canvas-draft-meta');
    view.input = h('textarea.canvas-draft-input', { 'aria-label': 'Question', placeholder: 'What should go here?' });
    view.context = h('div.canvas-draft-context', { 'aria-label': 'Context sent with this question', hidden: true });
    view.hint = h('span.canvas-draft-hint');
    view.waitingEl = h('span.canvas-draft-waiting', { role: 'status', hidden: true });
    view.send = h('button.btn.btn--sm.btn--primary', { type: 'submit', text: 'Ask' });
    view.resize = h('div.canvas-card-resize', { title: "Drag to resize; the answer's length follows", on: { pointerdown: (e) => this.startDraftResize(e) } });
    const question = () => {
      const trimmed = view.input.value.trim();
      return trimmed === '' && view.onPage ? LOOKUP_DEFAULT_QUERY : trimmed;
    };
    view.updateWords = () => {
      if (view.rect) view.words.textContent = `≈ ${estimateWords(view.rect, view.input.value.trim().length, bodyCharWidth())} words`;
    };
    view.updateSend = () => { view.send.disabled = question() === '' || view.waiting !== null; };
    const submit = () => {
      const text = question();
      if (text !== '' && view.waiting === null) this.submitDraft(text);
    };
    view.input.addEventListener('input', () => {
      view.updateWords();
      view.updateSend();
      this.refollow();
    });
    view.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelDraft();
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      } else if (e.altKey && e.key.startsWith('Arrow')) {
        e.preventDefault();
        e.stopPropagation();
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (step) this.resizeDraftBy(step[0] * DRAFT_RESIZE_STEP, step[1] * DRAFT_RESIZE_STEP);
      }
    });
    const form = h('form.canvas-card-surface.canvas-draft', { on: { submit: (e) => { e.preventDefault(); submit(); } } },
      view.meta, view.input, view.context,
      h('div.canvas-draft-actions', view.hint, view.waitingEl,
        h('button.btn.btn--sm', { type: 'button', text: 'Cancel', on: { click: () => this.cancelDraft() } }),
        view.send),
      view.resize);
    view.el = h('article.canvas-card.canvas-card--draft', { 'data-canvas-draft': '' }, form);
    return view;
  }

  /* ---- Links ---- */

  measureTermOffsets(cards) {
    const offsets = {};
    for (const card of cards) {
      if (card.kind !== 'expansion') continue;
      const host = cards.find((other) => other.id === card.hostId);
      const hostEl = this.surface.querySelector(`[data-canvas-card="${CSS.escape(card.hostId)}"] .canvas-card-surface`);
      const term = hostEl?.querySelector(`[data-canvas-terms~="${card.expansionId}"]`);
      if (!host || !hostEl || !term) continue;
      const hostBox = hostEl.getBoundingClientRect();
      if (hostBox.width === 0) continue;
      const point = termPoint(term);
      const scale = hostBox.width / host.rect.w;
      offsets[card.id] = { x: (point.x - hostBox.left) / scale, y: (point.y - hostBox.top) / scale };
    }
    return offsets;
  }

  renderLinks(d, info) {
    const cards = d.displayed;
    const links = this.store.links;
    const selected = d.liveSelection;
    const offsets = this.measureTermOffsets(cards);
    const rectOf = new Map(cards.map((card) => [card.id, card.rect]));
    const continuations = canvasContinuations(cards);
    const sessionLinks = continuations.filter((item) => item.kind === 'link');
    const allSeams = continuations.filter((item) => item.kind === 'seam');
    // Seams are drawn above every card, so one under a third card has to be left out.
    const rankOf = (id) => (id ? (info.stackRanks.get(id) ?? -1) : -1);
    const seams = allSeams.filter(({ id, start, end }) => {
      const card = cards.find((item) => item.id === id);
      const level = Math.max(rankOf(id), rankOf(card && sourceCardId(card)));
      const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      return !cards.some((other) => rankOf(other.id) > level && containsPoint(other.rect, middle));
    });
    const termLinks = cards.filter((card) => card.kind === 'expansion').flatMap((card) => {
      if (allSeams.some((seam) => seam.id === card.id)) return [];
      const host = cards.find((other) => other.id === card.hostId);
      if (!host) return [];
      const raw = offsets[card.id] ?? { x: host.rect.w / 2, y: host.rect.h / 2 };
      // A term scrolled out of its card hands its link to the card's edge.
      const from = clampPointInside({ x: host.rect.x + raw.x, y: host.rect.y + raw.y }, host.rect);
      return [{ id: card.id, from, d: linkPath(from, card.rect) }];
    });
    const connectors = links.flatMap((link) => {
      const from = rectOf.get(link.from);
      const to = rectOf.get(link.to);
      return from && to ? [{ link, ...connectorGeometry(from, to) }] : [];
    });
    const relations = askedAboutRelations(cards).flatMap((relation) => {
      const from = rectOf.get(relation.from);
      const to = rectOf.get(relation.to);
      return from && to ? [{ ...relation, d: connectorGeometry(from, to).d }] : [];
    });
    for (const svg of [this.svgUnder, this.svgOver, this.svgSeams]) svg.classList.toggle('is-dragging', info.dragging);

    // Drawn twice: strong under the cards for open space, and faint over them so a link can be
    // traced back to its term without striking through the text. Only the part under the cards
    // takes clicks, so a link never steals one meant for text.
    const lineItem = (key, d0, opts, extra) => ({
      key,
      create: () => {
        const g = svgEl('g');
        const line = linkLine(d0, opts);
        g.appendChild(line);
        g.__line = line;
        extra?.create(g);
        return g;
      },
      update: (g) => {
        setPathD(g.__line, d0);
        extra?.update(g);
      }
    });
    const under = [];
    for (const relation of relations) {
      const key = `rel ${relation.from} ${relation.to}`;
      under.push({
        key,
        create: () => {
          const g = svgEl('g', { class: 'canvas-relation' });
          g.__line = svgEl('path', { class: 'canvas-relation-line', 'marker-end': 'url(#canvas-arrow)' });
          g.__hit = hitPath(relation.d, 'Follow this link', { click: (e) => this.followRelation(e, relation.from, relation.to) });
          g.append(g.__line, g.__hit);
          return g;
        },
        update: (g) => { g.__line.setAttribute('d', relation.d); g.__hit.setAttribute('d', relation.d); }
      });
    }
    for (const term of termLinks) {
      under.push(lineItem(`term ${term.id}`, term.d, {}, {
        create: (g) => { g.__hit = hitPath(term.d, 'Follow this link', { click: (e) => this.followLink(e, term.id, g.__from) }); g.appendChild(g.__hit); },
        update: (g) => { g.__hit.setAttribute('d', term.d); g.__from = term.from; }
      }));
    }
    for (const { link, d: d0 } of connectors) {
      const dashed = Boolean(link.context);
      under.push({
        key: `link ${link.id} ${dashed}`,
        create: () => {
          const g = svgEl('g', { 'data-canvas-link': link.id });
          g.__line = linkLine(d0, { arrow: true, dashed });
          g.__hit = hitPath(d0, link.context === 'branch' ? 'Sends the whole branch as context. Double-click to label'
            : link.context === 'card' ? 'Sends this card as context. Double-click to label' : 'Double-click to label', {
            click: (e) => this.selectLink(e, link.id),
            contextmenu: (e) => this.openLinkMenu(e, link.id)
          });
          g.append(g.__line, g.__hit);
          return g;
        },
        update: (g) => {
          g.setAttribute('class', `canvas-connector${dashed ? ' canvas-connector--context' : ''}${selected.has(link.id) ? ' is-selected' : ''}`);
          setPathD(g.__line, d0);
          g.__hit.setAttribute('d', d0);
        }
      });
    }
    for (const item of sessionLinks) {
      under.push(lineItem(`session ${item.id}`, item.d, {}, {
        create: (g) => {
          g.__arrow = svgEl('path', { class: 'canvas-link-arrow', d: ARROW });
          g.__hit = hitPath(item.d, 'Follow this link', { click: (e) => this.followLink(e, item.id, g.__start) });
          g.append(g.__arrow, g.__hit);
        },
        update: (g) => {
          g.__arrow.style.transform = pointerTransform(item.end, item.side);
          g.__hit.setAttribute('d', item.d);
          g.__start = item.start;
        }
      }));
    }
    for (const item of info.draftLinks) {
      const d0 = connectorGeometry(item.from, item.to).d;
      under.push({
        key: `draft ${item.id}`,
        create: () => svgEl('path', { class: 'canvas-link-line canvas-link-line--pending canvas-link-line--context', 'marker-end': 'url(#canvas-arrow)' }),
        update: (path) => path.setAttribute('d', d0)
      });
    }
    if (info.pending) {
      const d0 = connectorGeometry(info.pending.from, info.pending.to).d;
      under.push({
        key: 'pending',
        create: () => svgEl('path', { class: 'canvas-link-line canvas-link-line--pending', 'marker-end': 'url(#canvas-arrow)' }),
        update: (path) => path.setAttribute('d', d0)
      });
    }
    syncKeyed(this.underGroup, this.linkCaches.under, under);

    const over = [];
    for (const term of termLinks) {
      over.push(lineItem(`term ${term.id}`, term.d, {}, {
        create: (g) => { g.__dot = svgEl('circle', { class: 'canvas-link-dot', r: 3.5 }); g.appendChild(g.__dot); },
        update: (g) => { g.__dot.setAttribute('cx', String(term.from.x)); g.__dot.setAttribute('cy', String(term.from.y)); }
      }));
    }
    for (const { link, d: d0 } of connectors) {
      const dashed = Boolean(link.context);
      over.push({
        key: `link ${link.id} ${dashed}`,
        create: () => {
          const g = svgEl('g', dashed ? { class: 'canvas-connector--context' } : {});
          g.__line = linkLine(d0, { dashed });
          g.appendChild(g.__line);
          return g;
        },
        update: (g) => setPathD(g.__line, d0)
      });
    }
    for (const item of sessionLinks) {
      over.push(lineItem(`session ${item.id}`, item.d, {}, {
        create: (g) => { g.__arrow = svgEl('path', { class: 'canvas-link-arrow', d: ARROW }); g.appendChild(g.__arrow); },
        update: (g) => { g.__arrow.style.transform = pointerTransform(item.end, item.side); }
      }));
    }
    syncKeyed(this.overGroup, this.linkCaches.over, over);

    syncKeyed(this.seamGroup, this.linkCaches.seams, seams.map(({ id, start, end, side }) => ({
      key: id,
      create: () => {
        const g = svgEl('g', { class: 'canvas-seam', 'data-canvas-seam': id });
        g.__line = svgEl('path', { class: 'canvas-seam-line' });
        g.__mark = svgEl('g', { class: 'canvas-seam-mark' });
        g.__mark.append(svgEl('circle', { r: 8 }), svgEl('path', { d: CHEVRON }));
        g.append(g.__line, g.__mark);
        return g;
      },
      update: (g) => {
        setPathD(g.__line, `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
        g.__mark.style.transform = pointerTransform({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, side);
      }
    })));

    syncKeyed(this.labelsLayer, this.linkCaches.labels, connectors.flatMap(({ link, mid }) => {
      const editing = this.editingLinkId === link.id;
      if (!editing && !link.label) return [];
      return [{
        key: `${link.id} ${editing}`,
        create: () => {
          const el = h('div.canvas-connector-label', {
            on: { click: (e) => this.selectLink(e, link.id), contextmenu: (e) => this.openLinkMenu(e, link.id) }
          });
          if (editing) {
            let done = false;
            const finish = (value) => {
              if (done) return;
              done = true;
              if (value !== null) this.store.labelLink(link.id, value);
              this.editingLinkId = null;
              this.schedule();
            };
            const input = h('input.canvas-connector-input', {
              'aria-label': 'How these two relate', placeholder: 'relates to…', value: link.label || '',
              on: {
                blur: () => finish(input.value),
                pointerdown: (e) => e.stopPropagation(),
                keydown: (e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') finish(input.value);
                  else if (e.key === 'Escape') finish(null);
                }
              }
            });
            el.appendChild(input);
            setTimeout(() => { input.focus({ preventScroll: true }); input.select(); }, 0);
          }
          return el;
        },
        update: (el) => {
          el.classList.toggle('is-selected', selected.has(link.id));
          el.style.transform = `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`;
          if (!editing) el.textContent = link.label;
        }
      }];
    }));
  }

  /* ================= Starting points ================= */

  /** A fresh canvas holding a web page, with a question box beside it. */
  startFromPage(page) {
    this.store.newCanvas();
    const id = this.store.addPage({ x: 0, y: 0, ...DEFAULT_PAGE_SIZE }, page);
    this.continueCard(id, ['right']);
    this.currentId = id;
    const { width, height } = this.surfaceSize();
    if (width > 0) {
      const page0 = this.store.cards.find((card) => card.id === id);
      const fit = fitViewport([unionRect(page0.rect, rectAgainst(page0.rect, 'right', DEFAULT_MESSAGE_SIZE))], { width, height });
      this.store.setViewport({ ...fit, zoom: Math.min(fit.zoom, 1) });
    }
    this.srStatus.textContent = 'The page is on the canvas. Select text in it to expand it, or ask about it.';
  }

  /** Brings everything into view, for a canvas just opened. */
  fitAll() {
    const rects = [...this.store.cards.map((card) => card.rect), ...this.store.frames.map((frame) => frame.rect)];
    const { width, height } = this.surfaceSize();
    if (rects.length === 0 || width === 0) return;
    this.store.setViewport(fitViewport(rects, { width, height }));
  }
}
