/* The memory_* function tools and their per-request agent, ported from Delta
 * Explorer's src/main/memory/tools.ts. */

import {
  buildAutoLoadedMemoryPrompt,
  buildMemoryPrompt,
  MEMORY_PATH_HINT,
  MEMORY_TOOL_DESCRIPTIONS
} from '../shared/prompts.js';
import { getCachedModel } from './model-catalog.js';
import { withInstructions } from './provider.js';
import {
  editMemory,
  grepMemories,
  listMemories,
  makeMemoryDirectory,
  MemoryError,
  moveMemory,
  readAutoLoadedMemories,
  readMemory,
  removeMemory,
  writeMemory
} from './memory-store.js';

const ASSISTANT_MAX_STEPS = 10;
/** The curator reads, rewrites several files and refreshes meta-files in one pass. */
const CURATOR_MAX_STEPS = 25;

const pathProperty = { type: 'string', description: MEMORY_PATH_HINT };

/** The model reads a failure as a tool result and can correct itself. */
async function report(operation) {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof MemoryError) return `Error: ${err.message}`;
    return `Error: the document base refused this operation (${err?.message || 'unknown'}).`;
  }
}

function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function createMemoryTools(onChange) {
  const mutate = (operation) => report(async () => {
    const result = await operation();
    onChange();
    return result;
  });
  return [
    {
      name: 'memory_ls',
      description: MEMORY_TOOL_DESCRIPTIONS.ls,
      parameters: objectSchema({ path: pathProperty }, ['path']),
      execute: ({ path }) => report(() => listMemories(path))
    },
    {
      name: 'memory_cat',
      description: MEMORY_TOOL_DESCRIPTIONS.cat,
      parameters: objectSchema({ path: pathProperty }, ['path']),
      execute: ({ path }) => report(() => readMemory(path))
    },
    {
      name: 'memory_grep',
      description: MEMORY_TOOL_DESCRIPTIONS.grep,
      parameters: objectSchema({ text: { type: 'string' }, path: pathProperty }, ['text', 'path']),
      execute: ({ text, path }) => report(() => grepMemories(text, path))
    },
    {
      name: 'memory_write',
      description: MEMORY_TOOL_DESCRIPTIONS.write,
      parameters: objectSchema({ path: pathProperty, content: { type: 'string' } }, ['path', 'content']),
      execute: ({ path, content }) => mutate(() => writeMemory(path, content))
    },
    {
      name: 'memory_edit',
      description: MEMORY_TOOL_DESCRIPTIONS.edit,
      parameters: objectSchema({ path: pathProperty, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text']),
      execute: ({ path, old_text, new_text }) => mutate(() => editMemory(path, old_text, new_text))
    },
    {
      name: 'memory_mkdir',
      description: MEMORY_TOOL_DESCRIPTIONS.mkdir,
      parameters: objectSchema({ path: pathProperty }, ['path']),
      execute: ({ path }) => mutate(() => makeMemoryDirectory(path))
    },
    {
      name: 'memory_mv',
      description: MEMORY_TOOL_DESCRIPTIONS.mv,
      parameters: objectSchema({ from: pathProperty, to: pathProperty }, ['from', 'to']),
      execute: ({ from, to }) => mutate(() => moveMemory(from, to))
    },
    {
      name: 'memory_rm',
      description: MEMORY_TOOL_DESCRIPTIONS.rm,
      parameters: objectSchema({ path: pathProperty, recursive: { type: 'boolean' } }, ['path', 'recursive']),
      execute: ({ path, recursive }) => mutate(() => removeMemory(path, recursive === true))
    }
  ];
}

async function catalogSaysNoTools(target) {
  const model = await getCachedModel(target.providerType, target.model);
  return model !== null && !model.toolCall;
}

/**
 * The memory tools for one request against `target`. Never throws: memory
 * problems must not be why a message fails. A curator pass treats `undefined`
 * as a failure, since it can do nothing else.
 *
 * Without tools (a catalog-known tool-less model) chat and look-up still get
 * the auto-loaded notes as plain text via `fallbackMessages`.
 */
export async function memoryAgentFor(role, target, messages, onChange) {
  try {
    const curating = role === 'kb-maintenance';
    const autoLoaded = await readAutoLoadedMemories();
    const fallbackMessages = withInstructions(messages, buildAutoLoadedMemoryPrompt(autoLoaded));
    if (await catalogSaysNoTools(target)) return { agent: undefined, messages: curating ? messages : fallbackMessages };
    return {
      agent: {
        tools: createMemoryTools(onChange),
        instructions: buildMemoryPrompt(await listMemories('.'), autoLoaded, curating ? 'curator' : 'assistant'),
        maxSteps: curating ? CURATOR_MAX_STEPS : ASSISTANT_MAX_STEPS,
        toolsRequired: curating,
        fallbackMessages
      },
      messages
    };
  } catch (err) {
    console.warn('Memory tools are unavailable for this request:', err);
    return { agent: undefined, messages };
  }
}
