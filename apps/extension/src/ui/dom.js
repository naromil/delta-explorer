/* Small DOM helpers for the extension pages. No innerHTML anywhere. */

/** h('div.cls#id', { attrs, on: { click } }, ...children) */
export function h(spec, props, ...children) {
  // The props argument is optional: a node, string or array there is the first child.
  if (props !== null && props !== undefined && (props instanceof Node || typeof props === 'string' || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const [, tag = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(spec);
  const el = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'on') {
        for (const [event, fn] of Object.entries(value)) el.addEventListener(event, fn);
      } else if (key === 'text') {
        el.textContent = value;
      } else if (key === 'class') {
        el.className = [el.className, value].filter(Boolean).join(' ');
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key in el && typeof value !== 'string') {
        el[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
  home: ['M3 10.5L12 3l9 7.5', 'M5 9.5V20h5v-6h4v6h5V9.5'],
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  canvas: ['M3 3h8v6H3z', 'M13 15h8v6h-8z', 'M7 9v4a2 2 0 0 0 2 2h4'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z', 'M8 7h8M8 11h6'],
  compass: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M15.5 8.5l-2 5-5 2 2-5z'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  plus: ['M12 5v14M5 12h14'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.35-4.35'],
  download: ['M12 3v12m0 0l-4-4m4 4l4-4M4 19h16'],
  trash: ['M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3'],
  send: ['M4 12l16-8-6 16-2-7z'],
  stop: ['M7 7h10v10H7z'],
  attach: ['M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  delta: ['M12 3L2.5 20h19z'],
  arrowDown: ['M12 5v14M5 12l7 7 7-7'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 3'],
  edit: ['M16.5 3.5l4 4L8 20H4v-4z'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v5h-5'],
  file: ['M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z', 'M14 3v5h5'],
  memory: ['M12 3a7 7 0 0 0-4 12.7V19h8v-3.3A7 7 0 0 0 12 3z', 'M9 22h6']
};

export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', name === 'stop' || name === 'send' ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const MINUTE = 60_000;

export function formatRelativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, now - then);
  if (diff < MINUTE) return 'just now';
  if (diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < 24 * 60 * MINUTE) return `${Math.floor(diff / (60 * MINUTE))}h ago`;
  if (diff < 7 * 24 * 60 * MINUTE) return `${Math.floor(diff / (24 * 60 * MINUTE))}d ago`;
  return new Date(then).toLocaleDateString();
}

export function formatElapsed(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'recently';
  const minutes = Math.max(0, Math.round((Date.now() - then) / MINUTE));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Applies dark / light / system to the document root. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

export function downloadText(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function isMac() {
  return /Mac/.test(navigator.platform);
}

/** "Ctrl+K" → "⌘K" on macOS. */
export function keyLabel(combo) {
  return isMac() ? combo.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧') : combo;
}

/** A brief toast at the bottom of the page. */
let toastTimer = null;
export function toast(message) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = h('div#app-toast.toast', { role: 'status' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 4000);
}
