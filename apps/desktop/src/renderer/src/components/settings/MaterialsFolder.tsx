import { useEffect, useState } from 'react'

/**
 * The learning-materials folder. It is not part of the autosaved settings: the main process
 * stores what the system dialog returns, so this only shows the choice and asks for a change.
 */
function MaterialsFolder(): React.JSX.Element {
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .loadSettings()
      .then((settings) => {
        if (!cancelled) setFolder(settings.materialsDir ?? '')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const choose = async (): Promise<void> => {
    const result = await window.api.chooseMaterialsFolder()
    if (result.ok) {
      setFolder(result.path)
      setError(null)
    } else if (result.error !== 'Canceled.') {
      setError(result.error)
    }
  }

  const clear = async (): Promise<void> => {
    const result = await window.api.clearMaterialsFolder()
    if (result.ok) {
      setFolder('')
      setError(null)
    } else {
      setError('Failed to save settings.')
    }
  }

  return (
    <div className="settings-section">
      <label className="settings-label">Learning materials folder</label>
      <div className="settings-inline">
        <span className="settings-path" title={folder || undefined}>
          {folder || 'No folder chosen'}
        </span>
        <button type="button" className="btn" onClick={() => void choose()}>
          {folder ? 'Change…' : 'Choose…'}
        </button>
        {folder && (
          <button type="button" className="btn" onClick={() => void clear()}>
            Remove
          </button>
        )}
      </div>
      {error && <p className="settings-hint settings-hint--notice">{error}</p>}
      <p className="settings-hint">
        The assistant can list, search and read the files in this folder to answer from your own
        materials: text files (notes, code) as text, and PDFs and images by looking at the pages,
        which needs a model that reads images; other models get only a PDF&apos;s text. It can never
        change the folder and reads nothing outside it. Hidden files are skipped. Requires a model
        that supports tool calling.
      </p>
    </div>
  )
}

export default MaterialsFolder
