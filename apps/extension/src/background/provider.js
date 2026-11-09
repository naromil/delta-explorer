/* Streaming LLM client, ported from Delta Explorer's src/main/provider.ts.
 *
 * Every provider speaks the OpenAI-compatible chat-completions wire format, so a
 * provider is a name plus a default base URL; Google AI Studio goes through its
 * OpenAI-compatible endpoint. Function tools (the memory_* tools) run in a
 * bounded agent loop; the last step is forced to answer in text. */

import { DEFAULT_OLLAMA_HOST } from '../shared/models.js';
import { resolveRole, RoleUnassignedError } from './config.js';

/** An *idle* timeout: a long answer that keeps producing tokens is never cut off. */
const IDLE_TIMEOUT_MS = 40_000;
const TIMEOUT_MESSAGE = `Request timed out after ${IDLE_TIMEOUT_MS / 1000}s. Check your API endpoint and network connection.`;
export const CANCEL_MESSAGE = 'Generation stopped.';
const API_ERROR_BODY_LIMIT = 500;
const REJECTED_REQUEST_STATUSES = new Set([400, 404, 422]);

export class NoApiKeyError extends Error {}
/** The endpoint refused the request itself, which is how a model without tool support fails. */
class RequestRejectedError extends Error {}

const ROUTES = {
  'google-ai-studio': { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', requiresApiKey: true, fixedBaseUrl: true },
  openai: { baseUrl: 'https://api.openai.com/v1', requiresApiKey: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', requiresApiKey: true },
  'openai-compatible': { requiresApiKey: false },
  ollama: { requiresApiKey: false }
};

function stripTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function chatBaseUrlFor(connection) {
  const route = ROUTES[connection.providerType];
  if (!route) throw new Error(`Provider "${connection.providerType}" is not supported.`);
  if (connection.providerType === 'ollama') {
    return `${stripTrailingSlashes(connection.host || DEFAULT_OLLAMA_HOST)}/v1`;
  }
  const baseUrl = route.fixedBaseUrl ? route.baseUrl : stripTrailingSlashes(connection.baseUrl || route.baseUrl || '');
  if (!baseUrl) throw new NoApiKeyError('Base URL is required for the OpenAI Compatible provider.');
  return baseUrl;
}

/* ---- Wire format ---- */

function toWireMessage(message) {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
  }
  if (message.tool_calls) {
    return { role: 'assistant', content: message.content || null, tool_calls: message.tool_calls };
  }
  if (!message.images || message.images.length === 0) {
    return { role: message.role, content: message.content };
  }
  return {
    role: 'user',
    content: [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...message.images.map(({ mediaType, data }) => ({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } }))
    ]
  };
}

/** Appends instructions to the system prompt (or adds one). */
export function withInstructions(messages, instructions) {
  if (!instructions) return messages;
  const systemIndex = messages.findIndex((msg) => msg.role === 'system');
  if (systemIndex === -1) return [{ role: 'system', content: instructions }, ...messages];
  return messages.map((msg, index) =>
    index === systemIndex ? { ...msg, content: msg.content + '\n\n' + instructions } : msg
  );
}

function linkSignals(external) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, IDLE_TIMEOUT_MS);
  };
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  arm();
  return {
    signal: controller.signal,
    arm,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
  };
}

async function readError(res) {
  let body = '';
  try { body = (await res.text()).trim(); } catch { /* ignore */ }
  const detail = body.length > API_ERROR_BODY_LIMIT ? `${body.slice(0, API_ERROR_BODY_LIMIT)}…` : body;
  const message = detail ? `API error ${res.status}: ${detail}` : `API error ${res.status}`;
  return REJECTED_REQUEST_STATUSES.has(res.status) ? new RequestRejectedError(message) : new Error(message);
}

/**
 * One streamed completion. Yields `{ text }` deltas and finally `{ toolCalls }`
 * with the assembled function calls (possibly empty).
 */
async function* streamStep(url, headers, body, link) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: link.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new Error(`Could not reach ${new URL(url).host}: ${err?.message || err}`);
  }
  if (!res.ok) throw await readError(res);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Response body is not readable');

  const decoder = new TextDecoder();
  let buffer = '';
  const calls = [];
  let finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    link.arm();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { finished = true; break; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.error) {
        const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message || JSON.stringify(parsed.error);
        throw new Error(`API error: ${message}`);
      }
      const delta = parsed?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content !== '') yield { text: delta.content };
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls) {
          const index = typeof part.index === 'number' ? part.index : calls.length;
          const call = calls[index] || (calls[index] = { id: '', name: '', arguments: '' });
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (typeof part.function?.arguments === 'string') call.arguments += part.function.arguments;
          else if (part.function?.arguments && typeof part.function.arguments === 'object') {
            call.arguments = JSON.stringify(part.function.arguments);
          }
        }
      }
    }
  }
  try { reader.cancel(); } catch { /* ignore */ }
  yield { toolCalls: calls.filter(Boolean).map((call, i) => ({ ...call, id: call.id || `call_${Date.now()}_${i}` })) };
}

