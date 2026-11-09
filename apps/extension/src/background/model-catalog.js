/* models.dev catalog (24h cache, offline fallback) plus endpoint discovery and
 * connection tests. Ported from Delta Explorer's services/model-catalog.ts,
 * shared/model-catalog.ts and services/model-discovery.ts. */

import { DEFAULT_OLLAMA_HOST, providerRegistry } from '../shared/models.js';

const CATALOG_URL = 'https://models.dev/api.json';
const CATALOG_KEY = 'deltaModelCatalog';
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const DISCOVERY_TIMEOUT_MS = 8_000;
const CACHE_VERSION = 1;

/** models.dev provider ids for the types the public catalog can enumerate. */
const CATALOG_PROVIDER_IDS = {
  'google-ai-studio': 'google',
  openai: 'openai',
  openrouter: 'openrouter'
};

let memoryCache = null;
let inFlight = null;

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function readNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildCatalogModel(id, raw) {
  const model = asRecord(raw);
  if (!model) return null;
  if (model.type !== undefined && model.type !== 'language') return null;
  const limit = asRecord(model.limit) || {};
  const cost = asRecord(model.cost) || {};
  const input = (asRecord(model.modalities) || {}).input;
  return {
    id,
    name: typeof model.name === 'string' && model.name ? model.name : id,
    contextWindow: readNumber(limit.context),
    maxOutput: readNumber(limit.output),
    toolCall: model.tool_call === true,
    reasoning: model.reasoning === true,
    inputModalities: Array.isArray(input) ? input.filter((m) => typeof m === 'string') : [],
    costIn: readNumber(cost.input),
    costOut: readNumber(cost.output)
  };
}

function buildModelCatalog(raw, fetchedAt) {
  const providers = asRecord(raw) || {};
  const result = {};
  for (const [providerType, catalogId] of Object.entries(CATALOG_PROVIDER_IDS)) {
    const models = asRecord(asRecord(providers[catalogId])?.models) || {};
    const built = [];
    for (const [id, model] of Object.entries(models)) {
      const entry = buildCatalogModel(id, model);
      if (entry) built.push(entry);
    }
    if (built.length > 0) result[providerType] = built.sort((a, b) => a.id.localeCompare(b.id));
  }
  return { fetchedAt, providers: result };
}

function isFresh(catalog) {
  const fetchedAt = Date.parse(catalog.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < CATALOG_MAX_AGE_MS;
}

async function readCache() {
  try {
    const obj = await browser.storage.local.get(CATALOG_KEY);
    const cached = obj[CATALOG_KEY];
    if (!cached || cached.version !== CACHE_VERSION || !cached.catalog?.providers) return null;
    return cached.catalog;
  } catch {
    return null;
  }
}

async function refresh() {
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
    const catalog = buildModelCatalog(await res.json(), new Date().toISOString());
    if (Object.keys(catalog.providers).length === 0) throw new Error('models.dev returned no usable providers');
    memoryCache = catalog;
    await browser.storage.local.set({ [CATALOG_KEY]: { version: CACHE_VERSION, catalog } });
    return { catalog, source: 'network' };
  } catch (err) {
    const stale = memoryCache || await readCache();
    const error = err?.message || String(err);
    return stale ? { catalog: stale, source: 'cache', error } : { catalog: null, source: 'unavailable', error };
  }
}

/** `{ catalog, source: 'network' | 'cache' | 'unavailable', error? }` */
export async function getModelCatalog({ force = false } = {}) {
  if (!force) {
    if (memoryCache && isFresh(memoryCache)) return { catalog: memoryCache, source: 'cache' };
    const cached = await readCache();
    if (cached) {
      memoryCache = cached;
      if (isFresh(cached)) return { catalog: cached, source: 'cache' };
    }
  }
  if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
  return inFlight;
}

/** Offline-only lookup for budgeting and tool gating; never fetches, never throws. */
export async function getCachedModel(providerType, modelId) {
  try {
    const catalog = memoryCache || await readCache();
    if (catalog && !memoryCache) memoryCache = catalog;
    return (catalog?.providers?.[providerType] || []).find((model) => model.id === modelId) || null;
  } catch {
    return null;
  }
}

/* ---- Discovery and connection tests ---- */

function resolveListBase(connection) {
  if (connection.providerType === 'ollama') return stripSlashes(connection.host || DEFAULT_OLLAMA_HOST);
  if (connection.providerType === 'google-ai-studio') return providerRegistry['google-ai-studio'].defaultBaseUrl;
  const base = connection.baseUrl || providerRegistry[connection.providerType]?.defaultBaseUrl;
  return base ? stripSlashes(base) : null;
}

function stripSlashes(value) {
  return String(value).trim().replace(/\/+$/, '');
}

function authHeaders(connection) {
  if (!connection.apiKey || connection.providerType === 'ollama') return {};
  if (connection.providerType === 'google-ai-studio') return { 'x-goog-api-key': connection.apiKey };
  return { Authorization: `Bearer ${connection.apiKey}` };
}

function parseModels(connection, payload) {
  const record = asRecord(payload) || {};
  if (connection.providerType === 'ollama') {
    return (Array.isArray(record.models) ? record.models : []).map((m) => m?.name).filter((n) => typeof n === 'string' && n);
  }
  if (connection.providerType === 'google-ai-studio') {
    return (Array.isArray(record.models) ? record.models : []).flatMap((m) => {
      if (!m || typeof m.name !== 'string') return [];
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      if (!methods.includes('generateContent')) return [];
      const id = m.name.startsWith('models/') ? m.name.slice(7) : m.name;
      return id ? [id] : [];
    });
  }
  return (Array.isArray(record.data) ? record.data : []).map((m) => m?.id).filter((id) => typeof id === 'string' && id);
}

/** `{ models: string[], error? }` from the endpoint's own model list. */
export async function discoverConnectionModels(connection) {
  try {
    const base = resolveListBase(connection);
    if (!base) return { models: [], error: 'Base URL is required for the OpenAI Compatible provider.' };
    const url = connection.providerType === 'ollama' ? `${base}/api/tags` : `${base}/models`;
    const res = await fetch(url, { headers: authHeaders(connection), signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (!res.ok) return { models: [], error: `HTTP ${res.status}${res.statusText ? ': ' + res.statusText : ''}`, status: res.status };
    let payload;
    try { payload = await res.json(); } catch { return { models: [], error: `Invalid JSON response from ${url}` }; }
    return { models: [...new Set(parseModels(connection, payload))].sort() };
  } catch (err) {
    return { models: [], error: err?.message || String(err) };
  }
}

/** `{ ok, detail }`: lists models, or probes a chat completion when listing is unsupported. */
export async function testConnection(connection, probeModel) {
  const discovery = await discoverConnectionModels(connection);
  if (discovery.models.length > 0) return { ok: true, detail: `${discovery.models.length} models available` };
  const status = discovery.status ?? null;
  if (status === 401 || (status === 403 && connection.providerType === 'google-ai-studio')) {
    return { ok: false, detail: `API key rejected (HTTP ${status})` };
  }
  if (probeModel && (status === 403 || status === 404 || status === 405)) {
    try {
      const base = resolveListBase(connection);
      const url = connection.providerType === 'ollama' ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(connection) },
        body: JSON.stringify({ model: probeModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
      });
      if (res.ok) return { ok: true, detail: `Endpoint reachable (no model list: HTTP ${status})` };
      if (res.status === 401) return { ok: false, detail: `API key rejected (HTTP ${res.status})` };
      return { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err?.message || String(err) };
    }
  }
  return { ok: false, detail: discovery.error || 'No models available' };
}
