import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '@delta/ui/conversation'

interface MemoryFile {
  path: string
  autoLoaded: boolean
}

type Row =
  | { kind: 'directory'; key: string; name: string; depth: number }
  | { kind: 'file'; key: string; name: string; depth: number; file: MemoryFile }

/** The sorted file list as indented rows, a directory row before the first file inside it. */
function treeRows(files: MemoryFile[]): Row[] {
  const rows: Row[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const parts = file.path.split('/')
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const directory = parts.slice(0, depth + 1).join('/')
      if (seen.has(directory)) continue
      seen.add(directory)
      rows.push({ kind: 'directory', key: `${directory}/`, name: parts[depth], depth })
    }
    rows.push({
      kind: 'file',
      key: file.path,
      name: parts[parts.length - 1],
      depth: parts.length - 1,
      file
    })
  }
  return rows
}

interface OpenFile {
  path: string
  content: string
  truncated: boolean
}

const noop = (): void => {}
const noExpansion = (): null => null

/**
 * The document base as the assistant sees it: every note, readable and correctable.
 * It follows `memory-updated`, so a note written mid-chat or by a review shows up here.
 */
function MemoryBrowser(): React.JSX.Element {
  const [files, setFiles] = useState<MemoryFile[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loaded, setOpen] = useState<OpenFile | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  /** The file changed on disk under an open editor. */
  const [stale, setStale] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const editing = draft !== null
  // A file still on its way shows nothing rather than the one before it.
  const open = loaded?.path === selected ? loaded : null
  const editingRef = useRef(editing)
  const selectedRef = useRef(selected)

  useEffect(() => {
    editingRef.current = editing
  }, [editing])

  const loadFile = useCallback((path: string): void => {
    void window.api.memoryRead(path).then((result) => {
      if (selectedRef.current !== path) return
      if (!result.ok) {
        if (!editingRef.current) setOpen(null)
        setError(result.error)
        return
      }
      setOpen((current) => {
        if (editingRef.current && current?.path === path) {
          if (current.content !== result.content) setStale(true)
          return current
        }
        return { path, content: result.content, truncated: result.truncated }
      })
    })
  }, [])

  const choose = useCallback(
    (path: string | null): void => {
      selectedRef.current = path
      setSelected(path)
      if (path) loadFile(path)
    },
    [loadFile]
  )

  /** Reads the list again, and the open file with it; a file that is gone hands over to another. */
  const refresh = useCallback((): void => {
    void window.api.memoryList().then((result) => {
      if (!result.ok) {
        setError(result.error)
        setFiles([])
        return
      }
      setFiles(result.files)
      const current = selectedRef.current
      const kept =
        current !== null &&
        // An open editor keeps its file even after a review removed it, so the text is not lost.
        (editingRef.current || result.files.some((file) => file.path === current))
      choose(
        kept
          ? current
          : ((result.files.find((file) => file.autoLoaded) ?? result.files[0])?.path ?? null)
      )
    })
  }, [choose])

  useEffect(() => {
    refresh()
    return window.api.onMemoryUpdated(refresh)
  }, [refresh])

  const rows = useMemo(() => treeRows(files ?? []), [files])

  const select = (path: string): void => {
    if (path === selected) return
    if (editing && draft !== open?.content && !window.confirm('Discard your unsaved changes?')) {
      return
    }
    setDraft(null)
    setStale(false)
    setError(null)
    choose(path)
  }

  const startEditing = (): void => {
    if (!open || open.truncated) return
    setDraft(open.content)
    setStale(false)
    setError(null)
    setTimeout(() => editorRef.current?.focus({ preventScroll: true }), 0)
  }

  const cancelEditing = (): void => {
    setDraft(null)
    setStale(false)
    setError(null)
    if (selected) loadFile(selected)
  }

  const save = async (): Promise<void> => {
    if (!open || draft === null || saving) return
    setSaving(true)
    const result = await window.api.memoryWrite(open.path, draft)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setOpen({ path: open.path, content: draft, truncated: false })
    setDraft(null)
    setStale(false)
    setError(null)
  }

  const remove = async (): Promise<void> => {
    if (!open) return
    if (!window.confirm(`Delete ${open.path}? The assistant will no longer know what it says.`)) {
      return
    }
    const result = await window.api.memoryRemove(open.path)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setDraft(null)
    setError(null)
    choose(null)
    refresh()
  }

  const openFolder = async (): Promise<void> => {
    const result = await window.api.memoryOpenFolder()
    if (!result.ok) setError(result.error)
  }

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      if (draft === open?.content || window.confirm('Discard your unsaved changes?')) {
        cancelEditing()
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault()
      void save()
    }
  }

  return (
    <section className="kb-memory" aria-label="Memory notes">
      <div className="kb-memory-head">
        <h2 className="kb-memory-title">Notes about you</h2>
        <span className="kb-memory-count">
          {files === null ? '' : `${files.length} ${files.length === 1 ? 'file' : 'files'}`}
        </span>
        <button className="btn btn--sm" onClick={() => void openFolder()}>
          Open folder
        </button>
      </div>
      {error && (
        <p className="kb-error" role="alert">
          {error}
        </p>
      )}
      {files !== null && files.length === 0 ? (
        <p className="kb-memory-empty">
          Nothing yet. Notes appear here as the assistant learns how you learn: what you already
          know, where you get stuck, and what you are working towards.
        </p>
      ) : (
        <div className="kb-memory-panes">
          <nav className="kb-memory-tree" aria-label="Files">
            {rows.map((row) =>
              row.kind === 'directory' ? (
                <div
                  key={row.key}
                  className="kb-memory-dir"
                  style={{ paddingLeft: 10 + row.depth * 14 }}
                >
                  {row.name}/
                </div>
              ) : (
                <button
                  key={row.key}
                  className={`kb-memory-file${row.file.path === selected ? ' selected' : ''}`}
                  style={{ paddingLeft: 10 + row.depth * 14 }}
                  aria-current={row.file.path === selected ? 'true' : undefined}
                  title={row.file.path}
                  onClick={() => select(row.file.path)}
                >
                  <span className="kb-memory-file-name">{row.name}</span>
                  {row.file.autoLoaded && (
                    <span
                      className="kb-memory-badge"
                      title="Read with every message. Other notes are opened when they are relevant."
                    >
                      always read
                    </span>
                  )}
                </button>
              )
            )}
          </nav>
          <div className="kb-memory-viewer">
            {open && (
              <>
                <div className="kb-memory-viewer-head">
                  <span className="kb-memory-path" title={open.path}>
                    {open.path}
                  </span>
                  {editing ? (
                    <>
                      <button className="btn btn--sm" onClick={cancelEditing} disabled={saving}>
                        Cancel
                      </button>
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => void save()}
                        disabled={saving || draft === open.content}
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn--sm"
                        onClick={startEditing}
                        disabled={open.truncated}
                        title={
                          open.truncated
                            ? 'Too long to edit here; use Open folder'
                            : 'Correct this note'
                        }
                      >
                        Edit
                      </button>
                      <button className="btn btn--sm" onClick={() => void remove()}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
                {stale && (
                  <p className="kb-memory-stale" role="status">
                    This note changed while you were editing. Saving replaces the newer version.
                  </p>
                )}
                {editing ? (
                  <textarea
                    ref={editorRef}
                    className="kb-memory-editor"
                    value={draft}
                    spellCheck={false}
                    aria-label={`Edit ${open.path}`}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleEditorKeyDown}
                  />
                ) : (
                  <div className="kb-memory-body message-content">
                    {open.content.trim() === '' ? (
                      <p className="kb-memory-blank">This note is empty.</p>
                    ) : (
                      <Markdown
                        source={open.content}
                        expansions={[]}
                        anchored={false}
                        onFold={noop}
                        onUnfold={noop}
                        renderExpansion={noExpansion}
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export default MemoryBrowser
