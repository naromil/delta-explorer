/* Streaming over runtime Ports. A client (dashboard, popup or content script)
 * opens a `delta-stream` port and posts one request; the background replies with
 * batched `{ delta }` messages and a final `{ done, text }` or `{ error, text }`.
 * Disconnecting the port stops generation.
 *
 * Requests:
 *   { kind: 'chat', role: 'chat' | 'lookup', messages }
 *   { kind: 'page-expand', bubbleId, page: { title, url }, context, chain: [{ selection, prompt?, answer }],
 *     selection, prompt? }
 */

import { buildContextBudget } from './context.js';
import { callProviderStream, CANCEL_MESSAGE, resolveTarget } from './provider.js';
import { memoryAgentFor } from './memory-tools.js';
import { getCachedModel } from './model-catalog.js';
import { saveExpansionRecord } from './expansion-records.js';
import { keepAlive } from './keep-alive.js';
import {
  buildExpandAncestorQuestion,
  buildExpandPromptedInstruction,
  buildExpandUserInstruction,
  buildPageContextMessage,
  getSystemPrompt,
  IMAGE_OMITTED_NOTE
} from '../shared/prompts.js';

const CHUNK_FLUSH_INTERVAL_MS = 32;
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;
const MAX_CONTEXT_CHARS = 12_000;

/* ---- Validation ---- */

function parseMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const messages = [];
  for (const entry of raw) {
    if (!entry || typeof entry.content !== 'string' || !MESSAGE_ROLES.has(entry.role)) return null;
    if (entry.images === undefined) {
      messages.push({ role: entry.role, content: entry.content });
      continue;
    }
    if (entry.role !== 'user' || !Array.isArray(entry.images) || entry.images.length > MAX_IMAGES) return null;
    const images = [];
    for (const image of entry.images) {
      if (!image || !IMAGE_TYPES.has(image.mediaType) || typeof image.data !== 'string') return null;
      images.push({ mediaType: image.mediaType, data: image.data });
    }
    messages.push({ role: entry.role, content: entry.content, ...(images.length ? { images } : {}) });
  }
  return messages;
}

function str(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return limit ? text.slice(0, limit) : text;
}

/** A page expansion: the page passage, the chain of bubbles it is nested in, then the question. */
function buildPageExpandMessages(request) {
  const selection = str(request.selection, 2000);
  const prompt = typeof request.prompt === 'string' ? request.prompt : undefined;
  const chain = Array.isArray(request.chain) ? request.chain.slice(0, 10) : [];
  const messages = [
    { role: 'system', content: getSystemPrompt('lookup') },
    { role: 'user', content: buildPageContextMessage(str(request.context, MAX_CONTEXT_CHARS), request.page) }
  ];
  chain.forEach((link, index) => {
    const linkSelection = str(link?.selection, 2000);
    const linkPrompt = typeof link?.prompt === 'string' && link.prompt.trim() ? link.prompt : undefined;
    const question = index === 0
      ? (linkPrompt !== undefined ? buildExpandPromptedInstruction(linkSelection, linkPrompt) : buildExpandUserInstruction(linkSelection))
      : buildExpandAncestorQuestion(linkSelection, linkPrompt);
    messages.push({ role: 'user', content: question });
    messages.push({ role: 'assistant', content: str(link?.answer, MAX_CONTEXT_CHARS) || '(empty answer)' });
  });
  messages.push({
    role: 'user',
    content: prompt !== undefined && prompt.trim() !== ''
      ? buildExpandPromptedInstruction(selection, prompt)
      : buildExpandUserInstruction(selection)
  });
  return messages;
}

/* ---- Images ---- */

async function imageSupport(target) {
  const model = await getCachedModel(target.providerType, target.model);
  if (!model) return 'unknown';
  return model.inputModalities.includes('image') ? 'yes' : 'no';
}

export async function imageSupportForRole(role) {
  try {
    return await imageSupport(await resolveTarget(role));
  } catch {
    return 'unknown';
  }
}

/** Refuses images on the newest message for a text-only model, and drops older ones with a note. */
async function fitImages(messages, target) {
  if (!messages.some((m) => m.images)) return messages;
  if ((await imageSupport(target)) !== 'no') return messages;
  const last = messages[messages.length - 1];
  if (last.images) throw new Error(`${target.model} cannot read images. Remove the images or assign a vision model.`);
  return messages.map((m) => (m.images ? { role: m.role, content: `${m.content}\n\n${IMAGE_OMITTED_NOTE}`.trim() } : m));
}

/* ---- Port handling ---- */

export function handleStreamPort(port, { onMemoryChanged }) {
  const controller = new AbortController();
  let settled = false;
  port.onDisconnect.addListener(() => { if (!settled) controller.abort(); });

  const send = (message) => {
    try { port.postMessage(message); } catch { controller.abort(); }
  };

  port.onMessage.addListener((request) => {
    if (settled || request?.type !== 'start') return;
    run(request).catch(() => {});
  });

  async function run(request) {
    const release = keepAlive();
    let text = '';
    let buffer = '';
    let timer = null;
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (buffer) { send({ delta: buffer }); buffer = ''; }
    };
    try {
      let role;
      let messages;
      if (request.kind === 'page-expand') {
        role = 'lookup';
        messages = buildPageExpandMessages(request);
      } else if (request.kind === 'chat') {
        role = request.role === 'lookup' ? 'lookup' : 'chat';
        messages = parseMessages(request.messages);
        if (!messages) throw new Error('Invalid request.');
      } else {
        throw new Error('Invalid request.');
      }

      const target = await resolveTarget(role);
      messages = await fitImages(messages, target);
      const memory = await memoryAgentFor(role, target, messages, onMemoryChanged);
      const budgeted = await buildContextBudget(memory.messages, target);
      const agent = memory.agent ? { ...memory.agent, fallbackMessages: await buildContextBudget(memory.agent.fallbackMessages, target) } : undefined;

      for await (const chunk of callProviderStream(budgeted, role, { target, agent, signal: controller.signal })) {
        text += chunk;
        buffer += chunk;
        if (timer === null) timer = setTimeout(flush, CHUNK_FLUSH_INTERVAL_MS);
      }
      flush();
      settled = true;
      send({ done: true, text });

      if (request.kind === 'page-expand' && text.trim()) {
        const chain = Array.isArray(request.chain) ? request.chain : [];
        saveExpansionRecord({
          id: str(request.bubbleId, 100) || `px_${Date.now()}`,
          timestamp: Date.now(),
          url: str(request.page?.url, 2000),
          title: str(request.page?.title, 300),
          selection: str(request.selection, 2000),
          context: str(request.context, 4000),
          prompt: typeof request.prompt === 'string' ? request.prompt : '',
          response: text,
          ancestors: chain.map((link) => ({ selection: str(link?.selection, 300), prompt: str(link?.prompt, 300) }))
        }).catch((err) => console.warn('Failed to record a page expansion:', err));
      }
    } catch (err) {
      flush();
      settled = true;
      const message = controller.signal.aborted ? CANCEL_MESSAGE : (err?.message || String(err));
      send({ error: message, text, cancelled: controller.signal.aborted });
    } finally {
      clearTimeout(timer);
      release();
      try { port.disconnect(); } catch { /* already gone */ }
    }
  }
}
