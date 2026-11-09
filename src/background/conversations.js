/* Conversation store, ported from Delta Explorer's src/main/conversations.ts.
 *
 * Each record lives under its own key (`deltaConv:<id>`) with a metadata index
 * (`deltaConvIndex`: id -> meta), so listing never loads bodies. Writes go
 * through one chain, so an autosave queued before a delete cannot recreate the
 * record, and a KB mutation cannot overwrite a newer autosave. */

import {
  migrateConversationRecord,
  SAFE_CONVERSATION_ID,
  toConversationMeta
} from '../shared/conversation.js';
import { flattenMarkdown } from '../shared/rich-text.js';

const INDEX_KEY = 'deltaConvIndex';
const RECORD_PREFIX = 'deltaConv:';
const LEGACY_KEY = 'deltaConversations';
const SEARCH_RESULT_LIMIT = 100;
const SNIPPET_RADIUS = 80;

let chain = Promise.resolve();
const savedListeners = new Set();

function serialize(task) {
  const result = chain.then(task, task);
  chain = result.then(() => undefined, () => undefined);
  return result;
}

export function onConversationSaved(listener) {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}

function notifySaved(record) {
  for (const listener of savedListeners) {
    try { listener(record); } catch (err) { console.warn('Conversation listener failed:', err); }
  }
}

function assertId(id) {
  if (typeof id !== 'string' || !SAFE_CONVERSATION_ID.test(id)) throw new Error('Invalid conversation id.');
}

async function readIndex() {
  const obj = await browser.storage.local.get(INDEX_KEY);
  const index = obj[INDEX_KEY];
  return index && typeof index === 'object' ? index : {};
}

let migrated = false;
/** Moves the earlier single-array store into per-record keys, once. */
async function ensureMigrated() {
  if (migrated) return;
  migrated = true;
  const obj = await browser.storage.local.get(LEGACY_KEY);
  const legacy = obj[LEGACY_KEY];
  if (!Array.isArray(legacy)) return;
  const index = await readIndex();
  const writes = {};
  for (const raw of legacy) {
    const record = migrateConversationRecord(raw);
    if (!record || !SAFE_CONVERSATION_ID.test(record.id) || index[record.id]) continue;
    writes[RECORD_PREFIX + record.id] = record;
    index[record.id] = toConversationMeta(record);
  }
  writes[INDEX_KEY] = index;
  await browser.storage.local.set(writes);
  await browser.storage.local.remove(LEGACY_KEY);
}

export async function listConversations() {
  await ensureMigrated();
  const index = await readIndex();
  return Object.values(index).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadConversation(id) {
  assertId(id);
  await ensureMigrated();
  const key = RECORD_PREFIX + id;
  const obj = await browser.storage.local.get(key);
  return obj[key] ? migrateConversationRecord(obj[key]) : null;
}

/** Whole-record write; the stored meta is rebuilt from the record. */
export function saveConversation(raw) {
  return serialize(async () => {
    await ensureMigrated();
    const record = migrateConversationRecord(raw);
    if (!record) throw new Error('Invalid conversation record.');
    assertId(record.id);
    const index = await readIndex();
    // Curation is tied to a version: folding or renaming leaves updatedAt, and so kbFed, alone.
    const previous = index[record.id];
    record.kbFed = !!(previous && previous.kbFed && previous.updatedAt === record.updatedAt);
    index[record.id] = toConversationMeta(record);
    await browser.storage.local.set({ [RECORD_PREFIX + record.id]: record, [INDEX_KEY]: index });
    notifySaved(record);
    return toConversationMeta(record);
  });
}

/** Read-modify-write inside the chain; a mutator returning false cancels the write. */
export function mutateConversation(id, mutate) {
  return serialize(async () => {
    const record = await loadConversation(id);
    if (!record) return null;
    if (mutate(record) === false) return record;
    const index = await readIndex();
    index[record.id] = toConversationMeta(record);
    await browser.storage.local.set({ [RECORD_PREFIX + record.id]: record, [INDEX_KEY]: index });
    return record;
  });
}

export function deleteConversation(id) {
  assertId(id);
  return serialize(async () => {
    const index = await readIndex();
    delete index[id];
    await browser.storage.local.remove(RECORD_PREFIX + id);
    await browser.storage.local.set({ [INDEX_KEY]: index });
    return true;
  });
}

/** Renames without moving the conversation in Recents. */
export function renameConversation(id, title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) return Promise.resolve(null);
  return mutateConversation(id, (record) => { record.title = clean; });
}

/**
 * `curatedUpdatedAt` is the version the curator actually read: a save that
 * landed during the pass leaves the conversation unfed, so its new content is
 * curated next.
 */
export function markConversationKbFed(id, curatedUpdatedAt) {
  return mutateConversation(id, (record) => {
    if (curatedUpdatedAt !== undefined && record.updatedAt !== curatedUpdatedAt) return false;
    record.kbFed = true;
  });
}

export async function listUnfedConversations() {
  return (await listConversations()).filter((meta) => !meta.kbFed);
}

function flattenExpansions(nodes, out) {
  for (const node of nodes || []) {
    out.push(node.prompt || '', node.answer || '');
    flattenExpansions(node.children, out);
  }
}

function contentSnippet(record, needle) {
  const turns = [...record.state.turns].reverse();
  const texts = [];
  for (const turn of turns) {
    texts.push(turn.content);
    const nested = [];
    flattenExpansions(turn.expansions, nested);
    texts.push(...nested);
  }
  if (record.source === 'lookup') texts.push(record.lookup.context);
  if (record.source === 'canvas') {
    for (const card of record.canvas.cards) if (card.kind === 'note') texts.push(card.text);
    for (const frame of record.canvas.frames) texts.push(frame.title);
  }
  for (const text of texts) {
    const flat = flattenMarkdown(text || '').replace(/\s+/g, ' ');
    const at = flat.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(flat.length, at + needle.length + SNIPPET_RADIUS);
    return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
  }
  return null;
}

/** Title matches first, then content matches with a snippet; newest first within each. */
export async function searchConversations(query) {
  const needle = String(query || '').trim().toLowerCase();
  const metas = await listConversations();
  if (!needle) return metas.slice(0, SEARCH_RESULT_LIMIT).map((meta) => ({ ...meta, matchedIn: 'title' }));
  const results = [];
  const candidates = [];
  for (const meta of metas) {
    if (meta.title.toLowerCase().includes(needle)) results.push({ ...meta, matchedIn: 'title' });
    else candidates.push(meta);
  }
  const keys = candidates.map((meta) => RECORD_PREFIX + meta.id);
  const bodies = keys.length ? await browser.storage.local.get(keys) : {};
  for (const meta of candidates) {
    const record = migrateConversationRecord(bodies[RECORD_PREFIX + meta.id]);
    if (!record) continue;
    const snippet = contentSnippet(record, needle);
    if (snippet) results.push({ ...meta, matchedIn: 'content', snippet });
  }
  results.sort((a, b) =>
    a.matchedIn === b.matchedIn ? b.updatedAt.localeCompare(a.updatedAt) : a.matchedIn === 'title' ? -1 : 1
  );
  return results.slice(0, SEARCH_RESULT_LIMIT);
}
