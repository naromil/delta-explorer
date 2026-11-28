import type { MappedConversation } from '@delta/core/expansion-map'

/** Conversations read at once: enough to be quick, few enough to leave main responsive. */
const READ_CONCURRENCY = 4

/** The part of `window.api` the map reads, so it can run against a stand-in. */
export type ConversationLoader = Pick<Window['api'], 'listConversations' | 'loadConversation'>

export interface LoadProgress {
  read: number
  total: number
}

/**
 * Every conversation's expansions, for `buildExpansionMap`. Only the expansions are kept,
 * so message text and images are not held for the whole list. A record that fails to load
 * is skipped; `isCancelled` stops the reads once the view has gone.
 */
export async function loadExploredConversations(
  api: ConversationLoader,
  onProgress: (progress: LoadProgress) => void = () => {},
  isCancelled: () => boolean = () => false
): Promise<MappedConversation[]> {
  const metas = await api.listConversations()
  const loaded: MappedConversation[] = []
  let next = 0
  let read = 0
  onProgress({ read, total: metas.length })

  const worker = async (): Promise<void> => {
    while (next < metas.length && !isCancelled()) {
      const meta = metas[next++]
      const record = await api.loadConversation(meta.id).catch(() => null)
      read += 1
      if (isCancelled()) return
      onProgress({ read, total: metas.length })
      if (!record) continue
      const turns = record.state.turns
        .filter((turn) => turn.expansions.length > 0)
        .map(({ id, expansions }) => ({ id, content: '', expansions }))
      if (turns.length === 0) continue
      loaded.push({
        id: record.id,
        source: record.source,
        title: record.title,
        updatedAt: record.updatedAt,
        state: { turns }
      })
    }
  }

  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, metas.length) }, worker))
  return loaded
}
