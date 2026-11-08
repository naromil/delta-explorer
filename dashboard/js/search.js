/* Ctrl/Cmd+K: search every conversation by title and content. */

import { rpc } from '../../src/ui/api.js';
import { formatRelativeTime, h, icon } from '../../src/ui/dom.js';
import { CONVERSATION_SOURCE_LABELS } from '../../src/shared/conversation.js';

let openOverlay = null;

export function openSearch(app) {
  if (openOverlay) {
    openOverlay.input.focus();
    return;
  }
  const input = h('input.search-input', { type: 'search', placeholder: 'Search conversations…', 'aria-label': 'Search conversations', autocomplete: 'off' });
  const list = h('ul.search-results', { role: 'listbox', 'aria-label': 'Conversations' });
  const status = h('p.search-status');
  const panel = h('div.search-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search conversations' },
    h('div.search-field', icon('search', 16), input), status, list);
  const backdrop = h('div.search-backdrop', { on: { mousedown: (e) => { if (e.target === backdrop) close(); } } }, panel);
  document.body.appendChild(backdrop);

  let results = [];
  let highlight = 0;
  let version = 0;
  let timer = null;

  function close() {
    backdrop.remove();
    openOverlay = null;
  }

  function choose(index) {
    const result = results[index];
    if (!result) return;
    close();
    app.openConversation(result);
  }

  async function remove(index) {
    const result = results[index];
    if (!result) return;
    if (app.chat && app.chat.currentId() === result.id) {
      window.alert('That conversation is open in Chat. Delete it from the Chat toolbar instead.');
      return;
    }
    if (!window.confirm(`Delete “${result.title}”? This cannot be undone.`)) return;
    await rpc('deleteConversation', { id: result.id });
    run();
  }

  function render() {
    list.replaceChildren();
    results.forEach((result, index) => {
      const item = h('li.search-result' + (index === highlight ? '.active' : ''), {
        role: 'option', 'aria-selected': index === highlight ? 'true' : 'false',
        on: { click: () => choose(index), mousemove: () => { if (highlight !== index) { highlight = index; render(); } } }
      },
      h('div.search-result-main',
        h('span.search-result-title', { text: result.title }),
        h('span.search-result-meta', { text: `${CONVERSATION_SOURCE_LABELS[result.source] || 'Chat'} · ${formatRelativeTime(result.updatedAt)} · ${result.turnCount} turns` }),
        result.snippet ? h('span.search-result-snippet', { text: result.snippet }) : null),
      h('button.icon-btn.search-result-delete', {
        type: 'button', title: 'Delete', 'aria-label': `Delete ${result.title}`,
        on: { click: (e) => { e.stopPropagation(); remove(index); } }
      }, icon('trash', 14)));
      list.appendChild(item);
    });
    const active = list.children[highlight];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  async function run() {
    const mine = ++version;
    try {
      const found = await rpc('searchConversations', { query: input.value });
      if (mine !== version) return;
      results = found;
      highlight = Math.min(highlight, Math.max(0, results.length - 1));
      status.textContent = results.length === 0 ? (input.value.trim() ? 'No matching conversations.' : 'No conversations yet.') : '';
      render();
    } catch (err) {
      status.textContent = `Search failed: ${err.message || err}`;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    highlight = 0;
    timer = setTimeout(run, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight = Math.min(results.length - 1, highlight + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight = Math.max(0, highlight - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(highlight); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  openOverlay = { input };
  input.focus();
  run();
}
