/* A conversation with inline expansions, shared by the dashboard's Chat view
 * and the toolbar look-up. Ported from Delta Explorer's Conversation, Turn,
 * ExpansionFrame, ContextMenu, ExpandPrompt, ExpandSelectionBar and the
 * useChatStreaming / useExpansionContextMenu hooks.
 *
 * Answers render as markdown whose text nodes carry source offsets
 * (src/shared/markdown.js), so a selection maps onto an exact range of the
 * answer and becomes an expansion anchored there. */

import { openStream, rpc } from './api.js';
import { attachmentSrc, fileToImageAttachment, MAX_ATTACHMENTS_PER_MESSAGE } from './attachments.js';
import { clear, h, icon, keyLabel } from './dom.js';
import {
  buildConversationTitle,
  buildExpandRequest,
  newConversationId,
  persistableTurns,
  serializeForChat
} from '../shared/conversation.js';
import { EXPAND_INTENTS, isTermSelection, LOOKUP_DEFAULT_QUERY } from '../shared/prompts.js';
import {
  applyExpansionChunk,
  finalizeTurns,
  findExpansionInNodes,
  findExpansionInTurns,
  flattenMarkdown,
  insertExpansionInTurns,
  isSameRange,
  maxExpansionId,
  removeExpansionInTurns,
  restartExpansion,
  setExpansionFolded,
  updateExpansion,
  validateExpansionTarget
} from '../shared/rich-text.js';

const MD = globalThis.DeltaMarkdown;
const NOTICE_TIMEOUT_MS = 4000;
const SAVE_DEBOUNCE_MS = 250;
const PIN_THRESHOLD_PX = 48;
const ANSWER_PREVIEW_LENGTH = 70;

function refusalMessage(reason) {
  switch (reason) {
    case 'selection-mismatch': return 'The text changed while the menu was open. Select it again.';
    case 'overlaps-expansion':
    case 'inside-expansion': return 'That range overlaps an existing expansion.';
    case 'cross-block':
    case 'not-anchored': return 'Select text inside one paragraph, list item or heading.';
    case 'blank-selection':
    case 'empty-range': return 'Select some text to expand.';
    case 'out-of-bounds': return 'The selection is no longer available.';
    case 'parent-not-found':
    case 'turn-not-found': return 'That message is no longer on screen.';
    case 'streaming': return 'Wait for this answer to finish before expanding inside it.';
    default: return 'The selection cannot be expanded.';
  }
}

