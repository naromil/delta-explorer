/**
 * Every term the user expanded, across conversations: how often, where, and which terms led
 * to which (a term expanded inside another term's answer). Pure: the apps load the records.
 */
import type { ConversationSource } from './conversation'
import { expansionTermKey, expansionTermLabel } from './expansion-terms'
import type { ExpansionNode, RichTextTurn } from './rich-text'

/** The part of a conversation record the map reads. */
export interface MappedConversation {
  id: string
  source: ConversationSource
  title: string
  updatedAt: string
  state: { turns: RichTextTurn[] }
}

/** One conversation a term was expanded in. */
export interface TermPlace {
  id: string
  source: ConversationSource
  title: string
  updatedAt: string
  /** Finished expansions of the term there. */
  count: number
}

export interface ExpandedTerm {
  key: string
  /** The newest selection's spelling, case kept. */
  label: string
  /** Finished expansions of the term, in every conversation. */
  count: number
  /** Newest conversation first. */
  places: TermPlace[]
  /** Keys of the terms expanded inside this term's answers, most frequent first. */
  ledTo: string[]
  /** Keys of the terms in whose answers this one was expanded, most frequent first. */
  cameFrom: string[]
  /** `updatedAt` of the newest conversation holding it. */
  lastSeen: string
}

interface TermDraft {
  key: string
  label: string
  /** `updatedAt` + expansion id of the expansion `label` came from, to keep the newest. */
  labelAt: string
  labelId: number
  count: number
  places: Map<string, TermPlace>
  ledTo: Map<string, number>
  cameFrom: Map<string, number>
}

function isAnswered(node: ExpansionNode): boolean {
  return node.status === 'done' && node.answer.trim() !== ''
}

function draftFor(terms: Map<string, TermDraft>, key: string): TermDraft {
  let draft = terms.get(key)
  if (!draft) {
    draft = {
      key,
      label: '',
      labelAt: '',
      labelId: -1,
      count: 0,
      places: new Map(),
      ledTo: new Map(),
      cameFrom: new Map()
    }
    terms.set(key, draft)
  }
  return draft
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function newerThan(at: string, id: number, draft: TermDraft): boolean {
  return at > draft.labelAt || (at === draft.labelAt && id > draft.labelId)
}

/**
 * Walks one tree of expansions. `parentKey` is the nearest enclosing term: a passage between
 * them is not a term, so a term inside it still connects to the term above.
 */
function visitNodes(
  nodes: ExpansionNode[],
  conversation: MappedConversation,
  parentKey: string,
  terms: Map<string, TermDraft>
): void {
  for (const node of nodes) {
    const key = isAnswered(node) ? expansionTermKey(node.originalText) : ''
    if (key) {
      const draft = draftFor(terms, key)
      draft.count += 1
      const place = draft.places.get(conversation.id)
      if (place) place.count += 1
      else
        draft.places.set(conversation.id, {
          id: conversation.id,
          source: conversation.source,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          count: 1
        })
      if (newerThan(conversation.updatedAt, node.id, draft)) {
        draft.label = expansionTermLabel(node.originalText)
        draft.labelAt = conversation.updatedAt
        draft.labelId = node.id
      }
      if (parentKey && parentKey !== key) {
        bump(draft.cameFrom, parentKey)
        bump(draftFor(terms, parentKey).ledTo, key)
      }
    }
    visitNodes(node.children, conversation, key || parentKey, terms)
  }
}

function byFrequency(counts: Map<string, number>): string[] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key)
}

/**
 * The expanded terms of `conversations`, terms expanded more than once first, then the most
 * recently seen. Passages, failed and blank answers are left out, as in `expansionsOfTerm`.
 */
export function buildExpansionMap(conversations: MappedConversation[]): ExpandedTerm[] {
  const terms = new Map<string, TermDraft>()
  for (const conversation of conversations) {
    for (const turn of conversation.state.turns)
      visitNodes(turn.expansions, conversation, '', terms)
  }
  const mapped: ExpandedTerm[] = [...terms.values()].map((draft) => {
    const places = [...draft.places.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return {
      key: draft.key,
      label: draft.label,
      count: draft.count,
      places,
      ledTo: byFrequency(draft.ledTo),
      cameFrom: byFrequency(draft.cameFrom),
      lastSeen: places[0]?.updatedAt ?? ''
    }
  })
  return mapped.sort(
    (a, b) =>
      Number(b.count > 1) - Number(a.count > 1) ||
      b.lastSeen.localeCompare(a.lastSeen) ||
      b.count - a.count ||
      a.key.localeCompare(b.key)
  )
}

/** Terms whose spelling holds `query` (any case); every term for a blank query. */
export function filterExpansionMap(terms: ExpandedTerm[], query: string): ExpandedTerm[] {
  const needle = query.trim().toLowerCase()
  return needle ? terms.filter((term) => term.key.includes(needle)) : terms
}
