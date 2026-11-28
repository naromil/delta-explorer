/** A position in a list of text nodes: which node, and the character offset inside it. */
export interface TextPosition {
  node: number
  offset: number
}

export interface TextMatch {
  start: TextPosition
  /** Exclusive, and never at offset 0 of a node: a match ends inside the node holding its last character. */
  end: TextPosition
}

export const FIND_MATCH_LIMIT = 2000

/** Lower case only when that keeps every character where it was (it does not for "İ"). */
function folded(text: string): string {
  const lower = text.toLowerCase()
  return lower.length === text.length ? lower : text
}

/**
 * Case-insensitive matches of `query` in the text nodes read as one run, so a match
 * may start in one node and end in another: bold, links and highlights split a
 * sentence into several nodes.
 */
export function findTextMatches(
  texts: string[],
  query: string,
  limit = FIND_MATCH_LIMIT
): TextMatch[] {
  const needle = folded(query)
  if (needle === '') return []
  const starts: number[] = []
  let whole = ''
  for (const text of texts) {
    starts.push(whole.length)
    whole += folded(text)
  }

  const matches: TextMatch[] = []
  let node = 0
  let from = whole.indexOf(needle)
  while (from >= 0 && matches.length < limit) {
    const to = from + needle.length
    while (node + 1 < starts.length && starts[node + 1] <= from) node++
    let last = node
    while (last + 1 < starts.length && starts[last + 1] < to) last++
    matches.push({
      start: { node, offset: from - starts[node] },
      end: { node: last, offset: to - starts[last] }
    })
    from = whole.indexOf(needle, to)
  }
  return matches
}

/** Which match a step shows: a negative `position` counts back from the last match. */
export function shownMatchIndex(position: number, count: number): number {
  if (count === 0) return 0
  return position < 0 ? Math.max(0, count + position) : Math.min(position, count - 1)
}

/**
 * The text a search result opens the find bar with: the query, when it matched the messages.
 * A title match has nothing to jump to, so it opens the conversation as before.
 */
export function findQueryForResult(matchedIn: 'title' | 'content', query: string): string | null {
  const trimmed = query.trim()
  return matchedIn === 'content' && trimmed !== '' ? trimmed : null
}

/** Opens the find bar on `query` once `conversationId` is the conversation on screen. */
export interface FindRequest {
  conversationId: string
  query: string
  /** New for every request, so the same query can be asked again. */
  key: number
}
