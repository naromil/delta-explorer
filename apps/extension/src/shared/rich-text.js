/* Rich text model, ported from Delta Explorer's src/shared/rich-text.ts.
 *
 * A turn is one markdown `content` string plus `ExpansionNode` annotations
 * anchored by absolute source offsets:
 *
 *   { id, start, end, originalText, answer, prompt?, attachments?,
 *     status: 'loading' | 'done' | 'error', error?, folded, children: [] }
 *
 * Child offsets are relative to the parent's `answer`. Pure: no DOM. */

export const EXPANSION_EMPTY_ERROR = 'No output returned.';
export const EXPANSION_INTERRUPTED_ERROR = 'Response interrupted.';

/* ---- Markdown flattening ---- */

export function flattenMarkdown(text) {
  let flat = String(text || '').replace(/^#{1,6}\s+/gm, '');
  flat = flat.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  flat = flat.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
  flat = flat.replace(/`([^`]+)`/g, '$1');
  flat = flat.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  flat = flat.replace(/^[\s]*[-*+]\s+/gm, '· ');
  flat = flat.replace(/^[\s]*\d+\.\s+/gm, '· ');
  flat = flat.replace(/^>\s+/gm, '');
  flat = flat.replace(/^[-*_]{3,}\s*$/gm, '');
  return flat;
}

/* ---- Block boundaries ---- */

const BLOCK_LINE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t]|\||```|~~~| {4}\S)/;
const BLANK_LINE = /^[ \t]*$/;

function isBlockBoundaryAt(source, offset) {
  const previousEnd = offset - 1;
  if (previousEnd > 0) {
    const previousStart = source.lastIndexOf('\n', previousEnd - 1) + 1;
    if (BLANK_LINE.test(source.slice(previousStart, previousEnd))) return true;
  }
  const lineEnd = source.indexOf('\n', offset);
  const line = source.slice(offset, lineEnd < 0 ? source.length : lineEnd);
  return BLOCK_LINE.test(line);
}

/** True when the range covers a markdown block boundary; it cannot become one inline frame. */
export function crossesBlockBoundary(source, start, end) {
  let offset = source.indexOf('\n', start) + 1;
  while (offset > 0 && offset < end) {
    if (isBlockBoundaryAt(source, offset)) return true;
    const next = source.indexOf('\n', offset);
    if (next < 0) break;
    offset = next + 1;
  }
  return false;
}

/* ---- Insertion ---- */

export function isSameRange(a, b) {
  return a.start === b.start && a.end === b.end;
}

/** The one expansion a range shows: the open one, else the newest. */
export function activeExpansion(group) {
  for (let i = group.length - 1; i >= 0; i--) if (!group[i].folded) return group[i];
  return group[group.length - 1];
}

/** Returns the refusal reason, or `null` when the target is expandable. */
export function validateInsertion(source, expansions, range) {
  const { start, end } = range;
  const inBounds = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= source.length && start <= end;
  if (!inBounds) return 'out-of-bounds';
  if (start === end) return 'empty-range';
  if (source.slice(start, end).trim() === '') return 'blank-selection';

  for (const node of expansions) {
    if (end <= node.start || start >= node.end) continue;
    // The same range again is another question about that passage, not a conflict.
    if (start === node.start && end === node.end) continue;
    if (start >= node.start && end <= node.end) return 'inside-expansion';
    return 'overlaps-expansion';
  }

  if (!range.atomic && crossesBlockBoundary(source, start, end)) return 'cross-block';
  return null;
}

/** Full validation, including that the covered slice still matches what the user selected. */
export function validateExpansionTarget(source, expansions, target) {
  if (target.selection !== undefined && source.slice(target.start, target.end) !== target.selection) {
    return 'selection-mismatch';
  }
  return validateInsertion(source, expansions, target);
}

