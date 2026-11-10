/**
 * What a canvas card sends to the model.
 *
 * A message sends its session (the `parentId` chain, a page's text first when the session
 * starts on one), the cards it was asked about, what is linked into its branch, and the
 * length its rectangle holds. None of that is stored in a turn. An expansion is a follow-up
 * branching from the card that holds its term; on a page, the page itself is the context.
 */
import type {
  CanvasCard,
  CanvasLink,
  CanvasMessageCard,
  CanvasPageCard,
  CanvasRect
} from './canvas'
import {
  estimateWords,
  turnOwnerCard,
  turnsThroughCard,
  withCanvasContext,
  withCanvasFit,
  withCanvasSources
} from './canvas'
import { requestContext } from './canvas-context'
import { sourceExcerpts } from './canvas-selection'
import type { ProviderMessage, Turn } from './conversation'
import { serializeForChat } from './conversation'
import { buildExpandRequest } from './expand-prompt'
import {
  buildExpandAncestorQuestion,
  buildExpandPromptedInstruction,
  buildExpandUserInstruction,
  buildPageCanvasContextMessage,
  getSystemPrompt
} from './prompts'
import type { ExpansionTarget } from './rich-text'
import { expansionMessageInput, expansionPath, flattenMarkdown } from './rich-text'

const ROLE = 'chat'

function captionLength(text: string): number {
  return flattenMarkdown(text).length
}

/** The messages for a message card's answer; `charWidth` is the body font's average width. */
export function messageCardRequest(
  cards: CanvasCard[],
  links: CanvasLink[],
  turns: Turn[],
  card: CanvasMessageCard,
  charWidth: number
): ProviderMessage[] {
  const question = turns.find((turn) => turn.id === card.userTurnId)
  // The answer being written is blank, which serialization leaves out.
  const path = turnsThroughCard(cards, turns, card.id)
  const sources = sourceExcerpts(cards, turns, card.sources ?? [])
  const context = requestContext(cards, links, turns, card.id, card.sources ?? [])
  const messages = withCanvasContext(
    withCanvasSources(serializeForChat({ turns: path }, ROLE), sources),
    context
  )
  const words = estimateWords(card.rect, captionLength(question?.content ?? ''), charWidth)
  return withCanvasFit(messages, words)
}

/** An expansion on a page: the page, the chain of expansions it is nested in, then the question. */
function pageExpandMessages(
  page: CanvasPageCard,
  turn: Turn,
  target: ExpansionTarget,
  prompt: string | undefined
): ProviderMessage[] | null {
  const input = expansionMessageInput(turn, target.parentExpansionId, target)
  if (!input) return null
  const ancestors =
    target.parentExpansionId === undefined
      ? []
      : expansionPath(turn.expansions, target.parentExpansionId)
  if (!ancestors) return null
  const messages: ProviderMessage[] = [
    { role: 'system', content: getSystemPrompt(ROLE) },
    {
      role: 'user',
      content: buildPageCanvasContextMessage(turn.content, { title: page.title, url: page.url })
    }
  ]
  ancestors.forEach((node, index) => {
    const question =
      index > 0
        ? buildExpandAncestorQuestion(node.originalText, node.prompt)
        : node.prompt
          ? buildExpandPromptedInstruction(node.originalText, node.prompt)
          : buildExpandUserInstruction(node.originalText)
    messages.push({ role: 'user', content: question })
    messages.push({ role: 'assistant', content: node.answer || '(empty answer)' })
  })
  const question = (prompt ?? '').trim()
  messages.push({
    role: 'user',
    content: question
      ? buildExpandPromptedInstruction(input.selection, question)
      : buildExpandUserInstruction(input.selection)
  })
  return messages
}

/**
 * The messages for an expansion of `target` in `turn`, sized for `rect`; null when the card
 * holding the turn is gone or the range no longer fits its text.
 */
export function expansionCardRequest(
  cards: CanvasCard[],
  links: CanvasLink[],
  turns: Turn[],
  turn: Turn,
  target: ExpansionTarget,
  prompt: string | undefined,
  rect: CanvasRect,
  caption: string,
  charWidth: number
): ProviderMessage[] | null {
  const owner = turnOwnerCard(cards, turn.id)
  if (!owner) return null
  const messages =
    owner.kind === 'page'
      ? pageExpandMessages(owner, turn, target, prompt)
      : buildExpandRequest(
          { turns: turnsThroughCard(cards, turns, owner.id) },
          turn,
          target.parentExpansionId,
          target,
          ROLE,
          prompt
        )
  if (!messages) return null
  const context = requestContext(cards, links, turns, owner.id)
  return withCanvasFit(
    withCanvasContext(messages, context),
    estimateWords(rect, captionLength(caption), charWidth)
  )
}
