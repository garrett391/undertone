import * as lf from '../api/lastfm.js';
import { clearCache } from '../api/cache.js';
import { h } from './dom.js';

const KEY_PATTERN = /^[a-f0-9]{32}$/i;

export function createSettings({ onKeySaved }) {
  const dialog = h('dialog', { class: 'settings', 'aria-labelledby': 'settings-title' });
  document.body.append(dialog);
  // On first run there's nothing to go back to, so Escape shouldn't dismiss the dialog.
  dialog.addEventListener('cancel', (event) => {
    if (dialog.dataset.required === 'true') event.preventDefault();
  });

  function render({ firstRun }) {
    const fromEnv = lf.keyFromEnv();
    const error = h('p', { class: 'field-error', id: 'key-error', role: 'alert' });
    const input = h('input', {
      type: 'text',
      id: 'key-input',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      value: fromEnv ? '' : lf.getApiKey(),
      'aria-describedby': 'key-help key-error',
    });
    input.addEventListener('input', () => (error.textContent = ''));
    const save = h('button', { type: 'submit', class: 'button primary' }, 'Save key');

    const form = h(
      'form',
      {
        onSubmit: async (event) => {
          event.preventDefault();
          const key = input.value.trim();
          if (!KEY_PATTERN.test(key)) {
            error.textContent = 'Last.fm API keys are 32 characters of letters and numbers. Copy the “API key” line, not the shared secret.';
            input.focus();
            return;
          }
          save.disabled = true;
          save.textContent = 'Checking key…';
          try {
            await lf.verifyKey(key);
            lf.saveApiKey(key);
            dialog.close();
            onKeySaved();
          } catch (err) {
            error.textContent = err.code === -1 ? err.message : "Last.fm didn't accept this key. Check that you copied the full API key.";
          } finally {
            save.disabled = false;
            save.textContent = 'Save key';
          }
        },
      },
      h('label', { for: 'key-input', class: 'field-label' }, 'Last.fm API key'),
      input,
      error,
      h(
        'p',
        { class: 'hint', id: 'key-help' },
        'Create one for free at ',
        h('a', { class: 'text-link', href: 'https://www.last.fm/api/account/create', target: '_blank', rel: 'noopener noreferrer' }, 'last.fm/api/account/create'),
        '. Any app name works, and you can leave the callback URL blank. The key stays in this browser.',
      ),
      h('div', { class: 'dialog-actions' }, firstRun ? null : h('button', { type: 'button', class: 'button', onClick: () => dialog.close() }, 'Cancel'), save),
    );

    const clearButton = h('button', {
      type: 'button',
      class: 'button',
      onClick: async () => {
        await clearCache();
        clearButton.textContent = 'Saved data cleared';
      },
    }, 'Clear saved Last.fm data');

    const content = [
      h('h2', { id: 'settings-title', text: firstRun ? 'Connect to Last.fm' : 'Settings' }),
      h('p', { class: 'dialog-lead', text: 'Undertone maps music using Last.fm, which knows what millions of listeners play together. You need a free API key to start.' }),
      fromEnv ? h('p', { class: 'hint', text: 'Your key is set in .env.local. Edit that file to change it.' }) : form,
      firstRun ? null : h('section', { class: 'section' },
        h('h3', { text: 'Saved data' }),
        h('p', { class: 'hint', text: 'Results are saved in this browser for a week so maps load instantly. Clear them to fetch everything fresh.' }),
        clearButton,
      ),
      fromEnv && !firstRun ? h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'button', onClick: () => dialog.close() }, 'Close')) : null,
    ];
    dialog.replaceChildren(...content.filter(Boolean));
    return input;
  }

  return {
    open({ firstRun = false } = {}) {
      const input = render({ firstRun });
      dialog.dataset.required = String(firstRun);
      dialog.showModal();
      input?.focus?.();
    },
  };
}