function isCodeOrMath(text) {
  return /^(```|~~~|\$|\\\(|\\\[)/.test(text.trim());
}

function answerLabel(node) {
  const question = node.prompt ? node.prompt.trim() : '';
  if (question) return question;
  return isTermSelection(node.originalText) ? 'Definition' : 'Explanation';
}

function answerDetail(node) {
  if (node.status === 'error') return node.error || 'Failed';
  if (node.answer === '') return 'Thinking…';
  return flattenMarkdown(node.answer).replace(/\s+/g, ' ').trim().slice(0, ANSWER_PREVIEW_LENGTH);
}

function hasLoadingNode(nodes) {
  return nodes.some((node) => node.status === 'loading' || hasLoadingNode(node.children));
}

/** Word under a point, for a right-click without a selection. */
function wordRangeAtPoint(x, y) {
  const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
  if (!pos || !pos.offsetNode || pos.offsetNode.nodeType !== Node.TEXT_NODE) return null;
  const text = pos.offsetNode.nodeValue || '';
  let start = pos.offset;
  let end = pos.offset;
  const word = /[\p{L}\p{N}_'’-]/u;
  while (start > 0 && word.test(text[start - 1])) start--;
  while (end < text.length && word.test(text[end])) end++;
  if (start === end) return null;
  const range = document.createRange();
  range.setStart(pos.offsetNode, start);
  range.setEnd(pos.offsetNode, end);
  return range;
}

export class ConversationView {
  /**
   * options: {
   *   host, role: 'chat' | 'lookup', allowImages, placeholder,
   *   emptyState(fill): Node | null,  // shown when there are no turns
   *   onMetaChange(meta)              // title/id changes, after saves
   * }
   */
  constructor(options) {
    this.options = options;
    this.role = options.role === 'lookup' ? 'lookup' : 'chat';
    this.meta = null;
    this.context = '';
    this.page = null;
    this.turns = [];
    this.nextTurnId = 1;
    this.nextExpansionId = 1;
    this.mainStream = null;
    this.expansionStreams = new Map();
    this.attachments = [];
    this.attaching = false;
    this.pinned = true;
    this.renderQueue = new Set();
    this.renderScheduled = false;
    this.saveTimer = null;
    this.saveTouch = false;
    this.overlay = null;
    this.selectionBar = null;
    this.barRange = null;
    this.noticeTimer = null;
    this.editingTurnId = null;
    this.turnEls = new Map();
    this.build();
    this.bindGlobalEvents();
  }

  /* ================= Structure ================= */

  build() {
    const host = this.options.host;
    clear(host);
    host.classList.add('conversation');
    this.scrollEl = h('div.conv-scroll');
    this.contextEl = h('div.conv-context-slot');
    this.emptyEl = h('div.conv-empty-slot');
    this.listEl = h('div.message-list', { on: { contextmenu: (e) => this.handleContextMenu(e) } });
    this.scrollEl.append(this.contextEl, this.emptyEl, this.listEl);
    this.scrollEl.addEventListener('scroll', () => this.updatePinned());

    this.jumpBtn = h('button.jump-latest', { type: 'button', hidden: true, on: { click: () => this.scrollToBottom(true) } }, icon('arrowDown', 14), 'Latest');
    this.noticeEl = h('p.composer-notice', { role: 'alert', hidden: true });
    this.attachmentsEl = h('div.composer-attachments', { hidden: true });
    this.fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, on: { change: (e) => { this.addFiles(Array.from(e.target.files || [])); e.target.value = ''; } } });
    this.attachBtn = h('button.composer-attach', { type: 'button', title: 'Attach images', 'aria-label': 'Attach images', on: { click: () => this.fileInput.click() } }, icon('attach', 18));
    this.input = h('textarea.composer-input', {
      rows: 1,
      placeholder: this.options.placeholder || 'Message Delta Explorer…',
      'aria-label': this.options.placeholder || 'Message Delta Explorer',
      on: {
        input: () => this.syncComposer(),
        keydown: (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            this.submitComposer();
          }
        },
        paste: (e) => {
          if (!this.options.allowImages) return;
          const images = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
          if (images.length === 0) return;
          e.preventDefault();
          this.addFiles(images);
        }
      }
    });
    this.sendBtn = h('button.composer-send', { type: 'button', 'aria-label': 'Send message', on: { click: () => this.submitComposer() } }, icon('send', 16));
    this.stopBtn = h('button.composer-send.composer-stop', { type: 'button', 'aria-label': 'Stop generating', title: 'Stop generating (Esc)', hidden: true, on: { click: () => this.stop() } }, icon('stop', 14));
    const box = h('div.composer-box', {
      on: {
        dragover: (e) => { if (this.options.allowImages) e.preventDefault(); },
        drop: (e) => {
          if (!this.options.allowImages) return;
          e.preventDefault();
          this.addFiles(Array.from(e.dataTransfer?.files || []));
        }
      }
    }, this.options.allowImages ? [this.fileInput, this.attachBtn] : null, this.input, this.sendBtn, this.stopBtn);
    const meta = this.options.compact ? null : h('div.composer-meta',
      h('p.composer-hint', { text: 'Delta Explorer can make mistakes. Check important info.' }),
      h('span.composer-keys', h('kbd.kbd', { text: 'Enter' }), ' send ', h('span.keys-sep', { text: '·' }), ' ', h('kbd.kbd', { text: 'Shift' }), h('kbd.kbd', { text: 'Enter' }), ' newline'));
    this.composerEl = h('div.composer', this.jumpBtn, this.noticeEl, this.attachmentsEl, box, meta);
    this.srStatus = h('div.sr-only', { role: 'status', 'aria-live': 'polite' });
    host.append(this.scrollEl, this.composerEl, this.srStatus);
    this.syncComposer();
  }

  bindGlobalEvents() {
    this.onDocMouseUp = (e) => {
      if (e.button !== 0 || this.isOverlay(e.target)) return;
      setTimeout(() => this.refreshSelectionBar(), 0);
    };
    this.onDocKeyUp = (e) => { if (e.key === 'Shift' || e.shiftKey) this.refreshSelectionBar(); };
    this.onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) this.closeSelectionBar();
    };
    this.onKeyDown = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        if (this.overlay) { e.preventDefault(); this.closeOverlay(); return; }
        if (this.mainStream) { e.preventDefault(); this.stop(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'e') {
        if (this.handleExpandShortcut(e.shiftKey)) e.preventDefault();
      }
    };
    this.onScrollAny = () => {
      if (!this.selectionBar || !this.barRange) return;
      this.positionBar(this.selectionBar, this.barRange);
    };
    document.addEventListener('mouseup', this.onDocMouseUp);
    document.addEventListener('keyup', this.onDocKeyUp);
    document.addEventListener('selectionchange', this.onSelectionChange);
    document.addEventListener('scroll', this.onScrollAny, true);
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy() {
    this.stopAll();
    document.removeEventListener('mouseup', this.onDocMouseUp);
    document.removeEventListener('keyup', this.onDocKeyUp);
    document.removeEventListener('selectionchange', this.onSelectionChange);
    document.removeEventListener('scroll', this.onScrollAny, true);
    window.removeEventListener('keydown', this.onKeyDown);
    this.closeOverlay();
    this.closeSelectionBar();
  }

  /* ================= Loading ================= */

  /** Shows a stored record, or a fresh conversation when `record` is null. */
  load(record, { context = '', page = null } = {}) {
    this.stopAll();
    this.flushSave();
    this.editingTurnId = null;
    if (record) {
      this.meta = {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        kbFed: record.kbFed,
        source: record.source
      };
      this.context = record.source === 'lookup' ? record.lookup.context : '';
      this.page = record.source === 'lookup' ? record.lookup.page : null;
      this.turns = finalizeTurns(record.state.turns);
    } else {
      this.meta = null;
      this.context = context;
      this.page = page;
      this.turns = [];
    }
    this.nextTurnId = this.turns.reduce((max, turn) => Math.max(max, turn.id), 0) + 1;
    this.nextExpansionId = maxExpansionId(this.turns) + 1;
    this.setNotice(null);
    this.renderAll();
    this.scrollToBottom(true);
  }

  /** Page text for a look-up that has not been sent yet. */
  setContext(context, page) {
    if (this.turns.length > 0) return;
    this.context = context || '';
    this.page = page || null;
    this.renderContext();
  }

  get conversationId() { return this.meta ? this.meta.id : null; }
  get loading() { return !!this.mainStream; }
  get title() { return this.meta ? this.meta.title : ''; }

  focusComposer() { this.input.focus(); }

  fillComposer(text) {
    this.input.value = text;
    this.syncComposer();
    this.input.focus();
  }

  /* ================= Rendering ================= */

  renderAll() {
    this.renderContext();
    clear(this.listEl);
    this.turnEls = new Map();
    for (const turn of this.visibleTurns()) {
      const el = this.renderTurn(turn);
      this.turnEls.set(turn.id, el);
      this.listEl.appendChild(el);
    }
    this.renderEmpty();
    this.syncComposer();
  }

  visibleTurns() {
    return this.turns.filter((t) => t.content !== '' || (t.role === 'assistant' && this.loading) || (t.attachments && t.attachments.length));
  }

  renderContext() {
    clear(this.contextEl);
    if (!this.context) return;
    const label = this.page && (this.page.title || this.page.url) ? `Page context · ${this.page.title || this.page.url}` : 'Page context';
    const details = h('details.conv-context',
      h('summary', { text: label }),
      h('p', { text: this.context }),
      this.page && this.page.url ? h('a.conv-context-link', { href: this.page.url, target: '_blank', rel: 'noopener noreferrer', text: this.page.url }) : null);
    if (this.turns.length === 0 && this.options.onClearContext) {
      details.appendChild(h('button.btn.btn--sm', { type: 'button', text: 'Remove context', on: { click: () => { this.context = ''; this.page = null; this.renderContext(); this.options.onClearContext(); } } }));
    }
    this.contextEl.appendChild(details);
  }

  renderEmpty() {
    clear(this.emptyEl);
    if (this.turns.length > 0 || !this.options.emptyState) return;
    const node = this.options.emptyState((text) => this.fillComposer(text));
    if (node) this.emptyEl.appendChild(node);
  }

  scheduleTurnRender(turnId) {
    this.renderQueue.add(turnId);
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      const ids = [...this.renderQueue];
      this.renderQueue.clear();
      for (const id of ids) this.rerenderTurn(id);
      this.afterContentChange();
    });
  }

  rerenderTurn(turnId) {
    const turn = this.turns.find((t) => t.id === turnId);
    const old = this.turnEls.get(turnId);
    if (!turn) {
      if (old) old.remove();
      this.turnEls.delete(turnId);
      return;
    }
    if (!old) {
      this.renderAll();
      return;
    }
    // Keep a selection the user is making in another turn: replacing this turn only.
    const el = this.renderTurn(turn);
    old.replaceWith(el);
    this.turnEls.set(turnId, el);
  }

  afterContentChange() {
    if (this.pinned) this.scrollToBottom(false);
    this.updatePinned();
  }

  renderTurn(turn) {
    const isUser = turn.role === 'user';
    const streamingPlaceholder = !isUser && turn.content === '' && this.loading && turn.id === this.lastTurnId();
    const body = h('div.message-body');

    if (turn.attachments && turn.attachments.length) {
      body.appendChild(h('div.message-attachments', turn.attachments.map((a) =>
        h('img.message-attachment', { src: attachmentSrc(a), alt: a.name, title: a.name }))));
    }

    if (isUser && this.editingTurnId === turn.id) {
      body.appendChild(this.renderEditor(turn));
    } else if (streamingPlaceholder) {
      body.appendChild(h('div.message-content', h('span.typing', h('span'), h('span'), h('span'))));
    } else if (isUser) {
      body.appendChild(h('div.message-content.message-content--user', { text: turn.content }));
    } else {
      const content = h('div.message-content' + (turn.error ? '.message-error' : ''));
      if (turn.error) {
        content.textContent = turn.content;
      } else {
        content.appendChild(MD.render(turn.content, turn.expansions || [], {
          inline: false,
          renderExpansion: (node, group) => this.renderFrame(node, group)
        }));
      }
      body.appendChild(content);
    }

    if (!streamingPlaceholder && this.editingTurnId !== turn.id) {
      body.appendChild(this.renderTurnActions(turn));
    }

    return h(`div.message.message-${isUser ? 'user' : 'assistant'}`, { dataset: { turnId: String(turn.id) } },
      h('div.message-avatar', { 'aria-hidden': 'true' }, icon(isUser ? 'user' : 'delta', 16)),
      body);
  }

  renderTurnActions(turn) {
    const actions = h('div.message-actions');
    const copyBtn = h('button.message-action', { type: 'button', title: 'Copy', 'aria-label': 'Copy message' }, icon('copy', 14));
    copyBtn.addEventListener('click', () => {
      MD.copyToClipboard(turn.content).then(() => this.flash(copyBtn, 'Copied'));
    });
    actions.appendChild(copyBtn);
    if (turn.role === 'user') {
      actions.appendChild(h('button.message-action', {
        type: 'button', title: 'Edit and resend', 'aria-label': 'Edit message', disabled: this.loading,
        on: { click: () => { this.editingTurnId = turn.id; this.rerenderTurn(turn.id); } }
      }, icon('edit', 14)));
    } else {
      actions.appendChild(h('button.message-action', {
        type: 'button', title: turn.error ? 'Retry' : 'Regenerate', 'aria-label': turn.error ? 'Retry' : 'Regenerate answer', disabled: this.loading,
        on: { click: () => this.confirmRegenerate(turn.id) }
      }, icon('refresh', 14)));
    }
    return actions;
  }

  renderEditor(turn) {
    const area = h('textarea.message-editor', { rows: 2 });
    area.value = turn.content;
    const resize = () => { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 240)}px`; };
    const cancel = () => { this.editingTurnId = null; this.rerenderTurn(turn.id); };
    const submit = () => {
      const text = area.value.trim();
      if ((!text && !(turn.attachments && turn.attachments.length)) || this.loading) return;
      if (this.editMessage(turn.id, text)) this.editingTurnId = null;
    };
    area.addEventListener('input', resize);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    setTimeout(() => { area.focus(); resize(); }, 0);
    return h('div.message-edit', area, h('div.message-edit-actions',
      h('button.btn.btn--sm', { type: 'button', text: 'Cancel', on: { click: cancel } }),
      h('button.btn.btn--sm.btn--primary', { type: 'button', text: 'Send', on: { click: submit } })));
  }

  /* ---- Expansion frames ---- */

  renderOriginal(text) {
    if (MD.isPlainMarkdown(text)) return document.createTextNode(text);
    return MD.render(text, [], { inline: true, anchored: false });
  }

  renderFrame(node, group) {
    const count = group ? group.length : 1;
    const question = node.prompt ? node.prompt.trim() : '';
    if (node.folded) {
      const open = (el) => {
        if (count > 1) this.pickAnswer(node.id, this.pointBelow(el));
        else this.unfold(node.id);
      };
      const pill = h('span.queried', {
        dataset: { expansionId: String(node.id) }, role: 'button', tabindex: '0', 'aria-expanded': 'false',
        title: question || (count > 1 ? 'Click to choose an answer' : 'Click to expand again'),
        on: {
          click: (e) => { e.stopPropagation(); open(e.currentTarget); },
          keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e.currentTarget); } }
        }
      }, this.renderOriginal(node.originalText), count > 1 ? h('span.queried-count', { text: String(count) }) : null);
      return pill;
    }

    const pending = node.status === 'loading' && node.answer === '';
    const finished = node.status !== 'loading';
    const showSource = isCodeOrMath(node.originalText);
    const frame = h('span.frame.expanded' + (node.status === 'loading' ? '.loading' : '') + (node.status === 'error' ? '.error' : ''), { dataset: { expansionId: String(node.id) } });
    const inner = h('span.frame-inner');
    if (showSource) inner.appendChild(h('span.frame-source', this.renderOriginal(node.originalText)));
    if (question) inner.appendChild(h('span.frame-question', { text: question }));
    if (node.attachments && node.attachments.length) {
      inner.appendChild(h('span.frame-attachments', node.attachments.map((a) => h('img', { src: attachmentSrc(a), alt: a.name, title: a.name }))));
    }
    if (pending) {
      inner.appendChild(h('span.frame-placeholder', { text: 'Thinking…' }));
    } else {
      inner.appendChild(MD.render(node.answer, node.children, {
        inline: true,
        renderExpansion: (child, childGroup) => this.renderFrame(child, childGroup)
      }));
    }
    if (node.status === 'error') {
      if (!showSource) inner.appendChild(h('span.frame-term', { title: flattenMarkdown(node.originalText) }, this.renderOriginal(node.originalText)));
      if (node.error) inner.appendChild(h('span.frame-error', { text: node.error }));
    }

    const actions = h('span.frame-actions');
    const button = (label, title, onClick) => h('button.frame-action', {
      type: 'button', title: title || label, text: label,
      on: { click: (e) => { e.stopPropagation(); onClick(e.currentTarget); }, mousedown: (e) => e.preventDefault() }
    });
    actions.appendChild(h('span.fold-toggle', {
      role: 'button', tabindex: '0', title: 'Fold', 'aria-label': 'Fold expansion', 'aria-expanded': 'true', text: '▾',
      on: {
        click: (e) => { e.stopPropagation(); this.fold(node.id); },
        keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.fold(node.id); } }
      }
    }));
    if (!finished) actions.appendChild(button('Stop', 'Stop this answer', () => this.stopExpansion(node.id)));
    if (finished) actions.appendChild(button(node.status === 'error' ? 'Retry' : 'Regenerate', null, () => this.retryExpansion(node.id)));
    if (finished) actions.appendChild(button('Edit', 'Change the question and get a new answer', (el) => this.editExpansion(node.id, this.pointBelow(el))));
    if (finished) actions.appendChild(button('Ask…', 'Ask something else about this; this answer stays available', (el) => this.askAnother(node.id, this.pointBelow(el))));
    if (node.answer !== '') {
      actions.appendChild(button('Copy', null, (el) => MD.copyToClipboard(node.answer).then(() => this.flash(el, 'Copied'))));
    }
    actions.appendChild(button('Remove', null, () => this.removeExpansion(node.id)));
    if (count > 1) actions.appendChild(button(`${count} answers`, null, (el) => this.pickAnswer(node.id, this.pointBelow(el))));
    inner.appendChild(actions);
    frame.appendChild(inner);
    return frame;
  }

  flash(button, label) {
    const original = button.textContent;
    if (button.childElementCount > 0) {
      button.classList.add('is-done');
      setTimeout(() => button.classList.remove('is-done'), 1500);
      return;
    }
    button.textContent = label;
    setTimeout(() => { button.textContent = original; }, 1500);
  }

  pointBelow(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 4 };
  }

  /* ================= Scrolling ================= */

  updatePinned() {
    const el = this.scrollEl;
    this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    this.jumpBtn.hidden = this.pinned || this.visibleTurns().length === 0;
  }

  scrollToBottom(force) {
    if (force) this.pinned = true;
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    this.jumpBtn.hidden = true;
  }

  /* ================= Composer ================= */

  syncComposer() {
    const el = this.input;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    const loading = this.loading;
    this.sendBtn.hidden = loading;
    this.stopBtn.hidden = !loading;
    const empty = el.value.trim() === '' && this.attachments.length === 0;
    this.sendBtn.disabled = this.attaching || (empty && !(this.role === 'lookup' && this.context && this.turns.length === 0));
    if (this.attachBtn) this.attachBtn.disabled = this.attaching || this.attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE;
    this.renderAttachments();
  }

  renderAttachments() {
    if (!this.attachmentsEl) return;
    clear(this.attachmentsEl);
    this.attachmentsEl.hidden = this.attachments.length === 0;
    this.attachments.forEach((attachment, index) => {
      this.attachmentsEl.appendChild(h('div.composer-attachment',
        h('img', { src: attachmentSrc(attachment), alt: attachment.name, title: attachment.name }),
        h('button.composer-attachment-remove', {
          type: 'button', 'aria-label': `Remove ${attachment.name}`, text: '×',
          on: { click: () => { this.attachments.splice(index, 1); this.syncComposer(); } }
        })));
    });
  }

  async addFiles(files) {
    const room = MAX_ATTACHMENTS_PER_MESSAGE - this.attachments.length;
    if (room <= 0) { this.setNotice(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`); return; }
    const picked = files.slice(0, room);
    this.attaching = true;
    this.syncComposer();
    try {
      for (const file of picked) {
        try {
          this.attachments.push(await fileToImageAttachment(file));
        } catch (err) {
          this.setNotice(err.message || String(err));
        }
      }
      if (files.length > room) this.setNotice(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`);
    } finally {
      this.attaching = false;
      this.syncComposer();
    }
  }

  setNotice(message) {
    clearTimeout(this.noticeTimer);
    this.noticeEl.hidden = !message;
    this.noticeEl.textContent = message || '';
    if (message) this.noticeTimer = setTimeout(() => this.setNotice(null), 6000);
  }

  async submitComposer() {
    if (this.loading || this.attaching) return;
    let text = this.input.value.trim();
    const attachments = this.attachments.slice();
    if (!text && attachments.length === 0) {
      if (this.role === 'lookup' && this.context && this.turns.length === 0) text = LOOKUP_DEFAULT_QUERY;
      else return;
    }
    if (attachments.length) {
      const support = await rpc('imageSupport', { role: this.role }).catch(() => 'unknown');
      if (support === 'no') {
        this.setNotice('The assigned model cannot read images. Remove them or assign a vision model in Settings.');
        return;
      }
    }
    this.input.value = '';
    this.attachments = [];
    this.syncComposer();
    this.send(text, attachments);
  }

  /* ================= Chat ================= */

  lastTurnId() {
    return this.turns.length ? this.turns[this.turns.length - 1].id : null;
  }

  ensureMeta(firstText) {
    if (this.meta) return;
    const now = new Date().toISOString();
    this.meta = {
      id: newConversationId(),
      title: buildConversationTitle(firstText || 'New conversation'),
      createdAt: now,
      updatedAt: now,
      kbFed: false,
      source: this.role === 'lookup' ? 'lookup' : 'chat'
    };
    this.options.onMetaChange?.(this.meta);
  }

  send(text, attachments = []) {
    if (this.loading) return;
    this.ensureMeta(text);
    const userTurn = { id: this.nextTurnId++, role: 'user', content: text, expansions: [], ...(attachments.length ? { attachments } : {}) };
    this.turns = [...this.turns, userTurn];
    this.startAnswer();
  }

  /** Appends an assistant placeholder after the current last turn and streams into it. */
  startAnswer() {
    const assistant = { id: this.nextTurnId++, role: 'assistant', content: '', expansions: [] };
    const history = this.turns;
    this.turns = [...history, assistant];
    const messages = serializeForChat({ turns: history, context: this.context, page: this.page }, this.role);
    this.pinned = true;
    this.srStatus.textContent = 'Delta Explorer is responding';
    const stream = openStream({ kind: 'chat', role: this.role, messages }, {
      onDelta: (delta) => {
        this.patchTurn(assistant.id, (turn) => ({ ...turn, content: turn.content + delta }));
        this.scheduleTurnRender(assistant.id);
      },
      onDone: (text) => {
        this.mainStream = null;
        this.patchTurn(assistant.id, (turn) => ({ ...turn, content: text || turn.content }));
        this.finishAnswer(assistant.id);
      },
      onError: (message, partial, cancelled) => {
        this.mainStream = null;
        this.patchTurn(assistant.id, (turn) => {
          const kept = partial || turn.content;
          if (cancelled) return { ...turn, content: kept };
          if (kept.trim()) return { ...turn, content: kept };
          return { ...turn, content: message, error: true };
        });
        if (!cancelled && (partial || '').trim()) this.setNotice(message);
        // A stopped answer with no text leaves nothing to keep.
        this.turns = this.turns.filter((t) => !(t.id === assistant.id && t.content === ''));
        this.finishAnswer(assistant.id);
      }
    });
    this.mainStream = stream;
    this.renderAll();
    this.scrollToBottom(true);
    this.save(true);
  }

  finishAnswer(turnId) {
    this.srStatus.textContent = '';
    this.renderAll();
    this.afterContentChange();
    this.save(true);
    this.options.onAnswerDone?.(turnId);
  }

  patchTurn(id, fn) {
    this.turns = this.turns.map((turn) => (turn.id === id ? fn(turn) : turn));
  }

  stop() {
    if (this.mainStream) this.mainStream.stop();
  }

  stopAll() {
    this.stop();
    for (const stream of this.expansionStreams.values()) stream.stop();
    this.expansionStreams.clear();
  }

  confirmRegenerate(turnId) {
    if (this.loading) return;
    const index = this.turns.findIndex((t) => t.id === turnId);
    if (index < 0) return;
    if (index !== this.turns.length - 1) {
      const removed = this.turns.length - index;
      if (!window.confirm(`Regenerate this answer? ${removed} later message${removed === 1 ? '' : 's'} will be removed.`)) return;
    }
    this.regenerate(turnId);
  }

  regenerate(turnId) {
    const index = this.turns.findIndex((t) => t.id === turnId);
    if (index < 0 || this.loading) return;
    this.stopExpansionsFrom(index);
    this.turns = this.turns.slice(0, index);
    this.startAnswer();
  }

  editMessage(turnId, content) {
    if (this.loading) return false;
    const index = this.turns.findIndex((t) => t.id === turnId);
    if (index < 0) return false;
    const removed = this.turns.length - index - 1;
    if (removed > 1 && !window.confirm(`Resend this message? ${removed} later messages will be removed.`)) return false;
    this.stopExpansionsFrom(index);
    const edited = { ...this.turns[index], content, expansions: [] };
    this.turns = [...this.turns.slice(0, index), edited];
    this.startAnswer();
    return true;
  }

  stopExpansionsFrom(index) {
    const dropped = new Set(this.turns.slice(index).map((t) => t.id));
    for (const [id, stream] of this.expansionStreams) {
      const location = findExpansionInTurns(this.turns, id);
      if (location && dropped.has(location.turn.id)) {
        stream.stop();
        this.expansionStreams.delete(id);
      }
    }
  }

  /* ================= Saving ================= */

  save(touchContent) {
    this.saveTouch = this.saveTouch || touchContent;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const meta = this.meta;
    if (!meta) return;
    const touch = this.saveTouch;
    this.saveTouch = false;
    const turns = finalizeTurns(persistableTurns(this.turns));
    if (turns.length === 0 || turns.every((t) => t.content.trim() === '' && !(t.attachments && t.attachments.length))) return;
    if (touch) meta.updatedAt = new Date().toISOString();
    const record = {
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      kbFed: false,
      source: meta.source,
      state: { turns },
      ...(meta.source === 'lookup' ? { lookup: { context: this.context || '', page: this.page || { title: '', url: '' } } } : {})
    };
    // kbFed is decided by the store: a save that leaves updatedAt alone keeps it.
    rpc('saveConversation', { record })
      .then(() => this.options.onMetaChange?.(meta))
      .catch((err) => this.setNotice(`This conversation could not be saved: ${err.message || err}`));
  }

  async rename(title) {
    if (!this.meta) return;
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!clean || clean === this.meta.title) return;
    this.meta.title = clean;
    this.flushSave();
    await rpc('renameConversation', { id: this.meta.id, title: clean });
    this.options.onMetaChange?.(this.meta);
  }

  /** The record as it stands, for export. */
  snapshot() {
    if (!this.meta) return null;
    return {
      ...this.meta,
      state: { turns: finalizeTurns(persistableTurns(this.turns)) },
      ...(this.meta.source === 'lookup' ? { lookup: { context: this.context, page: this.page || { title: '', url: '' } } } : {})
    };
  }

  /* ================= Expansions ================= */

  sourceFor(turn, frameId) {
    if (frameId === null) return { source: turn.content, siblings: turn.expansions };
    const parent = findExpansionInNodes(turn.expansions, frameId);
    if (!parent) return null;
    return { source: parent.node.answer, siblings: parent.node.children, parentExpansionId: parent.node.id, parent: parent.node };
  }

  resolveTarget(turn, anchors) {
    if (this.loading && turn.id === this.lastTurnId()) return { ok: false, reason: 'streaming' };
    const scope = this.sourceFor(turn, anchors.frameId);
    if (!scope) return { ok: false, reason: 'parent-not-found' };
    if (scope.parent && scope.parent.status === 'loading') return { ok: false, reason: 'streaming' };
    const anchored = MD.anchoredRange(scope.source, { start: anchors.start, end: anchors.end });
    if (!anchored) return { ok: false, reason: 'not-anchored' };
    const target = {
      start: anchored.start,
      end: anchored.end,
      selection: scope.source.slice(anchored.start, anchored.end),
      ...(anchored.kind === 'atom' ? { atomic: true } : {}),
      ...(scope.parentExpansionId !== undefined ? { parentExpansionId: scope.parentExpansionId } : {})
    };
    const refusal = validateExpansionTarget(scope.source, scope.siblings, target);
    if (refusal) return { ok: false, reason: refusal };
    return { ok: true, target };
  }

  /** A selection inside this view's answers, with what it would expand. */
  readSelection(range) {
    if (!range) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      if (sel.toString().trim() === '') return null;
      range = sel.getRangeAt(0);
    }
    const container = range.commonAncestorContainer;
    const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (!element || !this.listEl.contains(element)) return null;
    const turnEl = element.closest('[data-turn-id]');
    if (!turnEl) return null;
    const turnId = Number(turnEl.dataset.turnId);
    const turn = this.turns.find((t) => t.id === turnId);
    if (!turn) return null;
    if (turn.role !== 'assistant' || turn.error) return { turnId, range, turn, resolved: { ok: false, reason: 'not-anchored' }, isUser: turn.role === 'user' };
    const anchors = MD.anchorsFromRange(range);
    const resolved = anchors ? this.resolveTarget(turn, anchors) : { ok: false, reason: 'not-anchored' };
    return { turnId, range, turn, resolved };
  }

  expand(turnId, target, prompt, attachments) {
    const id = this.nextExpansionId++;
    const result = insertExpansionInTurns(this.turns, turnId, target, id, prompt, attachments);
    if (!result.ok) {
      this.showNotice(refusalMessage(result.reason));
      return;
    }
    this.turns = result.turns;
    this.startExpansion(id);
    this.scheduleTurnRender(turnId);
    this.save(true);
  }

  startExpansion(id) {
    const location = findExpansionInTurns(this.turns, id);
    if (!location) return;
    const { node, parent, turn } = location;
    const messages = buildExpandRequest(
      { turns: this.turns, context: this.context, page: this.page },
      turn,
      parent ? parent.id : undefined,
      { start: node.start, end: node.end },
      this.role,
      node.prompt,
      node.attachments
    );
    if (!messages) {
      this.turns = applyExpansionChunk(this.turns, id, { error: 'The selection is no longer available.' });
      this.scheduleTurnRender(turn.id);
      return;
    }
    const turnIdOf = () => findExpansionInTurns(this.turns, id)?.turn.id;
    const stream = openStream({ kind: 'chat', role: this.role, messages }, {
      onDelta: (delta) => {
        this.turns = applyExpansionChunk(this.turns, id, { delta });
        const tid = turnIdOf();
        if (tid !== undefined) this.scheduleTurnRender(tid);
      },
      onDone: (text) => {
        this.expansionStreams.delete(id);
        this.turns = applyExpansionChunk(this.turns, id, { text, done: true });
        const tid = turnIdOf();
        if (tid !== undefined) this.scheduleTurnRender(tid);
        this.save(true);
      },
      onError: (message, partial, cancelled) => {
        this.expansionStreams.delete(id);
        const current = findExpansionInTurns(this.turns, id);
        const kept = partial || current?.node.answer || '';
        this.turns = cancelled && kept.trim()
          ? applyExpansionChunk(this.turns, id, { text: kept, done: true })
          : applyExpansionChunk(this.turns, id, { error: message, text: kept });
        const tid = turnIdOf();
        if (tid !== undefined) this.scheduleTurnRender(tid);
        this.save(true);
      }
    });
    this.expansionStreams.set(id, stream);
  }

  stopExpansion(id) {
    const stream = this.expansionStreams.get(id);
    if (stream) stream.stop();
  }

  confirmDroppingNested(id, action) {
    const nested = findExpansionInTurns(this.turns, id)?.node.children.length || 0;
    if (nested === 0) return true;
    return window.confirm(`${action}? The expansions inside this answer will be removed.`);
  }

  stopNested(node) {
    for (const child of node.children) {
      this.stopExpansion(child.id);
      this.stopNested(child);
    }
  }

  retryExpansion(id) {
    const location = findExpansionInTurns(this.turns, id);
    if (!location || !this.confirmDroppingNested(id, 'Regenerate this answer')) return;
    this.stopNested(location.node);
    this.turns = restartExpansion(this.turns, id);
    this.startExpansion(id);
    this.scheduleTurnRender(location.turn.id);
  }

  editExpansion(id, at) {
    const node = findExpansionInTurns(this.turns, id)?.node;
    if (!node) return;
    this.openPrompt(at, {
      initialPrompt: node.prompt || '',
      onSubmit: (prompt) => {
        const location = findExpansionInTurns(this.turns, id);
        if (!location || !this.confirmDroppingNested(id, 'Replace this answer')) return;
        this.stopNested(location.node);
        const question = prompt.trim();
        this.turns = restartExpansion(updateExpansion(this.turns, id, { prompt: question === '' ? undefined : question }), id);
        this.startExpansion(id);
        this.scheduleTurnRender(location.turn.id);
      }
    });
  }

  removeExpansion(id) {
    const location = findExpansionInTurns(this.turns, id);
    if (!location || !this.confirmDroppingNested(id, 'Remove this answer')) return;
    this.stopExpansion(id);
    this.stopNested(location.node);
    this.turns = removeExpansionInTurns(this.turns, id);
    this.scheduleTurnRender(location.turn.id);
    this.save(false);
  }

  fold(id) {
    const location = findExpansionInTurns(this.turns, id);
    if (!location) return;
    this.turns = setExpansionFolded(this.turns, id, true);
    this.scheduleTurnRender(location.turn.id);
    this.save(false);
  }

  unfold(id) {
    const location = findExpansionInTurns(this.turns, id);
    if (!location) return;
    this.turns = setExpansionFolded(this.turns, id, false);
    this.scheduleTurnRender(location.turn.id);
    this.save(false);
  }

  /** A pending request on an existing expansion's range, to ask about it again. */
  targetOfExpansion(id) {
    const location = findExpansionInTurns(this.turns, id);
    if (!location) return null;
    const { node, parent, turn } = location;
    const source = parent ? parent.answer : turn.content;
    const anchored = MD.anchoredRange(source, node);
    return {
      turnId: turn.id,
      target: {
        start: node.start,
        end: node.end,
        selection: node.originalText,
        ...(anchored && anchored.kind === 'atom' ? { atomic: true } : {}),
        ...(parent ? { parentExpansionId: parent.id } : {})
      }
    };
  }

  askAnother(id, at) {
    const pending = this.targetOfExpansion(id);
    if (!pending) return;
    this.openPrompt(at, { onSubmit: (prompt, attachments) => this.expand(pending.turnId, pending.target, prompt, attachments) });
  }

  pickAnswer(id, at) {
    const location = findExpansionInTurns(this.turns, id);
    if (!location) return;
    const items = location.siblings
      .filter((node) => isSameRange(node, location.node))
      .map((node) => ({ label: answerLabel(node), detail: answerDetail(node), onSelect: () => this.unfold(node.id) }));
    items.push({ label: 'Ask another…', onSelect: () => this.askAnother(id, at) });
    this.openMenu(at, items, 'Choose an answer');
  }

  /* ================= Menus, prompt, selection bar ================= */

  isOverlay(target) {
    return target instanceof Element && !!target.closest('.expand-selection-bar, .expand-prompt, .ctx-menu');
  }

  closeOverlay() {
    if (!this.overlay) return;
    const { el, cleanup } = this.overlay;
    this.overlay = null;
    cleanup();
    el.remove();
  }

  placePopup(el, at) {
    document.body.appendChild(el);
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - rect.height - 8))}px`;
  }

  showOverlay(el, at, focusEl) {
    this.closeOverlay();
    this.closeSelectionBar();
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    this.placePopup(el, at);
    const previous = document.activeElement;
    const onDown = (e) => { if (!el.contains(e.target)) this.closeOverlay(); };
    document.addEventListener('mousedown', onDown, true);
    this.overlay = {
      el,
      cleanup: () => {
        document.removeEventListener('mousedown', onDown, true);
        if (previous && previous.focus && document.contains(previous)) previous.focus();
      }
    };
    if (focusEl) setTimeout(() => focusEl.focus(), 0);
  }

  /** items: [{ label, detail?, disabled?, shortcut?, onSelect } | 'separator' | { hint }] */
  openMenu(at, items, label = 'Text actions') {
    const menu = h('div.ctx-menu', { role: 'menu', 'aria-label': label });
    const buttons = [];
    for (const item of items) {
      if (item === 'separator') { menu.appendChild(h('div.sep', { role: 'separator' })); continue; }
      if (item.hint) { menu.appendChild(h('div.hint', { role: 'presentation', text: item.hint })); continue; }
      const btn = h('button.item' + (item.detail ? '.item--stacked' : ''), {
        type: 'button', role: 'menuitem', disabled: !!item.disabled,
        on: { click: () => { this.closeOverlay(); item.onSelect(); } }
      }, h('span', { text: item.label }), item.detail ? h('span.item-detail', { text: item.detail }) : null,
      item.shortcut ? h('kbd.item-key', { text: item.shortcut }) : null);
      buttons.push(btn);
      menu.appendChild(btn);
    }
    menu.addEventListener('keydown', (e) => {
      const enabled = buttons.filter((b) => !b.disabled);
      const index = enabled.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = index < 0 ? 0 : (index + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
        enabled[next]?.focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        this.closeOverlay();
      }
    });
    this.showOverlay(menu, at, buttons.find((b) => !b.disabled));
  }

  /** opts: { initialPrompt?, onSubmit(prompt, attachments) } */
  openPrompt(at, opts) {
    const editing = typeof opts.initialPrompt === 'string';
    const input = h('input.expand-prompt-input', {
      type: 'text', autocomplete: 'off',
      placeholder: editing ? 'Blank for a plain explanation' : 'Expand on…',
      'aria-label': editing ? 'Edit question' : 'Expand on'
    });
    if (editing) input.value = opts.initialPrompt;
    const submit = (value) => {
      this.closeOverlay();
      opts.onSubmit(String(value || ''), []);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeOverlay(); }
    });
    const panel = h('div.expand-prompt', { role: 'dialog' }, input,
      editing ? null : h('div.expand-intents', EXPAND_INTENTS.map((intent) => h('button.expand-intent', {
        type: 'button', title: intent.prompt, text: intent.label,
        on: { click: () => submit(intent.prompt) }
      }))));
    this.showOverlay(panel, at, input);
    if (editing) setTimeout(() => input.select(), 0);
  }

  showNotice(message) {
    let el = this.options.host.querySelector('.expand-notice');
    if (!el) {
      el = h('div.expand-notice', { role: 'status', on: { click: () => el.remove() } });
      this.options.host.appendChild(el);
    }
    el.textContent = message;
    clearTimeout(this.expandNoticeTimer);
    this.expandNoticeTimer = setTimeout(() => el.remove(), NOTICE_TIMEOUT_MS);
  }

  closeSelectionBar() {
    if (this.selectionBar) this.selectionBar.remove();
    this.selectionBar = null;
    this.barRange = null;
  }

  positionBar(bar, range) {
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { this.closeSelectionBar(); return; }
    const barRect = bar.getBoundingClientRect();
    const above = rect.top - barRect.height - 6;
    bar.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - barRect.width / 2, window.innerWidth - barRect.width - 8))}px`;
    bar.style.top = `${above >= 8 ? above : rect.bottom + 6}px`;
  }

  refreshSelectionBar() {
    if (this.overlay) return;
    const live = this.readSelection();
    if (!live || !live.resolved.ok) { this.closeSelectionBar(); return; }
    this.closeSelectionBar();
    const { turnId, range } = live;
    const target = live.resolved.target;
    const run = (prompt) => {
      window.getSelection()?.removeAllRanges();
      this.closeSelectionBar();
      this.expand(turnId, target, prompt);
    };
    const bar = h('div.expand-selection-bar', { role: 'toolbar', 'aria-label': 'Expand selection', on: { mousedown: (e) => e.preventDefault() } },
      h('button.expand-intent.expand-intent--primary', { type: 'button', text: 'Expand', title: `Define or explain (${keyLabel('Ctrl+E')})`, on: { click: () => run(undefined) } }),
      EXPAND_INTENTS.map((intent) => h('button.expand-intent', { type: 'button', text: intent.label, title: intent.prompt, on: { click: () => run(intent.prompt) } })),
      h('button.expand-intent', {
        type: 'button', text: 'Ask…', title: 'Ask your own question',
        on: {
          click: () => {
            const rect = range.getBoundingClientRect();
            this.openPrompt({ x: rect.left, y: rect.bottom + 6 }, { onSubmit: (prompt, attachments) => { window.getSelection()?.removeAllRanges(); this.expand(turnId, target, prompt, attachments); } });
          }
        }
      }));
    bar.style.visibility = 'hidden';
    document.body.appendChild(bar);
    this.selectionBar = bar;
    this.barRange = range;
    this.positionBar(bar, range);
    bar.style.visibility = '';
  }

  /** Ctrl+E expands the selection; with Shift it asks first. Returns whether it acted. */
  handleExpandShortcut(prompted) {
    const live = this.readSelection();
    if (!live) return false;
    if (!live.resolved.ok) {
      this.showNotice(refusalMessage(live.resolved.reason));
      return true;
    }
    const { turnId } = live;
    const target = live.resolved.target;
    if (prompted) {
      const rect = live.range.getBoundingClientRect();
      this.openPrompt({ x: rect.left, y: rect.bottom + 6 }, { onSubmit: (prompt, attachments) => this.expand(turnId, target, prompt, attachments) });
    } else {
      window.getSelection()?.removeAllRanges();
      this.closeSelectionBar();
      this.expand(turnId, target);
    }
    return true;
  }

  handleContextMenu(e) {
    const turnEl = e.target.closest?.('[data-turn-id]');
    if (!turnEl) return;
    e.preventDefault();
    this.closeSelectionBar();
    const turnId = Number(turnEl.dataset.turnId);
    const turn = this.turns.find((t) => t.id === turnId);
    if (!turn) return;
    const at = { x: e.clientX, y: e.clientY };
    const selection = window.getSelection();
    let selectedText = selection ? selection.toString() : '';
    if (selectedText.trim() && selection.rangeCount > 0 && !selection.getRangeAt(0).intersectsNode(e.target)) {
      selection.removeAllRanges();
      selectedText = '';
    }
    const selectAll = () => {
      const content = turnEl.querySelector('.message-content');
      if (!content) return;
      const range = document.createRange();
      range.selectNodeContents(content);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    };
    const plainMenu = (copied) => this.openMenu(at, [
      { label: 'Expand', disabled: true, onSelect() {} },
      { label: 'Expand on…', disabled: true, onSelect() {} },
      'separator',
      { label: 'Copy', disabled: !copied, onSelect: () => MD.copyToClipboard(copied) },
      { label: 'Select All', onSelect: selectAll }
    ]);
    const expandMenu = (pendingTurnId, resolved, copied) => {
      const target = resolved.ok ? resolved.target : null;
      this.openMenu(at, [
        { label: 'Expand', shortcut: keyLabel('Ctrl+E'), disabled: !target, onSelect: () => { window.getSelection()?.removeAllRanges(); this.expand(pendingTurnId, target); } },
        { label: 'Expand on…', disabled: !target, onSelect: () => this.openPrompt(at, { onSubmit: (prompt, attachments) => this.expand(pendingTurnId, target, prompt, attachments) }) },
        resolved.ok ? null : { hint: refusalMessage(resolved.reason) },
        'separator',
        { label: 'Copy', disabled: !copied, onSelect: () => MD.copyToClipboard(copied) },
        { label: 'Select All', onSelect: selectAll }
      ].filter(Boolean));
    };

    if (turn.role === 'user' || turn.error) { plainMenu(selectedText); return; }

    const pill = e.target.closest?.('.queried[data-expansion-id]');
    if (pill) {
      const pending = this.targetOfExpansion(Number(pill.dataset.expansionId));
      if (pending) {
        expandMenu(pending.turnId, { ok: true, target: pending.target }, flattenMarkdown(pending.target.selection));
        return;
      }
    }

    if (selectedText.trim() && selection.rangeCount > 0) {
      const live = this.readSelection(selection.getRangeAt(0));
      if (live) { expandMenu(turnId, live.resolved, selectedText); return; }
    }

    const word = wordRangeAtPoint(e.clientX, e.clientY);
    if (word && turnEl.contains(word.startContainer)) {
      const live = this.readSelection(word);
      if (live) {
        selection.removeAllRanges();
        selection.addRange(word);
        expandMenu(turnId, live.resolved, word.toString());
        return;
      }
    }

    const atom = e.target.closest?.('[data-atom-start]');
    if (atom) {
      const range = document.createRange();
      range.selectNodeContents(atom);
      const live = this.readSelection(range);
      if (live && live.resolved.ok) { expandMenu(turnId, live.resolved, live.resolved.target.selection); return; }
    }
    plainMenu(selectedText);
  }
}
