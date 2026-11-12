import { buildTitleRequestMessages, cleanGeneratedTitle } from '@delta/core/conversation'
import { callProviderStream } from './provider'

const TITLE_TIMEOUT_MS = 30_000

/**
 * Names a conversation from its first message with the assistant's model, without tools.
 * Never throws: `null` keeps the title cut from the message, which the list already shows.
 */
export async function generateConversationTitle(firstMessage: string): Promise<string | null> {
  if (firstMessage.trim() === '') return null
  const signal = AbortSignal.timeout(TITLE_TIMEOUT_MS)
  try {
    let reply = ''
    for await (const chunk of callProviderStream(
      buildTitleRequestMessages(firstMessage),
      'chat',
      signal
    )) {
      reply += chunk
    }
    return cleanGeneratedTitle(reply)
  } catch (err) {
    console.warn('Could not generate a conversation title:', err)
    return null
  }
}
