/* Right-click menus, the "Expand on…" prompt and the floating selection bar for the canvas.
 * The same look as the conversation view's (classes from conversation.css). */

import { h, keyLabel } from '../dom.js';
import { EXPAND_INTENTS } from '../../shared/prompts.js';

export class CanvasPopups {
  constructor() {
    this.overlay = null;
    this.bar = null;
    this.barRange = null;
    this.onScroll = () => { if (this.bar && this.barRange) this.positionBar(); };
    document.addEventListener('scroll', this.onScroll, true);
  }

  destroy() {
    document.removeEventListener('scroll', this.onScroll, true);
    this.close();
    this.closeBar();
  }

  get open() { return this.overlay !== null; }

  isPopup(target) {
    return target instanceof Element && !!target.closest('.expand-selection-bar, .expand-prompt, .ctx-menu');
  }

  close() {
    if (!this.overlay) return;
    const { el, cleanup } = this.overlay;
    this.overlay = null;
    cleanup();
    el.remove();
  }

  place(el, at) {
    document.body.appendChild(el);
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - rect.height - 8))}px`;
  }

  show(el, at, focusEl) {
    this.close();
    this.closeBar();
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    this.place(el, at);
    const previous = document.activeElement;
    const onDown = (e) => { if (!el.contains(e.target)) this.close(); };
    document.addEventListener('mousedown', onDown, true);
    this.overlay = {
      el,
      cleanup: () => {
        document.removeEventListener('mousedown', onDown, true);
        if (previous && previous.focus && document.contains(previous)) previous.focus({ preventScroll: true });
      }
    };
    if (focusEl) setTimeout(() => focusEl.focus({ preventScroll: true }), 0);
  }

  /** items: [{ label, detail?, disabled?, shortcut?, onSelect } | 'separator' | { hint }] */
  menu(at, items, label = 'Actions') {
    const menu = h('div.ctx-menu', { role: 'menu', 'aria-label': label });
    const buttons = [];
    for (const item of items) {
      if (!item) continue;
      if (item === 'separator') { menu.appendChild(h('div.sep', { role: 'separator' })); continue; }
      if (item.hint) { menu.appendChild(h('div.hint', { role: 'presentation', text: item.hint })); continue; }
      const btn = h('button.item' + (item.detail ? '.item--stacked' : ''), {
        type: 'button', role: 'menuitem', disabled: !!item.disabled,
        on: { click: () => { this.close(); item.onSelect(); } }
      }, h('span', { text: item.label }), item.detail ? h('span.item-detail', { text: item.detail }) : null,
      item.shortcut ? h('kbd.item-key', { text: keyLabel(item.shortcut) }) : null);
      buttons.push(btn);
      menu.appendChild(btn);
    }
    menu.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const enabled = buttons.filter((b) => !b.disabled);
      const index = enabled.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = index < 0 ? 0 : (index + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
        enabled[next]?.focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        this.close();
      }
    });
    this.show(menu, at, buttons.find((b) => !b.disabled));
  }

  /** opts: { initialPrompt?, placeholder?, onSubmit(prompt) }; `initialPrompt` makes it an editor. */
  prompt(at, opts) {
    const editing = typeof opts.initialPrompt === 'string';
    const input = h('input.expand-prompt-input', {
      type: 'text', autocomplete: 'off',
      placeholder: opts.placeholder || (editing ? 'Blank for a plain explanation' : 'Expand on…'),
      'aria-label': editing ? 'Edit question' : 'Expand on'
    });
    if (editing) input.value = opts.initialPrompt;
    const submit = (value) => {
      this.close();
      opts.onSubmit(String(value || ''));
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    const panel = h('div.expand-prompt', { role: 'dialog' }, input,
      editing ? null : h('div.expand-intents', EXPAND_INTENTS.map((intent) => h('button.expand-intent', {
        type: 'button', title: intent.prompt, text: intent.label, on: { click: () => submit(intent.prompt) }
      }))));
    this.show(panel, at, input);
    if (editing) setTimeout(() => input.select(), 0);
  }

  /* ---- The bar over a selection in an answer ---- */

  closeBar() {
    if (this.bar) this.bar.remove();
    this.bar = null;
    this.barRange = null;
  }

  positionBar() {
    const rect = this.barRange.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { this.closeBar(); return; }
    const barRect = this.bar.getBoundingClientRect();
    const above = rect.top - barRect.height - 6;
    this.bar.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - barRect.width / 2, window.innerWidth - barRect.width - 8))}px`;
    this.bar.style.top = `${above >= 8 ? above : rect.bottom + 6}px`;
  }

  /** run(prompt | undefined) expands; ask() opens the prompt. */
  showBar(range, run) {
    this.closeBar();
    const bar = h('div.expand-selection-bar', { role: 'toolbar', 'aria-label': 'Expand selection', on: { mousedown: (e) => e.preventDefault() } },
      h('button.expand-intent.expand-intent--primary', { type: 'button', text: 'Expand', title: `Define or explain (${keyLabel('Ctrl+E')})`, on: { click: () => run(undefined) } }),
      EXPAND_INTENTS.map((intent) => h('button.expand-intent', { type: 'button', text: intent.label, title: intent.prompt, on: { click: () => run(intent.prompt) } })),
      h('button.expand-intent', {
        type: 'button', text: 'Ask…', title: 'Ask your own question',
        on: {
          click: () => {
            const rect = range.getBoundingClientRect();
            this.prompt({ x: rect.left, y: rect.bottom + 6 }, { onSubmit: (prompt) => run(prompt) });
          }
        }
      }));
    bar.style.visibility = 'hidden';
    document.body.appendChild(bar);
    this.bar = bar;
    this.barRange = range;
    this.positionBar();
    bar.style.visibility = '';
  }
}
