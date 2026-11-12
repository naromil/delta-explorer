export type ProviderType =
  | 'google-ai-studio'
  | 'openai-compatible'
  | 'openai'
  | 'ollama'
  | 'openrouter'
  | 'anthropic'
  | 'mistral'
  | 'groq'
  | 'deepseek'
  | 'xai'
  | 'together'
  | 'lmstudio'
  | 'claude-code'

/** `cli` runs a local command instead of calling an HTTP endpoint (see `Connection.command`). */
export type AuthShape = 'apiKey' | 'none' | 'host' | 'cli'

export type PrivacyTier = 'local' | 'cloud-zdr' | 'cloud'

/** `chat` answers in every window (chat, look-up popup, canvas, expansions). */
export type RoleId = 'chat' | 'kb-maintenance'

export type LookupContextMode = 'none' | 'clipboard' | 'fullscreen-ocr'

export type ThemeMode = 'system' | 'light' | 'dark'

export type { ImageInput, ProviderMessage } from '@delta/core/messages'

export interface ProviderTypeDef {
  label: string
  authShape: AuthShape
  defaultBaseUrl?: string
  implemented: boolean
  knownModels?: string[]
}

export interface RoleDef {
  label: string
  description: string
  locked: boolean
}

export interface Connection {
  id: string
  label: string
  providerType: ProviderType
  /** Only present in main, or in the renderer while the user types a new key. */
  apiKey?: string
  /** Renderer-only: a key is stored for this connection (see `redactModelConfig`). */
  hasApiKey?: boolean
  baseUrl?: string
  host?: string
  /** `cli` providers: the executable to run; blank finds it on PATH. */
  command?: string
}

export interface RoleAssignment {
  connectionId: string | null
  model: string
}

export interface ModelConfig {
  schemaVersion: number
  connections: Record<string, Connection>
  roles: Record<RoleId, RoleAssignment>
}

/**
 * v4 merged the chat and lookup roles into one assistant role.
 * v3 dropped the per-role web-search flag: search is only reachable through
 * provider-specific tools, so a common flag could not be honoured uniformly.
 */
export const MODEL_CONFIG_VERSION = 4

export const providerRegistry: Record<ProviderType, ProviderTypeDef> = {
  'google-ai-studio': {
    label: 'Google AI Studio',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    implemented: true,
    knownModels: [
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemma-4-31b-it'
    ]
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    authShape: 'apiKey',
    implemented: true
  },
  openai: {
    label: 'OpenAI',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.openai.com/v1',
    implemented: true,
    knownModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-nano', 'gpt-4o', 'gpt-5.6-luna']
  },
  ollama: {
    label: 'Ollama',
    authShape: 'host',
    implemented: true,
    knownModels: ['qwen3:4b', 'gemma4:e4b', 'gpt-oss:20b', 'llama3.2:1b', 'llama3.2:3b']
  },
  openrouter: {
    label: 'OpenRouter',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    implemented: true,
    knownModels: [
      'google/gemini-3.5-flash',
      'google/gemini-3.1-flash-lite',
      'openai/gpt-oss-120b',
      'openai/gpt-4o-mini',
      'openai/gpt-5-nano'
    ]
  },
  anthropic: {
    label: 'Anthropic',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    implemented: true,
    knownModels: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']
  },
  mistral: {
    label: 'Mistral',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    implemented: true,
    knownModels: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest']
  },
  groq: {
    label: 'Groq',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    implemented: true,
    knownModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile']
  },
  deepseek: {
    label: 'DeepSeek',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    implemented: true,
    knownModels: ['deepseek-chat', 'deepseek-reasoner']
  },
  xai: {
    label: 'xAI',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.x.ai/v1',
    implemented: true,
    knownModels: ['grok-4-fast', 'grok-4']
  },
  together: {
    label: 'Together AI',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    implemented: true,
    knownModels: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct-Turbo']
  },
  lmstudio: {
    label: 'LM Studio',
    authShape: 'none',
    defaultBaseUrl: 'http://localhost:1234/v1',
    implemented: true
  },
  'claude-code': {
    label: 'Claude Code (headless)',
    authShape: 'cli',
    implemented: true,
    knownModels: ['sonnet', 'opus', 'haiku', 'fable']
  }
}

/** Providers reached by spawning a local CLI rather than over HTTP. */
export function isCliProvider(providerType: ProviderType): boolean {
  return providerRegistry[providerType]?.authShape === 'cli'
}

export const roleRegistry: Record<RoleId, RoleDef> = {
  chat: {
    label: 'Assistant',
    description: 'Answers in the chat, the look-up popup, the canvas and expansions',
    locked: false
  },
  'kb-maintenance': {
    label: 'Knowledge Base Maintenance',
    description: 'Model used to process and maintain the local knowledge base',
    locked: false
  }
}

export const DEFAULT_ROLES: Record<RoleId, RoleAssignment> = {
  chat: { connectionId: null, model: '' },
  'kb-maintenance': { connectionId: null, model: '' }
}

export function createDefaultModelConfig(): ModelConfig {
  return {
    schemaVersion: MODEL_CONFIG_VERSION,
    connections: {},
    roles: {
      chat: { ...DEFAULT_ROLES.chat },
      'kb-maintenance': { ...DEFAULT_ROLES['kb-maintenance'] }
    }
  }
}

export function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}
