/* The canvas's chrome: tool rail, selection bar, outline and search, map, and the shortcut
 * sheet. Ported from Delta Explorer's views/canvas/{CanvasToolRail,CanvasSelectionBar,
 * CanvasOutline,CanvasMinimap,CanvasShortcuts}.tsx. Each builds its DOM once and is
 * updated with `update(props)`. */

import { h, keyLabel } from '../dom.js';
import { CANVAS_COLORS, unionRect, visibleWorldRect } from '../../shared/canvas.js';
import { boundsOf } from '../../shared/canvas-selection.js';
import { searchCanvasOutline } from '../../shared/canvas-outline.js';
import { canvasIcon, svgEl } from './helpers.js';

/* ---- Tool rail ---- */

const TOOLS = [
  { tool: 'select', icon: 'select', label: 'Select', key: 'V' },
  { tool: 'hand', icon: 'hand', label: 'Hand: drag anywhere to pan', key: 'H' },
  { tool: 'answer', icon: 'answer', label: 'Answer: draw a rectangle to ask in', key: 'R' },
  { tool: 'note', icon: 'note', label: 'Note: your own text', key: 'T' },
  { tool: 'connect', icon: 'connect', label: 'Connect: drag from card to card', key: 'C' },
  { tool: 'frame', icon: 'frame', label: 'Frame: group a region', key: 'F' }
];

export class ToolRail {
  /** actions: { onTool(tool), onUndo(), onRedo(), onToggleOutline() } */
  constructor(actions) {
    this.toolButtons = new Map();
    this.el = h('div.canvas-rail', { role: 'toolbar', 'aria-label': 'Tools', 'aria-orientation': 'vertical' });
    for (const { tool, icon, label, key } of TOOLS) {
      const button = h('button.canvas-rail-btn', {
        type: 'button', 'aria-label': label, 'data-tip': `${label}  (${key})`, on: { click: () => actions.onTool(tool) }
      }, canvasIcon(icon));
      this.toolButtons.set(tool, button);
      this.el.appendChild(button);
    }
    this.undoBtn = h('button.canvas-rail-btn', { type: 'button', 'aria-label': 'Undo', on: { click: actions.onUndo } }, canvasIcon('undo'));
    this.redoBtn = h('button.canvas-rail-btn', { type: 'button', 'aria-label': 'Redo', on: { click: actions.onRedo } }, canvasIcon('redo'));
    this.outlineBtn = h('button.canvas-rail-btn', {
      type: 'button', 'aria-label': 'Outline and search', 'data-tip': `Outline and search  (O, ${keyLabel('Ctrl+F')})`,
      on: { click: actions.onToggleOutline }
    }, canvasIcon('outline'));
    this.el.append(h('span.canvas-rail-sep', { role: 'separator' }), this.undoBtn, this.redoBtn,
      h('span.canvas-rail-sep', { role: 'separator' }), this.outlineBtn);
  }

  update({ tool, undoLabel, redoLabel, outlineOpen }) {
    for (const [item, button] of this.toolButtons) {
      button.classList.toggle('is-active', item === tool);
      button.setAttribute('aria-pressed', String(item === tool));
    }
    this.undoBtn.disabled = undoLabel === null;
    this.undoBtn.dataset.tip = undoLabel ? `Undo ${undoLabel.toLowerCase()}  (${keyLabel('Ctrl+Z')})` : 'Nothing to undo';
    this.redoBtn.disabled = redoLabel === null;
    this.redoBtn.dataset.tip = redoLabel ? `Redo ${redoLabel.toLowerCase()}  (${keyLabel('Ctrl+Shift+Z')})` : 'Nothing to redo';
    this.outlineBtn.classList.toggle('is-active', outlineOpen);
    this.outlineBtn.setAttribute('aria-expanded', String(outlineOpen));
  }
}

/* ---- Selection bar ---- */

