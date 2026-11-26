import { useEffect, useMemo, useRef, useState } from 'react'
import { CONVERSATION_SOURCE_LABELS } from '@delta/core/conversation'
import type { ExpandedTerm, MappedConversation, TermPlace } from '@delta/core/expansion-map'
import { buildExpansionMap, filterExpansionMap } from '@delta/core/expansion-map'
import { formatRelativeTime } from '@delta/ui/lib/format'
import { loadExploredConversations } from './load-explored'
import type { LoadProgress } from './load-explored'

/** Connections shown per direction; the rest are counted. */
const LINK_LIMIT = 8

interface ExploredViewProps {
  /** Opens the conversation, at the term when it is a chat or a look-up. */
  onOpenTerm: (place: TermPlace, label: string) => void
}

function TermLinks({
  label,
  keys,
  terms,
  onFocus
}: {
  label: string
  keys: string[]
  terms: Map<string, ExpandedTerm>
  onFocus: (key: string) => void
}): React.JSX.Element | null {
  if (keys.length === 0) return null
  const shown = keys.slice(0, LINK_LIMIT)
  return (
    <div className="explored-links">
      <span className="explored-links-label">{label}</span>
      {shown.map((key) => (
        <button
          key={key}
          type="button"
          className="explored-chip"
          title="Show this term"
          onClick={() => onFocus(key)}
        >
          {terms.get(key)?.label ?? key}
        </button>
      ))}
      {keys.length > shown.length && (
        <span className="explored-links-more">+{keys.length - shown.length} more</span>
      )}
    </div>
  )
}

function expandedTimes(term: ExpandedTerm): string {
  const times = term.count === 1 ? 'Expanded once' : `Expanded ${term.count} times`
  return term.places.length > 1 ? `${times} in ${term.places.length} conversations` : times
}

/**
 * Every term the user expanded, across conversations: repeats first, where each was asked,
 * and which terms led to which. Read from the stored conversations whenever it opens.
 */
function ExploredView({ onOpenTerm }: ExploredViewProps): React.JSX.Element {
  const [conversations, setConversations] = useState<MappedConversation[] | null>(null)
  const [progress, setProgress] = useState<LoadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const itemRefs = useRef(new Map<string, HTMLLIElement>())

  useEffect(() => {
    let cancelled = false
    loadExploredConversations(
      window.api,
      (next) => {
        if (!cancelled) setProgress(next)
      },
      () => cancelled
    )
      .then((loaded) => {
        if (!cancelled) setConversations(loaded)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not read your conversations.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const terms = useMemo(() => buildExpansionMap(conversations ?? []), [conversations])
  const byKey = useMemo(() => new Map(terms.map((term) => [term.key, term])), [terms])
  const shown = useMemo(() => filterExpansionMap(terms, query), [terms, query])
  const repeated = terms.filter((term) => term.count > 1).length

  useEffect(() => {
    if (focusedKey) itemRefs.current.get(focusedKey)?.scrollIntoView({ block: 'center' })
  }, [focusedKey])

  const focusTerm = (key: string): void => {
    if (!filterExpansionMap(terms, query).some((term) => term.key === key)) setQuery('')
    setFocusedKey(key)
  }

  const status = error
    ? null
    : conversations === null
      ? progress && progress.total > 0
        ? `Reading conversations… ${progress.read} of ${progress.total}`
        : 'Reading conversations…'
      : terms.length === 0
        ? null
        : `${terms.length} ${terms.length === 1 ? 'term' : 'terms'} · ${repeated} expanded more than once`

  return (
    <div className="view-shell">
      <div className="view-shell-header">
        <h1>Explored</h1>
        <p className="view-shell-subtitle">
          Every term you expanded, across your conversations. Repeats come first; open a
          conversation to jump back to where you asked.
        </p>
      </div>
      <div className="view-shell-content">
        {terms.length > 0 && (
          <input
            type="text"
            className="field explored-filter"
            placeholder="Filter terms"
            aria-label="Filter terms"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        {error && <p className="explored-error">{error}</p>}
        {status && (
          <p className="explored-status" aria-live="polite">
            {status}
          </p>
        )}
        {conversations !== null && terms.length === 0 && !error && (
          <p className="view-empty-state">
            Nothing expanded yet. Select a word in an answer and press{' '}
            <kbd className="kbd">Ctrl/Cmd+E</kbd> to expand it; it will appear here.
          </p>
        )}
        {terms.length > 0 && shown.length === 0 && (
          <p className="view-empty-state">No term matches “{query.trim()}”.</p>
        )}
        <ul className="explored-list">
          {shown.map((term) => (
            <li
              key={term.key}
              ref={(el) => {
                if (el) itemRefs.current.set(term.key, el)
                else itemRefs.current.delete(term.key)
              }}
              className={`explored-term${term.key === focusedKey ? ' is-focused' : ''}`}
            >
              <div className="explored-term-head">
                <span className="explored-term-label">{term.label}</span>
                <span className={`explored-term-count${term.count > 1 ? ' is-repeat' : ''}`}>
                  {expandedTimes(term)}
                </span>
              </div>
              <div className="explored-places">
                {term.places.map((place) => (
                  <button
                    key={place.id}
                    type="button"
                    className="explored-place"
                    title={
                      place.source === 'canvas'
                        ? 'Open this canvas'
                        : 'Open this conversation at the term'
                    }
                    onClick={() => onOpenTerm(place, term.label)}
                  >
                    <span className="explored-place-title">{place.title}</span>
                    <span className="explored-place-meta">
                      {CONVERSATION_SOURCE_LABELS[place.source]} ·{' '}
                      {formatRelativeTime(place.updatedAt)}
                      {place.count > 1 ? ` · ×${place.count}` : ''}
                    </span>
                  </button>
                ))}
              </div>
              <TermLinks label="Led to" keys={term.ledTo} terms={byKey} onFocus={focusTerm} />
              <TermLinks label="Came from" keys={term.cameFrom} terms={byKey} onFocus={focusTerm} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default ExploredView
