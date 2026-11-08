/* A log of expansions made on web pages: the curator's material for what the
 * user looked up while browsing. Chat expansions live in their conversation
 * records instead.
 *
 * Record: { id, timestamp, url, title, selection, context, prompt, response,
 *           ancestors: [{ selection, prompt }], kbFed }
 *
 * Records are kept after the curator reads them (only `kbFed` is set). They are
 * removed by the Knowledge Base "Forget browsing history" button or when the
 * cap evicts the oldest. */

const STORAGE_KEY = 'deltaExpansionRecords';
const MAX_RECORDS = 500;

let chain = Promise.resolve();
const savedListeners = new Set();

function serialize(task) {
  const result = chain.then(task, task);
  chain = result.then(() => undefined, () => undefined);
  return result;
}

export function onExpansionRecorded(listener) {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}

export async function loadExpansionRecords() {
  try {
    const obj = await browser.storage.local.get(STORAGE_KEY);
    return Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
  } catch {
    return [];
  }
}

/** An answer regenerated on the same bubble replaces its earlier record. */
export function saveExpansionRecord(record) {
  return serialize(async () => {
    const records = (await loadExpansionRecords()).filter((r) => r.id !== record.id);
    records.push({ ...record, kbFed: false });
    await browser.storage.local.set({ [STORAGE_KEY]: records.slice(-MAX_RECORDS) });
    for (const listener of savedListeners) {
      try { listener(record); } catch { /* ignore */ }
    }
  });
}

export function markExpansionsKbFed(ids) {
  const wanted = new Set(ids);
  return serialize(async () => {
    const records = await loadExpansionRecords();
    for (const record of records) if (wanted.has(record.id)) record.kbFed = true;
    await browser.storage.local.set({ [STORAGE_KEY]: records });
  });
}

export function resetExpansionsKbFed(ids) {
  const wanted = new Set(ids);
  return serialize(async () => {
    const records = await loadExpansionRecords();
    for (const record of records) if (wanted.has(record.id)) record.kbFed = false;
    await browser.storage.local.set({ [STORAGE_KEY]: records });
  });
}

export function clearExpansionRecords() {
  return serialize(() => browser.storage.local.remove(STORAGE_KEY));
}

/**
 * Records grouped by page, newest page first: one curator pass per page, like
 * one pass per conversation. `id` is stable for a page's unfed group.
 */
export function groupByPage(records) {
  const groups = new Map();
  for (const record of records) {
    const key = record.url || '(unknown page)';
    let group = groups.get(key);
    if (!group) {
      group = { id: `page:${key}`, url: record.url || '', title: record.title || '', records: [], updatedAt: 0 };
      groups.set(key, group);
    }
    group.records.push(record);
    if (record.title) group.title = record.title;
    group.updatedAt = Math.max(group.updatedAt, record.timestamp || 0);
  }
  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
