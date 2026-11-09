/* DOM, wording and motion helpers for the canvas board; nothing here holds board state.
 * Ported from Delta Explorer's views/canvas/{board-helpers,card-content,right-drag,CanvasIcons}
 * and lib/{viewport-motion,char-width}. */

import { BODY_CHAR_WIDTH, chaseViewport, longestLine } from '../../shared/canvas.js';
import { findExpansionInTurns, flattenMarkdown } from '../../shared/rich-text.js';

/* ---- Card content ---- */

/**
 * The status and text a card shows, from its turn or expansion:
 * `{ caption, question?, answer, expansions, status: 'streaming' | 'done' | 'failed', failure? }`.
 */
export function cardContent(card, turns, streamingTurnIds) {
  if (card.kind === 'note') return { caption: '', answer: card.text, expansions: [], status: 'done' };
  if (card.kind === 'page') {
    const turn = turns.find((item) => item.id === card.turnId);
    return { caption: card.title || card.url || 'Web page', answer: turn?.content ?? '', expansions: turn?.expansions ?? [], status: 'done' };
  }
  if (card.kind === 'message') {
    const user = turns.find((turn) => turn.id === card.userTurnId);
    const turn = turns.find((item) => item.id === card.turnId);
    const content = turn?.content ?? '';
    const streaming = streamingTurnIds.has(card.turnId);
    const blank = content.trim() === '';
    const failed = !streaming && (turn?.error === true || blank);
    return {
      caption: user?.content ?? '',
      answer: content,
      expansions: turn?.expansions ?? [],
      status: streaming ? 'streaming' : failed ? 'failed' : 'done',
      ...(failed ? { failure: blank ? 'Stopped before an answer.' : content } : {})
    };
  }
  const node = findExpansionInTurns(turns, card.expansionId)?.node;
  return {
    caption: flattenMarkdown(node?.originalText ?? ''),
    ...(node?.prompt?.trim() ? { question: node.prompt.trim() } : {}),
    answer: node?.answer ?? '',
    expansions: node?.children ?? [],
    status: node?.status === 'loading' ? 'streaming' : node?.status === 'error' ? 'failed' : 'done',
    ...(node?.status === 'error' ? { failure: node.error ?? 'The answer failed.' } : {})
  };
}

/* ---- Measuring ---- */

const SAMPLE =
  'When a conversation grows past the limit, the oldest messages are usually dropped first, ' +
  'which is why a long chat can appear to forget what was said at the beginning of it.';
let measuredCharWidth = null;

/** The average character width of 14px body text in the font this platform really uses. */
export function bodyCharWidth() {
  if (measuredCharWidth !== null) return measuredCharWidth;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return BODY_CHAR_WIDTH;
  context.font = `14px ${getComputedStyle(document.body).fontFamily}`;
  measuredCharWidth = context.measureText(SAMPLE).width / SAMPLE.length;
  return measuredCharWidth;
}

/**
 * The height at which a card's body will not scroll, at its current width, in world pixels.
 * Squeezed to nothing, a body's scroll height is what the browser itself compares against.
 */
export function measureCardHeight(surface, id) {
  const card = surface.querySelector(`[data-canvas-card="${CSS.escape(id)}"] .canvas-card-surface`);
  const body = card?.querySelector('.canvas-card-body');
  if (!card || !body || !body.querySelector('.message-content')) return null;
  const chrome = card.offsetHeight - body.offsetHeight;
  const { flex, height, overflowY } = body.style;
  body.style.flex = 'none';
  body.style.height = '0';
  body.style.overflowY = 'hidden';
  const horizontalScrollbar = body.offsetHeight - body.clientHeight;
  const needed = chrome + horizontalScrollbar + body.scrollHeight + 1;
  body.style.flex = flex;
  body.style.height = height;
  body.style.overflowY = overflowY;
  return needed;
}

/** The middle of a term on screen: of its longest line, which always has text under it. */
export function termPoint(term) {
  const box = longestLine([...term.getClientRects()]) ?? term.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** Scrolls a card body so `el` sits in its middle, without moving anything around it. */
export function scrollIntoBody(el, scale) {
  const body = el.closest('.canvas-card-body');
  if (!body) return;
  const offset = (el.getBoundingClientRect().top - body.getBoundingClientRect().top) / scale + body.scrollTop;
  body.scrollTop = offset - body.clientHeight / 2;
}

export function canScrollBy(element, dx, dy) {
  const { scrollTop, scrollHeight, clientHeight, scrollLeft, scrollWidth, clientWidth } = element;
  if (dy < 0 && scrollTop > 0) return true;
  if (dy > 0 && scrollTop + clientHeight < scrollHeight - 1) return true;
  if (dx < 0 && scrollLeft > 0) return true;
  return dx > 0 && scrollLeft + clientWidth < scrollWidth - 1;
}

/** Shift+wheel is a plain mouse's only way sideways. Line and page deltas become pixels. */
export function wheelPanDelta(e) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.shiftKey && dx === 0) return { deltaX: dy, deltaY: 0 };
  return { deltaX: dx, deltaY: dy };
}

