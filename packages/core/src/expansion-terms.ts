/**
 * Terms the user expanded, compared across turns and conversations: one spelling per term
 * (`expansionTermKey`) and the finished expansions that answered it (`expansionsOfTerm`).
 * Pure: the apps decide where the turns come from.
 */
import { findExpansionInTurns, flattenMarkdown, isSameRange } from './rich-text'
import type { ExpansionNode, RichTextTurn } from './rich-text'

/** Longer selections are passages rather than terms, and are not matched. */
export const TERM_KEY_LIMIT = 80

const EDGE_PUNCTUATION = /^[\s"'“”‘’«»()[\]{}.,;:!?…-]+|[\s"'“”‘’«»()[\]{}.,;:!?…-]+$/g

/**
 * A selected term as the user saw it: markdown flattened, single spaces and no punctuation at
 * its edges, case kept. Empty when there is no term or the selection is a passage.
 */
export function expansionTermLabel(originalText: string): string {
  const flat = flattenMarkdown(originalText).replace(/\s+/g, ' ')
  const label = flat.replace(EDGE_PUNCTUATION, '')
  return label.length > TERM_KEY_LIMIT ? '' : label
}

/**
 * One spelling for a selected term: markdown flattened, lower case, single spaces and no
 * punctuation at its edges. Empty when there is no term or the selection is a passage.
 */
export function expansionTermKey(originalText: string): string {
  const key = expansionTermLabel(originalText).toLowerCase()
  return key.length > TERM_KEY_LIMIT ? '' : key
}

export interface TermExpansion {
  turnId: number
  node: ExpansionNode
}

function collectTermExpansions(
  nodes: ExpansionNode[],
  turnId: number,
  key: string,
  found: TermExpansion[]
): void {
  for (const node of nodes) {
    const answered = node.status === 'done' && node.answer.trim() !== ''
    if (answered && expansionTermKey(node.originalText) === key) found.push({ turnId, node })
    collectTermExpansions(node.children, turnId, key, found)
  }
}

/**
 * Finished expansions of the term `key` in `turns`, nested ones included, in the order the
 * turns hold them. A failed, streaming or blank answer is not one.
 */
export function expansionsOfTerm(turns: RichTextTurn[], key: string): TermExpansion[] {
  const found: TermExpansion[] = []
  if (!key) return found
  for (const turn of turns) collectTermExpansions(turn.expansions, turn.id, key, found)
  return found
}

/**
 * The newest finished expansion of the same term made before expansion `id` (ids grow within
 * a conversation). Other answers on its own range are left out: its frame lists those already.
 */
export function earlierExpansionOfTerm(turns: RichTextTurn[], id: number): TermExpansion | null {
  const location = findExpansionInTurns(turns, id)
  if (!location) return null
  const sameRange = new Set(
    location.siblings.filter((other) => isSameRange(other, location.node)).map(({ id }) => id)
  )
  const earlier = expansionsOfTerm(turns, expansionTermKey(location.node.originalText)).filter(
    ({ node }) => node.id < id && !sameRange.has(node.id)
  )
  return earlier.at(-1) ?? null
}
