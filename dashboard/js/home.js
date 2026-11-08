/* Home: quick actions and recent conversations. */

import { onBroadcast, rpc } from '../../src/ui/api.js';
import { formatRelativeTime, h, icon } from '../../src/ui/dom.js';
import { CONVERSATION_SOURCE_LABELS } from '../../src/shared/conversation.js';

const RECENT_LIMIT = 6;

export function createHomeView(host, app) {
  const recentSection = h('section.home-recent', { 'aria-label': 'Recent conversations' });
  const setupBanner = h('div.setup-banner', { hidden: true });

  const action = (iconName, title, desc, onClick, extra) =>
    h('button.home-action', { type: 'button', on: { click: onClick } },
      h('span.home-action-icon', icon(iconName, 20)),
      h('span.home-action-body',
        h('span.home-action-title', { text: title }),
        h('span.home-action-desc', { text: desc }),
        extra || null));

  const lookupKey = h('kbd.kbd.home-action-hotkey', { hidden: true });

  host.append(
    h('div.view-header', h('h1', { text: 'Home' }), h('p.view-subtitle', { text: 'An assistant that remembers what matters from your conversations.' })),
    h('div.view-content',
      setupBanner,
      h('div.home-actions',
        action('chat', 'Start a chat', 'Ask anything — Delta Explorer remembers.', () => app.newChat()),
        action('book', 'Update memories', 'Curate your recent chats and page look-ups into notes.', () => app.navigate('knowledge')),
        action('search', 'Look something up', 'Select text on any page, or open the look-up from the toolbar.', () => app.navigate('guide'), lookupKey)),
      recentSection));

  async function refreshSetup() {
    try {
      const config = await rpc('getModelConfig');
      const missing = ['chat', 'lookup'].filter((role) => !config.roles[role].connectionId || !config.roles[role].model);
      setupBanner.hidden = missing.length === 0;
      setupBanner.replaceChildren(
        h('div',
          h('strong', { text: Object.keys(config.connections).length === 0 ? 'Connect a model to get started.' : 'Some roles have no model yet.' }),
          h('p', { text: 'Delta Explorer uses your own API key or a local Ollama model. Add a connection, then assign it to Chat and Look-up.' })),
        h('button.btn.btn--primary', { type: 'button', text: 'Open model settings', on: { click: () => app.navigate('settings/models') } }));
    } catch { /* ignore */ }
  }

  async function refreshShortcut() {
    try {
      const commands = await browser.commands.getAll();
      const lookup = commands.find((c) => c.name === '_execute_action');
      lookupKey.hidden = !lookup || !lookup.shortcut;
      lookupKey.textContent = lookup?.shortcut || '';
    } catch { /* ignore */ }
  }

  async function refreshRecent() {
    let list = [];
    try { list = await rpc('listConversations'); } catch { /* search still reaches everything */ }
    recentSection.replaceChildren();
    if (list.length === 0) return;
    recentSection.append(
      h('h2.home-section-title', { text: 'Recent conversations' }),
      h('ul.home-recent-list', list.slice(0, RECENT_LIMIT).map((meta) => h('li',
        h('button.home-recent-item', { type: 'button', on: { click: () => app.openConversation(meta) } },
          h('span.home-recent-title', { text: meta.title }),
          h('span.home-recent-meta', { text: `${CONVERSATION_SOURCE_LABELS[meta.source] || 'Chat'} · ${formatRelativeTime(meta.updatedAt)} · ${meta.turnCount} turns` }))))));
  }

  onBroadcast('conversationsChanged', () => { if (!host.hidden) refreshRecent(); });
  onBroadcast('configChanged', () => refreshSetup());

  return {
    show() {
      refreshSetup();
      refreshShortcut();
      refreshRecent();
    }
  };
}
