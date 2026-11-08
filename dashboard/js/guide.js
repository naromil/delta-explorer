/* Guide: how to expand text on pages, look things up, and the keyboard shortcuts. */

import { h, keyLabel } from '../../src/ui/dom.js';

const COMMAND_LABELS = {
  _execute_action: 'Open the look-up',
  expand: 'Expand the selected text',
  'expand-prompted': 'Expand with your own question'
};

export function createGuideView(host, app) {
  const shortcutRows = h('tbody');

  const step = (title, ...body) => h('section.guide-step', h('h2', { text: title }), ...body);
  const p = (text) => h('p', { text });

  host.append(
    h('div.view-header', h('h1', { text: 'Guide' }), h('p.view-subtitle', { text: 'Learn while you read: everything works on any web page.' })),
    h('div.view-content.guide',
      step('Expand any text on a page',
        p('Select a word, a phrase or a passage, then right-click and choose Expand for a definition or explanation, or Expand on… to ask your own question. The answer appears inline, right where the text was.'),
        p('Expand on… also offers one-click questions: Simpler, Example, Why, Compare and Deeper. Turn on “Show the Expand bar on web pages” in Settings to get them over every selection.'),
        p('Answers can nest: select text inside an answer to expand it further. Use the buttons on an answer to regenerate it, change its question, copy it, or continue in Chat. Right-click its title (or press Esc) to fold it back into the text; click the marked text to open it again. Expansions come back when you revisit the page.')),
      step('Look something up',
        p('Click the Delta Explorer toolbar button to ask about the page you are on. By default the selected text goes along as context; Settings → General can send the readable page text instead, or nothing.'),
        p('Answers in the look-up can be expanded like any other. Open in Chat continues the conversation in the dashboard.')),
      step('Chat',
        p('Chat keeps every conversation, searchable from anywhere with ' + keyLabel('Ctrl+K') + '. Select text in an answer to expand it inline, attach images for vision models, edit and resend your messages, or regenerate any answer. Export a conversation as markdown from the toolbar.')),
      step('Memories',
        p('In the background, Delta Explorer curates your conversations and page expansions into private markdown notes about what you know and how you like things explained, and uses them to tailor every answer. Read, edit or delete them in the Knowledge Base. Learning needs a tool-capable model on the Knowledge Base Maintenance role.')),
      step('Keyboard shortcuts',
        h('table.shortcut-table',
          h('thead', h('tr', h('th', { text: 'Action' }), h('th', { text: 'Keys' }))),
          shortcutRows),
        h('p.hint', {},
          'Browser-wide shortcuts can be changed in ',
          h('a', { href: '#settings/shortcuts', text: 'Settings → Shortcuts' }),
          '.'))));

  async function renderShortcuts() {
    const rows = [];
    try {
      const commands = await browser.commands.getAll();
      for (const command of commands) {
        if (!COMMAND_LABELS[command.name]) continue;
        rows.push([COMMAND_LABELS[command.name], command.shortcut || 'Not set']);
      }
    } catch { /* ignore */ }
    rows.push(
      ['Search conversations (dashboard)', keyLabel('Ctrl+K')],
      ['New chat (dashboard)', keyLabel('Ctrl+Shift+O')],
      ['Open Settings (dashboard)', keyLabel('Ctrl+,')],
      ['Stop a response', 'Esc'],
      ['Fold the newest answer on a page', 'Esc']
    );
    shortcutRows.replaceChildren(...rows.map(([action, keys]) => h('tr', h('td', { text: action }), h('td', h('kbd.kbd', { text: keys })))));
  }

  return {
    show() { renderShortcuts(); }
  };
}