const ALIGNMENTS = [
  { edge: 'left', label: 'Left', d: 'M4 3v18M8 7h12M8 12h7M8 17h10' },
  { edge: 'center', label: 'Centre', d: 'M12 3v18M6 7h12M8.5 12h7M7 17h10' },
  { edge: 'right', label: 'Right', d: 'M20 3v18M4 7h12M9 12h7M6 17h10' },
  { edge: 'top', label: 'Top', d: 'M3 4h18M7 8v12M12 8v7M17 8v10' },
  { edge: 'middle', label: 'Middle', d: 'M3 12h18M7 6v12M12 8.5v7M17 7v10' },
  { edge: 'bottom', label: 'Bottom', d: 'M3 20h18M7 4v12M12 9v7M17 6v10' }
];

function barButton(icon, label, onClick, disabled = false) {
  return h('button.canvas-bar-btn', { type: 'button', 'aria-label': label, 'data-tip': label, disabled, on: { click: onClick } }, canvasIcon(icon));
}

function alignGlyph(d) {
  const svg = svgEl('svg', { class: 'canvas-glyph', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { d }));
  return svg;
}

/** What can be done to the selection. It stays put on screen, so it never covers what it acts on. */
export function selectionBar(props) {
  if (props.linkOnly) {
    return h('div.canvas-bar', { role: 'toolbar', 'aria-label': 'Connection' },
      h('span.canvas-bar-count', { text: 'Connection' }),
      barButton('label', 'Label  (Enter)', props.onLabelLink),
      barButton('reverse', 'Reverse direction', props.onReverseLink),
      barButton('trash', 'Delete  (Del)', props.onDelete));
  }
  const bar = h('div.canvas-bar', { role: 'toolbar', 'aria-label': 'Selection' },
    h('span.canvas-bar-count', { text: `${props.count} selected` }));
  if (props.askable) {
    bar.appendChild(h('button.canvas-bar-ask', { type: 'button', 'data-tip': 'Ask about this  (A)', on: { click: props.onAsk } }, canvasIcon('ask'), 'Ask'));
  }
  if (props.colorable) {
    bar.append(h('span.canvas-bar-sep'), h('div.canvas-swatches', { role: 'group', 'aria-label': 'Colour' },
      h('button.canvas-swatch.canvas-swatch--none' + (props.color === undefined ? '.is-active' : ''), {
        type: 'button', 'aria-label': 'No colour', 'data-tip': 'No colour', on: { click: () => props.onColor(undefined) }
      }),
      CANVAS_COLORS.map((item) => h('button.canvas-swatch' + (props.color === item ? '.is-active' : ''), {
        type: 'button', 'data-color': item, 'aria-label': item, 'aria-pressed': String(props.color === item),
        on: { click: () => props.onColor(item) }
      }))));
  }
  bar.appendChild(h('span.canvas-bar-sep'));
  if (props.blocks >= 2) {
    const anchor = h('span.canvas-bar-anchor');
    let menu = null;
    const closeMenu = () => {
      menu?.remove();
      menu = null;
      document.removeEventListener('pointerdown', onOutside, true);
    };
    const onOutside = (e) => { if (!anchor.contains(e.target)) closeMenu(); };
    const choose = (action) => () => { action(); closeMenu(); };
    const openMenu = () => {
      if (menu) { closeMenu(); return; }
      menu = h('div.canvas-arrange', { role: 'menu', 'aria-label': 'Arrange' },
        h('div.canvas-arrange-grid', ALIGNMENTS.map(({ edge, label, d }) => h('button.canvas-bar-btn', {
          type: 'button', role: 'menuitem', 'aria-label': `Align ${label.toLowerCase()}`, title: `Align ${label.toLowerCase()}`,
          on: { click: choose(() => props.onAlign(edge)) }
        }, alignGlyph(d)))),
        h('button.canvas-arrange-item', { type: 'button', role: 'menuitem', disabled: props.blocks < 3, text: 'Space evenly across', on: { click: choose(() => props.onDistribute('x')) } }),
        h('button.canvas-arrange-item', { type: 'button', role: 'menuitem', disabled: props.blocks < 3, text: 'Space evenly down', on: { click: choose(() => props.onDistribute('y')) } }),
        h('button.canvas-arrange-item', { type: 'button', role: 'menuitem', text: 'Tidy up', on: { click: choose(props.onTidy) } }));
      anchor.appendChild(menu);
      document.addEventListener('pointerdown', onOutside, true);
    };
    anchor.appendChild(barButton('align', 'Arrange', openMenu));
    bar.appendChild(anchor);
  }
  if (props.connectable) bar.appendChild(barButton('connect', 'Connect these two', props.onConnect));
  if (props.collapsible) {
    bar.appendChild(barButton(props.collapsed ? 'expand' : 'collapse', props.collapsed ? 'Expand  (.)' : 'Collapse to title  (.)', props.onCollapse));
  }
  bar.append(
    barButton('frame', `Put in a frame  (${keyLabel('Ctrl+G')})`, props.onFrame),
    barButton('duplicate', `Duplicate  (${keyLabel('Ctrl+D')})`, props.onDuplicate),
    barButton('copy', `Copy as markdown  (${keyLabel('Ctrl+C')})`, props.onCopy),
    barButton('zoomTo', 'Zoom to selection  (Z)', props.onZoom),
    barButton('trash', 'Delete  (Del)', props.onDelete));
  return bar;
}

