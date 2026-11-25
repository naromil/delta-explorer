import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasNotice } from './board-model'
import { NOTICE_MS } from './board-model'

export interface BoardNotice {
  /** What the hint line reports, until it times out or is cleared. */
  notice: CanvasNotice | null
  showNotice: (text: string, undoable?: boolean) => void
  clearNotice: () => void
}

/** A passing notice on the board, such as "Already tidy." or what a delete took along. */
export function useBoardNotice(): BoardNotice {
  const [notice, setNotice] = useState<CanvasNotice | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const showNotice = useCallback((text: string, undoable = false): void => {
    setNotice({ text, undoable })
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])

  const clearNotice = useCallback((): void => setNotice(null), [])

  return { notice, showNotice, clearNotice }
}
