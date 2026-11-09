/* Memory document base, ported from Delta Explorer's src/main/memory/store.ts.
 *
 * A tree of markdown files kept in browser.storage.local under `deltaMemories`
 * as `{ files: { path: content }, dirs: [path] }`. Paths come from a model whose
 * input can include web page text, so every path is validated here: relative,
 * no `..`, `.md` files only. There is deliberately no real filesystem behind
 * it. Operations are serialized so parallel tool calls cannot interleave. */

import { AUTO_LOADED_MEMORY_PREFIX } from '../shared/prompts.js';

const STORAGE_KEY = 'deltaMemories';
export const MAX_MEMORY_FILE_CHARS = 32_000;
const MAX_LISTED_ENTRIES = 200;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_LINE_CHARS = 200;
const MAX_AUTO_LOADED_FILE_CHARS = 8_000;
const MAX_AUTO_LOADED_TOTAL_CHARS = 16_000;

/** A refusal worded for the model. */
export class MemoryError extends Error {}

let cache = null;
let chain = Promise.resolve();
const changeListeners = new Set();

export function onMemoriesChanged(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function serialize(task) {
  const result = chain.then(task, task);
  chain = result.then(() => undefined, () => undefined);
  return result;
}

async function load() {
  if (cache) return cache;
  const obj = await browser.storage.local.get(STORAGE_KEY);
  const raw = obj[STORAGE_KEY];
  const files = {};
  const dirs = new Set();
  if (raw && typeof raw === 'object') {
    if (raw.files && typeof raw.files === 'object') {
      for (const [path, content] of Object.entries(raw.files)) {
        if (typeof content === 'string') files[path] = content;
      }
    }
    if (Array.isArray(raw.dirs)) raw.dirs.forEach((dir) => typeof dir === 'string' && dirs.add(dir));
  }
  cache = { files, dirs };
  return cache;
}

async function persist() {
  await browser.storage.local.set({ [STORAGE_KEY]: { files: cache.files, dirs: [...cache.dirs] } });
  for (const listener of changeListeners) {
    try { listener(); } catch { /* ignore */ }
  }
}

/* ---- Paths ---- */

function locate(input) {
  const raw = String(input ?? '');
  const normalized = raw.trim().replaceAll('\\', '/');
  // eslint-disable-next-line no-control-regex
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || /[\x00-\x1f]/.test(raw)) {
    throw new MemoryError(`Invalid path "${raw}": use a path relative to the memories directory.`);
  }
  const segments = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (segments.includes('..')) throw new MemoryError(`Invalid path "${raw}": ".." is not allowed.`);
  return segments.join('/');
}

function isMarkdownName(name) {
  return name.toLowerCase().endsWith('.md');
}

function locateMarkdown(input) {
  const path = locate(input);
  if (!isMarkdownName(path)) throw new MemoryError(`"${input}" is not a markdown file: names must end in .md.`);
  return path;
}

function parentsOf(path) {
  const parts = path.split('/');
  const parents = [];
  for (let i = 1; i < parts.length; i++) parents.push(parts.slice(0, i).join('/'));
  return parents;
}

function allDirectories(state) {
  const dirs = new Set(state.dirs);
  for (const path of Object.keys(state.files)) parentsOf(path).forEach((dir) => dirs.add(dir));
  return dirs;
}

function isDirectory(state, path) {
  if (path === '') return true;
  return allDirectories(state).has(path);
}

function assertFits(content) {
  if (content.length > MAX_MEMORY_FILE_CHARS) {
    throw new MemoryError(`Content is ${content.length} characters; the limit is ${MAX_MEMORY_FILE_CHARS} per file. Split it into several files.`);
  }
}

function assertWritable(state, path) {
  if (isDirectory(state, path)) throw new MemoryError(`A directory already exists at ${path}.`);
  for (const parent of parentsOf(path)) {
    if (state.files[parent] !== undefined) throw new MemoryError(`${parent} is a file, not a directory.`);
  }
}

/** Depth-first, sorted entries below `dir`. */
function walk(state, dir) {
  const prefix = dir ? dir + '/' : '';
  const children = new Map();
  for (const d of allDirectories(state)) {
    if (!d.startsWith(prefix) || d === dir) continue;
    const name = d.slice(prefix.length).split('/')[0];
    children.set(name, true);
  }
  for (const path of Object.keys(state.files)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest.includes('/')) children.set(rest, children.get(rest) || false);
  }
  const entries = [];
  for (const name of [...children.keys()].sort((a, b) => a.localeCompare(b))) {
    const relative = prefix + name;
    if (children.get(name)) {
      entries.push({ relative, isDirectory: true });
      entries.push(...walk(state, relative));
    } else {
      entries.push({ relative, isDirectory: false });
    }
  }
  return entries;
}

