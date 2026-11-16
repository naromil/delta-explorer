/**
 * What the model is doing while it uses tools instead of answering. The host reports a label
 * per request; each view records it against the turn or expansion that request answers, and
 * the placeholders read it here, so no label is threaded through `Markdown`.
 */
import { createContext, useContext } from 'react'

/** What a request answers: a whole turn, or one expansion in it. */
export type ActivityTarget = { turnId: number } | { expansionId: number }

export interface ActivityEntry {
  label: string
  target: ActivityTarget
}

/** The newest label of each request that reported one, by `requestId`. */
export type ActivityLabels = ReadonlyMap<string, ActivityEntry>

export interface ToolActivity {
  turns: ReadonlyMap<number, string>
  expansions: ReadonlyMap<number, string>
}

export const NO_ACTIVITY_LABELS: ActivityLabels = new Map()

export const NO_TOOL_ACTIVITY: ToolActivity = { turns: new Map(), expansions: new Map() }

export function withActivityLabel(
  labels: ActivityLabels,
  requestId: string,
  label: string,
  target: ActivityTarget
): ActivityLabels {
  const next = new Map(labels)
  next.set(requestId, { label, target })
  return next
}

/** Returns `labels` itself when there is nothing to remove, so state does not change. */
export function withoutActivityLabel(labels: ActivityLabels, requestId: string): ActivityLabels {
  if (!labels.has(requestId)) return labels
  const next = new Map(labels)
  next.delete(requestId)
  return next
}

/** Keeps the labels of live requests only; `labels` itself when all are live. */
export function liveActivityLabels(
  labels: ActivityLabels,
  live: (requestId: string) => boolean
): ActivityLabels {
  let next = labels
  for (const requestId of labels.keys()) {
    if (!live(requestId)) next = withoutActivityLabel(next, requestId)
  }
  return next
}

export function resolveToolActivity(labels: ActivityLabels): ToolActivity {
  if (labels.size === 0) return NO_TOOL_ACTIVITY
  const turns = new Map<number, string>()
  const expansions = new Map<number, string>()
  for (const { label, target } of labels.values()) {
    if ('expansionId' in target) expansions.set(target.expansionId, label)
    else turns.set(target.turnId, label)
  }
  return { turns, expansions }
}

export const ToolActivityContext = createContext<ToolActivity>(NO_TOOL_ACTIVITY)

export function useToolActivity(): ToolActivity {
  return useContext(ToolActivityContext)
}
