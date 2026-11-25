/**
 * "You expanded this before": an app that can look through the user's conversations provides
 * this, and an open expansion frame asks it for an earlier answer to the same term. Without a
 * provider (the extension, the canvas) frames show nothing extra.
 */
import { createContext, useContext, useEffect, useState } from 'react'
import type { ConversationTarget } from '@delta/core/conversation'
import type { ExpansionNode } from '@delta/core/rich-text'

/** What identifies an expansion's term: its id within the conversation and the text selected. */
export type ExpandedTerm = Pick<ExpansionNode, 'id' | 'originalText'>

export interface EarlierExpansion {
  originalText: string
  prompt?: string
  answer: string
  /** Another conversation that holds it; absent when it is earlier in this one. */
  conversation?: ConversationTarget & { title: string }
}

export interface ExpansionHistory {
  /** An earlier finished answer to the same term; `null` when there is none. */
  earlierExpansion: (term: ExpandedTerm) => Promise<EarlierExpansion | null>
  openConversation: (target: ConversationTarget) => void
}

export const ExpansionHistoryContext = createContext<ExpansionHistory | null>(null)

export function useExpansionHistory(): ExpansionHistory | null {
  return useContext(ExpansionHistoryContext)
}

/** Asks once per open frame and term; a folded frame asks nothing. */
export function useEarlierExpansion(node: ExpansionNode): EarlierExpansion | null {
  const history = useExpansionHistory()
  const [found, setFound] = useState<{ key: string; earlier: EarlierExpansion | null } | null>(null)
  const { id, originalText } = node
  const key = `${id}\n${originalText}`
  const asking = history !== null && !node.folded

  useEffect(() => {
    if (!asking || !history) return
    let cancelled = false
    history
      .earlierExpansion({ id, originalText })
      .then((earlier) => {
        if (!cancelled) setFound({ key, earlier })
      })
      .catch(() => {
        if (!cancelled) setFound({ key, earlier: null })
      })
    return () => {
      cancelled = true
    }
  }, [asking, history, id, originalText, key])

  return asking && found?.key === key ? found.earlier : null
}