/* ---- Read operations ---- */

export function listMemories(path = '.') {
  return serialize(async () => {
    const state = await load();
    const target = locate(path);
    if (state.files[target] !== undefined) return target;
    if (!isDirectory(state, target)) throw new MemoryError(`No such file or directory: ${target || '.'}`);
    const lines = [];
    for (const entry of walk(state, target)) {
      if (lines.length === MAX_LISTED_ENTRIES) {
        lines.push(`… listing truncated at ${MAX_LISTED_ENTRIES} entries`);
        break;
      }
      lines.push(entry.isDirectory ? `${entry.relative}/` : entry.relative);
    }
    return lines.length > 0 ? lines.join('\n') : '(empty)';
  });
}

export function readMemory(path) {
  return serialize(async () => {
    const state = await load();
    const target = locateMarkdown(path);
    const content = state.files[target];
    if (content === undefined) throw new MemoryError(`No such file: ${target}`);
    if (content.length <= MAX_MEMORY_FILE_CHARS) return content;
    return `${content.slice(0, MAX_MEMORY_FILE_CHARS)}\n… file truncated at ${MAX_MEMORY_FILE_CHARS} characters`;
  });
}

/** Every `index*` file directly in the root, for the system prompt. */
export function readAutoLoadedMemories() {
  return serialize(async () => {
    const state = await load();
    const paths = Object.keys(state.files)
      .filter((path) => !path.includes('/') && path.toLowerCase().startsWith(AUTO_LOADED_MEMORY_PREFIX))
      .sort((a, b) => a.localeCompare(b));
    const loaded = [];
    let remaining = MAX_AUTO_LOADED_TOTAL_CHARS;
    for (const path of paths) {
      const limit = Math.min(MAX_AUTO_LOADED_FILE_CHARS, remaining);
      if (limit <= 0) break;
      const content = state.files[path];
      remaining -= Math.min(content.length, limit);
      loaded.push({
        path,
        content: content.length <= limit ? content : `${content.slice(0, limit)}\n… truncated; read the file for the rest, and shorten it`
      });
    }
    return loaded;
  });
}

function clipLine(line) {
  const trimmed = line.trim();
  return trimmed.length > MAX_GREP_LINE_CHARS ? `${trimmed.slice(0, MAX_GREP_LINE_CHARS)}…` : trimmed;
}

/** Case-insensitive literal search: a model-written regex could hang the background. */
export function grepMemories(pattern, path = '.') {
  return serialize(async () => {
    const state = await load();
    const needle = String(pattern || '').toLowerCase();
    if (needle === '') throw new MemoryError('The search text must not be empty.');
    const target = locate(path);
    let files;
    if (state.files[target] !== undefined) files = [target];
    else if (isDirectory(state, target)) files = walk(state, target).filter((e) => !e.isDirectory).map((e) => e.relative);
    else throw new MemoryError(`No such file or directory: ${target || '.'}`);
    const matches = [];
    for (const file of files) {
      const lines = state.files[file].split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        if (matches.length === MAX_GREP_MATCHES) {
          matches.push(`… results truncated at ${MAX_GREP_MATCHES} matches`);
          return matches.join('\n');
        }
        matches.push(`${file}:${i + 1}: ${clipLine(lines[i])}`);
      }
    }
    return matches.length > 0 ? matches.join('\n') : '(no matches)';
  });
}

/* ---- Write operations ---- */

export function writeMemory(path, content) {
  return serialize(async () => {
    const state = await load();
    const target = locateMarkdown(path);
    const text = String(content ?? '');
    assertFits(text);
    assertWritable(state, target);
    state.files[target] = text;
    await persist();
    return `Wrote ${target}`;
  });
}