export function insertExpansion(source, expansions, target, id, prompt, attachments) {
  const refusal = validateExpansionTarget(source, expansions, target);
  if (refusal) return { ok: false, reason: refusal };

  const node = {
    id,
    start: target.start,
    end: target.end,
    originalText: source.slice(target.start, target.end),
    answer: '',
    ...(prompt !== undefined ? { prompt } : {}),
    ...(attachments && attachments.length ? { attachments } : {}),
    status: 'loading',
    folded: false,
    children: []
  };

  // One range shows one frame at a time, and the newest question is the one asked for.
  const others = expansions.map((other) =>
    isSameRange(other, node) && !other.folded ? { ...other, folded: true } : other
  );
  const next = [...others, node].sort((a, b) => a.start - b.start);
  return { ok: true, expansions: next, node };
}

/* ---- Lookup ---- */

export function findExpansionInNodes(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return { node, parent: null, siblings: nodes };
    const found = findExpansionInNodes(node.children, id);
    if (found) return { node: found.node, parent: found.parent || node, siblings: found.siblings };
  }
  return null;
}

export function findExpansionInTurns(turns, id) {
  for (const turn of turns) {
    const found = findExpansionInNodes(turn.expansions || [], id);
    if (found) return { ...found, turn };
  }
  return null;
}

/** Ancestors of `id`, outermost first, ending with the expansion itself. */
export function expansionPath(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const below = expansionPath(node.children, id);
    if (below) return [node, ...below];
  }
  return null;
}

/** The expansion and everything nested under it. */
export function expansionSubtreeIds(node) {
  return [node.id, ...node.children.flatMap(expansionSubtreeIds)];
}

export function maxExpansionId(turns) {
  let max = 0;
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.id > max) max = node.id;
      visit(node.children);
    }
  };
  for (const turn of turns) visit(turn.expansions || []);
  return max;
}

/* ---- Updates ---- */

function updateInNodes(nodes, id, patch, state) {
  let changed = false;
  const next = nodes.map((node) => {
    if (state.matched) return node;
    if (node.id === id) {
      state.matched = true;
      changed = true;
      return { ...node, ...patch };
    }
    const children = updateInNodes(node.children, id, patch, state);
    if (children === node.children) return node;
    changed = true;
    return { ...node, children };
  });
  return changed ? next : nodes;
}

/** Applies a patch to one expansion, at any depth; first match only. */
export function updateExpansion(turns, id, patch) {
  const state = { matched: false };
  let changed = false;
  const next = turns.map((turn) => {
    if (state.matched) return turn;
    const expansions = updateInNodes(turn.expansions || [], id, patch, state);
    if (expansions === turn.expansions) return turn;
    changed = true;
    return { ...turn, expansions };
  });
  return changed ? next : turns;
}

/** Back to waiting for a fresh answer; nested expansions go with the old answer. */
export function restartExpansion(turns, id) {
  return updateExpansion(turns, id, { answer: '', status: 'loading', error: undefined, folded: false, children: [] });
}

/** Unfolding one expansion folds the others on its range. */
export function setExpansionFolded(turns, id, folded) {
  if (folded) return updateExpansion(turns, id, { folded });
  const location = findExpansionInTurns(turns, id);
  if (!location) return turns;
  let next = turns;
  for (const sibling of location.siblings) {
    if (sibling.id !== id && !sibling.folded && isSameRange(sibling, location.node)) {
      next = updateExpansion(next, sibling.id, { folded: true });
    }
  }
  return updateExpansion(next, id, { folded });
}

function removeInNodes(nodes, id, state) {
  let changed = false;
  const next = [];
  for (const node of nodes) {
    if (!state.removed && node.id === id) {
      state.removed = true;
      changed = true;
      continue;
    }
    const children = removeInNodes(node.children, id, state);
    if (children === node.children) {
      next.push(node);
      continue;
    }
    changed = true;
    next.push({ ...node, children });
  }
  return changed ? next : nodes;
}

