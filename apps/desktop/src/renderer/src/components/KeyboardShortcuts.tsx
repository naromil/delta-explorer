import { useEffect, useRef } from 'react'

const SHORTCUTS: ReadonlyArray<{ keys: string[]; action: string }> = [
  { keys: ['Ctrl/Cmd', 'N'], action: 'Start a new chat from any view' },
  { keys: ['Ctrl/Cmd', 'K'], action: 'Search conversations' },
  { keys: ['Ctrl/Cmd', 'F'], action: 'Find in the open chat' },
  { keys: ['Ctrl/Cmd', ','], action: 'Open Settings' },
  { keys: ['Ctrl/Cmd', '/'], action: 'Show these shortcuts from any view' },
  { keys: ['Ctrl/Cmd', 'E'], action: 'Expand the selected text' },
  {
    keys: ['Ctrl/Cmd', 'Shift', 'E'],
    action: 'Expand on… — ask a question about the selection'
  },
  { keys: ['↑'], action: 'Edit your last message (in an empty chat composer)' },
  { keys: ['Esc'], action: 'Stop a response while it is generating' }
]

export function ShortcutList(): React.JSX.Element {
  return (
    <ul className="lookup-guide-shortcuts">
      {SHORTCUTS.map((shortcut) => (
        <li key={shortcut.action}>
          <span className="lookup-guide-shortcut-keys">
            {shortcut.keys.map((key, i) => (
              <kbd key={i} className="kbd">
                {key}
              </kbd>
            ))}
          </span>
          <span>{shortcut.action}</span>
        </li>
      ))}
    </ul>
  )
}

/** `App`'s own Ctrl/Cmd keys, which still reach it while the list is open. */
const APP_KEYS = new Set(['/', 'k', 'n', ','])

interface ShortcutsDialogProps {
  onClose: () => void
}

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && APP_KEYS.has(e.key.toLowerCase())) return
      // The view underneath (an answer's Stop, the canvas keys) must not act while this is open.
      e.stopPropagation()
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

  return (
    <div className="conversation-search-overlay" onClick={onClose}>
      <div
        className="conversation-search-panel shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="conversation-search-header shortcuts-dialog-header">
          <h2 className="shortcuts-dialog-title">Keyboard shortcuts</h2>
          <button ref={closeRef} className="btn btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="conversation-search-list shortcuts-dialog-body">
          <ShortcutList />
          <p className="shortcuts-dialog-note">
            On the canvas, press <kbd className="kbd">?</kbd> for its own keys.
          </p>
        </div>
      </div>
    </div>
  )
}
