import { h } from './dom.js';

// One status line in the corner for loading, confirmations, and errors.
export function createStatus(root) {
  let timer = null;
  const text = h('span', { class: 'status-text' });
  const actionSlot = h('span');
  root.append(h('span', { class: 'status-dot', 'aria-hidden': 'true' }), text, actionSlot);
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  function set(message, tone, action) {
    clearTimeout(timer);
    root.dataset.tone = tone;
    text.textContent = message;
    actionSlot.replaceChildren(
      action ? h('button', { type: 'button', class: 'status-action', onClick: action.onClick }, action.label) : '',
    );
    root.hidden = false;
  }

  return {
    loading: (message) => set(message, 'loading'),
    info(message, { duration = 3500, action } = {}) {
      set(message, 'info', action);
      if (duration) timer = setTimeout(() => (root.hidden = true), duration);
    },
    error: (message, action) => set(message, 'error', action),
    hide() {
      clearTimeout(timer);
      root.hidden = true;
    },
  };
}