/* ---- Focus and keys ---- */

export function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** Keys on these belong to them: Enter presses a button, arrows move a caret or scroll text. */
export function ownsKeys(target) {
  return target instanceof Element && target.closest('button, a, select, [role="button"], [data-canvas-card], [data-canvas-draft]') !== null;
}

/** A claimed press takes no focus by itself, so whatever held it would otherwise keep it. */
export function releaseFocus(pressed) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && !active.contains(pressed)) active.blur();
}

/* ---- Wording ---- */

export function dependentsPhrase(count) {
  return count === 1 ? 'the card that depends on it' : `the ${count} cards that depend on it`;
}

/** Taking other cards along is asked about twice, as they may be far off screen. */
export function confirmCascade(question, dependents, undoable) {
  const others = dependents === 1 ? '1 other card' : `${dependents} other cards`;
  return window.confirm(question) && window.confirm(undoable
    ? `Are you sure? ${others} will be deleted too. Ctrl+Z brings them back while this canvas stays open.`
    : `Are you sure? ${others} will be permanently deleted. This cannot be undone.`);
}

export function deletedNotice(count) {
  return count === 1 ? 'Deleted.' : `Deleted ${count} items.`;
}

/* ---- Preferences ---- */

const MINIMAP_STORAGE_KEY = 'delta-canvas-minimap';

export function readMinimapPreference() {
  try { return localStorage.getItem(MINIMAP_STORAGE_KEY) !== 'off'; } catch { return true; }
}

export function saveMinimapPreference(open) {
  try { localStorage.setItem(MINIMAP_STORAGE_KEY, open ? 'on' : 'off'); } catch { /* costs nothing */ }
}

/* ---- Viewport motion ---- */

/** Holds the layer and the stored viewport back until a run of wheel events is over. */
const SETTLE_MS = 120;

/**
 * Wheel input moves the view many times a frame's worth of distance, so frames are painted
 * directly and the store only hears about the viewport once it rests.
 * host: { read(), paint(viewport), commit(viewport), setMoving(moving) }
 */
export function createViewportMotion(host) {
  let target = null;
  let frameId = null;
  let settleTimer = null;
  let lastFrame = null;

  const clearPending = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    clearTimeout(settleTimer);
    frameId = null;
    settleTimer = null;
    lastFrame = null;
  };

  const stop = (commit) => {
    clearPending();
    if (target === null) return;
    target = null;
    host.setMoving(false);
    if (commit) host.commit(host.read());
  };

  const frame = (time) => {
    if (target === null) return;
    const elapsed = lastFrame === null ? 16 : time - lastFrame;
    lastFrame = time;
    const next = chaseViewport(host.read(), target, elapsed);
    host.paint(next);
    if (next === target) {
      frameId = null;
      lastFrame = null;
      settleTimer = setTimeout(() => stop(true), SETTLE_MS);
    } else {
      frameId = requestAnimationFrame(frame);
    }
  };

  return {
    /** `immediate` also applies the change to what is on screen, for input in small steps. */
    steer(change, immediate = false) {
      if (target === null) host.setMoving(true);
      clearTimeout(settleTimer);
      settleTimer = null;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target = change(target ?? host.read());
      if (immediate || reduced) host.paint(reduced ? target : change(host.read()));
      if (frameId === null) frameId = requestAnimationFrame(frame);
    },
    /** Stops where the view is now and commits it. */
    settle: () => stop(true),
    /** Stops without committing, for a board that is going away. */
    cancel: () => stop(false)
  };
}

/* ---- Right drag ---- */

const RIGHT_DRAG_START_PX = 5;
const RIGHT_BUTTON = 2;
const RIGHT_BUTTONS_BIT = 2;

/**
 * Tells a right click from a right drag. Linux and macOS fire `contextmenu` on press and
 * Windows on release, so a press holds its menu back, and the release either replays it on
 * whatever was pressed or, after a drag, drops it.
 */
export function createRightDrag() {
  let press = null;
  let swallowNext = false;
  let replaying = false;
  return {
    onPress(e) {
      swallowNext = false;
      press = null;
      if (e.button !== RIGHT_BUTTON || e.target.closest('input, textarea, select')) return;
      press = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, dragging: false, menuTarget: null };
    },
    /** The press that has just become a drag, once; otherwise null. */
    onMove(e) {
      if (!press || press.dragging) return null;
      if (!(e.buttons & RIGHT_BUTTONS_BIT)) { press = null; return null; }
      if (Math.hypot(e.clientX - press.clientX, e.clientY - press.clientY) < RIGHT_DRAG_START_PX) return null;
      press.dragging = true;
      return press;
    },
    onRelease(e) {
      if (e.button !== RIGHT_BUTTON || !press) return;
      const released = press;
      press = null;
      if (released.dragging) {
        swallowNext = released.menuTarget === null;
        return;
      }
      if (!released.menuTarget) return;
      replaying = true;
      released.menuTarget.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: RIGHT_BUTTON, clientX: released.clientX, clientY: released.clientY
      }));
      replaying = false;
    },
    onCancel() { press = null; },
    onContextMenuCapture(e) {
      if (replaying || (!press && !swallowNext)) return;
      e.preventDefault();
      e.stopPropagation();
      if (press) press.menuTarget = e.target;
      else swallowNext = false;
    }
  };
}

