import { h } from './dom.js';

/**
 * On small screens the details panel is a bottom sheet with three resting
 * heights: peek (just the title), half, and full. Drag the handle to move it,
 * tap the handle to collapse or expand, or use the arrow keys. Between rests it
 * snaps, so a flick moves one notch and it always lands somewhere sensible.
 *
 * Height is published as a CSS variable (--sheet-h) so the map controls and
 * status line can ride along with the sheet instead of being covered by it.
 */
export function createSheet(panelEl, { onSnap } = {}) {
  const root = document.documentElement;
  const small = window.matchMedia('(max-width: 759px)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ORDER = ['peek', 'half', 'full'];
  const PEEK = 96;

  const handle = h(
    'div',
    { class: 'sheet-handle', role: 'button', tabindex: 0, 'aria-label': 'Resize the details panel' },
    h('span', { class: 'sheet-grip', 'aria-hidden': 'true' }),
  );
  panelEl.prepend(handle);

  let state = 'half';
  let drag = null;

  function rests() {
    const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
    return {
      peek: PEEK,
      half: Math.round(window.innerHeight * 0.44),
      full: Math.max(PEEK + 160, Math.round(window.innerHeight - top - 12)),
    };
  }

  const active = () => small.matches && !panelEl.hidden;
  const currentPx = () => (active() ? rests()[state] : 0);

  function apply({ animate = true } = {}) {
    if (!small.matches) {
      root.style.removeProperty('--sheet-h');
      delete panelEl.dataset.sheet;
      return;
    }
    panelEl.classList.toggle('no-anim', !animate || reduceMotion);
    root.style.setProperty('--sheet-h', `${currentPx()}px`);
    panelEl.dataset.sheet = state;
    handle.setAttribute('aria-expanded', String(state !== 'peek'));
  }

  function snapTo(next, { animate = true } = {}) {
    const from = parseFloat(root.style.getPropertyValue('--sheet-h')) || currentPx();
    state = next;
    apply({ animate });
    const to = currentPx();
    if (to !== from) onSnap?.({ from, to, state });
  }

  const step = (dir) => {
    const i = ORDER.indexOf(state);
    const next = ORDER[Math.min(ORDER.length - 1, Math.max(0, i + dir))];
    if (next !== state) snapTo(next);
  };

  // ---------- Drag ----------

  handle.addEventListener('pointerdown', (event) => {
    if (!active()) return;
    handle.setPointerCapture(event.pointerId);
    drag = {
      startY: event.clientY,
      startH: panelEl.getBoundingClientRect().height,
      moved: false,
      samples: [[performance.now(), event.clientY]],
    };
    panelEl.classList.add('dragging');
  });

  handle.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dy = drag.startY - event.clientY;
    if (Math.abs(dy) > 4) drag.moved = true;
    const { peek, full } = rests();
    const px = Math.min(full, Math.max(peek, drag.startH + dy));
    root.style.setProperty('--sheet-h', `${px}px`);
    drag.samples.push([performance.now(), event.clientY]);
    if (drag.samples.length > 6) drag.samples.shift();
  });

  function endDrag(event) {
    if (!drag) return;
    panelEl.classList.remove('dragging');
    const { moved, samples, startH } = drag;
    drag = null;

    if (!moved) {
      snapTo(state === 'peek' ? 'half' : 'peek'); // A tap is a collapse/expand toggle.
      return;
    }

    // A quick flick moves one notch in its direction; otherwise land on the nearest rest.
    const [t0, y0] = samples[0];
    const [t1, y1] = samples[samples.length - 1];
    const velocity = t1 > t0 ? (y0 - y1) / (t1 - t0) : 0; // px/ms, positive = upward
    const px = parseFloat(root.style.getPropertyValue('--sheet-h')) || startH;
    const r = rests();

    let next;
    if (Math.abs(velocity) > 0.45) {
      const i = ORDER.indexOf(state);
      next = ORDER[Math.min(ORDER.length - 1, Math.max(0, i + (velocity > 0 ? 1 : -1)))];
    } else {
      next = ORDER.reduce((best, s) => (Math.abs(r[s] - px) < Math.abs(r[best] - px) ? s : best), 'half');
    }
    const from = startH;
    state = next;
    apply();
    onSnap?.({ from, to: currentPx(), state });
    event.preventDefault?.();
  }

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // ---------- Keyboard ----------

  handle.addEventListener('keydown', (event) => {
    if (!active()) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      snapTo(state === 'peek' ? 'half' : 'peek');
    }
  });

  // ---------- Keep in sync ----------

  new MutationObserver(() => apply({ animate: false })).observe(panelEl, { attributes: true, attributeFilter: ['hidden'] });
  small.addEventListener('change', () => apply({ animate: false }));
  window.addEventListener('resize', () => apply({ animate: false }));
  apply({ animate: false });

  return {
    // New content should be readable: come up from peek, but never yank the
    // sheet down from full.
    reveal() {
      if (active() && state === 'peek') snapTo('half');
    },
    heightPx: currentPx,
    state: () => state,
  };
}