/* ---- Outline ---- */

const KIND_ICON = { frame: 'frame', note: 'note', message: null, expansion: null, page: 'external' };

/** Every card as a list: click to go there, or type to find a card and dim the rest. */
export class Outline {
  /** actions: { onSearchMatches(ids | null), onGoTo(id), onClose() } */
  constructor(actions) {
    this.actions = actions;
    this.rows = [];
    this.query = '';
    this.activeIndex = 0;
    this.selectedIds = new Set();
    this.streamingIds = new Set();
    this.input = h('input', {
      'aria-label': 'Search this canvas', placeholder: 'Search this canvas',
      on: {
        input: () => { this.query = this.input.value; this.activeIndex = 0; this.render(); this.reportMatches(); },
        keydown: (e) => this.handleKey(e)
      }
    });
    this.count = h('span.canvas-outline-count', { role: 'status' });
    this.list = h('div.canvas-outline-list');
    this.el = h('aside.canvas-outline', { 'aria-label': 'Canvas outline' },
      h('div.canvas-outline-search', canvasIcon('search'), this.input, this.count), this.list);
  }

  get searching() { return this.query.trim() !== ''; }

  hits() { return searchCanvasOutline(this.rows, this.query); }

  shown() { return this.searching ? this.hits() : this.rows; }

  reportMatches() {
    this.actions.onSearchMatches(this.searching ? new Set(this.hits().map((hit) => hit.id)) : null);
  }

  focus() {
    this.input.focus({ preventScroll: true });
    this.input.select();
  }

  handleKey(e) {
    e.stopPropagation();
    const shown = this.shown();
    const step = (direction) => {
      if (shown.length === 0) return;
      this.activeIndex = (this.activeIndex + direction + shown.length) % shown.length;
      this.render();
      if (this.searching) this.actions.onGoTo(shown[this.activeIndex].id);
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) step(-1);
      else if (shown[this.activeIndex]) this.actions.onGoTo(shown[this.activeIndex].id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (this.searching) { this.input.value = ''; this.query = ''; this.render(); this.reportMatches(); }
      else this.actions.onClose();
    }
  }

  update({ rows, selectedIds, streamingIds }) {
    this.rows = rows;
    this.selectedIds = selectedIds;
    this.streamingIds = streamingIds;
    this.render();
    if (this.searching) this.reportMatches();
  }

