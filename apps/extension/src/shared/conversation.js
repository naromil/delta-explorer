/* Conversation model, ported from Delta Explorer's src/shared/conversation.ts
 * and src/shared/expand-prompt.ts.
 *
 * A record is one entity with type-specific properties:
 *
 *   { id, title, createdAt, updatedAt, kbFed, source: 'chat' | 'lookup' | 'canvas',
 *     state: { turns },
 *     lookup?: { context, page: { title, url } },   // only a look-up holds this
 *     canvas?: CanvasLayout }                       // only a canvas holds this (canvas.js)
 *
 * A turn is `{ id: number, role, content, expansions, error?, attachments? }`. */

import {
  buildExpandAncestorQuestion,
  buildExpandPromptedInstruction,
  buildExpandUserInstruction,
  buildPageContextMessage,
  getSystemPrompt
} from './prompts.js';
import { expansionMessageInput, expansionPath, finalizeTurns, flattenMarkdown } from './rich-text.js';
import { normalizeCanvasLayout } from './canvas.js';
import { cardText } from './canvas-selection.js';

export const CONVERSATION_SOURCE_LABELS = { chat: 'Chat', lookup: 'Look-up', canvas: 'Canvas' };
export const CONVERSATION_TITLE_MAX_LENGTH = 60;
export const SAFE_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function newConversationId() {
  return crypto.randomUUID();
}

/** An assistant turn with no content is an in-flight placeholder; never persist one. */
export function persistableTurns(turns) {
  return turns.filter((turn) => turn.role !== 'assistant' || String(turn.content).trim() !== '');
}

/** The page a canvas was opened on: the web chat it mirrors, else the newest page card's address, or ''. */
export function canvasPageUrl(record) {
  if (record.source !== 'canvas') return '';
  if (record.canvas.webChat?.url) return record.canvas.webChat.url;
  const pages = record.canvas.cards.filter((card) => card.kind === 'page' && card.url);
  return pages.length ? pages[pages.length - 1].url : '';
}

/** The turns that hold page text rather than anything the user said. */
export function pageTurnIds(record) {
  if (record.source !== 'canvas') return new Set();
  return new Set(record.canvas.cards.filter((card) => card.kind === 'page').map((card) => card.turnId));
}

export function toConversationMeta(record) {
  const pageUrl = canvasPageUrl(record);
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    source: record.source,
    kbFed: !!record.kbFed,
    turnCount: record.state.turns.length - pageTurnIds(record).size,
    ...(pageUrl ? { pageUrl } : {})
  };
}

export function buildConversationTitle(text) {
  const flat = flattenMarkdown(text).replace(/\s+/g, ' ').trim();
  if (flat === '') return 'New conversation';
  if (flat.length <= CONVERSATION_TITLE_MAX_LENGTH) return flat;
  return flat.slice(0, CONVERSATION_TITLE_MAX_LENGTH).trimEnd();
}

function attachmentImages(attachments) {
  return (attachments || []).map(({ mediaType, data }) => ({ mediaType, data }));
}

function isoOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return new Date().toISOString();
}

/**
 * Load-time boundary for stored records. Accepts the extension's earlier shape
 * (`turns` at the top level, uuid turn ids, `source: 'expansion'`) as well as
 * the current one, and turns any in-flight expansion into a recoverable error.
 */
export function migrateConversationRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const rawTurns = Array.isArray(raw.state?.turns) ? raw.state.turns : Array.isArray(raw.turns) ? raw.turns : [];
  let nextId = 1;
  const turns = rawTurns
    .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant'))
    .map((turn) => {
      const id = typeof turn.id === 'number' && Number.isFinite(turn.id) ? turn.id : nextId;
      nextId = Math.max(nextId, id) + 1;
      return {
        id,
        role: turn.role,
        content: typeof turn.content === 'string' ? turn.content : '',
        expansions: Array.isArray(turn.expansions) ? turn.expansions : [],
        ...(turn.error ? { error: true } : {}),
        ...(Array.isArray(turn.attachments) && turn.attachments.length ? { attachments: turn.attachments } : {})
      };
    });
  const base = {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'New conversation',
    createdAt: isoOf(raw.createdAt),
    updatedAt: isoOf(raw.updatedAt),
    kbFed: !!raw.kbFed,
    state: { turns: finalizeTurns(turns) }
  };
  if (raw.source === 'lookup') {
    const lookup = raw.lookup && typeof raw.lookup === 'object' ? raw.lookup : {};
    return {
      ...base,
      source: 'lookup',
      lookup: {
        context: typeof lookup.context === 'string' ? lookup.context : '',
        page: {
          title: typeof lookup.page?.title === 'string' ? lookup.page.title : '',
          url: typeof lookup.page?.url === 'string' ? lookup.page.url : ''
        }
      }
    };
  }
  if (raw.source === 'canvas') {
    return { ...base, source: 'canvas', canvas: normalizeCanvasLayout(raw.canvas, base.state.turns) };
  }
  return { ...base, source: 'chat' };
}

/** The live state a conversation view works on. */
export function stateOfRecord(record) {
  return {
    turns: record.state.turns,
    context: record.source === 'lookup' ? record.lookup.context : '',
    page: record.source === 'lookup' ? record.lookup.page : null
  };
}

/**
 * Provider messages for a conversation. The system prompt is always sent;
 * the page-context preamble only when the look-up had page text. Expansions
 * are UI annotations and never part of the history.
 */
