import * as lf from '../api/lastfm.js';
import { h, icons, formatCount } from './dom.js';

/**
 * The panel has three states: an overview of the current map, details for the
 * selected artist or song, and the result of a path search.
 * `actions` are callbacks supplied by main.js.
 */
export function createPanel(root, actions) {
  let detailToken = 0;
  const touch = window.matchMedia('(pointer: coarse)').matches;

  const body = h('div', { class: 'panel-body' });
  root.append(body);

  function show(...children) {
    body.replaceChildren(...children.filter(Boolean));
    root.hidden = false;
    body.scrollTop = 0;
  }

  const button = (label, onClick, extra = {}) =>
    h('button', { type: 'button', class: 'button', onClick, ...extra }, label);

  const tagList = (tags) =>
    tags.length
      ? h(
          'div',
          { class: 'tag-list' },
          tags.slice(0, 8).map((t) =>
            h('button', { type: 'button', class: 'tag', title: `Explore the “${t}” vibe`, onClick: () => actions.exploreTag(t) }, t),
          ),
        )
      : null;

  const lastfmLink = (url) =>
    url
      ? h(
          'a',
          { class: 'text-link', href: url, target: '_blank', rel: 'noopener noreferrer' },
          'Open on Last.fm',
          h('span', { class: 'link-icon', html: icons.external }),
        )
      : null;

  // ---------- Overview ----------

  function showOverview(map) {
    detailToken++;
    const bridges = map.bridges.filter((b) => map.graph.hasNode(b.id));
    show(
      h('h2', { class: 'panel-title', text: map.title }),
      map.subtitle ? h('p', { class: 'panel-sub', text: map.subtitle }) : null,
      h('p', { class: 'meta', text: map.stats }),
      map.note ? h('p', { class: 'note', text: map.note }) : null,
      map.action ? h('div', { class: 'actions' }, button(map.action.label, map.action.onClick)) : null,
      bridges.length
        ? h(
            'section',
            { class: 'section' },
            h('h3', { text: 'Bridges' }),
            h('p', {
              class: 'hint',
              text: `${map.kindPlural[0].toUpperCase() + map.kindPlural.slice(1)} that connect different scenes on this map.`,
            }),
            h(
              'ul',
              { class: 'link-list' },
              bridges.map((b) =>
                h(
                  'li',
                  {},
                  h(
                    'button',
                    { type: 'button', class: 'list-button', onClick: () => actions.selectNode(b.id, { focus: true }) },
                    h('span', { class: 'list-main', text: b.label }),
                    b.sub ? h('span', { class: 'list-sub', text: b.sub }) : null,
                  ),
                ),
              ),
            ),
          )
        : null,
      h(
        'p',
        { class: 'hint help' },
        touch
          ? 'Tap a node for details, and double-tap one to grow the map from it. Drag nodes to rearrange, and pinch to zoom.'
          : 'Select a node for details. Double-click one to grow the map from it. Drag nodes to rearrange, and scroll to zoom.',
      ),
    );
  }

  function showLoading(title, subtitle) {
    detailToken++;
    show(
      h('h2', { class: 'panel-title', text: title }),
      subtitle ? h('p', { class: 'panel-sub', text: subtitle }) : null,
      h('div', { class: 'skeleton', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
    );
  }

  // ---------- Node details ----------

  function nodeActions(id, node) {
    return h(
      'div',
      { class: 'actions' },
      node.seed ? null : button('Center the map here', () => actions.recenter(id)),
      button('Show more like this', () => actions.expand(id)),
      button('Find a path from here', () => actions.startPath(id)),
      button('Show me something different', () => actions.somethingDifferent(id)),
    );
  }

  /**
   * The full ranked similar list, not just what the map left out. On a phone
   * only a handful of node labels fit, so this is how you read a map without
   * tapping every dot. Rows already on the map jump to them; rows that aren't
   * get added, so the list doubles as a precise version of "show more like this".
   */
  function similarSection(node, token) {
    const isArtist = node.kind === 'artist';
    const heading = isArtist ? 'Similar artists' : 'Similar songs';
    const slot = h('section', { class: 'section' }, h('h3', { text: heading }), skeletonList());

    const load = isArtist
      ? lf.similarArtists(node.label, 14).then((r) => r.items.map((a) => ({ kind: 'artist', name: a.name, match: a.match })))
      : lf
          .similarTracks(node.artist, node.label, 14)
          .then((items) => items.map((t) => ({ kind: 'track', name: t.name, artist: t.artist, match: t.match })));

    load
      .then((items) => {
        if (token !== detailToken) return;
        if (!items.length) {
          slot.remove();
          return;
        }
        slot.replaceChildren(
          h('h3', { text: heading }),
          h('p', { class: 'hint', text: 'Tap one to go to it, or to add it if it isn’t on the map yet.' }),
          h(
            'ul',
            { class: 'link-list' },
            items.slice(0, 10).map((item) => {
              const onMap = Boolean(actions.locate(item));
              const label = item.kind === 'track' ? `${item.name} by ${item.artist}` : item.name;
              return h(
                'li',
                {},
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'list-button',
                    'aria-label': onMap ? `Go to ${label}` : `Add ${label} to the map`,
                    onClick: () => actions.openSimilar(item),
                  },
                  h('span', { class: 'list-main', text: item.name }),
                  h('span', { class: 'list-sub', text: item.kind === 'track' ? item.artist : `${Math.round(item.match * 100)}%` }),
                  // Kept on every row so the percentages line up in a column.
                  h('span', { class: 'list-add', html: onMap ? '' : icons.plus }),
                ),
              );
            }),
          ),
        );
      })
      .catch(() => {
        if (token === detailToken) slot.remove();
      });

    return slot;
  }

  function showArtist(id, node, relation) {
    const token = ++detailToken;
    const meta = h('p', { class: 'meta', text: 'Loading details…' });
    const tagsSlot = h('div');
    const songsSlot = h('section', { class: 'section' }, h('h3', { text: 'Popular songs' }), skeletonList());
    const bioSlot = h('div');

    show(
      h('p', { class: 'kind', text: 'Artist' }),
      h('h2', { class: 'panel-title', text: node.label }),
      relation ? h('p', { class: 'relation', text: relation }) : null,
      meta,
      tagsSlot,
      nodeActions(id, node),
      similarSection(node, token),
      songsSlot,
      bioSlot,
    );

    lf.artistInfo(node.label)
      .then((info) => {
        if (token !== detailToken) return;
        meta.textContent = info.listeners ? `${formatCount(info.listeners)} listeners on Last.fm` : '';
        const tags = tagList(info.tags);
        if (tags) tagsSlot.replaceWith(tags);
        bioSlot.replaceWith(
          h('div', { class: 'section' }, info.bio ? h('p', { class: 'bio', text: info.bio }) : null, lastfmLink(info.url)),
        );
      })
      .catch((err) => {
        if (token === detailToken) meta.textContent = err.message;
      });

    lf.artistTopTracks(node.label, 6)
      .then((tracks) => {
        if (token !== detailToken) return;
        songsSlot.replaceChildren(
          h('h3', { text: 'Popular songs' }),
          h('p', { class: 'hint', text: 'Pick one to map songs like it.' }),
          h(
            'ul',
            { class: 'link-list' },
            tracks.map((t) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { type: 'button', class: 'list-button', onClick: () => actions.openTrack(t.artist, t.name) },
                  h('span', { class: 'list-main', text: t.name }),
                  t.listeners ? h('span', { class: 'list-sub', text: `${formatCount(t.listeners)} listeners` }) : null,
                ),
              ),
            ),
          ),
        );
      })
      .catch(() => {
        if (token === detailToken) songsSlot.remove();
      });
  }

  function showTrack(id, node, relation) {
    const token = ++detailToken;
    const meta = h('p', { class: 'meta', text: 'Loading details…' });
    const tagsSlot = h('div');
    const linkSlot = h('div');

    show(
      h('p', { class: 'kind', text: 'Song' }),
      h('h2', { class: 'panel-title', text: node.label }),
      h(
        'p',
        { class: 'panel-sub' },
        'by ',
        h('button', { type: 'button', class: 'inline-link', onClick: () => actions.openArtist(node.artist) }, node.artist),
      ),
      relation ? h('p', { class: 'relation', text: relation }) : null,
      meta,
      tagsSlot,
      nodeActions(id, node),
      similarSection(node, token),
      linkSlot,
    );

    lf.trackInfo(node.artist, node.label)
      .then((info) => {
        if (token !== detailToken) return;
        const parts = [];
        if (info.album) parts.push(`From ${info.album}`);
        if (info.listeners) parts.push(`${formatCount(info.listeners)} listeners on Last.fm`);
        meta.textContent = parts.join('. ');
        const tags = tagList(info.tags);
        if (tags) tagsSlot.replaceWith(tags);
        linkSlot.replaceWith(h('div', { class: 'section' }, lastfmLink(info.url)));
      })
      .catch((err) => {
        if (token === detailToken) meta.textContent = err.code === 6 ? '' : err.message;
      });
  }

  // ---------- Paths ----------

  function showPath({ from, to, steps, kindPlural, note }) {
    detailToken++;
    show(
      h('h2', { class: 'panel-title', text: `From ${from} to ${to}` }),
      h('p', {
        class: 'meta',
        // Counting what's in the list, since for songs the list is a running order.
        text: `${steps.length} ${kindPlural}, following the strongest connections between them.`,
      }),
      note ? h('p', { class: 'note', text: note }) : null,
      h(
        'ol',
        { class: 'path-list' },
        steps.map((s) =>
          h(
            'li',
            {},
            h(
              'button',
              { type: 'button', class: 'list-button', onClick: () => actions.selectNode(s.id, { focus: true, keepPath: true }) },
              h('span', { class: 'list-main', text: s.label }),
              s.sub ? h('span', { class: 'list-sub', text: s.sub }) : null,
            ),
          ),
        ),
      ),
      h('div', { class: 'actions' }, button('Clear path', actions.clearPath)),
    );
  }

  function skeletonList() {
    return h('div', { class: 'skeleton', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'));
  }

  return {
    showOverview,
    showLoading,
    showArtist,
    showTrack,
    showPath,
    hide() {
      detailToken++;
      root.hidden = true;
    },
  };
}
