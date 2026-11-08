/* Knowledge Base maintenance, ported from Delta Explorer's src/main/kb/
 * (analysis.ts, run.ts, schedule.ts, maintenance.ts, store.ts).
 *
 * The document base curates itself: every saved conversation and every page
 * expansion is material, and a quiet period after the last write starts a
 * bounded curator pass. Timers are browser.alarms, because Firefox suspends an
 * idle background page; a running pass keeps the page awake. */

import { KB_MEMORY_SYSTEM_PROMPT, LEARNING_PREFERENCES_FILE } from '../shared/prompts.js';
import { loadSettings, resolveRole } from './config.js';
import { callProvider, resolveTarget } from './provider.js';
import { memoryAgentFor } from './memory-tools.js';
import { hasMemoryFile, writeMemory } from './memory-store.js';
import {
  listConversations,
  listUnfedConversations,
  loadConversation,
  markConversationKbFed,
  onConversationSaved
} from './conversations.js';
import {
  groupByPage,
  loadExpansionRecords,
  markExpansionsKbFed,
  onExpansionRecorded
} from './expansion-records.js';
import { keepAlive } from './keep-alive.js';

export const CURATOR_UNAVAILABLE_ERROR =
  'The Knowledge Base Maintenance model cannot use tools, so it cannot update memories. Assign one that supports tool calling.';

/* ---- Pacing policy (pure) ---- */

const AUTO_DEBOUNCE_MS = 20_000;
const AUTO_MIN_INTERVAL_MS = 10 * 60_000;
const AUTO_BACKLOG_INTERVAL_MS = 45_000;
const AUTO_BATCH_SIZE = 4;
const AUTO_RETRY_BASE_MS = 2 * 60_000;
const AUTO_RETRY_MAX_MS = 30 * 60_000;
const AUTO_STARTUP_DELAY_MS = 15_000;
const ALARM_NAME = 'delta-kb-auto';
const STATE_KEY = 'deltaKbState';
const LEGACY_KB_KEY = 'deltaKbData';

function autoRetryDelayMs(failedAttempts) {
  const attempts = Math.max(1, Math.trunc(failedAttempts));
  return Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * 2 ** (attempts - 1));
}

function startupDelayMs(lastRunAt, now) {
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN;
  const elapsed = Number.isFinite(last) ? now - last : AUTO_MIN_INTERVAL_MS;
  return Math.max(AUTO_STARTUP_DELAY_MS, Math.min(AUTO_MIN_INTERVAL_MS, AUTO_MIN_INTERVAL_MS - elapsed));
}

/* ---- Persisted state ---- */

function emptyState() {
  return { lastRunAt: null, lastLearnedAt: null, lastAnalyzed: 0, lastError: null, failedAttempts: 0 };
}

async function loadKbState() {
  const obj = await browser.storage.local.get(STATE_KEY);
  const raw = obj[STATE_KEY] && typeof obj[STATE_KEY] === 'object' ? obj[STATE_KEY] : {};
  const iso = (v) => (typeof v === 'string' && v.trim() ? v : null);
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
  return {
    lastRunAt: iso(raw.lastRunAt),
    lastLearnedAt: iso(raw.lastLearnedAt),
    lastAnalyzed: count(raw.lastAnalyzed),
    lastError: iso(raw.lastError),
    failedAttempts: count(raw.failedAttempts)
  };
}

function saveKbState(state) {
  return browser.storage.local.set({ [STATE_KEY]: state });
}

/* ---- Material ---- */

const ANSWER_LIMIT = 300;
const CONTEXT_RADIUS = 80;

function clip(text, limit = ANSWER_LIMIT) {
  const value = String(text || '').trim();
  return value.length > limit ? value.slice(0, limit) + '...' : value;
}

function collectExpansions(source, nodes, out) {
  for (const node of nodes || []) {
    const before = source.slice(Math.max(0, node.start - CONTEXT_RADIUS), node.start);
    const after = source.slice(node.end, node.end + CONTEXT_RADIUS);
    out.push({
      term: node.originalText,
      prompt: node.prompt,
      context: (before + node.originalText + after).replace(/\s+/g, ' ').trim(),
      answer: node.status === 'error' ? '' : clip(node.answer)
    });
    collectExpansions(node.answer || '', node.children, out);
  }
}

