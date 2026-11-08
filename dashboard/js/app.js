/* Dashboard shell: navigation, routing by URL hash, theme, global shortcuts.
 *
 * Routes: #home, #chat, #chat/<id>, #knowledge, #guide, #settings, #settings/<tab>. */

import { onBroadcast, rpc } from '../../src/ui/api.js';
import { applyTheme, h, icon, keyLabel } from '../../src/ui/dom.js';
import { createHomeView } from './home.js';
import { createChatView } from './chat.js';
import { createKnowledgeView } from './knowledge.js';
import { createGuideView } from './guide.js';
import { createSettingsView } from './settings.js';
import { openSearch } from './search.js';

const NAV = [
  { view: 'home', label: 'Home', icon: 'home' },
  { view: 'chat', label: 'Chat', icon: 'chat' },
  { view: 'knowledge', label: 'Knowledge Base', icon: 'book' },
  { view: 'guide', label: 'Guide', icon: 'compass' },
  { view: 'settings', label: 'Settings', icon: 'settings' }
];

const views = {};
let current = null;

const app = {
  navigate(route) {
    const next = `#${route}`;
    if (location.hash === next) route && handleRoute();
    else location.hash = next;
  },
  openConversation(meta) {
    app.navigate(`chat/${meta.id}`);
  },
  newChat() {
    app.navigate('chat/new');
  },
  search() {
    openSearch(app);
  },
  get chat() {
    return views.chat;
  }
};

function viewFactory(name) {
  const host = document.getElementById(`view-${name}`);
  switch (name) {
    case 'home': return createHomeView(host, app);
    case 'chat': return createChatView(host, app);
    case 'knowledge': return createKnowledgeView(host, app);
    case 'guide': return createGuideView(host, app);
    case 'settings': return createSettingsView(host, app);
    default: return null;
  }
}

function handleRoute() {
  const raw = location.hash.replace(/^#/, '') || 'home';
  const [name, ...rest] = raw.split('/');
  const viewName = NAV.some((n) => n.view === name) ? name : 'home';
  const arg = rest.join('/');
  if (!views[viewName]) views[viewName] = viewFactory(viewName);
  for (const n of NAV) {
    document.getElementById(`view-${n.view}`).hidden = n.view !== viewName;
    const button = document.querySelector(`.sidebar-tab[data-view="${n.view}"]`);
    if (button) {
      button.classList.toggle('active', n.view === viewName);
      if (n.view === viewName) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }
  if (current && current !== views[viewName]) current.hide?.();
  current = views[viewName];
  current?.show?.(arg);
}

function buildNav() {
  const nav = document.getElementById('sidebar-nav');
  for (const item of NAV) {
    nav.appendChild(h('button.sidebar-tab', {
      type: 'button', dataset: { view: item.view },
      on: { click: () => app.navigate(item.view === 'chat' && views.chat?.currentId() ? `chat/${views.chat.currentId()}` : item.view) }
    }, icon(item.icon, 17), h('span', { text: item.label })));
  }
  document.getElementById('search-key').textContent = keyLabel('Ctrl+K');
  document.getElementById('sidebar-search').addEventListener('click', () => app.search());
}

function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'k' && !e.shiftKey) {
      e.preventDefault();
      app.search();
    } else if (key === 'o' && e.shiftKey) {
      e.preventDefault();
      app.newChat();
    } else if (key === ',') {
      e.preventDefault();
      app.navigate('settings');
    }
  });
  // Ctrl+E is an extension command, so the browser takes the key before this page sees it.
  onBroadcast('expandShortcut', (msg) => {
    if (!document.hasFocus()) return;
    if (current === views.chat) views.chat.handleExpandShortcut(!!msg.prompted);
  });
}

let pillTimer = null;
function bindMemoryIndicator() {
  const pill = document.getElementById('memory-pill');
  onBroadcast('memoryUpdated', () => {
    pill.hidden = false;
    pill.classList.remove('fade');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => {
      pill.classList.add('fade');
      setTimeout(() => { pill.hidden = true; }, 400);
    }, 3000);
  });
}

async function initTheme() {
  try {
    const settings = await rpc('getSettings');
    applyTheme(settings.theme);
  } catch { /* system theme */ }
  onBroadcast('settingsChanged', (msg) => applyTheme(msg.settings?.theme));
}

buildNav();
bindShortcuts();
bindMemoryIndicator();
initTheme();
window.addEventListener('hashchange', handleRoute);
handleRoute();
