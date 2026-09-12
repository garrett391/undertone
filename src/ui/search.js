import * as lf from '../api/lastfm.js';
import { h, icons, formatCount } from './dom.js';

const MAX_TAGS = 4;
const STARTER_VIBES = ['chill', 'ambient', 'melancholic', 'dreamy', 'atmospheric', 'mellow', 'rainy day', 'energetic'];

export function createSearch(root, { onPickArtist, onPickTrack, onPickNode, onPickEnd, onTagsChange, getVocabulary, findOnMap }) {
  // 'browse' is the normal state. In 'pickEnd', a choice becomes the far end of
  // a path instead of a new map, so vibes are hidden and the wording changes.
  let mode = 'browse';
  let tags = [];
  let options = [];
  let activeIndex = -1;
  let requestId = 0;
  let debounce = null;

  const input = h('input', {
    type: 'text',
    id: 'search-input',
    placeholder: 'Search artists, songs, or a vibe',
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-controls': 'search-results',
    'aria-autocomplete': 'list',
    'aria-label': 'Search artists, songs, or a vibe',
  });
  const clearButton = h('button', {
    type: 'button',
    class: 'icon-button clear',
    'aria-label': 'Clear search',
    html: icons.close,
    hidden: true,
    onClick: () => {
      input.value = '';
      clearButton.hidden = true;
      input.focus();
      update();
    },
  });
  const list = h('ul', { id: 'search-results', class: 'results', role: 'listbox', hidden: true });
  const chips = h('div', { class: 'chips', 'aria-label': 'Your vibe' });

  root.append(
    h('div', { class: 'field' }, h('span', { class: 'field-icon', html: icons.search }), input, clearButton),
    list,
    chips,
  );

  // ---------- Results ----------

  function setOpen(open) {
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) {
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
    }
  }

  function renderGroups(groups, message) {
    list.replaceChildren();
    options = [];
    if (message) list.append(h('li', { class: 'message', role: 'presentation', text: message }));
    for (const group of groups) {
      if (!group.items.length) continue;
      list.append(h('li', { class: 'group-label', role: 'presentation', text: group.label }));
      for (const item of group.items) {
        const index = options.length;
        options.push(item);
        list.append(
          h(
            'li',
            {
              id: `search-option-${index}`,
              class: 'option',
              role: 'option',
              'aria-selected': 'false',
              onMousedown: (e) => e.preventDefault(),
              onClick: () => pick(item),
              onMousemove: () => setActive(index),
            },
            h('span', { class: 'option-main', text: item.primary }),
            item.secondary ? h('span', { class: 'option-sub', text: item.secondary }) : null,
          ),
        );
      }
    }
    setOpen(list.children.length > 0);
  }

  function setActive(index) {
    activeIndex = index;
    list.querySelectorAll('.option').forEach((el, i) => el.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', `search-option-${index}`);
      list.querySelector(`#search-option-${index}`)?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  const flatten = (s) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');

  const keyOf = (item) => `${flatten(item.name)}|${flatten(item.artist || '')}`;

  // Nodes already drawn on the canvas. These need no network call, so they can
  // be shown the moment you type — useful on a dense map, or on touch where
  // there's no hover.
  function mapOptions(query) {
    const q = flatten(query);
    return (findOnMap?.(q) || []).map((n) => ({
      type: 'node',
      id: n.id,
      name: n.label,
      artist: n.artist,
      primary: n.label,
      secondary: n.artist || '',
    }));
  }

  function vibeOptions(query) {
    const vocab = getVocabulary();
    const q = query.toLowerCase();
    const available = (t) => !tags.includes(t);
    if (!q) {
      const starters = STARTER_VIBES.filter((t) => available(t) && (!vocab.length || vocab.includes(t)));
      return starters.map((t) => ({ type: 'tag', tag: t, primary: t }));
    }
    const starts = vocab.filter((t) => t.startsWith(q) && available(t));
    const contains = vocab.filter((t) => !t.startsWith(q) && t.includes(q) && available(t));
    const matches = [...starts, ...contains].slice(0, 5).map((t) => ({ type: 'tag', tag: t, primary: t }));
    if (!vocab.includes(q) && available(q)) {
      matches.push({ type: 'tag', tag: q, primary: `Use “${query}” as a vibe` });
    }
    return matches;
  }

  async function update() {
    const query = input.value.trim();
    clearButton.hidden = !input.value;
    const id = ++requestId;

    if (query.length < 2) {
      const vibes = mode === 'browse' && tags.length < MAX_TAGS ? vibeOptions('') : [];
      if (document.activeElement === input && vibes.length) {
        renderGroups([{ label: tags.length ? 'Add to your vibe' : 'Try a vibe', items: vibes }]);
      } else {
        setOpen(false);
      }
      return;
    }

    const mapGroup = { label: 'On this map', items: mapOptions(query) };
    const vibeGroup = {
      label: 'Vibes',
      items: mode === 'browse' && tags.length < MAX_TAGS ? vibeOptions(query) : [],
    };
    renderGroups([mapGroup, vibeGroup], 'Searching…');

    try {
      const [artists, tracks] = await Promise.all([lf.searchArtists(query, 4), lf.searchTracks(query, 4)]);
      if (id !== requestId) return;
      const artistGroup = {
        label: 'Artists',
        items: artists.map((a) => ({
          type: 'artist',
          name: a.name,
          primary: a.name,
          secondary: a.listeners ? `${formatCount(a.listeners)} listeners` : '',
        })),
      };
      const songGroup = {
        label: 'Songs',
        items: tracks.map((t) => ({ type: 'track', name: t.name, artist: t.artist, primary: t.name, secondary: t.artist })),
      };
      const onMap = new Set(mapGroup.items.map(keyOf));
      artistGroup.items = artistGroup.items.filter((i) => !onMap.has(keyOf(i)));
      songGroup.items = songGroup.items.filter((i) => !onMap.has(keyOf(i)));

      const exactVibe = getVocabulary().includes(query.toLowerCase());
      const rest = exactVibe ? [vibeGroup, artistGroup, songGroup] : [artistGroup, songGroup, vibeGroup];
      const groups = [mapGroup, ...rest];
      const empty = groups.every((g) => !g.items.length);
      renderGroups(groups, empty ? `Nothing on Last.fm matches “${query}”.` : null);
    } catch (err) {
      if (id !== requestId) return;
      renderGroups([vibeGroup], err.message);
    }
  }

  function pick(item) {
    if (item.type === 'tag') {
      input.value = '';
      clearButton.hidden = true;
      setTags([...tags, item.tag]);
      onTagsChange(tags);
      update();
      return;
    }
    input.value = '';
    clearButton.hidden = true;
    setOpen(false);
    input.blur();

    if (mode === 'pickEnd') {
      onPickEnd(
        item.type === 'node'
          ? { kind: item.artist ? 'track' : 'artist', name: item.name, artist: item.artist, id: item.id }
          : { kind: item.type === 'artist' ? 'artist' : 'track', name: item.name, artist: item.artist },
      );
      return;
    }
    if (item.type === 'node') onPickNode(item.id);
    if (item.type === 'artist') onPickArtist(item.name);
    if (item.type === 'track') onPickTrack(item.artist, item.name);
  }

  // ---------- Chips ----------

  function setTags(next) {
    tags = [...new Set(next)].slice(0, MAX_TAGS);
    chips.replaceChildren(
      ...tags.map((t) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip',
            'aria-label': `Remove ${t}`,
            onClick: () => {
              setTags(tags.filter((x) => x !== t));
              onTagsChange(tags);
            },
          },
          h('span', { text: t }),
          h('span', { class: 'chip-x', html: icons.close }),
        ),
      ),
    );
    chips.hidden = tags.length === 0;
  }
  setTags([]);

  // ---------- Events ----------

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(update, 260);
  });
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => setTimeout(() => setOpen(false), 120));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && options.length) {
      event.preventDefault();
      if (list.hidden) setOpen(true);
      setActive((activeIndex + 1) % options.length);
    } else if (event.key === 'ArrowUp' && options.length) {
      event.preventDefault();
      setActive(activeIndex <= 0 ? options.length - 1 : activeIndex - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = options[activeIndex] || options[0];
      if (choice && !list.hidden) pick(choice);
    } else if (event.key === 'Escape') {
      if (!list.hidden) setOpen(false);
      else input.blur();
    } else if (event.key === 'Backspace' && !input.value && tags.length) {
      setTags(tags.slice(0, -1));
      onTagsChange(tags);
    }
  });

  return {
    setTags,
    setMode(next) {
      mode = next;
      input.placeholder =
        next === 'pickEnd' ? 'Search for the other end of the path' : 'Search artists, songs, or a vibe';
      input.setAttribute('aria-label', input.placeholder);
      // Switching modes changes what a search means, so any half-typed query goes.
      input.value = '';
      clearButton.hidden = true;
      setOpen(false);
      // On touch, focusing would raise the keyboard over the map the person is
      // about to tap, so the search bar waits to be reached for.
      if (next === 'pickEnd' && !window.matchMedia('(pointer: coarse)').matches) input.focus();
    },
    clearText() {
      input.value = '';
      clearButton.hidden = true;
      setOpen(false);
    },
    focus: () => input.focus(),
    getTags: () => [...tags],
  };
}
