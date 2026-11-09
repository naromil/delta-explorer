/* Knowledge Base: automatic learning status, manual passes, and a browser for
 * the memory notes (the desktop app keeps them as files; here they live in
 * extension storage, so this view is how to read, edit or delete them). */

import { onBroadcast, rpc } from '../../src/ui/api.js';
import { formatElapsed, h, icon, toast } from '../../src/ui/dom.js';

function describeStatus(status) {
  if (!status) return 'Automatic learning status unavailable.';
  if (!status.configured) return 'Assign a model to Knowledge Base Maintenance to learn automatically.';
  if (!status.enabled) return 'Automatic learning is off — turn it on in Settings → General.';
  if (status.state === 'running') return 'Learning from your conversations…';
  if (status.pending > 0) return `${status.pending} item${status.pending === 1 ? '' : 's'} queued for automatic learning`;
  if (status.lastLearnedAt) return `Memories updated ${formatElapsed(status.lastLearnedAt)}`;
  return 'Automatic learning is on — memories build as you chat and look things up.';
}

export function createKnowledgeView(host, app) {
  let status = null;
  let totalItems = 0;
  let busy = false;
  let files = [];
  let selected = null;
  let editing = false;

  const statusText = h('span.kb-status-text');
  const analyzeBtn = h('button.btn.btn--primary', { type: 'button', text: 'Analyze now', on: { click: analyze } });
  const reanalyzeBtn = h('button.btn', { type: 'button', text: 'Re-Analyze', on: { click: () => { reanalyzeRow.hidden = false; countInput.focus(); } } });
  const countInput = h('input.input.kb-count', { type: 'number', min: '1', value: '5', 'aria-label': 'How many recent items' });
  const reanalyzeRow = h('div.kb-reanalyze', { hidden: true },
    h('label', { text: 'Re-analyze the most recent ' }), countInput, h('span', { text: ' item(s).' }),
    h('button.btn.btn--primary.btn--sm', { type: 'button', text: 'Go', on: { click: reanalyze } }),
    h('button.btn.btn--sm', { type: 'button', text: 'Cancel', on: { click: () => { reanalyzeRow.hidden = true; } } }));
  countInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') reanalyze();
    if (e.key === 'Escape') reanalyzeRow.hidden = true;
  });
  const errorEl = h('p.kb-error', { hidden: true });
  const resultEl = h('p.kb-result', { hidden: true });
  const browsingEl = h('p.kb-browsing');

  const fileList = h('ul.memory-list', { 'aria-label': 'Memory notes' });
  const viewer = h('div.memory-viewer');

  host.append(
    h('div.view-header', h('h1', { text: 'Knowledge Base' }),
      h('p.view-subtitle', { text: 'Private markdown notes about you, curated from your chats and page look-ups. They personalize every answer.' })),
    h('div.view-content',
      h('div.card',
        h('div.kb-status-bar', statusText, h('div.kb-buttons', analyzeBtn, reanalyzeBtn)),
        reanalyzeRow, errorEl, resultEl,
        h('p.kb-section-desc', { text: 'Analyze now curates what is still in the queue; Re-Analyze goes over recent conversations and pages again. Learning uses the Knowledge Base Maintenance model, which must support tool calling.' }),
        h('div.kb-browsing-row', browsingEl,
          h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Forget browsing history', on: { click: forgetBrowsing } }))),
      h('div.card.memory-card',
        h('div.memory-header',
          h('h2', { text: 'Memories' }),
          h('div.memory-header-actions',
            h('button.btn.btn--sm', { type: 'button', on: { click: newNote } }, icon('plus', 14), 'New note'),
            h('button.btn.btn--sm.btn--danger', { type: 'button', text: 'Clear all', on: { click: clearAll } }))),
        h('div.memory-layout', fileList, viewer))));

  function setError(message) {
    errorEl.hidden = !message;
    errorEl.textContent = message || '';
  }

  function setResult(message) {
    resultEl.hidden = !message;
    resultEl.textContent = message || '';
  }

  function renderStatus() {
    statusText.textContent = describeStatus(status);
    const running = status?.state === 'running';
    analyzeBtn.disabled = busy || running || !status?.configured || (status?.pending || 0) === 0;
    reanalyzeBtn.disabled = busy || running || !status?.configured || totalItems === 0;
    countInput.max = String(Math.max(1, totalItems));
    if (!busy && !running && status?.lastError) setError(`Automatic learning failed: ${status.lastError}`);
  }

  async function refreshStatus() {
    try {
      const [s, count, browsing] = await Promise.all([rpc('kbStatus'), rpc('kbCountItems'), rpc('browsingStats')]);
      status = s;
      totalItems = count;
      browsingEl.textContent = browsing.total === 0
        ? 'No page expansions recorded yet.'
        : `${browsing.total} page expansion${browsing.total === 1 ? '' : 's'} recorded (${browsing.unfed} not yet learned from).`;
      renderStatus();
    } catch (err) {
      statusText.textContent = `Could not load the status: ${err.message || err}`;
    }
  }

  async function analyze() {
    busy = true;
    setError(null);
    setResult(null);
    analyzeBtn.textContent = 'Analyzing…';
    renderStatus();
    try {
      const result = await rpc('kbAnalyze');
      setResult(result.conversationsAnalyzed === 0 ? 'Nothing new to analyze.' : `Analyzed ${result.conversationsAnalyzed} item(s).`);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      busy = false;
      analyzeBtn.textContent = 'Analyze now';
      await refreshStatus();
      await refreshFiles();
    }
  }

  async function reanalyze() {
    const n = parseInt(countInput.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    reanalyzeRow.hidden = true;
    busy = true;
    setError(null);
    setResult(null);
    reanalyzeBtn.textContent = 'Re-analyzing…';
    renderStatus();
    try {
      const result = await rpc('kbReanalyze', { count: Math.min(n, totalItems) });
      setResult(result.conversationsAnalyzed === 0 ? 'Nothing to re-analyze.' : `Re-analyzed ${result.conversationsAnalyzed} item(s).`);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      busy = false;
      reanalyzeBtn.textContent = 'Re-Analyze';
      await refreshStatus();
      await refreshFiles();
    }
  }

  async function forgetBrowsing() {
    if (!window.confirm('Forget every recorded page expansion? Notes already written from them stay until you edit or delete them.')) return;
    await rpc('forgetBrowsing');
    await refreshStatus();
    toast('Browsing history forgotten.');
  }

  /* ---- Memory browser ---- */

  async function refreshFiles() {
    try {
      files = await rpc('memoryList');
    } catch {
      files = [];
    }
    if (selected && !files.some((f) => f.path === selected)) {
      selected = null;
      editing = false;
    }
    renderFiles();
    if (!editing) renderViewer();
  }

  function renderFiles() {
    fileList.replaceChildren();
    if (files.length === 0) {
      fileList.appendChild(h('li.memory-empty', { text: 'No notes yet. They appear as Delta Explorer learns about you.' }));
      return;
    }
    for (const file of files) {
      const depth = file.path.split('/').length - 1;
      fileList.appendChild(h('li',
        h('button.memory-file' + (file.path === selected ? '.active' : ''), {
          type: 'button', style: { paddingLeft: `${10 + depth * 14}px` }, title: file.path,
          on: { click: () => select(file.path) }
        }, icon('file', 14), h('span.memory-file-name', { text: file.path }),
        file.autoLoaded ? h('span.memory-badge', { text: 'always loaded', title: 'Root files named index* are loaded into every conversation.' }) : null)));
    }
  }

  function select(path) {
    if (editing && !window.confirm('Discard your unsaved changes?')) return;
    selected = path;
    editing = false;
    renderFiles();
    renderViewer();
  }

  async function renderViewer() {
    viewer.replaceChildren();
    if (!selected) {
      viewer.appendChild(h('p.memory-placeholder', { text: 'Select a note to read it. Notes are plain markdown; you can correct or delete anything.' }));
      return;
    }
    let content = '';
    try {
      content = await rpc('memoryRead', { path: selected });
    } catch (err) {
      viewer.appendChild(h('p.kb-error', { text: err.message || String(err) }));
      return;
    }
    const path = selected;
    viewer.append(
      h('div.memory-viewer-header',
        h('span.memory-viewer-path', { text: path }),
        h('div.memory-header-actions',
          h('button.btn.btn--sm', { type: 'button', on: { click: () => edit(path, content) } }, icon('edit', 14), 'Edit'),
          h('button.btn.btn--sm.btn--danger', { type: 'button', on: { click: () => remove(path) } }, icon('trash', 14), 'Delete'))),
      h('div.memory-rendered', globalThis.DeltaMarkdown.render(content, [], { anchored: false })));
  }

  function edit(path, content, isNew = false) {
    editing = true;
    const pathInput = h('input.input', { value: path, 'aria-label': 'Note path', placeholder: 'topic/note.md', readOnly: !isNew });
    const area = h('textarea.textarea.memory-editor', { rows: 18, 'aria-label': 'Note content' });
    area.value = content;
    const save = async () => {
      const target = pathInput.value.trim();
      try {
        await rpc('memoryWrite', { path: target, content: area.value });
        editing = false;
        selected = target.replace(/^\.?\/+/, '');
        await refreshFiles();
        renderViewer();
        toast('Note saved.');
      } catch (err) {
        toast(err.message || String(err));
      }
    };
    viewer.replaceChildren(
      h('div.memory-viewer-header', pathInput),
      area,
      h('div.memory-edit-actions',
        h('button.btn.btn--sm', { type: 'button', text: 'Cancel', on: { click: () => { editing = false; if (isNew) selected = null; renderViewer(); renderFiles(); } } }),
        h('button.btn.btn--sm.btn--primary', { type: 'button', text: 'Save', on: { click: save } })));
    (isNew ? pathInput : area).focus();
  }

  function newNote() {
    if (editing && !window.confirm('Discard your unsaved changes?')) return;
    selected = null;
    renderFiles();
    edit('', '# \n', true);
  }

  async function remove(path) {
    if (!window.confirm(`Delete ${path}?`)) return;
    try {
      await rpc('memoryDelete', { path });
      selected = null;
      await refreshFiles();
    } catch (err) {
      toast(err.message || String(err));
    }
  }

  async function clearAll() {
    if (!window.confirm('Delete every memory note? Delta Explorer will start learning about you from scratch.')) return;
    await rpc('memoryClear');
    selected = null;
    editing = false;
    await refreshFiles();
  }

  onBroadcast('kbStatusChanged', (msg) => {
    status = msg.status;
    renderStatus();
  });
  onBroadcast('memoryUpdated', () => { if (!host.hidden) refreshFiles(); });
  onBroadcast('configChanged', () => { if (!host.hidden) refreshStatus(); });
  onBroadcast('settingsChanged', () => { if (!host.hidden) refreshStatus(); });

  return {
    show() {
      refreshStatus();
      refreshFiles();
    }
  };
}
