import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { findTextMatches } from './find-text'

const ALL = 'delta-find'
const CURRENT = 'delta-find-current'
/** Formulas keep a hidden text copy and an editor holds its own text; neither is on the page. */
const SKIPPED = '.katex, textarea'
const VIEW_MARGIN_PX = 80

function textNodesIn(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(SKIPPED)) nodes.push(node as Text)
  }
  return nodes
}

function rangesIn(root: HTMLElement, query: string): Range[] {
  const nodes = textNodesIn(root)
  return findTextMatches(
    nodes.map((node) => node.data),
    query
  ).map(({ start, end }) => {
    const range = document.createRange()
    range.setStart(nodes[start.node], start.offset)
    range.setEnd(nodes[end.node], end.offset)
    return range
  })
}

/** Scrolls only when the match is outside the comfortable part of the view. */
function reveal(root: HTMLElement, range: Range): void {
  const box = range.getBoundingClientRect()
  const view = root.getBoundingClientRect()
  if (box.top >= view.top + VIEW_MARGIN_PX && box.bottom <= view.bottom - VIEW_MARGIN_PX) return
  root.scrollTop += box.top - view.top - view.height / 3
}

interface FindBarProps {
  /** The scrolling element whose text is searched. */
  rootRef: RefObject<HTMLElement | null>
  /** Changes whenever the text may have: matches are read again, the place is kept. */
  signal: unknown
  /** Bumped by Ctrl/Cmd+F while the bar is open, to take the focus back. */
  focusKey: number
  onClose: () => void
}

/**
 * Find in the open conversation. Matches are painted with the CSS Custom Highlight
 * API, which leaves the DOM alone: React keeps its nodes, text offsets stay true,
 * and the input keeps the focus, none of which `webContents.findInPage` allows.
 */
function FindBar({ rootRef, signal, focusKey, onClose }: FindBarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState(0)
  const [count, setCount] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  /** The step the view last scrolled for, so streaming text never moves it again. */
  const revealedRef = useRef('')

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusKey])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ranges = rangesIn(root, query.trim())
    setCount(ranges.length)
    if (ranges.length === 0) {
      CSS.highlights.delete(ALL)
      CSS.highlights.delete(CURRENT)
      return
    }
    const current = ranges[Math.min(position, ranges.length - 1)]
    CSS.highlights.set(ALL, new Highlight(...ranges))
    CSS.highlights.set(CURRENT, new Highlight(current))
    const step = `${query}\n${position}`
    if (revealedRef.current !== step) {
      revealedRef.current = step
      reveal(root, current)
    }
  }, [rootRef, query, position, signal])

  useEffect(() => {
    return () => {
      CSS.highlights.delete(ALL)
      CSS.highlights.delete(CURRENT)
    }
  }, [])

  const shown = count === 0 ? 0 : Math.min(position, count - 1)
  const step = (by: number): void => {
    if (count > 0) setPosition((shown + by + count) % count)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      // Claimed here, so Escape closes the bar without also stopping an answer.
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="find-anchor">
      <div className="find-bar" role="search">
        <input
          ref={inputRef}
          className="find-input"
          type="text"
          value={query}
          placeholder="Find in conversation"
          aria-label="Find in conversation"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value)
            setPosition(0)
          }}
          onKeyDown={handleKeyDown}
        />
        <span className="find-count" aria-live="polite">
          {query.trim() === '' ? '' : count === 0 ? 'No matches' : `${shown + 1} of ${count}`}
        </span>
        <button
          className="find-step"
          onClick={() => step(-1)}
          disabled={count === 0}
          aria-label="Previous match"
          title="Previous (Shift+Enter)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
        <button
          className="find-step"
          onClick={() => step(1)}
          disabled={count === 0}
          aria-label="Next match"
          title="Next (Enter)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <button className="find-step" onClick={onClose} aria-label="Close find" title="Close (Esc)">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default FindBar
