import { useCallback, useEffect, useRef, useState } from 'react'
import Settings, { type SettingsTab } from './views/settings/Settings'
import Conversation from './components/conversation/Conversation'
import ConversationSearch from './components/conversation/ConversationSearch'
import HomeView from './views/home/HomeView'
import KnowledgeView from './views/knowledge/KnowledgeView'
import ExploredView from './views/explored/ExploredView'
import LookupGuideView from './views/lookup-guide/LookupGuideView'
import { CanvasView, useCanvas } from '@delta/ui/canvas'
import { ExpansionHistoryContext, ToolActivityContext } from '@delta/ui/conversation'
import { useChatStreaming } from './hooks/useChatStreaming'
import { useExpansionHistory } from './hooks/useExpansionHistory'
import MemoryIndicator from './components/MemoryIndicator'
import { ShortcutsDialog } from './components/KeyboardShortcuts'
import type { FindRequest } from './components/conversation/find-text'
import type { ImageAttachment } from '@delta/core/attachments'
import type { ConversationTarget } from '@delta/core/conversation'
import { hasNoConnections } from '../../shared/models'

type View = 'home' | 'chat' | 'canvas' | 'explored' | 'knowledge' | 'lookup-guide' | 'settings'

const mainNavEntries: Array<{ view: View; label: string; icon: string }> = [
  { view: 'home', label: 'Home', icon: 'home' },
  { view: 'chat', label: 'Chat', icon: 'chat' },
  { view: 'canvas', label: 'Canvas', icon: 'canvas' },
  { view: 'explored', label: 'Explored', icon: 'explored' },
  { view: 'knowledge', label: 'Knowledge Base', icon: 'knowledge' },
  { view: 'lookup-guide', label: 'Look-Up Guide', icon: 'lookup' }
]

const settingsNavEntry: { view: View; label: string; icon: string } = {
  view: 'settings',
  label: 'Settings',
  icon: 'settings'
}

const ICONS: Record<string, React.JSX.Element> = {
  home: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12l9-9 9 9" />
      <path d="M5 10v10a1 1 0 001 1h3a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1h3a1 1 0 001-1V10" />
    </svg>
  ),
  chat: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  ),
  canvas: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="11" height="11" rx="1" />
      <path d="M14 8h6a1 1 0 011 1v11a1 1 0 01-1 1H9a1 1 0 01-1-1v-6" />
    </svg>
  ),
  explored: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
      <path d="M8.3 7.1l7.4.8M7 8.4l1.4 7.2M16.4 10l-5.6 6.2" />
    </svg>
  ),
  knowledge: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      <path d="M8 7h8M8 11h6" />
    </svg>
  ),
  lookup: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  ),
  settings: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  )
}

