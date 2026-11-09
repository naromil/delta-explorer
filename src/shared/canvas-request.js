/* What a canvas card sends to the model. Ported from the request half of Delta Explorer's
 * hooks/useCanvas.ts, plus the extension's page cards.
 *
 * A message sends its session (the `parentId` chain, a page's text first when the session
 * starts on one), the cards it was asked about, what is linked into its branch, and the
 * length its rectangle holds. None of that is stored in a turn. Everything here is pure. */

import {
  estimateWords,
  turnOwnerCard,
  turnsThroughCard,
  withCanvasContext,
  withCanvasFit,
  withCanvasSources
} from './canvas.js';
import { requestContext } from './canvas-context.js';
import { sourceExcerpts } from './canvas-selection.js';
import { buildExpandRequest, serializeForChat } from './conversation.js';
import {
  buildExpandAncestorQuestion,
  buildExpandPromptedInstruction,
  buildExpandUserInstruction,
  buildPageCanvasContextMessage,
  getSystemPrompt
} from './prompts.js';
import { expansionMessageInput, expansionPath, flattenMarkdown } from './rich-text.js';

const ROLE = 'chat';

function captionLength(text) {
  return flattenMarkdown(text || '').length;
}

/** The messages for a message card's answer; `charWidth` is the body font's average width. */
export function messageCardRequest(cards, links, turns, card, charWidth) {
  const question = turns.find((turn) => turn.id === card.userTurnId);
  // The answer being written is blank, which serialization leaves out.
  const path = turnsThroughCard(cards, turns, card.id);
  const sources = sourceExcerpts(cards, turns, card.sources || []);
  const context = requestContext(cards, links, turns, card.id, card.sources || []);
  const messages = withCanvasContext(withCanvasSources(serializeForChat({ turns: path }, ROLE), sources), context);
  const words = estimateWords(card.rect, captionLength(question?.content), charWidth);
  return withCanvasFit(messages, words);
}

/** An expansion on a page: the page, the chain of expansions it is nested in, then the question. */
function pageExpandMessages(page, turn, target, prompt) {
  const input = expansionMessageInput(turn, target.parentExpansionId, target);
  if (!input) return null;
  const ancestors = target.parentExpansionId === undefined ? [] : expansionPath(turn.expansions, target.parentExpansionId);
  if (!ancestors) return null;
  const messages = [
    { role: 'system', content: getSystemPrompt(ROLE) },
    { role: 'user', content: buildPageCanvasContextMessage(turn.content, { title: page.title, url: page.url }) }
  ];
  ancestors.forEach((node, index) => {
    const question = index === 0
      ? (node.prompt ? buildExpandPromptedInstruction(node.originalText, node.prompt) : buildExpandUserInstruction(node.originalText))
      : buildExpandAncestorQuestion(node.originalText, node.prompt);
    messages.push({ role: 'user', content: question });
    messages.push({ role: 'assistant', content: node.answer || '(empty answer)' });
  });
  const question = String(prompt || '').trim();
  messages.push({
    role: 'user',
    content: question ? buildExpandPromptedInstruction(input.selection, question) : buildExpandUserInstruction(input.selection)
  });
  return messages;
}

/**
 * The messages for an expansion of `target` in `turn`, sized for `rect`; null when the
 * card holding the turn is gone or the range no longer fits its text.
 */
export function expansionCardRequest(cards, links, turns, turn, target, prompt, rect, caption, charWidth) {
  const owner = turnOwnerCard(cards, turn.id);
  if (!owner) return null;
  const messages = owner.kind === 'page'
    ? pageExpandMessages(owner, turn, target, prompt)
    : buildExpandRequest({ turns: turnsThroughCard(cards, turns, owner.id) }, turn, target.parentExpansionId, target, ROLE, prompt);
  if (!messages) return null;
  const context = requestContext(cards, links, turns, owner.id);
  return withCanvasFit(withCanvasContext(messages, context), estimateWords(rect, captionLength(caption), charWidth));
}
