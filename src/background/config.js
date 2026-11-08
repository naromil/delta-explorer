/* Model config (connections + role assignments) and app settings in
 * browser.storage.local, with a one-time migration from the extension's
 * earlier single-provider `deltaConfig` / `deltaKbConfig` keys. */

import {
  createDefaultModelConfig,
  createDefaultSettings,
  generateConnectionId,
  normalizeSettings,
  providerRegistry,
  ROLE_IDS
} from '../shared/models.js';

export const MODEL_CONFIG_KEY = 'deltaModelConfig';
export const SETTINGS_KEY = 'deltaSettings';
const LEGACY_CONFIG_KEY = 'deltaConfig';
const LEGACY_KB_CONFIG_KEY = 'deltaKbConfig';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Never trust what storage holds: keep known providers, drop dangling role references. */
export function normalizeModelConfig(raw) {
  const config = createDefaultModelConfig();
  if (!isObject(raw)) return config;
  if (isObject(raw.connections)) {
    for (const [id, conn] of Object.entries(raw.connections)) {
      if (!isObject(conn) || !providerRegistry[conn.providerType]) continue;
      config.connections[id] = {
        id,
        label: typeof conn.label === 'string' ? conn.label : providerRegistry[conn.providerType].label,
        providerType: conn.providerType,
        apiKey: typeof conn.apiKey === 'string' ? conn.apiKey : '',
        baseUrl: typeof conn.baseUrl === 'string' ? conn.baseUrl : '',
        host: typeof conn.host === 'string' ? conn.host : ''
      };
    }
  }
  if (isObject(raw.roles)) {
    for (const role of ROLE_IDS) {
      const assignment = raw.roles[role];
      if (!isObject(assignment)) continue;
      const connectionId = typeof assignment.connectionId === 'string' && config.connections[assignment.connectionId]
        ? assignment.connectionId
        : null;
      config.roles[role] = {
        connectionId,
        model: typeof assignment.model === 'string' ? assignment.model.trim() : ''
      };
    }
  }
  return config;
}

function connectionFromLegacy(legacy, label) {
  const providerType = providerRegistry[legacy.providerType] ? legacy.providerType : 'openai-compatible';
  return {
    id: generateConnectionId(),
    label,
    providerType,
    apiKey: legacy.apiKey || '',
    baseUrl: providerType === 'google-ai-studio' ? '' : (legacy.baseUrl || ''),
    host: legacy.host || ''
  };
}

/** The earlier single provider becomes one connection assigned to chat and look-up. */
function migrateLegacyConfig(legacy, legacyKb) {
  const config = createDefaultModelConfig();
  if (!isObject(legacy)) return config;
  const hasLegacy = legacy.apiKey || legacy.model || legacy.baseUrl || legacy.host;
  if (!hasLegacy) return config;
  const main = connectionFromLegacy(legacy, providerRegistry[legacy.providerType]?.label || 'Connection');
  config.connections[main.id] = main;
  config.roles.chat = { connectionId: main.id, model: legacy.model || '' };
  config.roles.lookup = { connectionId: main.id, model: legacy.model || '' };
  config.roles['kb-maintenance'] = { connectionId: main.id, model: legacy.model || '' };

  if (isObject(legacyKb) && (legacyKb.providerType || legacyKb.model)) {
    const kbLegacy = {
      providerType: legacyKb.providerType || legacy.providerType,
      apiKey: legacyKb.apiKey || legacy.apiKey,
      baseUrl: legacyKb.baseUrl || legacy.baseUrl,
      host: legacyKb.host || legacy.host
    };
    const sameConnection = kbLegacy.providerType === legacy.providerType && kbLegacy.apiKey === legacy.apiKey &&
      kbLegacy.baseUrl === legacy.baseUrl && kbLegacy.host === legacy.host;
    let kbConnectionId = main.id;
    if (!sameConnection) {
      const kbConn = connectionFromLegacy(kbLegacy, 'Knowledge Base');
      config.connections[kbConn.id] = kbConn;
      kbConnectionId = kbConn.id;
    }
    config.roles['kb-maintenance'] = { connectionId: kbConnectionId, model: legacyKb.model || legacy.model || '' };
  }
  return config;
}

export async function loadModelConfig() {
  const obj = await browser.storage.local.get([MODEL_CONFIG_KEY, LEGACY_CONFIG_KEY, LEGACY_KB_CONFIG_KEY]);
  if (obj[MODEL_CONFIG_KEY]) return normalizeModelConfig(obj[MODEL_CONFIG_KEY]);
  const migrated = migrateLegacyConfig(obj[LEGACY_CONFIG_KEY], obj[LEGACY_KB_CONFIG_KEY]);
  await browser.storage.local.set({ [MODEL_CONFIG_KEY]: migrated });
  await browser.storage.local.remove([LEGACY_CONFIG_KEY, LEGACY_KB_CONFIG_KEY]);
  return migrated;
}

export async function saveModelConfig(raw) {
  const config = normalizeModelConfig(raw);
  await browser.storage.local.set({ [MODEL_CONFIG_KEY]: config });
  return config;
}

export class RoleUnassignedError extends Error {
  constructor(role) {
    const label = role === 'kb-maintenance' ? 'Knowledge Base Maintenance' : role === 'lookup' ? 'Look-up' : 'Chat';
    super(`No model is assigned to the ${label} role. Open Settings → Models to assign one.`);
    this.name = 'RoleUnassignedError';
  }
}

/** `{ connection, model }` for a role, or null when it is not fully assigned. */
export async function resolveRole(role) {
  const config = await loadModelConfig();
  const assignment = config.roles[role];
  if (!assignment || !assignment.connectionId || !assignment.model) return null;
  const connection = config.connections[assignment.connectionId];
  if (!connection) return null;
  return { connection, model: assignment.model };
}

export async function loadSettings() {
  const obj = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(obj[SETTINGS_KEY]);
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...(isObject(patch) ? patch : {}) });
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export { createDefaultSettings };
