/* What a canvas over a web chat (ChatGPT and the like) sends to that chat, and how the chat's
 * exchanges become cards. Pure.
 *
 * The chat keeps one line of history and cannot branch, so every question is asked at its end.
 * `layout.webChat.exchanges` names the card holding each of the chat's exchanges in order; a
 * question that is not about the latest one says which earlier answer or passage it means
 * (prompts.js). Cards the chat never saw (answered by the user's own model) go along as text. */

import {
  DEFAULT_MESSAGE_SIZE,
  estimateWords,
  rectClearOf,
  rectsOverlap,
  turnOwnerCard,
  withCanvasContext,
  withCanvasFit,
  withCanvasSources
} from './canvas.js';
import { requestContext } from '@delta/core/canvas-context';
import { sourceExcerpts } from './canvas-selection.js';
import {
  buildWebChatBranch,
  buildWebChatExpand,
  buildWebChatNewTopic,
  buildWebChatOutside,
  buildWebChatReplyRef,
  isTermSelection
} from './prompts.js';
import { expansionMessageInput, findExpansionInTurns, flattenMarkdown } from './rich-text.js';

/** A chat answer is read on the canvas, so its card starts wider than one drawn by hand. */
export const WEB_CHAT_CARD_SIZE = { w: 560, h: DEFAULT_MESSAGE_SIZE.h };
const COLUMN_GAP = 80;

function turnText(turns, id) {
  return turns.find((turn) => turn.id === id)?.content || '';
}

function isLatest(webChat, cardId) {
  return webChat.exchanges.length > 0 && webChat.exchanges.at(-1) === cardId;
}

/** What a card asked and answered, in the words a question can refer to it by. */
function exchangeOf(cards, turns, card) {
  if (card.kind === 'message') {
    return { kind: 'answer', question: turnText(turns, card.userTurnId), answer: turnText(turns, card.turnId) };
  }
  if (card.kind === 'expansion') {
    const node = findExpansionInTurns(turns, card.expansionId)?.node;
    return { kind: 'expansion', question: node?.prompt || node?.originalText || '', answer: node?.answer || '' };
  }
  if (card.kind === 'page') return { kind: 'outside', question: card.title || card.url, answer: turnText(turns, card.turnId) };
  return null;
}

/** How a question names the reply `card` holds: the latest, an earlier one, or one from elsewhere. */
function replyRef(webChat, card, exchange) {
  if (isLatest(webChat, card.id)) return buildWebChatReplyRef('latest');
  if (!webChat.exchanges.includes(card.id)) return buildWebChatReplyRef('outside', exchange.question);
  return buildWebChatReplyRef(exchange.kind, exchange.question);
}

/** The single message of a request, with the canvas notes the user's own model would get too. */
function withCanvasNotes(content, sources, context, words) {
  const messages = withCanvasFit(withCanvasContext(withCanvasSources([{ role: 'user', content }], sources), context), words);
  return messages[0].content;
}

/** The question a message card asks the web chat; `charWidth` is the body font's average width. */
export function webChatMessagePrompt(cards, links, turns, webChat, card, charWidth) {
  const question = turnText(turns, card.userTurnId);
  const parent = card.parentId === undefined ? undefined : cards.find((item) => item.id === card.parentId);
  const exchange = parent ? exchangeOf(cards, turns, parent) : null;
  let content = question;
  if (!parent || !exchange) {
    if (webChat.exchanges.length > 0) content = buildWebChatNewTopic(question);
  } else if (!isLatest(webChat, parent.id)) {
    const ref = replyRef(webChat, parent, exchange);
    content = webChat.exchanges.includes(parent.id)
      ? buildWebChatBranch(ref, flattenMarkdown(exchange.answer), question)
      : buildWebChatOutside(ref, exchange.answer, question);
  }
  const sources = sourceExcerpts(cards, turns, card.sources || []);
  const context = requestContext(cards, links, turns, card.id, card.sources || []);
  const words = estimateWords(card.rect, flattenMarkdown(question).length, charWidth);
  return withCanvasNotes(content, sources, context, words);
}

/**
 * The question an expansion of `target` in `turn` asks the web chat, sized for `rect`; null
 * when the card holding the turn is gone or the range no longer fits its text.
 */
export function webChatExpansionPrompt(cards, links, turns, webChat, turn, target, prompt, rect, caption, charWidth) {
  const owner = turnOwnerCard(cards, turn.id);
  if (!owner) return null;
  const input = expansionMessageInput(turn, target.parentExpansionId, target);
  if (!input) return null;
  const host = target.parentExpansionId === undefined
    ? owner
    : cards.find((card) => card.kind === 'expansion' && card.expansionId === target.parentExpansionId);
  const exchange = host && exchangeOf(cards, turns, host);
  if (!exchange) return null;
  const content = buildWebChatExpand(replyRef(webChat, host, exchange), input.selection, prompt, isTermSelection(input.selection));
  const context = requestContext(cards, links, turns, owner.id);
  return withCanvasNotes(content, [], context, estimateWords(rect, flattenMarkdown(caption || '').length, charWidth));
}

/** The newest card still holding one of the chat's exchanges. */
export function webChatTail(cards, webChat) {
  for (let i = webChat.exchanges.length - 1; i >= 0; i--) {
    const card = cards.find((item) => item.id === webChat.exchanges[i]);
    if (card) return card;
  }
  return null;
}

/** Where the first imported card goes: under the tail, or in a column of its own beside everything. */
function firstImportRect(cards, tail) {
  const others = cards.map((card) => card.rect);
  if (tail) {
    const below = { x: tail.rect.x, y: tail.rect.y + tail.rect.h, ...WEB_CHAT_CARD_SIZE };
    if (!others.some((rect) => rectsOverlap(below, rect))) return below;
  }
  if (others.length === 0) return { x: 0, y: 0, ...WEB_CHAT_CARD_SIZE };
  const right = Math.max(...others.map((rect) => rect.x + rect.w));
  const top = Math.min(...others.map((rect) => rect.y));
  return rectClearOf({ x: right + COLUMN_GAP, y: top, ...WEB_CHAT_CARD_SIZE }, others, 0);
}

/**
 * The chat's exchanges from `webChat.exchanges.length` on, as a chain of message cards under
 * the newest card holding an exchange. Returns `{ turns, cards, exchanges }` to append, where
 * `exchanges` is the whole new list.
 */
export function importWebChatExchanges(cards, webChat, exchanges, { newId, newTurnId }) {
  const fresh = exchanges.slice(webChat.exchanges.length);
  const added = { turns: [], cards: [], exchanges: [...webChat.exchanges] };
  let parent = webChatTail(cards, webChat);
  let rect = fresh.length > 0 ? firstImportRect(cards, parent) : null;
  for (const exchange of fresh) {
    const userTurnId = newTurnId();
    const turnId = newTurnId();
    const card = {
      kind: 'message',
      id: newId(),
      rect,
      userTurnId,
      turnId,
      ...(parent ? { parentId: parent.id } : {})
    };
    added.turns.push(
      { id: userTurnId, role: 'user', content: exchange.question, expansions: [] },
      { id: turnId, role: 'assistant', content: exchange.answer, expansions: [] }
    );
    added.cards.push(card);
    added.exchanges.push(card.id);
    parent = card;
    rect = { ...rect, y: rect.y + rect.h };
  }
  return added;
}
