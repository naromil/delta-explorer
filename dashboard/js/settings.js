/* Settings: General, Models (connections + role assignments), Shortcuts.
 * Everything autosaves; there is no Save button. */

import { onBroadcast, rpc } from '../../src/ui/api.js';
import { applyTheme, formatElapsed, h, icon, isMac, toast } from '../../src/ui/dom.js';
import {
  DEFAULT_OLLAMA_HOST,
  generateConnectionId,
  providerRegistry,
  PROVIDER_TYPES,
  roleRegistry,
  ROLE_IDS
} from '../../src/shared/models.js';

const SAVE_DEBOUNCE_MS = 500;
const PICKER_LIMIT = 50;
const TABS = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'shortcuts', label: 'Shortcuts' }
];
const COMMANDS = [
  { name: '_execute_action', label: 'Open the look-up' },
  { name: 'expand', label: 'Expand the selected text' },
  { name: 'expand-prompted', label: 'Expand with your own question' },
  { name: 'open-canvas', label: 'Explore the page on a canvas' }
];

function formatContextWindow(tokens) {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function describeModel(model) {
  const parts = [];
  const context = formatContextWindow(model.contextWindow);
  if (context) parts.push(`${context} context`);
  parts.push(model.toolCall ? 'tool calls' : 'no tool support');
  if (model.inputModalities.includes('image')) parts.push('images');
  if (model.reasoning) parts.push('reasoning');
  const price = (v) => (v === undefined ? '?' : `$${Math.round(v * 1000) / 1000}`);
  if (model.costIn !== undefined || model.costOut !== undefined) parts.push(`${price(model.costIn)} / ${price(model.costOut)} per 1M`);
  return parts.join(' · ');
}

function normalizeQuery(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function filterModels(models, query) {
  const q = normalizeQuery(query);
  if (!q) return models.slice(0, PICKER_LIMIT * 4);
  const prefixed = [];
  const contained = [];
  for (const model of models) {
    const id = normalizeQuery(model.id);
    if (id.startsWith(q)) prefixed.push(model);
    else if (id.includes(q)) contained.push(model);
  }
  return [...prefixed, ...contained].slice(0, PICKER_LIMIT);
}

/** A text field with a filterable dropdown; any typed id is accepted. */
function modelPicker({ value, getModels, onCommit, placeholder }) {
  const input = h('input.input.picker-input', { value, placeholder, autocomplete: 'off', spellcheck: false, 'aria-label': 'Model' });
  const list = h('ul.picker-list', { role: 'listbox', hidden: true });
  let visible = [];
  let highlight = 0;
  const render = () => {
    visible = filterModels(getModels(), input.value === value ? '' : input.value);
    list.replaceChildren(...visible.map((model, index) => h('li.picker-item' + (index === highlight ? '.active' : ''), {
      role: 'option',
      on: {
        mousedown: (e) => { e.preventDefault(); commit(model.id); },
        mousemove: () => { if (highlight !== index) { highlight = index; render(); } }
      }
    }, h('span.picker-id', { text: model.id }), model.hint ? h('span.picker-hint', { text: model.hint }) : null)));
    list.hidden = visible.length === 0;
    list.children[highlight]?.scrollIntoView({ block: 'nearest' });
  };
  const commit = (id) => {
    const next = String(id || '').trim();
    list.hidden = true;
    input.value = next;
    value = next;
    onCommit(next);
  };
  input.addEventListener('focus', () => { highlight = 0; render(); });
  input.addEventListener('input', () => { highlight = 0; render(); });
  input.addEventListener('blur', () => {
    list.hidden = true;
    if (input.value.trim() !== value) commit(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight = Math.min(visible.length - 1, highlight + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight = Math.max(0, highlight - 1); render(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      commit(!list.hidden && visible[highlight] ? visible[highlight].id : input.value);
      input.blur();
    } else if (e.key === 'Escape') {
      list.hidden = true;
      input.value = value;
    }
  });
  return { el: h('div.picker', input, list), refresh: () => { if (document.activeElement === input) render(); } };
}

export function createSettingsView(host, app) {
  let settings = null;
  let config = null;
  let catalogState = { catalog: null, source: 'unavailable' };
  const discovered = {}; // connectionId -> string[]
  let configTimer = null;
  let settingsTimer = null;
  let activeTab = 'general';

  const tabBar = h('div.settings-tabs', { role: 'tablist' });
  const panel = h('div.settings-panel');
  const saveStatus = h('span.settings-save-status', { role: 'status' });
  host.append(
    h('div.view-header', h('h1', { text: 'Settings' }), saveStatus),
    h('div.view-content', tabBar, panel));

  function renderTabs() {
    tabBar.replaceChildren(...TABS.map((tab) => h('button.settings-tab' + (tab.id === activeTab ? '.active' : ''), {
      type: 'button', role: 'tab', 'aria-selected': tab.id === activeTab ? 'true' : 'false', text: tab.label,
      on: { click: () => app.navigate(`settings/${tab.id}`) }
    })));
  }

  function flashSaved(error) {
    saveStatus.textContent = error ? `Not saved: ${error}` : 'Saved';
    saveStatus.classList.toggle('error', !!error);
    clearTimeout(flashSaved.timer);
    flashSaved.timer = setTimeout(() => { saveStatus.textContent = ''; }, 2000);
  }

  function queueSettingsSave(patch) {
    settings = { ...settings, ...patch };
    if (patch.theme) applyTheme(patch.theme);
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
      try {
        settings = await rpc('saveSettings', { patch: settings });
        flashSaved();
      } catch (err) {
        flashSaved(err.message || String(err));
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function queueConfigSave() {
    clearTimeout(configTimer);
    configTimer = setTimeout(async () => {
      try {
        await rpc('saveModelConfig', { config });
        flashSaved();
      } catch (err) {
        flashSaved(err.message || String(err));
      }
    }, SAVE_DEBOUNCE_MS);
  }

  /* ---- General ---- */

  function field(label, control, hint) {
    return h('div.settings-field', h('label.settings-label', { text: label }), control, hint ? h('p.settings-hint', { text: hint }) : null);
  }

  function toggle(checked, labelOn, labelOff, onChange) {
    const input = h('input.toggle-input', { type: 'checkbox', checked });
    const text = h('span.toggle-label', { text: checked ? labelOn : labelOff });
    input.addEventListener('change', () => {
      text.textContent = input.checked ? labelOn : labelOff;
      onChange(input.checked);
    });
    return h('label.toggle-row', input, h('span.toggle-track', h('span.toggle-thumb')), text);
  }

  function select(value, options, onChange) {
    const el = h('select.select', { on: { change: () => onChange(el.value) } },
      options.map(([v, label]) => h('option', { value: v, text: label, selected: v === value })));
    el.value = value;
    return el;
  }

  function renderGeneral() {
    panel.replaceChildren(
      h('div.card',
        field('Theme', select(settings.theme, [['system', 'Match system'], ['dark', 'Dark'], ['light', 'Light']], (v) => queueSettingsSave({ theme: v }))),
        field('Look-up context', select(settings.pageContext, [
          ['selection', 'Selected text (default)'],
          ['page', 'Selected text, else the readable page text'],
          ['none', 'None (no automatic context)']
        ], (v) => queueSettingsSave({ pageContext: v })), 'What the toolbar look-up sends along with your question. The context is shown before you ask and can be removed.'),
        field('Expand bar on web pages', toggle(settings.pageSelectionBar, 'Shown over any text you select', 'Only inside answers; use right-click or the shortcut on pages', (v) => queueSettingsSave({ pageSelectionBar: v }))),
        field('Automatic memory updates', toggle(settings.kbAutoMaintain, 'New chats and page expansions update memories in the background', 'Only learn when Analyze is pressed', (v) => queueSettingsSave({ kbAutoMaintain: v })),
          'Delta Explorer curates your conversations into private markdown notes that personalize every answer. Runs use the Knowledge Base Maintenance model, which must support tool calling.')),
      h('div.card.settings-privacy',
        h('h2', { text: 'Privacy' }),
        h('p', { text: 'Everything stays in this browser profile except requests to the model providers you configure (and the public models.dev model list). Expanding or looking up sends the selected text and nearby page text to your look-up model; chats go to your chat model; memory curation sends conversation summaries to the Knowledge Base Maintenance model. API keys are kept in extension storage on this device. No telemetry, no accounts.' })));
  }

  /* ---- Models ---- */

  function catalogModelsFor(providerType) {
    return catalogState.catalog?.providers?.[providerType] || [];
  }

  function modelsForConnection(conn) {
    if (!conn) return [];
    const catalog = catalogModelsFor(conn.providerType);
    const ids = discovered[conn.id] || (catalog.length ? catalog.map((m) => m.id) : providerRegistry[conn.providerType]?.knownModels || []);
    return ids.map((id) => {
      const meta = catalog.find((m) => m.id === id);
      return meta ? { id, hint: describeModel(meta) } : { id };
    });
  }

  function connectionCard(conn) {
    const def = providerRegistry[conn.providerType];
    const testResult = h('p.settings-test-result', { role: 'status', hidden: true });
    const update = (patch, rerender = false) => {
      Object.assign(conn, patch);
      testResult.hidden = true;
      queueConfigSave();
      if (rerender) renderModels();
    };
    const label = h('input.input.settings-input--title', { value: conn.label, placeholder: 'Connection name', on: { input: (e) => update({ label: e.target.value }) } });
    const testBtn = h('button.btn.btn--sm', { type: 'button', text: 'Test' });
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing…';
      const probe = ROLE_IDS.map((r) => config.roles[r]).find((a) => a.connectionId === conn.id && a.model)?.model;
      try {
        const result = await rpc('testConnection', { connection: conn, probeModel: probe });
        testResult.textContent = `${result.ok ? '✓' : '✗'} ${result.detail}`;
        testResult.className = `settings-test-result ${result.ok ? 'ok' : 'err'}`;
      } catch (err) {
        testResult.textContent = `✗ ${err.message || err}`;
        testResult.className = 'settings-test-result err';
      }
      testResult.hidden = false;
      testBtn.disabled = false;
      testBtn.textContent = 'Test';
    });
    const deleteBtn = h('button.btn.btn--sm.btn--danger', {
      type: 'button', text: 'Delete',
      on: {
        click: () => {
          if (!window.confirm(`Delete the “${conn.label || def.label}” connection? Roles using it will be unassigned.`)) return;
          delete config.connections[conn.id];
          for (const role of ROLE_IDS) if (config.roles[role].connectionId === conn.id) config.roles[role] = { connectionId: null, model: '' };
          queueConfigSave();
          renderModels();
        }
      }
    });
    const providerSelect = select(conn.providerType, PROVIDER_TYPES.map((t) => [t, providerRegistry[t].label]), (type) => {
      delete discovered[conn.id];
      update({
        providerType: type,
        baseUrl: '',
        host: type === 'ollama' ? DEFAULT_OLLAMA_HOST : '',
        apiKey: providerRegistry[type].authShape === 'apiKey' ? conn.apiKey : '',
        label: !conn.label || PROVIDER_TYPES.some((t) => providerRegistry[t].label === conn.label) ? providerRegistry[type].label : conn.label
      }, true);
    });
    const rows = [h('div.settings-field', h('label.settings-label.settings-label--sm', { text: 'Provider' }), providerSelect)];
    if (def.authShape === 'apiKey') {
      const keyInput = h('input.input', { type: 'password', value: conn.apiKey, autocomplete: 'off', spellcheck: false, placeholder: conn.providerType === 'openai-compatible' ? 'Optional for local servers' : 'Enter your API key…', on: { input: (e) => update({ apiKey: e.target.value.trim() }) } });
      const reveal = h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Show', on: { click: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; reveal.textContent = keyInput.type === 'password' ? 'Show' : 'Hide'; } } });
      rows.push(h('div.settings-field', h('label.settings-label.settings-label--sm', { text: 'API key' }), h('div.settings-inline', keyInput, reveal)));
    }
    if (conn.providerType === 'openai-compatible' || conn.providerType === 'openai' || conn.providerType === 'openrouter') {
      rows.push(h('div.settings-field',
        h('label.settings-label.settings-label--sm', { text: conn.providerType === 'openai-compatible' ? 'Base URL' : 'Base URL (optional)' }),
        h('input.input', { value: conn.baseUrl, spellcheck: false, placeholder: def.defaultBaseUrl || 'https://api.example.com/v1', on: { input: (e) => update({ baseUrl: e.target.value.trim() }) } })));
    }
    if (def.authShape === 'host') {
      rows.push(h('div.settings-field',
        h('label.settings-label.settings-label--sm', { text: 'Host' }),
        h('input.input', { value: conn.host || DEFAULT_OLLAMA_HOST, spellcheck: false, placeholder: DEFAULT_OLLAMA_HOST, on: { input: (e) => update({ host: e.target.value.trim() }) } }),
        h('p.settings-hint', { text: 'If requests fail with HTTP 403, Ollama is refusing this extension’s origin: start it with OLLAMA_ORIGINS="moz-extension://*".' })));
    }
    return h('div.card.connection-card',
      h('div.connection-header', label, h('div.connection-actions', testBtn, deleteBtn)),
      testResult,
      ...rows);
  }

  function roleRow(roleId) {
    const def = roleRegistry[roleId];
    const assignment = config.roles[roleId];
    const conn = assignment.connectionId ? config.connections[assignment.connectionId] : null;
    const hint = h('p.settings-hint.role-model-hint');
    const setHint = () => {
      const meta = conn ? catalogModelsFor(conn.providerType).find((m) => m.id === assignment.model) : null;
      const parts = [];
      if (meta) parts.push(describeModel(meta));
      if (roleId === 'kb-maintenance' && meta && !meta.toolCall) parts.push('This model cannot call tools, so it cannot update memories.');
      if (!assignment.model && conn) parts.push('Pick or type a model id.');
      hint.textContent = parts.join(' — ');
      hint.classList.toggle('warn', roleId === 'kb-maintenance' && !!meta && !meta.toolCall);
    };
    const connSelect = select(assignment.connectionId || '', [['', 'Unassigned'], ...Object.values(config.connections).map((c) => [c.id, c.label || providerRegistry[c.providerType].label])], (id) => {
      config.roles[roleId] = { connectionId: id || null, model: id && id === assignment.connectionId ? assignment.model : '' };
      queueConfigSave();
      renderModels();
    });
    const picker = conn ? modelPicker({
      value: assignment.model,
      placeholder: 'Model id, e.g. gpt-4o-mini',
      getModels: () => modelsForConnection(conn),
      onCommit: (model) => {
        config.roles[roleId].model = model;
        assignment.model = model;
        setHint();
        queueConfigSave();
      }
    }) : null;
    const fetchBtn = conn ? h('button.btn.btn--sm.btn--ghost', { type: 'button', title: 'Ask the endpoint for its model list' }, icon('refresh', 14), 'Fetch') : null;
    if (fetchBtn) {
      fetchBtn.addEventListener('click', async () => {
        fetchBtn.disabled = true;
        try {
          const result = await rpc('discoverModels', { connection: conn });
          if (result.models.length) {
            discovered[conn.id] = result.models;
            toast(`${result.models.length} models found.`);
            picker.refresh();
          } else {
            toast(result.error ? `Could not list models: ${result.error}` : 'The endpoint returned no models.');
          }
        } finally {
          fetchBtn.disabled = false;
        }
      });
    }
    setHint();
    return h('div.role-row',
      h('div.role-info', h('span.role-label', { text: def.label }), h('span.role-desc', { text: def.description })),
      h('div.role-controls', connSelect, picker ? h('div.role-model', picker.el, fetchBtn) : h('span.role-unassigned', { text: Object.keys(config.connections).length ? 'Choose a connection' : 'Add a connection first' })),
      hint);
  }

  function renderModels() {
    const catalogLine = h('p.settings-hint.catalog-line');
    const describeCatalog = () => {
      if (catalogState.catalog) {
        catalogLine.textContent = `Model details from models.dev, updated ${formatElapsed(catalogState.catalog.fetchedAt)}${catalogState.error ? ` (offline: ${catalogState.error})` : ''}.`;
      } else {
        catalogLine.textContent = `Model list unavailable${catalogState.error ? `: ${catalogState.error}` : ''}. You can still type any model id.`;
      }
    };
    describeCatalog();
    const refreshCatalog = h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Refresh list', on: { click: async () => {
      catalogState = await rpc('getCatalog', { force: true });
      renderModels();
    } } });
    panel.replaceChildren(...[
      h('div.card',
        h('div.section-header', h('h2', { text: 'Roles' })),
        h('p.settings-hint', { text: 'Each role uses its own connection and model, so look-ups can run on a fast model while chat uses a stronger one.' }),
        ...ROLE_IDS.map(roleRow),
        h('div.catalog-row', catalogLine, refreshCatalog)),
      h('div.section-header.connections-header',
        h('h2', { text: 'Connections' }),
        h('button.btn.btn--sm', { type: 'button', on: { click: addConnection } }, icon('plus', 14), 'Add connection')),
      Object.keys(config.connections).length === 0
        ? h('p.settings-hint', { text: 'No connections yet. Add one with your API key, or point it at a local Ollama.' })
        : null,
      ...Object.values(config.connections).map(connectionCard)
    ].filter(Boolean));
  }

  function addConnection() {
    const id = generateConnectionId();
    config.connections[id] = { id, label: providerRegistry.openai.label, providerType: 'openai', apiKey: '', baseUrl: '', host: '' };
    // The first connection is what every unassigned role should use.
    for (const role of ROLE_IDS) {
      if (!config.roles[role].connectionId) config.roles[role] = { connectionId: id, model: '' };
    }
    queueConfigSave();
    renderModels();
  }

  /* ---- Shortcuts ---- */

  function formatShortcut(e) {
    const parts = [];
    if (isMac() && e.metaKey) parts.push('Command');
    if (e.ctrlKey) parts.push(isMac() ? 'MacCtrl' : 'Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.key;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
    if (!isFunctionKey && parts.length === 0) return null;
    parts.push(key);
    return parts.join('+');
  }

  async function renderShortcuts() {
    const commands = await browser.commands.getAll().catch(() => []);
    const rows = COMMANDS.map(({ name, label }) => {
      const command = commands.find((c) => c.name === name);
      const status = h('span.settings-hint');
      const input = h('input.input.shortcut-input', { readOnly: true, value: command?.shortcut || '', placeholder: 'Press a key combination…' });
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Tab') return;
        e.preventDefault();
        e.stopPropagation();
        const formatted = formatShortcut(e);
        if (!formatted) return;
        try {
          await browser.commands.update({ name, shortcut: formatted });
          input.value = formatted;
          status.textContent = 'Updated.';
        } catch (err) {
          status.textContent = `Invalid shortcut: ${err.message || err}`;
        }
      });
      const reset = h('button.btn.btn--sm', { type: 'button', text: 'Reset', on: { click: async () => {
        await browser.commands.reset(name);
        const fresh = (await browser.commands.getAll()).find((c) => c.name === name);
        input.value = fresh?.shortcut || '';
        status.textContent = 'Reset to default.';
      } } });
      return h('div.shortcut-row', h('span.shortcut-label', { text: label }), input, reset, status);
    });
    panel.replaceChildren(h('div.card',
      h('p.settings-hint', { text: 'Click a field and press a combination with at least one modifier (Ctrl, Alt, Shift) or a function key. These work in every tab.' }),
      ...rows,
      h('p.settings-hint', { text: 'In the dashboard: Ctrl+K search, Ctrl+Shift+O new chat, Ctrl+, settings, Esc stops a response.' })));
  }

  /* ---- Routing ---- */

  async function render() {
    renderTabs();
    if (!settings || !config) {
      panel.replaceChildren(h('p.settings-hint', { text: 'Loading…' }));
      [settings, config] = await Promise.all([rpc('getSettings'), rpc('getModelConfig')]);
      rpc('getCatalog').then((state) => {
        catalogState = state;
        if (activeTab === 'models') renderModels();
      }).catch(() => {});
    }
    if (activeTab === 'general') renderGeneral();
    else if (activeTab === 'models') renderModels();
    else renderShortcuts();
  }

  onBroadcast('configChanged', async () => {
    // Another tab changed models; take its version unless an edit is pending here.
    if (configTimer && document.hasFocus()) return;
    config = await rpc('getModelConfig');
    if (!host.hidden && activeTab === 'models' && !host.contains(document.activeElement)) renderModels();
  });

  return {
    show(arg) {
      activeTab = TABS.some((t) => t.id === arg) ? arg : 'general';
      render();
    }
  };
}
