import { useLayoutEffect, useMemo, useRef } from 'react'
import type { Turn } from '@delta/core/conversation'
import type { ExpansionNode } from '@delta/core/rich-text'
import {
  earlierExpansionOfTerm,
  expansionTermKey,
  expansionsOfTerm
} from '@delta/core/expansion-terms'
import type { EarlierExpansion, ExpansionHistory } from '@delta/ui/conversation'

/** Search results opened to look for the term: title matches first, then the newest. */
const SEARCHED_CONVERSATIONS = 8

function earlierFrom(node: ExpansionNode): EarlierExpansion {
  return { originalText: node.originalText, prompt: node.prompt, answer: node.answer }
}

/** The part of `window.api` the search reads, so it can run against a stand-in. */
export type ConversationReader = Pick<Window['api'], 'searchConversations' | 'loadConversation'>

/**
 * The newest answer to the term `key` in another conversation. Search narrows them to those
 * mentioning it, and only the first few of those are read.
 */
export async function earlierElsewhere(
  api: ConversationReader,
  key: string,
  currentId: string | null
): Promise<EarlierExpansion | null> {
  const results = await api.searchConversations(key)
  const candidates = results.filter(({ id }) => id !== currentId).slice(0, SEARCHED_CONVERSATIONS)
  for (const candidate of candidates) {
    const record = await api.loadConversation(candidate.id)
    if (!record) continue
    const found = expansionsOfTerm(record.state.turns, key).at(-1)
    if (!found) continue
    return {
      ...earlierFrom(found.node),
      conversation: { id: record.id, source: record.source, title: record.title }
    }
  }
  return null
}

/**
 * Answers an open frame's "did I expand this before?": first earlier in the open conversation,
 * then in the others. What other conversations hold is asked once per term while this one is open.
 */
export function useExpansionHistory(
  conversationId: string | null,
  turns: Turn[]
): ExpansionHistory {
  const turnsRef = useRef(turns)
  // A layout effect runs before the frames' own effects ask, so they see the turn they sit in.
  useLayoutEffect(() => {
    turnsRef.current = turns
  }, [turns])

  return useMemo(() => {
    const elsewhere = new Map<string, Promise<EarlierExpansion | null>>()
    return {
      earlierExpansion: async ({ id, originalText }) => {
        const here = earlierExpansionOfTerm(turnsRef.current, id)
        if (here) return earlierFrom(here.node)
        const key = expansionTermKey(originalText)
        if (!key) return null
        let pending = elsewhere.get(key)
        if (!pending) {
          pending = earlierElsewhere(window.api, key, conversationId).catch(() => null)
          elsewhere.set(key, pending)
        }
        return pending
      },
      openConversation: (target) => window.api.openConversation(target)
    }
  }, [conversationId])
}