/** Replaces one exact occurrence, so an edit never lands somewhere unintended. */
export function editMemory(path, oldText, newText) {
  return serialize(async () => {
    const state = await load();
    const target = locateMarkdown(path);
    const content = state.files[target];
    if (content === undefined) throw new MemoryError(`No such file: ${target}`);
    const needle = String(oldText ?? '');
    if (needle === '') throw new MemoryError('The text to replace must not be empty.');
    const occurrences = content.split(needle).length - 1;
    if (occurrences !== 1) {
      throw new MemoryError(`The text to replace occurs ${occurrences} times in ${target}; it must occur exactly once.`);
    }
    const index = content.indexOf(needle);
    const updated = content.slice(0, index) + String(newText ?? '') + content.slice(index + needle.length);
    assertFits(updated);
    state.files[target] = updated;
    await persist();
    return `Edited ${target}`;
  });
}

export function makeMemoryDirectory(path) {
  return serialize(async () => {
    const state = await load();
    const target = locate(path);
    if (target === '') return 'The memories directory already exists.';
    if (isMarkdownName(target)) throw new MemoryError(`A directory must not be named like a markdown file: ${path}`);
    if (state.files[target] !== undefined) throw new MemoryError(`A file already exists at ${target}.`);
    for (const parent of parentsOf(target)) {
      if (state.files[parent] !== undefined) throw new MemoryError(`${parent} is a file, not a directory.`);
    }
    state.dirs.add(target);
    await persist();
    return `Created ${target}/`;
  });
}

export function moveMemory(from, to) {
  return serialize(async () => {
    const state = await load();
    const source = locate(from);
    const destination = locate(to);
    if (source === '' || destination === '') throw new MemoryError('The memories directory itself cannot be moved or replaced.');
    const sourceIsFile = state.files[source] !== undefined;
    if (!sourceIsFile && !isDirectory(state, source)) throw new MemoryError(`No such file or directory: ${source}`);
    if (sourceIsFile && !isMarkdownName(destination)) throw new MemoryError(`"${to}" is not a markdown file: names must end in .md.`);
    if (destination.startsWith(`${source}/`)) throw new MemoryError('A directory cannot be moved into itself.');
    if (state.files[destination] !== undefined || isDirectory(state, destination)) throw new MemoryError(`Already exists: ${destination}`);
    for (const parent of parentsOf(destination)) {
      if (state.files[parent] !== undefined) throw new MemoryError(`${parent} is a file, not a directory.`);
    }
    if (sourceIsFile) {
      state.files[destination] = state.files[source];
      delete state.files[source];
    } else {
      for (const path of Object.keys(state.files)) {
        if (path.startsWith(source + '/')) {
          state.files[destination + path.slice(source.length)] = state.files[path];
          delete state.files[path];
        }
      }
      for (const dir of [...state.dirs]) {
        if (dir === source || dir.startsWith(source + '/')) {
          state.dirs.delete(dir);
          state.dirs.add(destination + dir.slice(source.length));
        }
      }
    }
    await persist();
    return `Moved ${source} to ${destination}`;
  });
}

export function removeMemory(path, recursive = false) {
  return serialize(async () => {
    const state = await load();
    const target = locate(path);
    if (target === '') throw new MemoryError('The memories directory cannot be removed.');
    if (state.files[target] !== undefined) {
      if (!isMarkdownName(target)) throw new MemoryError(`"${path}" is not a markdown file: names must end in .md.`);
      delete state.files[target];
      await persist();
      return `Removed ${target}`;
    }
    if (!isDirectory(state, target)) throw new MemoryError(`No such file or directory: ${target}`);
    const inside = walk(state, target);
    if (inside.length > 0 && !recursive) {
      throw new MemoryError(`Directory is not empty: ${target}. Set recursive to remove it.`);
    }
    for (const p of Object.keys(state.files)) if (p.startsWith(target + '/')) delete state.files[p];
    for (const d of [...state.dirs]) if (d === target || d.startsWith(target + '/')) state.dirs.delete(d);
    await persist();
    return `Removed ${target}/`;
  });
}

/* ---- For the Knowledge Base view ---- */

/** Every file with its size, for the memory browser. */
export function listMemoryFiles() {
  return serialize(async () => {
    const state = await load();
    return Object.keys(state.files)
      .sort((a, b) => a.localeCompare(b))
      .map((path) => ({ path, size: state.files[path].length, autoLoaded: !path.includes('/') && path.toLowerCase().startsWith(AUTO_LOADED_MEMORY_PREFIX) }));
  });
}

export function clearMemories() {
  return serialize(async () => {
    await load();
    cache = { files: {}, dirs: new Set() };
    await persist();
    return true;
  });
}

export function hasMemoryFile(path) {
  return serialize(async () => {
    const state = await load();
    return state.files[locate(path)] !== undefined;
  });
}