  render() {
    const shown = this.shown();
    const searching = this.searching;
    const hits = searching ? shown.length : 0;
    this.count.hidden = !searching;
    this.count.textContent = hits === 0 ? 'None' : `${Math.min(this.activeIndex + 1, hits)}/${hits}`;
    const rows = shown.map((row, index) => {
      const icon = KIND_ICON[row.kind];
      const classes = ['canvas-outline-row', `canvas-outline-row--${row.kind}`];
      if (this.selectedIds.has(row.id)) classes.push('is-selected');
      if (index === this.activeIndex) classes.push('is-active');
      return h('button', {
        type: 'button', class: classes.join(' '), 'data-color': row.color, title: row.label,
        style: { paddingLeft: `${10 + (searching ? 0 : row.depth) * 14}px` },
        on: { click: () => { this.activeIndex = index; this.render(); this.actions.onGoTo(row.id); } }
      },
      h('span.canvas-outline-mark', { 'aria-hidden': 'true' }, icon ? canvasIcon(icon) : null),
      h('span.canvas-outline-text', h('span.canvas-outline-label', { text: row.label }),
        row.snippet ? h('span.canvas-outline-snippet', { text: row.snippet }) : null),
      this.streamingIds.has(row.id) ? h('span.canvas-outline-writing', { 'aria-label': 'Writing' }) : null);
    });
    this.list.replaceChildren(...(shown.length === 0
      ? [h('p.canvas-outline-empty', { text: searching ? 'Nothing on this canvas matches.' : 'Nothing on this canvas yet.' })]
      : rows));
    this.list.querySelector('.canvas-outline-row.is-active')?.scrollIntoView({ block: 'nearest' });
  }
}

/* ---- Map ---- */

const PADDING_FRACTION = 0.08;

/** The whole canvas at a glance: click or drag to go somewhere. */
export class Minimap {
  /** onNavigate(point, dragging) */
  constructor(onNavigate) {
    this.held = false;
    this.content = null;
    this.size = { width: 0, height: 0 };
    this.view = svgEl('rect', { class: 'canvas-minimap-view' });
    this.items = svgEl('g');
    this.el = svgEl('svg', { class: 'canvas-minimap', role: 'img', 'aria-label': 'Map of the canvas. Click to go somewhere.', preserveAspectRatio: 'xMidYMid meet' });
    this.el.append(this.items, this.view);
    const worldPoint = (e) => {
      const matrix = this.el.getScreenCTM();
      if (!matrix) return null;
      const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
      return { x: point.x, y: point.y };
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.el.setPointerCapture(e.pointerId);
      this.held = true;
      const point = worldPoint(e);
      if (point) onNavigate(point, false);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!this.held) return;
      const point = worldPoint(e);
      if (point) onNavigate(point, true);
    });
    this.el.addEventListener('pointerup', () => { this.held = false; if (this.lastViewport) this.paint(this.lastViewport); });
    this.el.addEventListener('pointercancel', () => { this.held = false; });
  }

  update({ cards, frames, selectedIds, size, viewport }) {
    this.size = size;
    this.content = boundsOf([...cards.map((card) => card.rect), ...frames.map((frame) => frame.rect)]);
    const rect = (item, cls) => svgEl('rect', {
      class: cls + (selectedIds.has(item.id) ? ' is-selected' : ''),
      ...(item.color ? { 'data-color': item.color } : {}),
      x: item.rect.x, y: item.rect.y, width: item.rect.w, height: item.rect.h
    });
    this.items.replaceChildren(...frames.map((frame) => rect(frame, 'canvas-minimap-frame')), ...cards.map((card) => rect(card, 'canvas-minimap-card')));
    this.paint(viewport);
  }

  /** Follows the viewport frame by frame, without rebuilding anything. */
  paint(viewport) {
    this.lastViewport = viewport;
    const visible = visibleWorldRect(viewport, this.size);
    this.view.setAttribute('x', String(visible.x));
    this.view.setAttribute('y', String(visible.y));
    this.view.setAttribute('width', String(Math.max(visible.w, 0)));
    this.view.setAttribute('height', String(Math.max(visible.h, 0)));
    // Held still under a drag, or the map would slide away from the pointer.
    if (this.held) return;
    const whole = this.content ? unionRect(this.content, visible) : visible;
    const pad = Math.max(whole.w, whole.h) * PADDING_FRACTION;
    if (!(whole.w > 0) || !(whole.h > 0)) return;
    this.el.setAttribute('viewBox', `${whole.x - pad} ${whole.y - pad} ${whole.w + pad * 2} ${whole.h + pad * 2}`);
  }
}

/* ---- Shortcuts ---- */

