import './style.css';
import * as lf from './api/lastfm.js';
import {
  buildArtistMap,
  buildTrackMap,
  buildVibeMap,
  buildPathMap,
  expandNode,
  attachNode,
  artistId,
  trackId,
  StaleError,
  EmptyMapError,
  PathNotFoundError,
  PATH_BUDGET,
} from './graph/build.js';
import { analyze, smoothestPath, farthestFrom, hopsBetween } from './graph/analysis.js';
import { createGraphView } from './ui/graphView.js';
import { createSearch } from './ui/search.js';
import { createPanel } from './ui/panel.js';
import { createStatus } from './ui/status.js';
import { createSettings } from './ui/settings.js';
import { createSheet } from './ui/sheet.js';
import { icons, formatList } from './ui/dom.js';
import { createSpectrum } from './graph/color.js';

const $ = (id) => document.getElementById(id);

const app = {
  route: null,
  graph: null,
  seedId: null,
  seedLabel: null,
  estimated: false,
  analysis: { communities: {}, sceneCount: 0, bridges: [] },
  selectedId: null,
  pathFrom: null,
  path: null,
  token: 0,
  vocab: [],
  trail: [],
};

// ---------- Components ----------

const view = createGraphView($('map'), {
  onSelect: (id) => selectNode(id),
  onExpand: (id) => expand(id),
  onBackground: () => clearSelection(),
  describe,
});

const status = createStatus($('status'));

const panel = createPanel($('panel'), {
  exploreTag: (tag) => navigate({ type: 'vibe', tags: [tag] }),
  recenter,
  expand,
  startPath,
  somethingDifferent,
  openTrack,
  openArtist,
  selectNode,
  clearPath,
  locate,
  openSimilar,
});

const search = createSearch($('search'), {
  onPickArtist: openArtist,
  onPickTrack: openTrack,
  onPickNode: (id) => selectNode(id, { focus: true }),
  onPickEnd: finishPathWith,
  findOnMap,
  onTagsChange: (tags) => {
    if (tags.length) navigate({ type: 'vibe', tags });
    else if (app.route?.type === 'vibe') location.hash = '';
  },
  getVocabulary: () => app.vocab,
});

const settings = createSettings({ onKeySaved: start });

// On phones the panel is a bottom sheet. When it snaps to a new height, the
// map's usable area changes, so the insets update and the view slides by half
// the difference to keep what you were looking at centered in the new space.
const sheet = createSheet($('panel'), {
  onSnap({ from, to }) {
    updateInsets();
    if (app.graph) view.nudge(0, -(to - from) / 2);
  },
});

// ---------- Routing ----------
// Maps live in the URL, so the browser's back button works and maps can be bookmarked.

const enc = encodeURIComponent;

const endpointToPath = (ep) =>
  ep.kind === 'artist' ? `artist/${enc(ep.name)}` : `song/${enc(ep.artist)}/${enc(ep.name)}`;

function routeToHash(route) {
  if (route.type === 'artist') return `#artist/${enc(route.name)}`;
  if (route.type === 'track') return `#song/${enc(route.artist)}/${enc(route.name)}`;
  if (route.type === 'path') return `#path/${endpointToPath(route.from)}/to/${endpointToPath(route.to)}`;
  return `#vibe/${route.tags.map(enc).join('/')}`;
}

// Reads one endpoint out of a hash, returning it and where the next one starts.
function readEndpoint(parts, i) {
  if (parts[i] === 'artist' && parts[i + 1]) return [{ kind: 'artist', name: parts[i + 1] }, i + 2];
  if (parts[i] === 'song' && parts[i + 2]) return [{ kind: 'track', artist: parts[i + 1], name: parts[i + 2] }, i + 3];
  return [null, i];
}

