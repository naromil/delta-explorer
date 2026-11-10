/** The canvas: one board view and the hook that holds the open canvas. */
export { default as CanvasView } from './CanvasView'
export { useCanvas } from './useCanvas'
export type {
  CanvasCardUpdate,
  CanvasExpandPlacement,
  CanvasHistoryStep,
  CanvasPageInput
} from './useCanvas'