const SHORTCUTS = [
  {
    title: 'Tools',
    items: [
      [['V'], 'Select: click, Shift+click, or drag a box around cards'],
      [['H'], 'Hand: drag anywhere to pan'],
      [['R'], 'Answer: draw a rectangle to ask in'],
      [['T'], 'Note: your own text'],
      [['C'], 'Connect: drag from one card to another'],
      [['F'], 'Frame: group a region under a title']
    ]
  },
  {
    title: 'Asking',
    items: [
      [['Enter'], 'Reply below the focused card, or the newest one'],
      [['Shift', 'Enter'], 'Continue the focused card on its right'],
      [['A'], 'Ask about the selected cards'],
      [['N'], 'Ask a question in a new session'],
      [['E'], 'Edit the focused question and resend, or a note'],
      [['Ctrl', 'E'], 'Expand the text selected in a card; add Shift to ask first'],
      [['Double-click'], 'On empty space: ask here. On a title: zoom to it'],
      [['Alt', '↑↓←→'], 'While asking: resize the card, and so the answer']
    ]
  },
  {
    title: 'Selection',
    items: [
      [['Ctrl', 'A'], 'Select everything'],
      [['Shift', '↑↓←→'], 'Add the nearest card that way'],
      [['Ctrl', '↑↓←→'], 'Nudge the selection; Shift for further'],
      [['Ctrl', 'D'], 'Duplicate'],
      [['Ctrl', 'C'], 'Copy as markdown'],
      [['Ctrl', 'V'], 'Paste text as a note'],
      [['Ctrl', 'G'], 'Put in a frame'],
      [['.'], 'Collapse to the title, or expand'],
      [['Delete'], 'Delete'],
      [['Ctrl', 'Z'], 'Undo; add Shift to redo'],
      [['Shift', 'Drag'], 'Move a card with everything touching it'],
      [['Alt', 'Drag'], 'Pull a card and its attached children away from the rest']
    ]
  },
  {
    title: 'Getting around',
    items: [
      [['↑', '↓', '←', '→'], 'Go to the nearest card that way, or pan'],
      [['Tab'], 'Next card, term or button'],
      [['B'], 'Back: from an expansion to its term, or to the previous card'],
      [['Alt', '←', '→'], 'Back and forward through places you jumped to'],
      [['O'], 'Outline of every card'],
      [['Ctrl', 'F'], 'Search this canvas'],
      [['M'], 'Show or hide the map'],
      [['PgUp', 'PgDn'], 'Scroll the focused card'],
      [['Z'], 'Zoom to the selection'],
      [['+', '−', '0', '1'], 'Zoom in, zoom out, show everything, 100%'],
      [['Right-drag'], 'Pan, anywhere; a plain right click opens the menu'],
      [['Space'], 'Hold and drag to pan'],
      [['Ctrl', 'Scroll'], 'Zoom at the pointer'],
      [['Scroll'], 'Pan up and down'],
      [['Shift', 'Scroll'], 'Pan left and right'],
      [['Esc'], 'Cancel, then clear the selection']
    ]
  }
];

/** The canvas keyboard and mouse map, toggled with `?`. */
export function shortcutsPanel(onClose) {
  return h('section.canvas-shortcuts', { 'aria-label': 'Keyboard and mouse shortcuts' },
    h('header.canvas-shortcuts-header', h('h2', { text: 'Keyboard and mouse' }),
      h('button.canvas-icon-btn.canvas-icon-btn--close', { type: 'button', 'aria-label': 'Close', text: '×', on: { click: onClose } })),
    SHORTCUTS.map(({ title, items }) => h('div.canvas-shortcut-group', h('h3', { text: title }),
      h('dl', items.map(([keys, what]) => h('div.canvas-shortcut',
        h('dt', keys.map((key) => h('kbd', { text: key === 'Ctrl' ? keyLabel('Ctrl+').replace('+', '') || 'Ctrl' : key }))),
        h('dd', { text: what })))))),
    h('p.canvas-shortcuts-note', { text: 'Clicking a link travels along it; the arrow button on an expansion returns to its term.' }));
}
