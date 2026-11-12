import { useLayoutEffect, useRef, useState } from 'react'
import { EXPAND_INTENTS } from '@delta/core/prompts'

export interface ExpandSelectionBarState {
  /** Horizontal centre and top edge of the selection. */
  x: number
  y: number
  /** Bottom edge, used when there is no room above the selection. */
  bottom: number
  /** Absent when the selection cannot become an expansion (it crosses blocks). */
  onExpand?: (prompt?: string) => void
  onAsk?: () => void
  /** Toggles a highlight; `highlighted` says the selection is inside one already. */
  onHighlight?: () => void
  highlighted?: boolean
  /** Links the selected text to another card (the canvas). */
  onLink?: () => void
}

const BAR_GAP = 6

/**
 * Floats over a selection in an answer, so expanding takes one click and no right-click.
 * Expand and Ask… stay on the bar; the preset questions wait in a secondary menu.
 */
function ExpandSelectionBar({
  state
}: {
  state: ExpandSelectionBarState | null
}): React.JSX.Element | null {
  const barRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  // Open for one selection only: a new selection brings the bar back closed.
  const [moreFor, setMoreFor] = useState<ExpandSelectionBarState | null>(null)
  const moreOpen = state !== null && moreFor === state

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!state || !bar) {
      setPosition(null)
      return
    }
    const rect = bar.getBoundingClientRect()
    const above = state.y - rect.height - BAR_GAP
    setPosition({
      left: Math.max(8, Math.min(state.x - rect.width / 2, window.innerWidth - rect.width - 8)),
      top: above >= 8 ? above : state.bottom + BAR_GAP
    })
  }, [state])

  if (!state) return null
  const { onExpand, onAsk, onHighlight, onLink } = state

  return (
    <div
      ref={barRef}
      className="expand-selection-bar"
      role="toolbar"
      aria-label="Selection actions"
      style={position ?? { left: state.x, top: state.y, visibility: 'hidden' }}
      // Clicking the bar must not clear the selection it acts on.
      onMouseDown={(e) => e.preventDefault()}
    >
      {onExpand ? (
        <button
          type="button"
          className="expand-intent expand-intent--primary"
          onClick={() => onExpand()}
        >
          Expand
        </button>
      ) : null}
      {onAsk ? (
        <button type="button" className="expand-intent" onClick={onAsk}>
          Ask…
        </button>
      ) : null}
      {onHighlight ? (
        <button
          type="button"
          className={`expand-intent${state.highlighted ? ' is-active' : ''}`}
          title={
            state.highlighted
              ? 'Remove the highlight'
              : 'Mark as important: knowledge maintenance pays attention to highlights'
          }
          aria-pressed={state.highlighted ?? false}
          onClick={onHighlight}
        >
          {state.highlighted ? 'Unhighlight' : 'Highlight'}
        </button>
      ) : null}
      {onLink ? (
        <button
          type="button"
          className="expand-intent"
          title="Send this passage as context to another card or the composer"
          onClick={onLink}
        >
          Link…
        </button>
      ) : null}
      {onExpand ? (
        <div className="expand-more">
          <button
            type="button"
            className={`expand-intent${moreOpen ? ' is-active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            title="More questions"
            onClick={() => setMoreFor(moreOpen ? null : state)}
          >
            More ▾
          </button>
          {moreOpen ? (
            <div className="expand-more-menu" role="menu">
              {EXPAND_INTENTS.map((intent) => (
                <button
                  key={intent.label}
                  type="button"
                  role="menuitem"
                  className="expand-intent"
                  title={intent.prompt}
                  onClick={() => onExpand(intent.prompt)}
                >
                  {intent.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default ExpandSelectionBar
