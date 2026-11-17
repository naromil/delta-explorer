/* ---- Knowledge base maintenance ---- */

/** What the automatic learning loop is doing right now. */
export type KbMaintenanceState = 'idle' | 'running' | 'error'

/** Snapshot the Knowledge Base view renders; pushed on every change. */
export interface KbMaintenanceStatus {
  /** User preference (`settings.json` → `kbAutoMaintain`). */
  enabled: boolean
  /** True only when the `kb-maintenance` role resolves to a connection + model. */
  configured: boolean
  state: KbMaintenanceState
  /** Chat conversations waiting to be learned from. */
  pending: number
  /** ISO timestamp of the last successful document base update, automatic or manual. */
  lastLearnedAt: string | null
  /** Conversations curated into the document base by the last successful run. */
  lastAnalyzed: number
  lastError: string | null
  /** What the curator said it changed in the last pass that learned something. */
  lastChanges: KbChange[]
}

/** The curator's one-line reply for one conversation. */
export interface KbChange {
  title: string
  summary: string
}

export const KB_CHANGES_LIMIT = 8
const KB_CHANGE_TITLE_LIMIT = 120
const KB_CHANGE_SUMMARY_LIMIT = 400

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** A reply is model text: flattened, cut, and dropped when blank. */
export function normalizeKbChanges(raw: unknown): KbChange[] {
  if (!Array.isArray(raw)) return []
  const changes: KbChange[] = []
  for (const item of raw) {
    if (changes.length === KB_CHANGES_LIMIT) break
    const { title, summary } = (item ?? {}) as Partial<KbChange>
    if (typeof title !== 'string' || typeof summary !== 'string') continue
    const cut = clip(summary, KB_CHANGE_SUMMARY_LIMIT)
    if (cut) changes.push({ title: clip(title, KB_CHANGE_TITLE_LIMIT), summary: cut })
  }
  return changes
}

export interface KbRunResult {
  conversationsAnalyzed: number
  changes: KbChange[]
}

/**
 * `{userData}/kb/state.json`. Survives restarts so the loop can pace itself
 * (startup respects the interval since the last run) and so the UI can report
 * the last failure instead of retrying blindly.
 */
export interface KbPersistedState {
  lastRunAt: string | null
  lastLearnedAt: string | null
  lastAnalyzed: number
  lastError: string | null
  failedAttempts: number
  lastChanges: KbChange[]
}

export function emptyKbState(): KbPersistedState {
  return {
    lastRunAt: null,
    lastLearnedAt: null,
    lastAnalyzed: 0,
    lastError: null,
    failedAttempts: 0,
    lastChanges: []
  }
}

/** Accept only the shapes the loop can honour; a hand-edited file must not poison it. */
export function normalizeKbState(raw: unknown): KbPersistedState {
  const record =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : ({} as const)
  const isoOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
  return {
    lastRunAt: isoOrNull(record.lastRunAt),
    lastLearnedAt: isoOrNull(record.lastLearnedAt),
    lastAnalyzed: count(record.lastAnalyzed),
    lastError: isoOrNull(record.lastError),
    failedAttempts: count(record.failedAttempts),
    lastChanges: normalizeKbChanges(record.lastChanges)
  }
}
