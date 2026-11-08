/* Provider and role registries, ported from Delta Explorer's src/shared/models.ts.
 *
 * A configuration is a set of named connections (provider + credentials) plus
 * one assignment per role (connection + model), so look-ups can run on a fast,
 * cheap model while chat uses a stronger one. */

export const providerRegistry = {
  'google-ai-studio': {
    label: 'Google AI Studio',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    knownModels: ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemma-4-31b-it']
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    authShape: 'apiKey'
  },
  openai: {
    label: 'OpenAI',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.openai.com/v1',
    knownModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-nano', 'gpt-4o', 'gpt-5.6-luna']
  },
  ollama: {
    label: 'Ollama',
    authShape: 'host',
    knownModels: ['qwen3:4b', 'gemma4:e4b', 'gpt-oss:20b', 'llama3.2:1b', 'llama3.2:3b']
  },
  openrouter: {
    label: 'OpenRouter',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    knownModels: ['google/gemini-3.5-flash', 'google/gemini-3.1-flash-lite', 'openai/gpt-oss-120b', 'openai/gpt-4o-mini', 'openai/gpt-5-nano']
  }
};

export const PROVIDER_TYPES = Object.keys(providerRegistry);

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

export const roleRegistry = {
  chat: {
    label: 'Chat',
    description: 'Conversations in the Chat view, and expansions inside them.'
  },
  lookup: {
    label: 'Look-up',
    description: 'The toolbar look-up and expansions on web pages. A fast, cheap model works well.'
  },
  'kb-maintenance': {
    label: 'Knowledge Base Maintenance',
    description: 'Curates your conversations into memory notes. Needs tool calling; leave unassigned to turn learning off.'
  }
};

export const ROLE_IDS = Object.keys(roleRegistry);

export const MODEL_CONFIG_VERSION = 1;

export function createDefaultModelConfig() {
  return {
    schemaVersion: MODEL_CONFIG_VERSION,
    connections: {},
    roles: {
      chat: { connectionId: null, model: '' },
      lookup: { connectionId: null, model: '' },
      'kb-maintenance': { connectionId: null, model: '' }
    }
  };
}

export function generateConnectionId() {
  return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/* ---- App settings ---- */

/** `pageContext` is what the look-up popup sends along: nothing, the selection, or the page. */
export const PAGE_CONTEXT_MODES = ['none', 'selection', 'page'];
export const THEME_MODES = ['system', 'light', 'dark'];

export function createDefaultSettings() {
  return {
    theme: 'system',
    kbAutoMaintain: true,
    pageContext: 'selection',
    /** Show the Expand bar over any text selected on a web page (it always shows inside answers). */
    pageSelectionBar: false
  };
}

export function normalizeSettings(raw) {
  const defaults = createDefaultSettings();
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    theme: THEME_MODES.includes(value.theme) ? value.theme : defaults.theme,
    kbAutoMaintain: typeof value.kbAutoMaintain === 'boolean' ? value.kbAutoMaintain : defaults.kbAutoMaintain,
    pageContext: PAGE_CONTEXT_MODES.includes(value.pageContext) ? value.pageContext : defaults.pageContext,
    pageSelectionBar: typeof value.pageSelectionBar === 'boolean' ? value.pageSelectionBar : defaults.pageSelectionBar
  };
}