export function serializeForChat(state, role) {
  const messages = [{ role: 'system', content: getSystemPrompt(role) }];
  if (state.context) {
    messages.push({ role: 'user', content: buildPageContextMessage(state.context, state.page) });
  }
  for (const turn of state.turns) {
    if (turn.role === 'assistant' && (turn.error || String(turn.content).trim() === '')) continue;
    const images = attachmentImages(turn.attachments);
    messages.push({ role: turn.role, content: turn.content, ...(images.length > 0 ? { images } : {}) });
  }
  return messages;
}

function questionMessage(content, attachments) {
  const images = attachmentImages(attachments);
  return { role: 'user', content, ...(images.length > 0 ? { images } : {}) };
}

/** The branch for an expansion: earlier answer, the chain it is nested in, then the question. */
export function buildExpandMessages({ ancestors = [], answer, selection, prompt, attachments }) {
  const messages = [{ role: 'assistant', content: answer || '(empty answer)' }];
  for (const ancestor of ancestors) {
    messages.push(questionMessage(buildExpandAncestorQuestion(ancestor.originalText, ancestor.prompt), ancestor.attachments));
    messages.push({ role: 'assistant', content: ancestor.answer || '(empty answer)' });
  }
  messages.push(questionMessage(
    prompt !== undefined ? buildExpandPromptedInstruction(selection, prompt) : buildExpandUserInstruction(selection),
    attachments
  ));
  return messages;
}

/**
 * An expansion is a follow-up branching from `turn`: exactly what a follow-up
 * sent at that point would hold, then the chain of expansions it is nested in.
 * Keeping that prefix identical lets a provider serve it from its prompt cache.
 */
export function buildExpandRequest(state, turn, parentId, range, role, prompt, attachments) {
  const input = expansionMessageInput(turn, parentId, range);
  if (!input) return null;
  const ancestors = parentId === undefined ? [] : expansionPath(turn.expansions, parentId);
  if (!ancestors) return null;
  const index = state.turns.findIndex((item) => item.id === turn.id);
  const before = state.turns.slice(0, Math.max(0, index));
  return [
    ...serializeForChat({ ...state, turns: before }, role),
    ...buildExpandMessages({
      ancestors,
      answer: turn.content,
      selection: input.selection,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(attachments && attachments.length ? { attachments } : {})
    })
  ];
}

/* ---- Markdown export ---- */

function expansionLines(node, depth) {
  const prefix = '> '.repeat(depth);
  const prompt = node.prompt ? ` — ${node.prompt}` : '';
  const lines = [`${prefix}**Expansion on “${node.originalText}”**${prompt}`];
  for (const attachment of node.attachments || []) lines.push(`${prefix}_[Image: ${attachment.name}]_`);
  const answer = String(node.answer || '').trimEnd();
  if (answer) for (const line of answer.split('\n')) lines.push(`${prefix}${line}`);
  for (const child of node.children) lines.push(...expansionLines(child, depth + 1));
  return lines;
}

const LINK_NAME_MAX_LENGTH = 60;

/** A canvas's notes and connections, which hold no turn and so appear nowhere else. */
function canvasLines(record) {
  const layout = record.canvas;
  const { turns } = record.state;
  const notes = layout.cards.filter((card) => card.kind === 'note');
  const nameOf = (id) => {
    const card = layout.cards.find((item) => item.id === id);
    if (!card) return 'a removed card';
    const { title, body } = cardText(card, turns);
    const name = flattenMarkdown(title || body).replace(/\s+/g, ' ').trim();
    return name.length > LINK_NAME_MAX_LENGTH ? `${name.slice(0, LINK_NAME_MAX_LENGTH)}…` : name;
  };
  const lines = [];
  if (notes.length > 0) {
    lines.push('', '## Notes');
    for (const note of notes) lines.push('', note.text.trimEnd());
  }
  if (layout.links.length > 0) {
    lines.push('', '## Connections', '');
    for (const link of layout.links) {
      const relation = link.label ? ` — ${link.label} → ` : ' → ';
      lines.push(`- ${nameOf(link.from)}${relation}${nameOf(link.to)}`);
    }
  }
  return lines;
}

/** A conversation as standalone markdown, expansions quoted inline. */
export function renderConversationMarkdown(record) {
  const lines = [`# ${record.title}`, '', `_Created ${record.createdAt} · Updated ${record.updatedAt}_`];
  const pages = new Map(record.source === 'canvas'
    ? record.canvas.cards.filter((card) => card.kind === 'page').map((card) => [card.turnId, card])
    : []);
  if (record.source === 'lookup') {
    const page = record.lookup.page || {};
    if (page.url) lines.push('', `Page: [${page.title || page.url}](${page.url})`);
    if (record.lookup.context.trim() !== '') {
      lines.push('', '## Page context', '', record.lookup.context.trimEnd());
    }
  }
  for (const turn of record.state.turns) {
    if (turn.role === 'assistant' && (turn.error || turn.content.trim() === '')) continue;
    const page = pages.get(turn.id);
    if (page) {
      lines.push('', `## Page: ${page.title || page.url}`);
      if (page.url) lines.push('', `<${page.url}>`, '');
    } else {
      lines.push('', turn.role === 'user' ? '## You' : '## Delta Explorer');
    }
    for (const attachment of turn.attachments || []) lines.push(`_[Image: ${attachment.name}]_`);
    const body = turn.content.trimEnd();
    if (body) lines.push(body);
    for (const expansion of turn.expansions || []) lines.push('', ...expansionLines(expansion, 1));
  }
  if (record.source === 'canvas') lines.push(...canvasLines(record));
  return `${lines.join('\n')}\n`;
}

export function exportFileName(record) {
  const printable = [...record.title].filter((char) => char.charCodeAt(0) >= 32).join('');
  const sanitized = printable.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return `${sanitized || `conversation-${record.id}`}.md`;
}