function App(): React.JSX.Element {
  const [view, setView] = useState<View>('home')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [transferKey, setTransferKey] = useState(0)
  const [showSearch, setShowSearch] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  // Lives here, not in Conversation, so a view switch cannot drop the draft.
  const [draft, setDraft] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<ImageAttachment[]>([])
  /** A search result's query, waiting for main to open its conversation here. */
  const pendingFindRef = useRef<{ id: string; query: string } | null>(null)
  const findKeyRef = useRef(0)
  const [findRequest, setFindRequest] = useState<FindRequest | null>(null)
  const {
    state,
    toolActivity,
    loading,
    send,
    stop,
    retry,
    regenerate,
    editMessage,
    expand,
    retryExpansion,
    editExpansion,
    dismissExpansion,
    toggleHighlight,
    fold,
    unfold,
    renameConversation,
    newChat,
    deleteConversation,
    loadConversation,
    conversationId,
    conversationTitle,
    saveError
  } = useChatStreaming({
    onReplaceConversation: () => {
      setView('chat')
      setTransferKey((k) => k + 1)
    }
  })

  const expansionHistory = useExpansionHistory(conversationId, state.turns)

  const canvas = useCanvas()
  const { openCanvas, canvasId } = canvas

  const startNewChat = useCallback(() => {
    newChat()
    setView('chat')
  }, [newChat])

  // First run: with no connection yet, land on adding one, unless the user already moved on.
  useEffect(() => {
    let cancelled = false
    window.api
      .loadModelConfig()
      .then((config) => {
        if (cancelled || !hasNoConnections(config)) return
        setSettingsTab('models')
        setView((current) => (current === 'home' ? 'settings' : current))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Every history reaches this through main, which may raise a look-up's popup instead.
  useEffect(() => {
    return window.api.onConversationOpen(({ id, source }) => {
      const pending = pendingFindRef.current
      pendingFindRef.current = null
      setFindRequest(
        pending?.id === id && source !== 'canvas'
          ? { conversationId: id, query: pending.query, key: ++findKeyRef.current }
          : null
      )
      if (source === 'canvas') {
        setView('canvas')
        openCanvas(id)
      } else {
        setView('chat')
        void loadConversation(id)
      }
    })
  }, [openCanvas, loadConversation])

  const openConversation = useCallback((target: ConversationTarget) => {
    window.api.openConversation(target)
  }, [])

  /**
   * Opens a conversation with the find bar on `findQuery` (a search result, an explored term).
   * Main may raise a look-up's popup instead, which then leaves the query unused.
   */
  const openWithFind = useCallback((target: ConversationTarget, findQuery?: string) => {
    pendingFindRef.current = findQuery ? { id: target.id, query: findQuery } : null
    window.api.openConversation(target)
  }, [])

  const openExploredTerm = useCallback(
    (place: ConversationTarget, label: string) => {
      openWithFind(
        { id: place.id, source: place.source },
        place.source === 'canvas' ? undefined : label
      )
    },
    [openWithFind]
  )

  const finishFindRequest = useCallback((key: number) => {
    setFindRequest((request) => (request?.key === key ? null : request))
  }, [])

  const openSearch = useCallback(() => setShowSearch(true), [])
  const closeSearch = useCallback(() => setShowSearch(false), [])
  const closeShortcuts = useCallback(() => setShowShortcuts(false), [])

  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setShowShortcuts(false)
        setShowSearch(true)
      } else if (key === '/') {
        e.preventDefault()
        setShowSearch(false)
        setShowShortcuts((open) => !open)
      } else if (key === 'n') {
        e.preventDefault()
        setShowShortcuts(false)
        startNewChat()
      } else if (key === ',') {
        e.preventDefault()
        setShowShortcuts(false)
        setView('settings')
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [startNewChat])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span className="sidebar-brand-name">Delta Explorer</span>
        </div>
        <nav className="sidebar-nav">
          {mainNavEntries.map((entry) => (
            <button
              key={entry.view}
              className={`sidebar-nav-item${view === entry.view ? ' active' : ''}`}
              title={entry.label}
              aria-current={view === entry.view ? 'page' : undefined}
              onClick={() => setView(entry.view)}
            >
              {ICONS[entry.icon]}
              <span className="sidebar-nav-label">{entry.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-divider sidebar-divider--bottom" />
        <nav className="sidebar-nav">
          <button
            className={`sidebar-nav-item${view === settingsNavEntry.view ? ' active' : ''}`}
            title={settingsNavEntry.label}
            aria-current={view === settingsNavEntry.view ? 'page' : undefined}
            onClick={() => setView(settingsNavEntry.view)}
          >
            {ICONS[settingsNavEntry.icon]}
            <span className="sidebar-nav-label">{settingsNavEntry.label}</span>
          </button>
        </nav>
      </aside>
      <div className="app-main">
        {view === 'home' && (
          <HomeView
            onNavigate={setView}
            onOpenConversation={openConversation}
            onOpenSearch={openSearch}
          />
        )}
        {view === 'chat' && (
          <ToolActivityContext.Provider value={toolActivity}>
            <ExpansionHistoryContext.Provider value={expansionHistory}>
              <Conversation
                state={state}
                loading={loading}
                onSend={send}
                onStop={stop}
                onRetry={retry}
                onRegenerate={regenerate}
                onEditMessage={editMessage}
                onRename={renameConversation}
                onDelete={deleteConversation}
                onNewChat={newChat}
                onOpenSearch={openSearch}
                searchOpen={showSearch}
                input={draft}
                onInputChange={setDraft}
                attachments={draftAttachments}
                onAttachmentsChange={setDraftAttachments}
                conversationId={conversationId}
                conversationTitle={conversationTitle}
                saveError={saveError}
                onExpand={expand}
                onFold={fold}
                onUnfold={unfold}
                onRetryExpansion={retryExpansion}
                onEditExpansion={editExpansion}
                onDismissExpansion={dismissExpansion}
                onHighlight={toggleHighlight}
                transferKey={transferKey}
                findRequest={findRequest}
                onFindRequestDone={finishFindRequest}
              />
            </ExpansionHistoryContext.Provider>
          </ToolActivityContext.Provider>
        )}
        {view === 'canvas' && <CanvasView canvas={canvas} onOpenSearch={openSearch} />}
        {view === 'explored' && <ExploredView onOpenTerm={openExploredTerm} />}
        {view === 'knowledge' && <KnowledgeView />}
        {view === 'lookup-guide' && <LookupGuideView />}
        {view === 'settings' && <Settings initialTab={settingsTab} />}
      </div>
      {showSearch && (
        <ConversationSearch
          onSelect={openWithFind}
          onClose={closeSearch}
          openConversationIds={[conversationId, canvasId]}
        />
      )}
      {showShortcuts && <ShortcutsDialog onClose={closeShortcuts} />}
      <MemoryIndicator />
    </div>
  )
}

export default App
