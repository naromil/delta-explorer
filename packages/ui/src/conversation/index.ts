/** Rendering and expanding answers: shared by the chat, the look-up and the canvas. */
export { default as Markdown } from './Markdown'
export type { MarkdownActions, MarkdownProps, RenderExpansion } from './Markdown'
export { default as ExpansionFrame, OriginalText } from './ExpansionFrame'
export type { ExpansionFrameActions, FramePopupAt } from './ExpansionFrame'
export { default as ContextMenu } from './ContextMenu'
export type { ContextMenuItem, ContextMenuState } from './ContextMenu'
export { default as ExpandPrompt } from './ExpandPrompt'
export type { ExpandPromptState } from './ExpandPrompt'
export { default as ExpandSelectionBar } from './ExpandSelectionBar'
export type { ExpandSelectionBarState } from './ExpandSelectionBar'
export { useExpansionContextMenu } from './useExpansionContextMenu'
export type { ExpandRequest, HighlightRequest, SelectedPassage } from './useExpansionContextMenu'
export { useImageAttachments } from './useImageAttachments'
export type { ExpandOutcome } from './expand-outcome'
export { default as ToolActivityLine } from './ToolActivityLine'
export {
  NO_ACTIVITY_LABELS,
  NO_TOOL_ACTIVITY,
  ToolActivityContext,
  liveActivityLabels,
  resolveToolActivity,
  useToolActivity,
  withActivityLabel,
  withoutActivityLabel
} from '../lib/tool-activity'
export type {
  ActivityEntry,
  ActivityLabels,
  ActivityTarget,
  ToolActivity
} from '../lib/tool-activity'
