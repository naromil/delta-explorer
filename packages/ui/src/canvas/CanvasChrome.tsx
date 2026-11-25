/**
 * The board's fixed chrome around the plane: the title bar, the zoom bar, the empty canvas's
 * welcome and the hint line. They hold no state; `CanvasView` owns what they show.
 */
import type { RefObject } from 'react'
import type { CanvasViewport } from '@delta/core/canvas'
import type { CanvasNotice, Placing } from './board-model'
import { PASSAGE_PICK_TARGET } from './board-model'
import CanvasIcon from './CanvasIcons'
import { ZOOM_STEP } from './useCanvasKeyboard'

export type CanvasExportState = 'idle' | 'exporting' | 'saved'

export function CanvasTitleBar({
  title,
  empty,
  exportState,
  extras,
  onRename,
  onOpenHistory,
  onNew,
  onExport
}: {
  title: string
  /** Nothing on the canvas: New and Export have nothing to act on. */
  empty: { cards: boolean; frames: boolean }
  exportState: CanvasExportState
  extras?: React.ReactNode
  onRename: (title: string) => void
  onOpenHistory: (e: React.MouseEvent) => void
  onNew: () => void
  onExport: () => void
}): React.JSX.Element {
  return (
    <div className="canvas-toolbar canvas-toolbar--title">
      <input
        key={title}
        className="canvas-title"
        aria-label="Canvas name"
        defaultValue={title}
        title={title}
        onBlur={(e) => onRename(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            // Put the name back before blur commits it, and keep the key from the board.
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.value = title
            e.currentTarget.blur()
          }
        }}
      />
      <button
        type="button"
        className="canvas-tool"
        aria-haspopup="menu"
        aria-label="History"
        data-tip="History: canvases, chats and look-ups"
        onClick={onOpenHistory}
      >
        ▾
      </button>
      <button
        type="button"
        className="canvas-tool"
        data-tip="Start a new, empty canvas"
        disabled={empty.cards && empty.frames}
        onClick={onNew}
      >
        New
      </button>
      <button
        type="button"
        className="canvas-tool"
        data-tip="Save this canvas as markdown"
        disabled={empty.cards || exportState === 'exporting'}
        onClick={onExport}
      >
        {exportState === 'exporting' ? 'Exporting…' : exportState === 'saved' ? 'Saved' : 'Export'}
      </button>
      {extras}
    </div>
  )
}

export function CanvasZoomBar({
  zoomValueRef,
  viewportRef,
  minimapOpen,
  helpOpen,
  onZoomBy,
  onShowEverything,
  onToggleMinimap,
  onToggleHelp
}: {
  /** Painted with the live zoom outside React, as the plane moves. */
  zoomValueRef: RefObject<HTMLSpanElement | null>
  viewportRef: RefObject<CanvasViewport>
  minimapOpen: boolean
  helpOpen: boolean
  onZoomBy: (factor: number) => void
  onShowEverything: () => void
  onToggleMinimap: () => void
  onToggleHelp: () => void
}): React.JSX.Element {
  return (
    <div className="canvas-toolbar canvas-toolbar--zoom" role="toolbar" aria-label="Zoom">
      <button
        type="button"
        className="canvas-tool"
        aria-label="Zoom out"
        data-tip="Zoom out  (−)"
        onClick={() => onZoomBy(1 / ZOOM_STEP)}
      >
        −
      </button>
      <button
        type="button"
        className="canvas-tool canvas-zoom-value"
        aria-label="Reset zoom to 100%"
        data-tip="Reset to 100%  (1)"
        onClick={() => onZoomBy(1 / viewportRef.current.zoom)}
      >
        <span ref={zoomValueRef} />
      </button>
      <button
        type="button"
        className="canvas-tool"
        aria-label="Zoom in"
        data-tip="Zoom in  (+)"
        onClick={() => onZoomBy(ZOOM_STEP)}
      >
        +
      </button>
      <button
        type="button"
        className="canvas-tool"
        data-tip="Show everything  (0)"
        onClick={onShowEverything}
      >
        Fit
      </button>
      <button
        type="button"
        className={`canvas-tool canvas-tool--icon${minimapOpen ? ' is-toggled' : ''}`}
        aria-label="Map"
        aria-pressed={minimapOpen}
        data-tip="Show or hide the map  (M)"
        onClick={onToggleMinimap}
      >
        <CanvasIcon name="map" />
      </button>
      <button
        type="button"
        className={`canvas-tool${helpOpen ? ' is-toggled' : ''}`}
        aria-label="Keyboard shortcuts"
        aria-expanded={helpOpen}
        data-tip="Keyboard and mouse shortcuts  (?)"
        onClick={onToggleHelp}
      >
        ?
      </button>
    </div>
  )
}

export function CanvasEmpty(): React.JSX.Element {
  return (
    <div className="canvas-empty">
      <h2>Draw a rectangle</h2>
      <p>
        Delta writes an answer sized to fit it. Draw against a side to continue the same
        conversation, or anywhere else to start a new one.
      </p>
      <ul className="canvas-empty-keys">
        <li>
          <kbd>N</kbd> type a question
        </li>
        <li>
          <kbd>T</kbd> write a note
        </li>
        <li>
          <kbd>?</kbd> every shortcut
        </li>
      </ul>
    </div>
  )
}

/** One line at the bottom: a notice first, then what a pending pick waits for, then the tool's hint. */
export function CanvasHint({
  message,
  placing,
  linkingPassage,
  toolHint,
  onUndo
}: {
  message: CanvasNotice | null
  placing: Placing | null
  linkingPassage: boolean
  toolHint: string | null | undefined
  onUndo: () => void
}): React.JSX.Element | null {
  if (!placing && !linkingPassage && !message && !toolHint) return null
  return (
    <div className="canvas-hint" role="status">
      {message ? (
        <>
          {message.text}
          {message.undoable ? (
            <button type="button" className="canvas-hint-action" onClick={onUndo}>
              Undo
            </button>
          ) : null}
        </>
      ) : placing ? (
        <>
          Draw a rectangle to size the answer to “{placing.label}”, or click for the default size.
          Esc cancels.
        </>
      ) : linkingPassage ? (
        PASSAGE_PICK_TARGET
      ) : (
        toolHint
      )}
    </div>
  )
}
