/* Canvas state: one open canvas, its turns and layout, and its streams. Ported from
 * Delta Explorer's hooks/useCanvas.ts.
 *
 * A canvas is a conversation record with `source: 'canvas'`, so the store and the curator
 * treat it as one. Unlike a chat, its turns are a pool rather than a line: what a request
 * sends is found by walking a card's session (src/shared/canvas-request.js).
 *
 * Listeners get `{ content, layout, viewport, meta, history, streaming }` flags saying what
 * changed; the board re-renders from `store.doc` and `store.meta`. */

import { openStream, rpc } from '../api.js';
import {
  cascadeCardIds,
  DEFAULT_PAGE_SIZE,
  DEFAULT_VIEWPORT,
  fitCardHeight,
  normalizeCanvasLayout,
  raisedStack,
  setCardCollapsed,
  withoutField
} from '../../shared/canvas.js';
import { duplicateSelection } from '../../shared/canvas-arrange.js';
import { applyCanvasPatch, diffCanvas } from '../../shared/canvas-history.js';
import { expansionCardRequest, messageCardRequest } from '../../shared/canvas-request.js';
import { buildConversationTitle, CONVERSATION_TITLE_MAX_LENGTH } from '../../shared/conversation.js';
import {
  applyExpansionChunk,
  expansionMessageInput,
  expansionSubtreeIds,
  finalizeTurns,
  findExpansionInTurns,
  insertExpansionInTurns,
  maxExpansionId,
  removeExpansionInTurns,
  restartExpansion,
  updateExpansion
} from '../../shared/rich-text.js';
import { bodyCharWidth } from './helpers.js';

const SAVE_DELAY_MS = 300;
export const UNTITLED = 'Untitled canvas';
const HISTORY_LIMIT = 100;
/** Page text kept on a page card; every session that continues it sends this much. */
export const PAGE_TEXT_LIMIT = 21_000;

let nextTurnId = Date.now();
const newId = () => crypto.randomUUID();

const emptyDoc = () => ({
  turns: [],
  layout: { cards: [], frames: [], links: [], stack: [], viewport: DEFAULT_VIEWPORT }
});

function snapshotOf({ turns, layout }) {
  return { turns, cards: layout.cards, frames: layout.frames, links: layout.links };
}

function newMeta() {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: UNTITLED, createdAt: now, updatedAt: now, kbFed: false, persisted: false };
}

function requestBelongsTo(request, card) {
  if (card.kind === 'message') return request.kind === 'send' && request.turnId === card.turnId;
  if (card.kind === 'expansion') return request.kind === 'expand' && request.expansionId === card.expansionId;
  return false;
}

export class CanvasStore {
  constructor() {
    this.doc = emptyDoc();
    this.meta = newMeta();
    this.loaded = false;
    /** requestKey -> { kind: 'send', turnId } | { kind: 'expand', expansionId }, plus its stream. */
    this.requests = new Map();
    this.requestCounter = 0;
    this.expansionCounter = 1;
    this.saveTimer = null;
    this.undoStack = [];
    this.redoStack = [];
    /** Cards whose height should be fitted to their answer the next time they are on screen. */
    this.fitCardIds = new Set();
    this.listeners = new Set();
    this.onSaveError = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change) {
    for (const listener of this.listeners) listener(change);
  }

