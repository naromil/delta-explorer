/* The canvas as a list: frames, then the sessions inside them, each card under the one it
 * came from. It is what the outline panel shows and what canvas search runs over.
 *
 * Ported from Delta Explorer's src/shared/canvas-outline.ts. */

import { sourceCardId } from './canvas.js';
import { cardText, cardsInsideFrame } from './canvas-selection.js';
import { flattenMarkdown } from './rich-text.js';
const LABEL_CHARS = 80;
const SNIPPET_RADIUS = 50;
function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}
function byPosition(a, b) {
  return a.rect.y - b.rect.y || a.rect.x - b.rect.x;
}
function cardRow(card, turns, depth) {
  const { title, body } = cardText(card, turns);
  const flatBody = oneLine(flattenMarkdown(body));
  const flatTitle = oneLine(flattenMarkdown(title));
  return {
    id: card.id,
    kind: card.kind,
    label: (flatTitle || flatBody || 'Empty note').slice(0, LABEL_CHARS),
    text: flatTitle === '' ? flatBody : `${flatTitle} ${flatBody}`,
    depth,
    ...(card.color ? { color: card.color } : {})
  };
}
function frameRow(frame) {
  const title = oneLine(frame.title);
  return {
    id: frame.id,
    kind: 'frame',
    label: title || 'Untitled frame',
    text: title,
    depth: 0,
    ...(frame.color ? { color: frame.color } : {})
  };
}
/** Frames in reading order with what they hold, then everything outside any frame. */
export function canvasOutline(layout, turns) {
  const byId = new Map(layout.cards.map((card) => [card.id, card]));
  const children = new Map();
  const roots = [];
  for (const card of layout.cards) {
    const source = sourceCardId(card);
    if (source !== undefined && byId.has(source)) {
      children.set(source, [...(children.get(source) ?? []), card]);
    }
    else {
      roots.push(card);
    }
  }
  const rows = [];
  const visit = (card, depth) => {
    rows.push(cardRow(card, turns, depth));
    for (const child of (children.get(card.id) ?? []).sort(byPosition))
      visit(child, depth + 1);
  };
  const placed = new Set();
  // The smallest frame claims a card first, so a nested frame keeps what it holds.
  const smallestFirst = [...layout.frames].sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
  const held = new Map();
  for (const frame of smallestFirst) {
    const inside = cardsInsideFrame(roots, frame).filter((card) => !placed.has(card.id));
    for (const card of inside)
      placed.add(card.id);
    held.set(frame.id, inside);
  }
  for (const frame of [...layout.frames].sort(byPosition)) {
    rows.push(frameRow(frame));
    for (const card of (held.get(frame.id) ?? []).sort(byPosition))
      visit(card, 1);
  }
  for (const card of roots.filter((item) => !placed.has(item.id)).sort(byPosition))
    visit(card, 0);
  return rows;
}
function snippetAround(text, at, length) {
  const start = Math.max(at - SNIPPET_RADIUS, 0);
  const end = Math.min(at + length + SNIPPET_RADIUS, text.length);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
/** Rows holding every word of the query, in outline order. */
export function searchCanvasOutline(rows, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0)
    return [];
  return rows.flatMap((row) => {
    const haystack = row.text.toLowerCase();
    if (!words.every((word) => haystack.includes(word)))
      return [];
    const inLabel = words.every((word) => row.label.toLowerCase().includes(word));
    return [
      inLabel
        ? row
        : {
          ...row,
          snippet: snippetAround(row.text, haystack.indexOf(words[0]), words[0].length)
        }
    ];
  });
}