function expandedTermLines(entries) {
  const lines = ['Expanded terms:'];
  for (const entry of entries) {
    lines.push('- Context: ' + entry.context);
    lines.push('  Term: "' + entry.term + '"');
    if (entry.inside) lines.push('  Inside the answer about: "' + entry.inside + '"');
    if (entry.answer) lines.push('  Answer: ' + entry.answer);
    if (entry.prompt) lines.push('  User asked: "' + entry.prompt + '"');
  }
  lines.push('');
  return lines;
}

export function buildConversationMaterial(record) {
  const parts = [`Title: ${record.title}`, `Date: ${record.updatedAt}`, `Source: ${record.source}`];
  if (record.source === 'lookup') {
    const page = record.lookup.page || {};
    if (page.url) parts.push(`Page: ${page.title ? page.title + ' — ' : ''}${page.url}`);
    if (record.lookup.context) parts.push(`Page text it was about: ${clip(record.lookup.context, 600)}`);
  }
  parts.push('---');
  const questionLines = [];
  const expansions = [];
  for (const turn of record.state.turns) {
    if (turn.role === 'user') {
      if (turn.content.trim()) questionLines.push('- User: ' + turn.content.trim());
    } else if (!turn.error && turn.content.trim()) {
      const last = questionLines[questionLines.length - 1];
      questionLines.push((last && last.startsWith('- User:') ? '  ' : '- ') + 'Assistant: ' + clip(turn.content));
    }
    collectExpansions(turn.content, turn.expansions, expansions);
  }
  if (questionLines.length > 0) parts.push('Questions:', ...questionLines, '');
  if (expansions.length > 0) parts.push(...expandedTermLines(expansions));
  return parts.join('\n');
}

function passageAround(context, selection) {
  const text = String(context || '').replace(/\s+/g, ' ').trim();
  const at = text.indexOf(selection);
  if (at === -1) return clip(text, CONTEXT_RADIUS * 2 + selection.length);
  return text.slice(Math.max(0, at - CONTEXT_RADIUS), at + selection.length + CONTEXT_RADIUS).trim();
}

export function buildPageMaterial(group) {
  const newest = Math.max(...group.records.map((r) => r.timestamp || 0));
  const parts = [
    `Title: ${group.title || '(untitled page)'}`,
    `Date: ${new Date(newest || Date.now()).toISOString()}`,
    'Source: expansions on a web page',
    `Page: ${group.url || '(unknown)'}`,
    '---'
  ];
  const entries = group.records.map((record) => {
    const ancestors = Array.isArray(record.ancestors) ? record.ancestors : [];
    return {
      term: record.selection,
      prompt: record.prompt || undefined,
      inside: ancestors.length ? ancestors[ancestors.length - 1].selection : undefined,
      context: passageAround(record.context, record.selection),
      answer: clip(record.response)
    };
  });
  parts.push(...expandedTermLines(entries));
  return parts.join('\n');
}

function buildKbMessages(material) {
  return [
    { role: 'system', content: KB_MEMORY_SYSTEM_PROMPT },
    { role: 'user', content: `Update the document base from this material:\n\n${material}` }
  ];
}

/* ---- Queue ---- */

function hasLearningMaterial(record) {
  return record.state.turns.some((turn) => turn.content.trim() !== '' || (turn.expansions || []).length > 0);
}

/** Every curatable item, newest first: conversations and pages with expansions. */
async function listItems({ unfedOnly }) {
  const metas = unfedOnly ? await listUnfedConversations() : await listConversations();
  const records = await loadExpansionRecords();
  const groups = groupByPage(unfedOnly ? records.filter((r) => !r.kbFed) : records);
  const items = [
    ...metas.map((meta) => ({ kind: 'conversation', id: meta.id, sortKey: Date.parse(meta.updatedAt) || 0 })),
    ...groups.map((group) => ({ kind: 'page', id: group.id, group, sortKey: group.updatedAt }))
  ];
  return items.sort((a, b) => b.sortKey - a.sortKey);
}

