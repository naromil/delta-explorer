/* Undo and redo for a canvas, as patches rather than snapshots, so taking back a move
 * never rewinds an answer that is still streaming. Everything here is pure.
 *
 * Ported from Delta Explorer's src/shared/canvas-history.ts. */

import { normalizeCanvasLayout } from './canvas.js';
import { finalizeTurns } from './rich-text.js';
function diffList(before, after) {
  const beforeAt = new Map(before.map((item, index) => [item.id, index]));
  const afterAt = new Map(after.map((item, index) => [item.id, index]));
  const changes = [];
  for (const [index, item] of before.entries()) {
    const other = afterAt.get(item.id);
    if (other === undefined) {
      changes.push({ id: item.id, before: item, beforeIndex: index, afterIndex: -1 });
    }
    else if (after[other] !== item) {
      changes.push({
        id: item.id,
        before: item,
        after: after[other],
        beforeIndex: index,
        afterIndex: other
      });
    }
  }
  for (const [index, item] of after.entries()) {
    if (!beforeAt.has(item.id)) {
      changes.push({ id: item.id, after: item, beforeIndex: -1, afterIndex: index });
    }
  }
  return changes;
}
/** What an action changed, or null when it changed nothing. */
export function diffCanvas(label, before, after) {
  const patch = {
    label,
    cards: diffList(before.cards, after.cards),
    frames: diffList(before.frames, after.frames),
    links: diffList(before.links, after.links),
    // A restored turn comes back at rest: its stream was cancelled when it left. Only a
    // turn that changed is finalized, so one still streaming elsewhere never counts as changed.
    turns: diffList(before.turns, after.turns).map((change) => change.before ? { ...change, before: finalizeTurns([change.before])[0] } : change)
  };
  const empty = patch.cards.length === 0 &&
    patch.frames.length === 0 &&
    patch.links.length === 0 &&
    patch.turns.length === 0;
  return empty ? null : patch;
}
function applyChanges(items, changes, direction) {
  const result = [...items];
  const undoing = direction === 'undo';
  const ordered = [...changes].sort((a, b) => undoing ? a.beforeIndex - b.beforeIndex : a.afterIndex - b.afterIndex);
  for (const change of ordered) {
    const to = undoing ? change.before : change.after;
    const index = result.findIndex((item) => item.id === change.id);
    if (to === undefined) {
      if (index >= 0)
        result.splice(index, 1);
    }
    else if (index >= 0) {
      result[index] = to;
    }
    else if (undoing ? change.after === undefined : change.before === undefined) {
      // It comes back where it was; one that left in some other way stays gone.
      const at = undoing ? change.beforeIndex : change.afterIndex;
      result.splice(Math.min(at, result.length), 0, to);
    }
  }
  return result;
}
/** Applies a patch to the canvas as it is now, not as it was when the patch was made. */
export function applyCanvasPatch(current, patch, direction) {
  const undoing = direction === 'undo';
  for (const change of patch.turns) {
    const expected = undoing ? change.after : change.before;
    const now = current.turns.find((turn) => turn.id === change.id);
    if (expected === undefined ? now !== undefined : now !== expected) {
      return { ok: false };
    }
  }
  const turns = applyChanges(current.turns, patch.turns, direction);
  const layout = normalizeCanvasLayout({
    cards: applyChanges(current.cards, patch.cards, direction),
    frames: applyChanges(current.frames, patch.frames, direction),
    links: applyChanges(current.links, patch.links, direction),
    viewport: { x: 0, y: 0, zoom: 1 }
  }, turns);
  return {
    ok: true,
    snapshot: { turns, cards: layout.cards, frames: layout.frames, links: layout.links }
  };
}