  get cards() { return this.doc.layout.cards; }
  get frames() { return this.doc.layout.frames; }
  get links() { return this.doc.layout.links; }
  get stack() { return this.doc.layout.stack; }
  get viewport() { return this.doc.layout.viewport; }
  get turns() { return this.doc.turns; }
  get canvasId() { return this.meta.id; }
  get title() { return this.meta.title; }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? null; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? null; }

  /** Assistant turns with a request in flight. */
  get streamingTurnIds() {
    const ids = new Set();
    for (const request of this.requests.values()) if (request.kind === 'send') ids.add(request.turnId);
    return ids;
  }

  updateDoc(change, flags = { layout: true }) {
    this.doc = change(this.doc);
    this.emit(flags);
  }

  updateMeta(patch) {
    this.meta = { ...this.meta, ...patch };
    this.emit({ meta: true });
  }

  /* ---- Persistence ---- */

  flushSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const current = this.meta;
    const { turns, layout } = this.doc;
    const onFailure = (err) => {
      console.warn('Failed to save canvas:', err);
      this.onSaveError?.(err);
    };
    if (layout.cards.length === 0 && layout.frames.length === 0) {
      if (!current.persisted) return Promise.resolve();
      this.meta = { ...current, persisted: false };
      return rpc('deleteConversation', { id: current.id }).catch(onFailure);
    }
    this.meta = { ...current, persisted: true };
    const record = {
      id: current.id,
      title: current.title,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      source: 'canvas',
      kbFed: false,
      state: { turns: finalizeTurns(turns) },
      canvas: layout
    };
    // kbFed is decided by the store: a save that leaves updatedAt alone keeps it.
    return rpc('saveConversation', { record }).catch(onFailure);
  }

  /** `touchContent` is for content only: moving or panning never reorders the recents list. */
  requestSave(touchContent) {
    if (touchContent) this.meta = { ...this.meta, updatedAt: new Date().toISOString() };
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DELAY_MS);
  }

  /* ---- Undo and redo ---- */

  /** Runs one user action and remembers what it changed, so it can be taken back. */
  recorded(label, action) {
    const before = snapshotOf(this.doc);
    action();
    const patch = diffCanvas(label, before, snapshotOf(this.doc));
    if (!patch) return;
    this.undoStack = [...this.undoStack, patch].slice(-HISTORY_LIMIT);
    this.redoStack = [];
    this.emit({ history: true });
  }

  stepHistory(direction) {
    const undoing = direction === 'undo';
    const from = undoing ? 'undoStack' : 'redoStack';
    const to = undoing ? 'redoStack' : 'undoStack';
    const patch = this[from].at(-1);
    if (!patch) return null;
    const result = applyCanvasPatch(snapshotOf(this.doc), patch, direction);
    this[from] = this[from].slice(0, -1);
    if (!result.ok) {
      // That answer has moved on, so this step can never apply again.
      this.emit({ history: true });
      return { ok: false, reason: `“${patch.label}” can no longer be taken back.` };
    }
    this[to] = [...this[to], patch];
    const { turns, cards, frames, links } = result.snapshot;
    this.updateDoc((prev) => ({ turns, layout: { ...prev.layout, cards, frames, links } }), { layout: true, content: true, history: true });
    this.requestSave(patch.turns.length > 0);
    return { ok: true, label: patch.label };
  }

  undo() { return this.stepHistory('undo'); }
  redo() { return this.stepHistory('redo'); }

  /* ---- Requests ---- */

  startRequest(request, messages) {
    const key = `r${++this.requestCounter}`;
    const entry = { ...request, stream: null };
    this.requests.set(key, entry);
    const live = () => this.requests.get(key) === entry;
    const settle = () => {
      this.requests.delete(key);
      this.emit({ streaming: true });
      this.requestSave(true);
    };
    const editTurn = (turnId, change) => {
      this.updateDoc((prev) => ({ ...prev, turns: prev.turns.map((turn) => (turn.id === turnId ? change(turn) : turn)) }), { content: true });
    };
    const fitAnswered = (matches) => {
      const card = this.doc.layout.cards.find(matches);
      if (card) this.fitCardIds.add(card.id);
    };
    const handlers = request.kind === 'send'
      ? {
        onDelta: (delta) => { if (live()) editTurn(request.turnId, (turn) => ({ ...turn, content: turn.content + delta })); },
        onDone: (text) => {
          if (!live()) return;
          if (text.trim() !== '') fitAnswered((card) => card.kind === 'message' && card.turnId === request.turnId);
          editTurn(request.turnId, (turn) => ({ ...turn, content: text }));
          settle();
        },
        onError: (message, partial, cancelled) => {
          if (!live()) return;
          editTurn(request.turnId, (turn) => {
            const kept = partial || turn.content;
            // A stopped answer is not what the rectangle was for, so it keeps its size.
            if (cancelled || kept.trim()) return { ...turn, content: kept };
            return { ...turn, content: message, error: true };
          });
          settle();
        }
      }
      : {
        onDelta: (delta) => {
          if (!live()) return;
          this.updateDoc((prev) => ({ ...prev, turns: applyExpansionChunk(prev.turns, request.expansionId, { delta }) }), { content: true });
        },
        onDone: (text) => {
          if (!live()) return;
          fitAnswered((card) => card.kind === 'expansion' && card.expansionId === request.expansionId);
          this.updateDoc((prev) => ({ ...prev, turns: applyExpansionChunk(prev.turns, request.expansionId, { text, done: true }) }), { content: true });
          settle();
        },
        onError: (message, partial, cancelled) => {
          if (!live()) return;
          const current = findExpansionInTurns(this.doc.turns, request.expansionId);
          const kept = partial || current?.node.answer || '';
          this.updateDoc((prev) => ({
            ...prev,
            turns: cancelled && kept.trim()
              ? applyExpansionChunk(prev.turns, request.expansionId, { text: kept, done: true })
              : applyExpansionChunk(prev.turns, request.expansionId, { error: message, text: kept })
          }), { content: true });
          settle();
        }
      };
    entry.stream = openStream({ kind: 'chat', role: 'chat', messages }, handlers);
    this.emit({ streaming: true });
  }

  /** Forgotten first, so a late chunk cannot land on what is being removed. */
  cancelRequests(matches) {
    for (const [key, request] of [...this.requests]) {
      if (!matches(request)) continue;
      this.requests.delete(key);
      request.stream?.stop();
    }
    this.emit({ streaming: true });
  }

  sendCard(card) {
    if (card.kind !== 'message') return;
    const { turns, layout } = this.doc;
    this.startRequest({ kind: 'send', turnId: card.turnId }, messageCardRequest(layout.cards, layout.links, turns, card, bodyCharWidth()));
  }

  expansionMessages(turn, target, prompt, rect, caption) {
    const { turns, layout } = this.doc;
    return expansionCardRequest(layout.cards, layout.links, turns, turn, target, prompt, rect, caption, bodyCharWidth());
  }

  /** Returns `{ ok }` or `{ ok: false, reason }`, a refusal reason from rich-text. */
  expand(turnId, target, prompt, placement) {
    const turn = this.doc.turns.find((item) => item.id === turnId);
    if (!turn) return { ok: false, reason: 'turn-not-found' };
    const input = expansionMessageInput(turn, target.parentExpansionId, target);
    if (!input) return { ok: false, reason: 'out-of-bounds' };
    if (!globalThis.DeltaMarkdown.isAnchoredRange(input.answer, target)) return { ok: false, reason: 'not-anchored' };
    const expansionId = this.expansionCounter;
    const insertion = insertExpansionInTurns(this.doc.turns, turnId, target, expansionId, prompt);
    if (!insertion.ok) return { ok: false, reason: insertion.reason };
    const messages = this.expansionMessages(turn, target, prompt, placement.rect, input.selection);
    if (!messages) return { ok: false, reason: 'turn-not-found' };
    this.expansionCounter += 1;
    const card = { kind: 'expansion', id: newId(), rect: placement.rect, turnId, expansionId, hostId: placement.hostId };
    this.updateDoc((prev) => ({
      turns: insertion.turns,
      layout: { ...prev.layout, cards: [...prev.layout.cards, card] }
    }), { layout: true, content: true });
    this.startRequest({ kind: 'expand', expansionId }, messages);
    this.requestSave(true);
    return { ok: true, id: card.id };
  }

  /** Returns the new card's id. `context` is a list of `{ from, context, label? }`. */
  ask(rect, question, parentId, sources = [], context = []) {
    const userTurnId = nextTurnId++;
    const turnId = nextTurnId++;
    const card = {
      kind: 'message',
      id: newId(),
      rect,
      userTurnId,
      turnId,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(sources.length > 0 ? { sources: [...sources] } : {})
    };
    if (this.meta.title === UNTITLED) this.meta = { ...this.meta, title: buildConversationTitle(question) };
    this.updateDoc((prev) => ({
      turns: [
        ...prev.turns,
        { id: userTurnId, role: 'user', content: question, expansions: [] },
        { id: turnId, role: 'assistant', content: '', expansions: [] }
      ],
      layout: {
        ...prev.layout,
        cards: [...prev.layout.cards, card],
        links: [...prev.layout.links, ...context.map((link) => ({ ...link, id: newId(), to: card.id }))]
      }
    }), { layout: true, content: true, meta: true });
    this.sendCard(card);
    this.requestSave(true);
    return card.id;
  }

  /** A page's text as a card: the first context of every session that continues it. */
  addPage(rect, page) {
    const turnId = nextTurnId++;
    const text = String(page.text || '').slice(0, PAGE_TEXT_LIMIT);
    const card = {
      kind: 'page',
      id: newId(),
      rect: rect || { x: 0, y: 0, ...DEFAULT_PAGE_SIZE },
      turnId,
      title: String(page.title || '').slice(0, 300),
      url: String(page.url || '').slice(0, 2000)
    };
    if (this.meta.title === UNTITLED) {
      this.meta = { ...this.meta, title: buildConversationTitle(card.title || card.url || 'Web page') };
    }
    this.recorded('Add page', () => {
      this.updateDoc((prev) => ({
        turns: [...prev.turns, { id: turnId, role: 'user', content: text, expansions: [] }],
        layout: { ...prev.layout, cards: [...prev.layout.cards, card] }
      }), { layout: true, content: true, meta: true });
    });
    this.requestSave(true);
    return card.id;
  }

  stopCard(id) {
    const card = this.cards.find((item) => item.id === id);
    if (!card) return;
    // Stays in the book: the stream ends with the partial text, which settles it.
    for (const request of this.requests.values()) {
      if (requestBelongsTo(request, card)) request.stream?.stop();
    }
  }

  removeCards(doomed) {
    const { turns, layout } = this.doc;
    const doomedCards = layout.cards.filter((card) => doomed.has(card.id));
    const doomedTurns = new Set();
    const doomedExpansions = new Set();
    for (const card of doomedCards) {
      if (card.kind === 'note') continue;
      if (card.kind === 'message') {
        doomedTurns.add(card.userTurnId);
        doomedTurns.add(card.turnId);
        continue;
      }
      if (card.kind === 'page') {
        doomedTurns.add(card.turnId);
        continue;
      }
      const location = findExpansionInTurns(turns, card.expansionId);
      if (location) for (const nodeId of expansionSubtreeIds(location.node)) doomedExpansions.add(nodeId);
    }
    this.cancelRequests((request) => (request.kind === 'send' ? doomedTurns.has(request.turnId) : doomedExpansions.has(request.expansionId)));
    this.updateDoc((prev) => {
      let nextTurns = prev.turns.filter((turn) => !doomedTurns.has(turn.id));
      for (const card of doomedCards) {
        if (card.kind === 'expansion') nextTurns = removeExpansionInTurns(nextTurns, card.expansionId);
      }
      return {
        turns: nextTurns,
        layout: {
          ...prev.layout,
          cards: prev.layout.cards.filter((card) => !doomed.has(card.id)),
          links: prev.layout.links.filter((link) => !doomed.has(link.from) && !doomed.has(link.to))
        }
      };
    }, { layout: true, content: true });
  }

  /** Removes cards with what depends on them, frames (not what they hold) and links. */
  removeItems(ids) {
    const { cards } = this.doc.layout;
    const doomed = new Set();
    for (const card of cards) {
      if (ids.has(card.id)) for (const id of cascadeCardIds(cards, card.id)) doomed.add(id);
    }
    this.recorded('Delete', () => {
      if (doomed.size > 0) this.removeCards(doomed);
      this.updateDoc((prev) => ({
        ...prev,
        layout: {
          ...prev.layout,
          frames: prev.layout.frames.filter((frame) => !ids.has(frame.id)),
          links: prev.layout.links.filter((link) => !ids.has(link.id))
        }
      }));
    });
    this.requestSave(doomed.size > 0);
  }

  /**
   * A fresh answer sized by the card as it is now, for Retry and Regenerate alike. What
   * depends on the old answer goes first: expansions are anchored in its text and
   * continuations were written after it.
   */
  regenerateCard(id) {
    const { turns, layout } = this.doc;
    const card = layout.cards.find((item) => item.id === id);
    if (!card || card.kind === 'note' || card.kind === 'page') return;
    const dependents = cascadeCardIds(layout.cards, id);
    dependents.delete(id);
    if (card.kind === 'message') {
      this.removeCards(dependents);
      this.cancelRequests((request) => requestBelongsTo(request, card));
      this.updateDoc((prev) => ({
        ...prev,
        turns: prev.turns.map((turn) => (turn.id === card.turnId ? { id: turn.id, role: turn.role, content: '', expansions: [] } : turn))
      }), { content: true });
      this.sendCard(this.doc.layout.cards.find((item) => item.id === id) || card);
    } else {
      const location = findExpansionInTurns(turns, card.expansionId);
      if (!location) return;
      const target = {
        start: location.node.start,
        end: location.node.end,
        ...(location.parent ? { parentExpansionId: location.parent.id } : {})
      };
      const messages = this.expansionMessages(location.turn, target, location.node.prompt, card.rect, location.node.originalText);
      if (!messages) return;
      this.removeCards(dependents);
      this.cancelRequests((request) => requestBelongsTo(request, card));
      this.updateDoc((prev) => ({ ...prev, turns: restartExpansion(prev.turns, card.expansionId) }), { content: true });
      this.startRequest({ kind: 'expand', expansionId: card.expansionId }, messages);
    }
    this.requestSave(true);
  }

  editCard(id, question) {
    const card = this.cards.find((item) => item.id === id);
    if (!card || card.kind === 'note' || card.kind === 'page') return;
    this.updateDoc((prev) => ({
      ...prev,
      turns: card.kind === 'expansion'
        ? updateExpansion(prev.turns, card.expansionId, { prompt: question })
        : prev.turns.map((turn) => (turn.id === card.userTurnId ? { ...turn, content: question } : turn))
    }), { content: true });
    this.regenerateCard(id);
  }

  /* ---- Layout ---- */

  setViewport(viewport) {
    this.doc = { ...this.doc, layout: { ...this.doc.layout, viewport } };
    this.emit({ viewport: true });
    this.requestSave(false);
  }

  updateCards(updates) {
    const byId = new Map(updates.map((update) => [update.id, update]));
    this.updateDoc((prev) => ({
      ...prev,
      layout: {
        ...prev.layout,
        cards: prev.layout.cards.map((card) => {
          const update = byId.get(card.id);
          return update ? { ...card, rect: update.rect } : card;
        })
      }
    }));
    this.requestSave(false);
  }

  /** Going on top is not an edit: it joins no undo step and leaves the recents order alone. */
  raiseCards(ids) {
    const { cards, stack } = this.doc.layout;
    const next = raisedStack(cards, stack, ids);
    if (next === stack) return;
    this.updateDoc((prev) => ({ ...prev, layout: { ...prev.layout, stack: next } }));
    this.requestSave(false);
  }

  /** Moves cards and frames as one undoable step. */
  moveItems(label, cards, frames = []) {
    const rects = new Map(frames.map((frame) => [frame.id, frame.rect]));
    this.recorded(label, () => {
      this.updateCards(cards);
      if (rects.size === 0) return;
      this.updateDoc((prev) => ({
        ...prev,
        layout: {
          ...prev.layout,
          frames: prev.layout.frames.map((frame) => {
            const rect = rects.get(frame.id);
            return rect ? { ...frame, rect } : frame;
          })
        }
      }));
    });
    this.raiseCards(cards.map((card) => card.id));
  }

  /** A change to the layout alone: never a change of content, so recents keep their order. */
  editLayout(label, change) {
    this.recorded(label, () => this.updateDoc((prev) => ({ ...prev, layout: change(prev.layout) })));
    this.requestSave(false);
  }

  addNote(rect, text) {
    const id = newId();
    this.editLayout('Add note', (layout) => ({ ...layout, cards: [...layout.cards, { kind: 'note', id, rect, text }] }));
    return id;
  }

  updateNote(id, text) {
    this.editLayout('Edit note', (layout) => ({
      ...layout,
      cards: layout.cards.map((card) => (card.id === id && card.kind === 'note' && card.text !== text ? { ...card, text } : card))
    }));
  }

  addFrame(rect, title) {
    const id = newId();
    this.editLayout('Add frame', (layout) => ({ ...layout, frames: [...layout.frames, { id, rect, title }] }));
    return id;
  }

  renameFrame(id, title) {
    this.editLayout('Rename frame', (layout) => ({
      ...layout,
      frames: layout.frames.map((frame) => (frame.id === id && frame.title !== title ? { ...frame, title } : frame))
    }));
  }

  addLink(from, to) {
    const { cards, links } = this.doc.layout;
    const known = (id) => cards.some((card) => card.id === id);
    if (from === to || !known(from) || !known(to)) return null;
    const existing = links.find((link) => link.from === from && link.to === to);
    if (existing) return existing.id;
    const id = newId();
    this.editLayout('Connect', (layout) => ({ ...layout, links: [...layout.links, { id, from, to }] }));
    return id;
  }

  editLink(label, id, change) {
    this.editLayout(label, (layout) => ({ ...layout, links: layout.links.map((link) => (link.id === id ? change(link) : link)) }));
  }

  labelLink(id, label) {
    const text = label.trim();
    this.editLink('Label connection', id, (link) => {
      if ((link.label ?? '') === text) return link;
      return text === '' ? withoutField(link, 'label') : { ...link, label: text };
    });
  }

  reverseLink(id) {
    this.editLink('Reverse connection', id, (link) => ({ ...link, from: link.to, to: link.from }));
  }

  /** What this link sends to the branch it points at; undefined makes it a plain arrow again. */
  setLinkContext(id, context) {
    this.editLink(context ? 'Send context' : 'Stop sending context', id, (link) => {
      if (link.context === context) return link;
      return context ? { ...link, context } : withoutField(link, 'context');
    });
  }

  setColor(ids, color) {
    const paint = (item) => {
      if (!ids.has(item.id) || item.color === color) return item;
      return color === undefined ? withoutField(item, 'color') : { ...item, color };
    };
    this.editLayout('Colour', (layout) => ({ ...layout, cards: layout.cards.map(paint), frames: layout.frames.map(paint) }));
  }

  setCollapsed(ids, collapsed) {
    this.editLayout(collapsed ? 'Collapse' : 'Expand', (layout) => ({
      ...layout,
      cards: [...ids].reduce((cards, id) => setCardCollapsed(cards, id, collapsed), layout.cards)
    }));
  }

  /** Returns the new items' ids; empty when nothing could be copied. */
  duplicate(ids) {
    const { turns, layout } = this.doc;
    const copy = duplicateSelection(layout, turns, ids, {
      newId,
      newTurnId: () => nextTurnId++,
      streamingTurnIds: this.streamingTurnIds
    });
    if (!copy) return [];
    this.recorded('Duplicate', () => {
      this.updateDoc((prev) => ({
        turns: [...prev.turns, ...copy.turns],
        layout: {
          ...prev.layout,
          cards: [...prev.layout.cards, ...copy.cards],
          frames: [...prev.layout.frames, ...copy.frames],
          links: [...prev.layout.links, ...copy.links]
        }
      }), { layout: true, content: true });
    });
    this.requestSave(copy.turns.length > 0);
    return copy.ids;
  }

  /** `null` means there was nothing to measure, so the card stays as it is. */
  fitCard(id, contentHeight) {
    this.fitCardIds.delete(id);
    if (contentHeight === null) return;
    const updates = fitCardHeight(this.doc.layout.cards, id, contentHeight);
    if (updates.length > 0) this.updateCards(updates);
  }

  rename(title) {
    const next = String(title || '').replace(/\s+/g, ' ').trim().slice(0, CONVERSATION_TITLE_MAX_LENGTH);
    if (next === '' || next === this.meta.title) return;
    this.updateMeta({ title: next });
    this.requestSave(false);
  }

  /** The record as it stands, for export. */
  snapshot() {
    return {
      ...this.meta,
      source: 'canvas',
      state: { turns: finalizeTurns(this.doc.turns) },
      canvas: this.doc.layout
    };
  }

  /* ---- Opening canvases ---- */

  replaceDoc(nextDoc, nextMeta) {
    if (this.saveTimer !== null) this.flushSave();
    this.cancelRequests(() => true);
    this.fitCardIds = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.meta = nextMeta;
    this.doc = nextDoc;
    this.expansionCounter = maxExpansionId(nextDoc.turns) + 1;
    this.loaded = true;
    this.emit({ replaced: true, layout: true, content: true, meta: true, history: true, viewport: true, streaming: true });
  }

  newCanvas() {
    this.replaceDoc(emptyDoc(), newMeta());
  }

  /** Loads a stored canvas; resolves to whether it was one. */
  async openCanvas(id) {
    const record = await rpc('loadConversation', { id }).catch(() => null);
    if (!record || record.source !== 'canvas') return false;
    const turns = finalizeTurns(record.state.turns);
    this.replaceDoc(
      { turns, layout: normalizeCanvasLayout(record.canvas, turns) },
      { id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, kbFed: record.kbFed, persisted: true }
    );
    return true;
  }

  async deleteCanvas() {
    const { id, persisted } = this.meta;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.replaceDoc(emptyDoc(), newMeta());
    if (persisted) await rpc('deleteConversation', { id }).catch(() => {});
  }

  /** Stops every stream and saves, for a page that is going away. */
  dispose() {
    this.flushSave();
    this.cancelRequests(() => true);
  }
}