let notifyMemoryChanged = () => {};

async function curate(material, signal) {
  const target = await resolveTarget('kb-maintenance');
  const messages = buildKbMessages(material);
  const { agent } = await memoryAgentFor('kb-maintenance', target, messages, () => notifyMemoryChanged());
  if (!agent) throw new Error(CURATOR_UNAVAILABLE_ERROR);
  await callProvider(messages, 'kb-maintenance', { target, agent, signal });
}

/** Curates items one at a time, marking each fed as it finishes. */
async function runKbAnalysis(items, { markFed, signal, onProgress }) {
  let analyzed = 0;
  let done = 0;
  for (const item of items) {
    if (signal?.aborted) break;
    if (item.kind === 'conversation') {
      const record = await loadConversation(item.id);
      if (record && !(markFed && record.kbFed)) {
        if (!hasLearningMaterial(record)) {
          if (markFed) await markConversationKbFed(item.id);
        } else {
          await curate(buildConversationMaterial(record), signal);
          if (markFed) await markConversationKbFed(item.id, record.updatedAt);
          analyzed++;
        }
      }
    } else {
      await curate(buildPageMaterial(item.group), signal);
      if (markFed) await markExpansionsKbFed(item.group.records.map((r) => r.id));
      analyzed++;
    }
    done++;
    if (onProgress) onProgress(done, items.length);
  }
  return { conversationsAnalyzed: signal?.aborted ? 0 : analyzed };
}

/* ---- Scheduler ---- */

let running = false;
let queue = Promise.resolve();
let pendingCount = 0;
let activeController = null;