/* ---- Icons ---- */

const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  select: [['path', { d: 'M5 3l14 8.5-6 1.6L10.5 20z' }]],
  hand: [
    ['path', { d: 'M8 12V5.5a1.5 1.5 0 013 0V11' }],
    ['path', { d: 'M11 11V4.5a1.5 1.5 0 013 0V11' }],
    ['path', { d: 'M14 11V6.5a1.5 1.5 0 013 0V14' }],
    ['path', { d: 'M8 11.5L6.6 10a1.6 1.6 0 00-2.4 2.1l3.4 5.2A6 6 0 0012.6 20H13a4 4 0 004-4v-3' }]
  ],
  answer: [
    ['path', { d: 'M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3' }],
    ['path', { d: 'M12 8.5v7M8.5 12h7' }]
  ],
  note: [
    ['path', { d: 'M5 4h14a1 1 0 011 1v9l-6 6H5a1 1 0 01-1-1V5a1 1 0 011-1z' }],
    ['path', { d: 'M14 20v-5a1 1 0 011-1h5' }]
  ],
  connect: [
    ['circle', { cx: 6, cy: 18, r: 2.5 }],
    ['path', { d: 'M8 16L19 5' }],
    ['path', { d: 'M13 5h6v6' }]
  ],
  frame: [
    ['path', { d: 'M3 8h8V5H4a1 1 0 00-1 1z' }],
    ['path', { d: 'M3 8v10a1 1 0 001 1h16a1 1 0 001-1V9a1 1 0 00-1-1z' }]
  ],
  undo: [['path', { d: 'M9 14L4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 010 11H11' }]],
  redo: [['path', { d: 'M15 14l5-5-5-5' }], ['path', { d: 'M20 9H9.5a5.5 5.5 0 000 11H13' }]],
  outline: [
    ['path', { d: 'M9 6h11M9 12h11M9 18h11' }],
    ['circle', { cx: 4.5, cy: 6, r: 1 }],
    ['circle', { cx: 4.5, cy: 12, r: 1 }],
    ['circle', { cx: 4.5, cy: 18, r: 1 }]
  ],
  search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'M16 16l4.5 4.5' }]],
  map: [
    ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 1.5 }],
    ['rect', { x: 11, y: 11, width: 7, height: 5, rx: 0.5 }]
  ],
  ask: [
    ['path', { d: 'M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1h-8l-5 4v-4H4a1 1 0 01-1-1V6a1 1 0 011-1z' }],
    ['path', { d: 'M12 8v5M9.5 10.5h5' }]
  ],
  align: [
    ['path', { d: 'M4 3v18' }],
    ['rect', { x: 8, y: 6, width: 12, height: 4, rx: 1 }],
    ['rect', { x: 8, y: 14, width: 7, height: 4, rx: 1 }]
  ],
  duplicate: [
    ['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }],
    ['path', { d: 'M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1' }]
  ],
  copy: [
    ['rect', { x: 8, y: 3, width: 8, height: 4, rx: 1 }],
    ['path', { d: 'M16 5h2a1 1 0 011 1v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6a1 1 0 011-1h2' }],
    ['path', { d: 'M9 12h6M9 16h4' }]
  ],
  zoomTo: [
    ['path', { d: 'M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4' }],
    ['circle', { cx: 12, cy: 12, r: 2.5 }]
  ],
  collapse: [['path', { d: 'M6 15l6-6 6 6' }]],
  expand: [['path', { d: 'M6 9l6 6 6-6' }]],
  trash: [['path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }]],
  reverse: [
    ['path', { d: 'M7 4L3 8l4 4' }], ['path', { d: 'M3 8h14' }],
    ['path', { d: 'M17 12l4 4-4 4' }], ['path', { d: 'M21 16H7' }]
  ],
  label: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z' }]],
  back: [['path', { d: 'M9 14L4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 010 11H11' }]],
  edit: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z' }]],
  regenerate: [['path', { d: 'M20 11a8 8 0 1 0-2.34 5.66' }], ['path', { d: 'M20 4v7h-7' }]],
  copyCard: [
    ['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }],
    ['path', { d: 'M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1' }]
  ],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
  external: [['path', { d: 'M14 4h6v6' }], ['path', { d: 'M20 4l-9 9' }], ['path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]]
};

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

/** One of the canvas's line icons, on a 24px grid. `strokeWidth` 2 matches the card buttons. */
export function canvasIcon(name, strokeWidth = 1.8, className = 'canvas-glyph') {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': strokeWidth,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
  });
  if (className) svg.setAttribute('class', className);
  for (const [tag, attrs] of PATHS[name] || []) svg.appendChild(svgEl(tag, attrs));
  return svg;
}