function hashToRoute(hash) {
  let parts;
  try {
    parts = hash.replace(/^#/, '').split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts[0] === 'artist' && parts[1]) return { type: 'artist', name: parts[1] };
  if (parts[0] === 'song' && parts[2]) return { type: 'track', artist: parts[1], name: parts[2] };
  if (parts[0] === 'path') {
    const [from, next] = readEndpoint(parts, 1);
    if (from && parts[next] === 'to') {
      const [to] = readEndpoint(parts, next + 1);
      if (to) return { type: 'path', from, to };
    }
    return null;
  }
  if (parts[0] === 'vibe') {
    const tags = parts.slice(1).filter(Boolean);
    if (tags.length) return { type: 'vibe', tags };
  }
  return null;
}

function navigate(route) {
  const hash = routeToHash(route);
  if (location.hash === hash) load(route);
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  const { trail } = app;
  if (trail.length >= 2 && trail[trail.length - 2] === location.hash) trail.pop();
  else trail.push(location.hash);
  const route = hashToRoute(location.hash);
  if (route) load(route);
  else showEmpty();
});

$('back').addEventListener('click', () => history.back());

function openArtist(name) {
  navigate({ type: 'artist', name });
}

function openTrack(artist, name) {
  navigate({ type: 'track', artist, name });
}

function recenter(id) {
  const node = app.graph.getNodeAttributes(id);
  if (node.kind === 'artist') openArtist(node.label);
  else openTrack(node.artist, node.label);
}

// ---------- Loading maps ----------

function titlesFor(route, result = {}) {
  if (route.type === 'artist') return { title: `Artists like ${result.seedLabel || route.name}` };
  if (route.type === 'track') {
    return { title: `Songs like ${result.seedLabel || route.name}`, subtitle: `by ${result.seedArtist || route.artist}` };
  }
  if (route.type === 'path') {
    return { title: `From ${result.fromLabel || route.from.name} to ${result.toLabel || route.to.name}` };
  }
  return { title: `Artists for ${formatList(route.tags)}` };
}

function setTitles({ title }) {
  $('map-title').textContent = title;
  document.title = `${title} | Undertone`;
}

async function load(route) {
  const token = ++app.token;
  Object.assign(app, {
    route,
    graph: null,
    seedId: null,
    seedLabel: null,
    selectedId: null,
    pathFrom: null,
    path: null,
    pathShown: false,
    converted: null,
    via: null,
    artistPath: null,
    nodeKind: route.type === 'track' || route.from?.kind === 'track' ? 'track' : 'artist',
  });
  app.analysis = { communities: {}, sceneCount: 0, bridges: [] };

  $('empty').hidden = true;
  $('controls').hidden = false;
  $('crumb').hidden = false;
  $('back').hidden = app.trail.length < 2;
  view.setPickMode(false);
  view.clear();
  search.setTags(route.type === 'vibe' ? route.tags : []);
  search.clearText();

  const titles = titlesFor(route);
  setTitles(titles);
  panel.showLoading(titles.title, titles.subtitle);
  sheet.reveal();
  updateInsets();

  const ctx = {
    check() {
      if (token !== app.token) throw new StaleError();
    },
    update(graph, options = {}) {
      if (token !== app.token) return;
      app.graph = graph;
      if ('centerId' in options) app.seedId = options.centerId;
      view.setGraph(graph, options);
    },
    progress(message) {
      if (token === app.token) status.loading(message);
    },
  };

  try {
    let result;
    if (route.type === 'artist') result = await buildArtistMap(route.name, ctx);
    else if (route.type === 'track') result = await buildTrackMap(route.artist, route.name, ctx);
    else if (route.type === 'path') result = await buildPathMap(route.from, route.to, ctx, { budget: route.budget || PATH_BUDGET.default });
    else result = await buildVibeMap(route.tags, ctx);
    ctx.check();

    Object.assign(app, {
      graph: result.graph,
      seedId: result.seedId ?? null,
      seedLabel: result.seedLabel,
      seedArtist: result.seedArtist,
      estimated: Boolean(result.estimated),
      converted: result.converted || null,
      via: result.via || null,
      artistPath: result.artistPath || null,
    });
    setTitles(titlesFor(route, result));

    if (route.type === 'path') {
      app.nodeKind = result.kind;
      app.ends = result.ends;
      view.setGraph(result.graph, { fresh: false, centerId: null });
      app.path = result.path;
      view.fit(true);
      refreshAnalysis();
      status.hide();
      showPathPanel();
      return;
    }

    refreshAnalysis();
    status.hide();
    if (!app.selectedId) showOverview();
  } catch (err) {
    if (err instanceof StaleError) return;
    handleLoadError(err, route);
  }
}

function handleLoadError(err, route) {
  if (err instanceof EmptyMapError || !app.graph) {
    showEmpty({ keepStatus: true });
  }
  if (err instanceof PathNotFoundError) {
    app.path = null;
    view.setPath(null);
    if (app.graph) showOverview();
    const current = route.budget || PATH_BUDGET.default;
    const atCeiling = current >= PATH_BUDGET.max;
    // Searching wider only helps if the search stopped early, and there's a ceiling.
    const canWiden = !err.exhausted && !atCeiling;
    status.error(
      canWiden || err.exhausted
        ? err.message
        : `${err.message} That's as far as this search goes: ${PATH_BUDGET.max} fetches, each asking one ${kindPlural().slice(0, -1)} for its similar list.`,
      canWiden
        ? { label: 'Keep looking', onClick: () => load({ ...route, budget: Math.min(PATH_BUDGET.max, current * 2) }) }
        : null,
    );
    return;
  }
  if (err.code === 10 || err.code === 26) {
    status.error(err.message, { label: 'Open settings', onClick: () => settings.open() });
  } else if (err instanceof EmptyMapError) {
    status.error(err.message);
  } else {
    status.error(err.message || 'Something went wrong while building the map.', {
      label: 'Try again',
      onClick: () => navigate(route),
    });
  }
}

function refreshAnalysis() {
  if (!app.graph) return;
  app.analysis = analyze(app.graph, app.seedId);
  view.setBridges(app.analysis.bridges);
}

function showEmpty({ keepStatus = false } = {}) {
  app.token++;
  Object.assign(app, { route: null, graph: null, seedId: null, selectedId: null, pathFrom: null, path: null });
  view.clear();
  view.setPickMode(false);
  panel.hide();
  search.setTags([]);
  $('empty').hidden = false;
  $('controls').hidden = true;
  $('crumb').hidden = true;
  document.title = 'Undertone';
  if (!keepStatus) status.hide();
}

// ---------- Describing nodes ----------

const kindPlural = () => (app.nodeKind === 'track' ? 'songs' : 'artists');
const labelOf = (id) => app.graph.getNodeAttribute(id, 'label');
const subOf = (id) => {
  const node = app.graph.getNodeAttributes(id);
  return node.kind === 'track' ? node.artist : null;
};
const percent = (w) => `${Math.round(w * 100)}%`;

function seedWeight(id) {
  if (!app.seedId || id === app.seedId || !app.graph.hasNode(app.seedId)) return null;
  const edge = app.graph.edge(id, app.seedId);
  return edge ? app.graph.getEdgeAttribute(edge, 'weight') : null;
}

function vibeMatch(node) {
  const total = app.route.tags.length;
  if (!node.matches) return 'Similar to artists in your vibe';
  return total > 1 ? `Tagged with ${node.matches} of your ${total} vibes` : `Tagged “${app.route.tags[0]}” on Last.fm`;
}

// On a path map there's no single seed, so position is described by the route:
// either which step a node is, or which step it sits closest to.
function pathRelation(id, node) {
  if (node.anchor) {
    return node.anchor === 'start' ? 'The start of this path.' : 'The end of this path.';
  }
  const step = app.path?.indexOf(id) ?? -1;
  if (step > 0) return `Step ${step} of ${app.path.length - 1} along the path`;

  let best = null;
  app.graph.forEachNeighbor(id, (nb) => {
    if (!app.path?.includes(nb)) return;
    const w = app.graph.getEdgeAttribute(app.graph.edge(id, nb), 'weight');
    if (!best || w > best.w) best = { id: nb, w };
  });
  return best ? `${percent(best.w)} similar to ${labelOf(best.id)}, on the path` : 'Near the path';
}

function relationText(id, node) {
  if (app.route.type === 'path') return pathRelation(id, node);
  if (node.seed) return app.route.type === 'track' ? 'This map starts from this song.' : 'This map starts from this artist.';
  if (app.route.type === 'vibe') return vibeMatch(node);
  const w = seedWeight(id);
  if (w != null) return `${percent(w)} similar to ${app.seedLabel}`;
  const hops = app.seedId ? hopsBetween(app.graph, app.seedId, id) : null;
  return hops ? `${hops} steps from ${app.seedLabel}` : null;
}

function describe(d) {
  let note = null;
  if (app.route?.type === 'path') note = pathRelation(d.id, d);
  else if (d.seed) note = 'Start of this map';
  else if (app.route?.type === 'vibe') note = vibeMatch(d);
  else {
    const w = seedWeight(d.id);
    if (w != null) note = `${percent(w)} similar to ${app.seedLabel}`;
  }
  return { title: d.label, subtitle: d.kind === 'track' ? d.artist : null, note };
}

// ---------- Panel states ----------

function showOverview() {
  if (!app.graph || !app.route) return;
  const count = app.graph.order;
  const scenes = app.analysis.sceneCount;
  const titles = titlesFor(app.route, app);
  let note = null;
  let action = null;
  if (app.estimated) {
    note = "Last.fm doesn't have song-to-song data for this track yet, so these are popular songs from similar artists.";
  } else if (app.route.type === 'vibe') {
    note = 'Bigger nodes match more of your vibe. Lines connect artists that listeners play together.';
  } else if (app.route.type === 'path') {
    note = app.path
      ? `The ${kindPlural()} around each step, so you can see what the route travels through.`
      : 'No route connected these two yet. The map shows both ends and their closest neighbors.';
  }
  if (app.path && !app.pathShown) action = { label: 'Show the path again', onClick: showPathPanel };
  panel.showOverview({
    graph: app.graph,
    title: titles.title,
    subtitle: titles.subtitle,
    stats: `${count} ${kindPlural()}${scenes > 1 ? ` in ${scenes} scenes` : ''}`,
    note,
    action,
    kindPlural: kindPlural(),
    bridges: app.analysis.bridges.map((id) => ({ id, label: labelOf(id), sub: subOf(id) })),
  });
}

function showPathPanel() {
  if (!app.path) return;
  app.selectedId = null;
  app.pathShown = true;
  sheet.reveal();
  view.select(null);
  view.setPath(app.path);
  panel.showPath({
    from: labelOf(app.path[0]),
    to: labelOf(app.path[app.path.length - 1]),
    kindPlural: kindPlural(),
    note: [
      app.converted ? `${app.converted.from} isn't a song, so the path ends at ${app.converted.to}.` : null,
      app.via === 'artists'
        ? `Last.fm doesn't link these songs directly, so this route follows their artists (${app.artistPath.join(' → ')}) with one song from each along the way.`
        : null,
    ]
      .filter(Boolean)
      .join(' '),
    steps: app.path.map((id) => ({ id, label: labelOf(id), sub: subOf(id) })),
  });
}

const flatten = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

// Matches against what's already drawn, so it can answer while you type.
function findOnMap(query) {
  if (!app.graph || query.length < 2) return [];
  const matches = [];
  app.graph.forEachNode((id, attrs) => {
    const at = flatten(`${attrs.label} ${attrs.artist || ''}`).indexOf(query);
    if (at >= 0) matches.push({ id, label: attrs.label, artist: attrs.artist, at, score: attrs.score ?? 0 });
  });
  return matches.sort((a, b) => a.at - b.at || b.score - a.score).slice(0, 5);
}

function selectNode(id, { focus = false, keepPath = false } = {}) {
  if (!app.graph?.hasNode(id)) return;
  if (app.pathFrom) {
    finishPath(id);
    return;
  }
  if (keepPath) {
    view.select(id);
    view.focusNode(id);
    return;
  }
  if (app.pathShown) {
    app.pathShown = false;
    view.setPath(null);
  }
  app.selectedId = id;
  view.select(id);
  sheet.reveal();
  if (focus) view.focusNode(id);
  const node = app.graph.getNodeAttributes(id);
  const relation = relationText(id, node);
  if (node.kind === 'artist') panel.showArtist(id, node, relation);
  else panel.showTrack(id, node, relation);
}

function clearSelection() {
  if (app.pathFrom) return cancelPath();
  if (app.pathShown) return clearPath();
  if (!app.selectedId) return;
  app.selectedId = null;
  view.select(null);
  showOverview();
}

// ---------- Actions ----------

// Where a similar-list row points, if it's already drawn.
function locate(item) {
  if (!app.graph) return null;
  const id = item.kind === 'artist' ? artistId(item.name) : trackId(item.artist, item.name);
  return app.graph.hasNode(id) ? id : null;
}

// Rows already on the map jump there; the rest get added next to the node
// they came from, then selected so you land on what you asked for either way.
async function openSimilar(item) {
  const existing = locate(item);
  if (existing) {
    selectNode(existing, { focus: true });
    return;
  }
  const hubId = app.selectedId;
  if (!app.graph || !hubId) return;

  const token = app.token;
  status.loading(`Adding ${item.name} to the map`);
  try {
    const id = await attachNode(app.graph, hubId, item, {
      check() {
        if (token !== app.token) throw new StaleError();
      },
    });
    view.setGraph(app.graph);
    refreshAnalysis();
    status.info(`Added ${item.name} next to ${labelOf(hubId)}`);
    selectNode(id, { focus: true });
  } catch (err) {
    if (err instanceof StaleError) return;
    status.error(err.message);
  }
}

async function expand(id) {
  if (!app.graph?.hasNode(id)) return;
  const token = app.token;
  const node = app.graph.getNodeAttributes(id);
  const noun = node.kind === 'track' ? 'songs' : 'artists';
  status.loading(`Finding more ${noun} like ${node.label}`);
  try {
    const added = await expandNode(app.graph, id, {
      check() {
        if (token !== app.token) throw new StaleError();
      },
    });
    view.setGraph(app.graph);
    refreshAnalysis();
    status.info(
      added
        ? `Added ${added} ${added === 1 ? noun.slice(0, -1) : noun} near ${node.label}`
        : `Everything similar to ${node.label} is already on the map`,
    );
    if (!app.selectedId && !app.pathShown) showOverview();
  } catch (err) {
    if (err instanceof StaleError) return;
    status.error(err.message);
  }
}

const endpointFor = (id) => {
  const node = app.graph.getNodeAttributes(id);
  return { kind: node.kind, name: node.label, artist: node.artist };
};

function startPath(id) {
  app.pathFrom = id;
  view.select(id);
  view.setPickMode(true);
  search.setMode('pickEnd');
  status.info(`Choose the other end of the path from ${labelOf(id)}: select a node, or search for anything.`, {
    duration: 0,
    action: { label: 'Cancel', onClick: cancelPath },
  });
}

function cancelPath() {
  app.pathFrom = null;
  view.setPickMode(false);
  search.setMode('browse');
  status.hide();
}

// Picking an end that's on the current map: if a route already exists here,
// draw it straight away rather than rebuilding the map.
function finishPath(id) {
  const from = app.pathFrom;
  if (id === from) {
    cancelPath();
    return;
  }
  const steps = smoothestPath(app.graph, from, id);
  if (!steps) {
    finishPathWith(endpointFor(id));
    return;
  }
  cancelPath();
  app.path = steps;
  showPathPanel();
}

// Picking an end that isn't on the map, or isn't reachable on it. The map is
// rebuilt by growing outward from both ends until they meet.
function finishPathWith(endpoint) {
  const from = app.pathFrom;
  if (!from) return;
  const fromEndpoint = endpointFor(from);
  cancelPath();
  if (endpoint.id === from) return;
  navigate({ type: 'path', from: fromEndpoint, to: endpoint });
}

function clearPath() {
  app.pathShown = false;
  view.setPath(null);
  showOverview();
}

function somethingDifferent(id) {
  const far = farthestFrom(app.graph, id);
  if (!far) {
    status.info(`Nothing on this map is far from ${labelOf(id)} yet. Grow the map first.`);
    return;
  }
  selectNode(far, { focus: true });
  status.info(`${labelOf(far)} is about as far from ${labelOf(id)} as this map reaches.`);
}

// ---------- Layout ----------

function updateInsets() {
  const wide = window.matchMedia('(min-width: 760px)').matches;
  const header = document.querySelector('.topbar').getBoundingClientRect();
  const panelEl = $('panel');
  const panelBox = panelEl.hidden ? null : panelEl.getBoundingClientRect();
  view.setInset(
    wide
      ? { top: header.bottom + 8, right: panelBox ? window.innerWidth - panelBox.left : 0, bottom: 40, left: 0 }
      : // The sheet's target height, not its rect, which is stale mid-animation.
        { top: header.bottom, right: 0, bottom: sheet.heightPx(), left: 0 },
  );
}
window.addEventListener('resize', updateInsets);

// ---------- Static UI ----------

function initChrome() {
  $('settings-button').innerHTML = icons.key;
  $('settings-button').addEventListener('click', () => settings.open());
  $('back').innerHTML = icons.back;
  $('zoom-in').innerHTML = icons.plus;
  $('zoom-out').innerHTML = icons.minus;
  $('zoom-fit').innerHTML = icons.fit;
  $('zoom-in').addEventListener('click', () => view.zoomBy(1.35));
  $('zoom-out').addEventListener('click', () => view.zoomBy(1 / 1.35));
  $('zoom-fit').addEventListener('click', () => view.fit(true));

  document.querySelectorAll('[data-example]').forEach((button) => {
    button.addEventListener('click', () => {
      const [type, a, b] = button.dataset.example.split('|');
      if (type === 'artist') openArtist(a);
      if (type === 'track') openTrack(a, b);
      if (type === 'vibe') navigate({ type: 'vibe', tags: a.split(',') });
      if (type === 'path') {
        navigate({ type: 'path', from: { kind: 'artist', name: a }, to: { kind: 'artist', name: b } });
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      search.focus();
    } else if (event.key === 'Escape' && !typing && !document.querySelector('dialog[open]')) {
      clearSelection();
    }
  });
}

// A small decorative constellation for the empty state, drawn with the same
// coloring as real maps so the first screen previews what the tool makes.
function drawEmptyArt() {
  const svgEl = $('empty-art');
  const NS = 'http://www.w3.org/2000/svg';
  const size = 400;
  svgEl.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`);

  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const clusters = [[-95, -70], [85, -95], [120, 55], [-60, 110], [10, 5]];
  const points = [{ id: 'c', x: 0, y: 0, score: 1, r: 9 }];
  clusters.forEach(([cx, cy], i) => {
    for (let j = 0; j < (i === 4 ? 3 : 7); j++) {
      const a = rand() * Math.PI * 2;
      const d = 14 + rand() * 48;
      points.push({ id: `${i}-${j}`, x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, score: rand(), r: 2.5 + rand() * 4.5 });
    }
  });
  const colorAt = createSpectrum(points, 'c');
  const el = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  };

  const defs = el('defs', {});
  const blur = el('filter', { id: 'art-blur', x: '-100%', y: '-100%', width: '300%', height: '300%' });
  blur.append(el('feGaussianBlur', { stdDeviation: 5 }));
  defs.append(blur);
  svgEl.append(defs);

  const drawn = new Set();
  for (const p of points) {
    const nearest = points
      .filter((q) => q !== p)
      .map((q) => [q, Math.hypot(q.x - p.x, q.y - p.y)])
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3);
    for (const [q, d] of nearest) {
      const key = [p.id, q.id].sort().join();
      if (drawn.has(key) || d > 140) continue;
      drawn.add(key);
      svgEl.append(el('line', {
        x1: p.x, y1: p.y, x2: q.x, y2: q.y,
        stroke: colorAt((p.x + q.x) / 2, (p.y + q.y) / 2),
        'stroke-opacity': 0.4,
        'stroke-width': 1.2,
      }));
    }
  }
  const halos = el('g', { filter: 'url(#art-blur)', opacity: 0.4 });
  for (const p of points) halos.append(el('circle', { cx: p.x, cy: p.y, r: p.r * 2, fill: colorAt(p.x, p.y) }));
  svgEl.append(halos);
  for (const p of points) {
    svgEl.append(el('circle', { cx: p.x, cy: p.y, r: p.r, fill: colorAt(p.x, p.y), stroke: '#0b0d18', 'stroke-width': 1.5 }));
  }
}

// ---------- Start ----------

function start() {
  if (!lf.getApiKey()) {
    showEmpty();
    settings.open({ firstRun: true });
    return;
  }
  lf.popularTags(500)
    .then((tags) => (app.vocab = tags))
    .catch(() => {});

  const route = hashToRoute(location.hash);
  app.trail = [location.hash];
  if (route) load(route);
  else showEmpty();
}

initChrome();
drawEmptyArt();
start();