function toolSchema(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

async function runTool(agent, call) {
  const tool = agent.tools.find((item) => item.name === call.name);
  if (!tool) return `Error: unknown tool ${call.name}.`;
  let args;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return 'Error: the arguments were not valid JSON.';
  }
  try {
    return String(await tool.execute(args || {}));
  } catch (err) {
    return `Error: ${err?.message || err}`;
  }
}

/** The agent loop; plain completion when `agent` is undefined. */
async function* streamModel(target, messages, externalSignal, agent) {
  const link = linkSignals(externalSignal);
  const headers = { 'Content-Type': 'application/json' };
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
  const url = `${target.baseUrl}/chat/completions`;
  let history = messages.map(toWireMessage);
  const maxSteps = agent ? agent.maxSteps : 1;
  let hasText = false;
  try {
    for (let step = 0; step < maxSteps; step++) {
      const body = { model: target.model, messages: history, stream: true };
      if (agent) {
        body.tools = agent.tools.map(toolSchema);
        if (step === maxSteps - 1) body.tool_choice = 'none';
      }
      let stepText = '';
      let toolCalls = [];
      let separated = false;
      for await (const part of streamStep(url, headers, body, link)) {
        if (part.text !== undefined) {
          // Text from separate tool steps must not run together in one answer.
          if (hasText && !separated && stepText === '' && step > 0) { yield '\n\n'; separated = true; }
          stepText += part.text;
          hasText = true;
          yield part.text;
        } else if (part.toolCalls) {
          toolCalls = part.toolCalls;
        }
      }
      if (!agent || toolCalls.length === 0) return;
      history = [
        ...history,
        {
          role: 'assistant',
          content: stepText || null,
          tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }))
        }
      ];
      for (const call of toolCalls) {
        if (link.signal.aborted) break;
        const result = await runTool(agent, call);
        link.arm();
        history.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
  } catch (err) {
    if (externalSignal?.aborted) throw new Error(CANCEL_MESSAGE);
    if (link.timedOut()) throw new Error(TIMEOUT_MESSAGE);
    throw err;
  } finally {
    link.dispose();
  }
}

/**
 * Tool support can only be discovered by asking custom endpoints and Ollama, so a
 * rejected tool request before any output falls back to a plain answer, unless
 * the caller has no use for an answer without tools.
 */
async function* streamWithTools(target, messages, agent, signal) {
  let emitted = false;
  try {
    for await (const chunk of streamModel(target, withInstructions(messages, agent.instructions), signal, agent)) {
      emitted = true;
      yield chunk;
    }
  } catch (err) {
    if (emitted || agent.toolsRequired || !(err instanceof RequestRejectedError)) throw err;
    console.warn('Retrying without tools after the endpoint rejected the request:', err.message);
    yield* streamModel(target, agent.fallbackMessages || messages, signal);
  }
}

export async function resolveTarget(role) {
  const resolved = await resolveRole(role);
  if (!resolved) throw new RoleUnassignedError(role);
  const { connection, model } = resolved;
  const route = ROUTES[connection.providerType];
  if (!route) throw new Error(`Provider "${connection.providerType}" is not supported.`);
  if (route.requiresApiKey && !connection.apiKey) {
    throw new NoApiKeyError('No API key configured. Open Settings → Models to add your provider API key.');
  }
  return {
    connection,
    model,
    providerType: connection.providerType,
    baseUrl: chatBaseUrlFor(connection),
    apiKey: connection.providerType === 'ollama' ? '' : connection.apiKey
  };
}

/**
 * Streams text for a role. `options.agent` is `{ tools, instructions, maxSteps,
 * toolsRequired?, fallbackMessages? }`; `options.target` skips role resolution.
 */
export async function* callProviderStream(messages, role, options = {}) {
  const target = options.target || await resolveTarget(role);
  if (options.agent) yield* streamWithTools(target, messages, options.agent, options.signal);
  else yield* streamModel(target, messages, options.signal);
}

export async function callProvider(messages, role, options = {}) {
  let response = '';
  for await (const chunk of callProviderStream(messages, role, options)) response += chunk;
  return response || '(No response received)';
}