export function removeExpansionInTurns(turns, id) {
  const state = { removed: false };
  let changed = false;
  const next = turns.map((turn) => {
    if (state.removed) return turn;
    const expansions = removeInNodes(turn.expansions || [], id, state);
    if (expansions === turn.expansions) return turn;
    changed = true;
    return { ...turn, expansions };
  });
  return changed ? next : turns;
}

/* ---- Streaming ---- */

/** Applies one chunk `{ delta?, text?, done?, error? }` to one expansion. */
export function applyExpansionChunk(turns, id, chunk) {
  const location = findExpansionInTurns(turns, id);
  if (!location) return turns;
  if (chunk.error !== undefined) {
    return updateExpansion(turns, id, { status: 'error', error: chunk.error, ...(chunk.text ? { answer: chunk.text } : {}) });
  }
  let next = turns;
  if (chunk.text !== undefined && chunk.text !== '') {
    next = updateExpansion(next, id, { answer: chunk.text });
  } else if (chunk.delta) {
    next = updateExpansion(next, id, { answer: location.node.answer + chunk.delta });
  }
  if (chunk.done) {
    const text = chunk.text !== undefined ? chunk.text : location.node.answer;
    next = String(text).trim() === ''
      ? updateExpansion(next, id, { status: 'error', error: EXPANSION_EMPTY_ERROR })
      : updateExpansion(next, id, { status: 'done' });
  }
  return next;
}

/** Turns any transient `loading` node into a recoverable error, so nothing waits forever. */
export function finalizeExpansions(nodes) {
  let changed = false;
  const next = nodes.map((node) => {
    let result = node;
    if (node.status === 'loading') {
      changed = true;
      result = { ...node, status: 'error', error: node.answer.trim() === '' ? EXPANSION_EMPTY_ERROR : EXPANSION_INTERRUPTED_ERROR };
    }
    const children = finalizeExpansions(node.children);
    if (children !== result.children) {
      changed = true;
      result = { ...result, children };
    }
    return result;
  });
  return changed ? next : nodes;
}

export function finalizeTurns(turns) {
  let changed = false;
  const next = turns.map((turn) => {
    const expansions = finalizeExpansions(turn.expansions || []);
    if (expansions === turn.expansions) return turn;
    changed = true;
    return { ...turn, expansions };
  });
  return changed ? next : turns;
}

/* ---- Turn-scoped operations ---- */

function replaceChildren(nodes, id, children) {
  let matched = false;
  const next = nodes.map((node) => {
    if (matched) return node;
    if (node.id === id) {
      matched = true;
      return { ...node, children };
    }
    const nested = replaceChildren(node.children, id, children);
    return nested === node.children ? node : { ...node, children: nested };
  });
  return matched ? next : nodes;
}

export function insertExpansionInTurns(turns, turnId, target, newExpansionId, prompt, attachments) {
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) return { ok: false, reason: 'turn-not-found' };
  const turn = turns[index];

  const parentId = target.parentExpansionId;
  const parent = parentId === undefined ? null : findExpansionInNodes(turn.expansions, parentId);
  if (parentId !== undefined && !parent) return { ok: false, reason: 'parent-not-found' };

  const result = insertExpansion(
    parent ? parent.node.answer : turn.content,
    parent ? parent.node.children : turn.expansions,
    target,
    newExpansionId,
    prompt,
    attachments
  );
  if (!result.ok) return result;

  const expansions = parent ? replaceChildren(turn.expansions, parentId, result.expansions) : result.expansions;
  return {
    ok: true,
    node: result.node,
    turns: turns.map((item, i) => (i === index ? { ...item, expansions } : item))
  };
}

/** The markdown the model should see as its own previous answer, plus the excerpt. */
export function expansionMessageInput(turn, parentId, range) {
  const source = parentId === undefined
    ? turn.content
    : (findExpansionInNodes(turn.expansions, parentId) || {}).node?.answer;
  if (source === undefined) return null;
  if (range.start < 0 || range.end > source.length || range.start >= range.end) return null;
  return { answer: source, selection: source.slice(range.start, range.end) };
}