function runExclusive(task) {
  const result = queue.then(task, task);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function countPending() {
  return (await listItems({ unfedOnly: true })).length;
}

async function buildStatus() {
  const [state, settings, role] = await Promise.all([loadKbState(), loadSettings(), resolveRole('kb-maintenance')]);
  return {
    enabled: settings.kbAutoMaintain,
    configured: role !== null,
    state: running ? 'running' : state.lastError ? 'error' : 'idle',
    pending: pendingCount,
    lastLearnedAt: state.lastLearnedAt,
    lastAnalyzed: state.lastAnalyzed,
    lastError: state.lastError
  };
}

function broadcast(message) {
  browser.runtime.sendMessage(message).catch(() => { /* no page is listening */ });
}

async function publishStatus() {
  const status = await buildStatus();
  broadcast({ type: 'kbStatusChanged', status });
  return status;
}

export async function getKbStatus() {
  pendingCount = await countPending();
  return buildStatus();
}

async function refreshStatus() {
  pendingCount = await countPending();
  return publishStatus();
}

function schedule(delayMs) {
  browser.alarms.create(ALARM_NAME, { when: Date.now() + Math.max(1000, delayMs) });
}

async function runAutoPass() {
  if (running) { schedule(AUTO_DEBOUNCE_MS); return; }
  const settings = await loadSettings();
  if (!settings.kbAutoMaintain) return;
  if (!(await resolveRole('kb-maintenance'))) { await refreshStatus(); return; }

  running = true;
  const controller = new AbortController();
  activeController = controller;
  const release = keepAlive();
  try {
    const items = await listItems({ unfedOnly: true });
    pendingCount = items.length;
    const batch = items.slice(0, AUTO_BATCH_SIZE);
    if (batch.length === 0) return;
    await publishStatus();
    const result = await runExclusive(() => runKbAnalysis(batch, { markFed: true, signal: controller.signal }));
    if (controller.signal.aborted) return;
    const now = new Date().toISOString();
    pendingCount = await countPending();
    const state = await loadKbState();
    await saveKbState({
      lastRunAt: now,
      lastLearnedAt: result.conversationsAnalyzed > 0 ? now : state.lastLearnedAt,
      lastAnalyzed: result.conversationsAnalyzed,
      lastError: null,
      failedAttempts: 0
    });
    if (pendingCount > 0) schedule(AUTO_BACKLOG_INTERVAL_MS);
  } catch (err) {
    if (controller.signal.aborted) return;
    const state = await loadKbState();
    const failedAttempts = state.failedAttempts + 1;
    await saveKbState({ ...state, lastRunAt: new Date().toISOString(), lastError: err?.message || String(err), failedAttempts });
    schedule(autoRetryDelayMs(failedAttempts));
  } finally {
    if (activeController === controller) activeController = null;
    running = false;
    release();
    await publishStatus().catch(() => {});
  }
}

async function handleNewMaterial() {
  const settings = await loadSettings();
  if (!settings.kbAutoMaintain) return;
  if (!(await resolveRole('kb-maintenance'))) return;
  schedule(AUTO_DEBOUNCE_MS);
}

/** Enabling learning or assigning the model takes effect without waiting for the next chat. */
export async function handleConfigChanged() {
  const status = await refreshStatus();
  if (!status.enabled || !status.configured) {
    browser.alarms.clear(ALARM_NAME);
    return;
  }
  if (status.pending > 0) schedule(AUTO_DEBOUNCE_MS);
}

/* ---- Manual runs ---- */

async function manualRun(items, markFed, onProgress) {
  const release = keepAlive();
  running = true;
  await publishStatus();
  try {
    const result = await runExclusive(() => runKbAnalysis(items, { markFed, onProgress }));
    if (result.conversationsAnalyzed > 0) {
      const now = new Date().toISOString();
      await saveKbState({ lastRunAt: now, lastLearnedAt: now, lastAnalyzed: result.conversationsAnalyzed, lastError: null, failedAttempts: 0 });
    }
    return result;
  } finally {
    running = false;
    release();
    await refreshStatus();
  }
}

/** Analyze now: every queued item. */
export async function analyzePending(onProgress) {
  return manualRun(await listItems({ unfedOnly: true }), true, onProgress);
}

/** Re-Analyze: the most recent `count` items, fed or not. */
export async function reanalyzeRecent(count, onProgress) {
  const n = Math.max(1, Math.trunc(Number(count) || 1));
  return manualRun((await listItems({ unfedOnly: false })).slice(0, n), false, onProgress);
}

export async function countCuratableItems() {
  return (await listItems({ unfedOnly: false })).length;
}

/* ---- Lifecycle ---- */

let started = false;

/** The earlier extension learned one prompt; it becomes the learning-preferences note, once. */
async function migrateLegacyKbPrompt() {
  const obj = await browser.storage.local.get(LEGACY_KB_KEY);
  const legacy = obj[LEGACY_KB_KEY];
  if (!legacy) return;
  const prompt = typeof legacy.prompt === 'string' ? legacy.prompt.trim() : '';
  if (prompt && !(await hasMemoryFile(LEARNING_PREFERENCES_FILE))) {
    await writeMemory(LEARNING_PREFERENCES_FILE, `# Learning preferences\n\n${prompt}\n`);
  }
  await browser.storage.local.remove(LEGACY_KB_KEY);
}

export function startKbAutoMaintenance(onMemoryChanged) {
  if (started) return;
  started = true;
  notifyMemoryChanged = onMemoryChanged;
  onConversationSaved((record) => { if (!record.kbFed) handleNewMaterial().catch(() => {}); });
  onExpansionRecorded(() => handleNewMaterial().catch(() => {}));
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) runAutoPass().catch((err) => console.warn('Automatic KB pass failed:', err));
  });
  (async () => {
    await migrateLegacyKbPrompt().catch((err) => console.warn('KB prompt migration failed:', err));
    const status = await refreshStatus();
    if (!status.enabled || !status.configured || status.pending === 0) return;
    const existing = await browser.alarms.get(ALARM_NAME);
    if (existing) return;
    schedule(startupDelayMs((await loadKbState()).lastRunAt, Date.now()));
  })().catch((err) => console.warn('Failed to start automatic Knowledge Base maintenance:', err));
}
