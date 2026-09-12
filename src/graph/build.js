import Graph from 'graphology';
import * as lf from '../api/lastfm.js';
import { smoothestPath } from './analysis.js';

// Thrown when a newer search replaces the one in progress.
export class StaleError extends Error {}
// Thrown when Last.fm has too little data to draw a map.
export class EmptyMapError extends Error {}

export const artistId = (name) => 'a:' + name.toLowerCase();
export const trackId = (artist, name) => 't:' + artist.toLowerCase() + '|' + name.toLowerCase();

const idFor = (kind, item) => (kind === 'artist' ? artistId(item.name) : trackId(item.artist, item.name));

function nodeFor(kind, item, score, hop, extra = {}) {
  return kind === 'artist'
    ? { kind, label: item.name, score, hop, ...extra }
    : { kind, label: item.name, artist: item.artist, score, hop, ...extra };
}

function upsertNode(g, id, attrs) {
  if (!g.hasNode(id)) {
    g.addNode(id, attrs);
    return true;
  }
  const cur = g.getNodeAttributes(id);
  g.mergeNodeAttributes(id, {
    score: Math.max(cur.score ?? 0, attrs.score ?? 0),
    hop: Math.min(cur.hop ?? 9, attrs.hop ?? 9),
  });
  return false;
}

function upsertEdge(g, a, b, weight) {
  if (a === b || !g.hasNode(a) || !g.hasNode(b)) return;
  const w = Math.max(0.02, Math.min(1, weight));
  const e = g.edge(a, b);
  if (!e) g.addEdge(a, b, { weight: w });
  else if (w > g.getEdgeAttribute(e, 'weight')) g.setEdgeAttribute(e, 'weight', w);
}

// Keeps a song map from filling up with one artist's catalog.
function capPerArtist(tracks, cap) {
  const counts = new Map();
  return tracks.filter((t) => {
    const k = t.artist.toLowerCase();
    const n = counts.get(k) || 0;
    counts.set(k, n + 1);
    return n < cap;
  });
}

const MAX_LINKS_PER_HUB = 10;
const MIN_LINK = 0.15;

const rethrowStale = (err) => {
  if (err instanceof StaleError) throw err;
};

/**
 * Fetches each hub's own similar list and links it to nodes already on the map,
 * which turns a star around the seed into a real network. A few strong new
 * neighbors are added too, so the map reaches a little further out.
 */
async function weave(g, kind, hubs, ctx, { maxNew = 2, minMatch = 0.45 } = {}) {
  let done = 0;
  await Promise.all(
    hubs.map(async (hub) => {
      let items = [];
      try {
        items =
          kind === 'artist'
            ? (await lf.similarArtists(hub.name, 40)).items
            : capPerArtist(await lf.similarTracks(hub.artist, hub.name, 30), 3);
      } catch (err) {
        rethrowStale(err);
        return; // One failed hub shouldn't sink the whole map.
      }
      ctx.check();
      const hubId = idFor(kind, hub);
      let added = 0;
      let linked = 0;
      for (const item of items) {
        const id = idFor(kind, item);
        if (g.hasNode(id)) {
          // Only the hub's strongest links, so the map stays readable instead of a hairball.
          if (linked < MAX_LINKS_PER_HUB && item.match >= MIN_LINK) {
            upsertEdge(g, hubId, id, item.match);
            linked++;
          }
        } else if (added < maxNew && item.match >= minMatch) {
          upsertNode(g, id, nodeFor(kind, item, (hub.match ?? 0.6) * item.match * 0.8, 2));
          upsertEdge(g, hubId, id, item.match);
          added++;
        }
      }
      done++;
      ctx.progress(`Connecting the map, ${done} of ${hubs.length}`);
      ctx.update(g);
    }),
  );
}

// ---------- Artist map ----------

export async function buildArtistMap(name, ctx) {
  ctx.progress(`Finding artists like ${name}`);
  let first;
  try {
    first = await lf.similarArtists(name, 30);
  } catch (err) {
    if (err.code === 6) {
      throw new EmptyMapError(`Last.fm couldn't find an artist called “${name}”. Check the spelling, or pick a match from the search list.`);
    }
    throw err;
  }
  ctx.check();
  if (!first.items.length) {
    throw new EmptyMapError(
      `Last.fm doesn't have similar artists for “${name}”. Check the spelling, or pick a match from the search list.`,
    );
  }

  const g = new Graph({ type: 'undirected' });
  const seedId = artistId(first.name);
  g.addNode(seedId, nodeFor('artist', { name: first.name }, 1, 0, { seed: true }));
  for (const a of first.items) {
    upsertNode(g, artistId(a.name), nodeFor('artist', a, a.match, 1));
    upsertEdge(g, seedId, artistId(a.name), a.match);
  }
  ctx.update(g, { fresh: true, centerId: seedId });

  await weave(g, 'artist', first.items.slice(0, 12), ctx);
  return { graph: g, seedId, seedLabel: first.name };
}

// ---------- Song map ----------

async function estimateFromArtists(artist, ctx) {
  const sim = await lf.similarArtists(artist, 10);
  ctx.check();
  const lists = await Promise.all(
    sim.items.slice(0, 6).map((a) =>
      lf
        .artistTopTracks(a.name, 3)
        .then((tops) => tops.map((t, i) => ({ ...t, match: a.match * (1 - i * 0.15) })))
        .catch((err) => {
          rethrowStale(err);
          return [];
        }),
    ),
  );
  ctx.check();
  return lists.flat();
}

export async function buildTrackMap(artist, name, ctx) {
  ctx.progress(`Finding songs like ${name}`);
  let info;
  try {
    info = await lf.trackInfo(artist, name);
  } catch (err) {
    if (err.code === 6) {
      throw new EmptyMapError(`Last.fm couldn't find “${name}” by ${artist}. Try picking it from the search list.`);
    }
    throw err;
  }
  ctx.check();

  const g = new Graph({ type: 'undirected' });
  const seedId = trackId(info.artist, info.name);
  g.addNode(seedId, nodeFor('track', info, 1, 0, { seed: true }));

  let first = capPerArtist(await lf.similarTracks(info.artist, info.name, 50), 3).slice(0, 30);
  ctx.check();
  let estimated = false;
  if (!first.length) {
    ctx.progress(`Looking for songs through ${info.artist}'s similar artists`);
    first = await estimateFromArtists(info.artist, ctx);
    estimated = true;
  }
  if (!first.length) {
    throw new EmptyMapError(
      `Last.fm doesn't have enough listening data to find songs like “${info.name}”. Try exploring ${info.artist} instead.`,
    );
  }

  for (const t of first) {
    const id = trackId(t.artist, t.name);
    upsertNode(g, id, nodeFor('track', t, t.match, 1));
    upsertEdge(g, seedId, id, t.match);
  }
  ctx.update(g, { fresh: true, centerId: seedId });

  if (!estimated) await weave(g, 'track', first.slice(0, 8), ctx);
  return { graph: g, seedId, seedLabel: info.name, seedArtist: info.artist, estimated };
}

// ---------- Vibe map ----------

export async function buildVibeMap(tags, ctx) {
  const listFormat = new Intl.ListFormat('en', { type: 'conjunction' });
  ctx.progress(`Finding artists tagged ${listFormat.format(tags)}`);

  const PER_TAG = 60;
  const lists = await Promise.all(
    tags.map((t) =>
      lf.tagTopArtists(t, PER_TAG).catch((err) => {
        if (err.code === 6) return [];
        throw err;
      }),
    ),
  );
  ctx.check();

  // Artists near the top of several tag lists score highest.
  const acc = new Map();
  lists.forEach((list) =>
    list.forEach((a) => {
      const id = artistId(a.name);
      const r = acc.get(id) || { name: a.name, sum: 0, count: 0 };
      r.sum += 1 - a.rank / PER_TAG;
      r.count += 1;
      acc.set(id, r);
    }),
  );
  if (!acc.size) {
    throw new EmptyMapError(
      `No artists are tagged ${listFormat.format(tags.map((t) => `“${t}”`))} on Last.fm. Try a broader word, like “chill” or “ambient”.`,
    );
  }

  const ranked = [...acc.values()]
    .map((r) => ({
      name: r.name,
      matches: r.count,
      raw: (r.count / tags.length) * (0.45 + 0.55 * (r.sum / r.count)),
    }))
    .sort((a, b) => b.raw - a.raw)
    .slice(0, 28);
  const top = ranked[0].raw;

  const g = new Graph({ type: 'undirected' });
  for (const r of ranked) {
    upsertNode(g, artistId(r.name), nodeFor('artist', r, r.raw / top, 1, { matches: r.matches }));
  }
  ctx.update(g, { fresh: true, centerId: null });

  await weave(
    g,
    'artist',
    ranked.slice(0, 14).map((r) => ({ name: r.name, match: r.raw / top })),
    ctx,
    { maxNew: 1, minMatch: 0.6 },
  );
  return { graph: g, seedId: null, seedLabel: null };
}

// ---------- Growing the map ----------

export async function expandNode(g, id, ctx, limit = 10) {
  const node = g.getNodeAttributes(id);
  const kind = node.kind;
  const items =
    kind === 'artist'
      ? (await lf.similarArtists(node.label, 40)).items
      : capPerArtist(await lf.similarTracks(node.artist, node.label, 40), 3);
  ctx.check();

  let added = 0;
  for (const item of items) {
    const otherId = idFor(kind, item);
    if (g.hasNode(otherId)) {
      upsertEdge(g, id, otherId, item.match);
    } else if (added < limit) {
      upsertNode(g, otherId, nodeFor(kind, item, Math.max(0.15, (node.score ?? 0.5) * item.match), (node.hop ?? 1) + 1));
      upsertEdge(g, id, otherId, item.match);
      added++;
    }
  }
  g.setNodeAttribute(id, 'expanded', true);
  return added;
}

/**
 * Adds one specific neighbor to the map and wires it into everything already
 * there, without pulling in anything else. Used by the similar lists in the
 * detail panel, where the point is to add the one you picked.
 */
export async function attachNode(g, hubId, item, ctx) {
  const kind = g.getNodeAttributes(hubId).kind;
  const id = idFor(kind, item);
  if (!g.hasNode(id)) {
    const hub = g.getNodeAttributes(hubId);
    upsertNode(g, id, nodeFor(kind, item, Math.max(0.15, (hub.score ?? 0.5) * item.match), (hub.hop ?? 1) + 1));
  }
  upsertEdge(g, hubId, id, item.match);
  try {
    await expandNode(g, id, ctx, 0); // limit 0: link to existing nodes only.
  } catch (err) {
    rethrowStale(err); // A failed wiring pass still leaves the node on the map.
  }
  return id;
}

// ---------- Paths between maps ----------

export class PathNotFoundError extends Error {
  // `exhausted` means there was nowhere left to look, not that the budget ran
  // out — searching harder would return the same answer.
  constructor(message, { checked, exhausted = false } = {}) {
    super(message);
    this.checked = checked;
    this.exhausted = exhausted;
  }
}

// Budgets count fetches (one song or artist asked "who are you similar to?"),
// not results: each fetch returns up to 50 neighbors. Songs get a short direct
// attempt, then route through artists, whose space is dense enough to nearly
// always connect.
export const PATH_BUDGET = { default: 32, max: 96, songDirect: 20 };

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

// Both ends of a path have to be the same kind of thing. If they aren't, the
// odd one out is converted: an artist becomes its most played song, and a song
// becomes the artist who made it.
async function matchKind(ep, kind) {
  if (ep.kind === kind) return ep;
  if (kind === 'artist') return { kind: 'artist', name: ep.artist, convertedFrom: ep.name };
  const tops = await lf.artistTopTracks(ep.name, 1);
  if (!tops.length) {
    throw new EmptyMapError(`Last.fm doesn't list any songs for ${ep.name}, so it can't be one end of a song path.`);
  }
  return { kind: 'track', artist: tops[0].artist, name: tops[0].name, convertedFrom: ep.name };
}

async function neighborsOf(kind, node, limit = 50) {
  if (kind === 'artist') {
    const r = await lf.similarArtists(node.label, limit);
    return { name: r.name, items: r.items };
  }
  return { name: node.label, items: await lf.similarTracks(node.artist, node.label, limit) };
}

// Resolves an endpoint to its canonical Last.fm spelling and its first ring of neighbors.
async function seedSide(ep, kind) {
  if (kind === 'artist') {
    let r;
    try {
      r = await lf.similarArtists(ep.name, 50);
    } catch (err) {
      if (err.code === 6) throw new EmptyMapError(`Last.fm couldn't find an artist called “${ep.name}”.`);
      throw err;
    }
    if (!r.items.length) {
      throw new EmptyMapError(`Last.fm doesn't have similar artists for “${r.name}”, so it can't be one end of a path.`);
    }
    return { node: { kind, label: r.name }, items: r.items };
  }

  let info;
  try {
    info = await lf.trackInfo(ep.artist, ep.name);
  } catch (err) {
    if (err.code === 6) throw new EmptyMapError(`Last.fm couldn't find “${ep.name}” by ${ep.artist}.`);
    throw err;
  }
  // A song with no similar-song data can still be routed through its artist.
  const items = await lf.similarTracks(info.artist, info.name, 50);
  return { node: { kind, label: info.name, artist: info.artist }, items };
}

/**
 * The two-ended search. Grows outward from both ends at once, strongest links
 * first, until the sides meet. Every fetch also links back to nodes already
 * found, so when the sides touch there's a real weighted graph to route through.
 *
 * Returns how the search ended; the caller decides what to do about it.
 */
async function searchBothEnds(g, kind, ends, seeds, ctx, { budget, noun }) {
  const seen = { a: new Set([ends.a]), b: new Set([ends.b]) };
  const frontier = { a: [], b: [] };
  const fetched = new Set([ends.a, ends.b]);
  const minMatch = kind === 'track' ? 0.15 : 0.2;
  let meeting = null;

  // Adds one fetch's worth of neighbors, and reports back if the far side got here first.
  function absorb(side, hubId, hub, items, hop) {
    const forFrontier = kind === 'track' ? capPerArtist(items, 3) : items;
    const frontierIds = new Set(forFrontier.slice(0, 16).map((i) => idFor(kind, i)));
    const other = side === 'a' ? 'b' : 'a';
    let hit = null;

    for (const item of items) {
      const id = idFor(kind, item);
      if (id === hubId) continue;
      upsertNode(g, id, nodeFor(kind, item, Math.max(0.1, (hub.score ?? 1) * item.match), hop));
      upsertEdge(g, hubId, id, item.match);

      if (!hit && seen[other].has(id)) hit = id;
      if (!seen[side].has(id)) {
        seen[side].add(id);
        if (frontierIds.has(id) && item.match >= minMatch) frontier[side].push({ id, hop, match: item.match });
      }
    }
    return hit;
  }

  // Both sides absorb before any short-circuiting, so each seed's ring is on the map.
  const hitA = absorb('a', ends.a, { score: 1 }, seeds.a, 1);
  const hitB = absorb('b', ends.b, { score: 1 }, seeds.b, 1);
  meeting = hitA || hitB;

  // Strongest links first, nearest ring first.
  const nextUp = (side) => {
    frontier[side].sort((x, y) => x.hop - y.hop || y.match - x.match);
    while (frontier[side].length) {
      const candidate = frontier[side].shift();
      if (!fetched.has(candidate.id)) return candidate;
    }
    return null;
  };

  let checked = 2;
  let exhausted = false;
  while (!meeting && checked < budget) {
    const batch = [];
    for (const side of ['a', 'b']) {
      for (let i = 0; i < 2; i++) {
        if (checked + batch.length >= budget) break;
        const next = nextUp(side);
        if (!next) break;
        fetched.add(next.id);
        batch.push({ side, ...next });
      }
    }
    if (!batch.length) {
      exhausted = true;
      break;
    }

    checked += batch.length;
    ctx.progress(`Checked ${checked} ${noun} from both ends`);

    const results = await Promise.all(
      batch.map((b) =>
        neighborsOf(kind, g.getNodeAttributes(b.id))
          .then((r) => ({ ...b, items: r.items }))
          .catch((err) => {
            rethrowStale(err);
            return { ...b, items: [] };
          }),
      ),
    );
    ctx.check();

    for (const r of results) {
      const hit = absorb(r.side, r.id, g.getNodeAttributes(r.id), r.items, r.hop + 1);
      if (hit && !meeting) meeting = hit;
    }
  }

  return { meeting, checked, exhausted, fetched };
}

// Fill in around a route so the path picked is the smoothest one available,
// not just the first that happened to close the gap.
async function enrichAround(g, kind, path, fetched, ctx) {
  const toEnrich = path.filter((id) => !fetched.has(id)).slice(0, 6);
  if (!toEnrich.length) return;
  ctx.progress('Checking for a smoother route');
  const extra = await Promise.all(
    toEnrich.map((id) =>
      neighborsOf(kind, g.getNodeAttributes(id))
        .then((r) => ({ id, items: r.items }))
        .catch((err) => {
          rethrowStale(err);
          return { id, items: [] };
        }),
    ),
  );
  ctx.check();
  for (const r of extra) {
    fetched.add(r.id);
    for (const item of r.items) {
      const otherId = idFor(kind, item);
      if (g.hasNode(otherId)) upsertEdge(g, r.id, otherId, item.match);
    }
  }
}

/**
 * Picks the nodes worth showing once a route is found: every step of the path,
 * plus each step's closest neighbors, so the path sits inside the music it
 * travels through rather than floating alone.
 */
function corridorGraph(g, path, ends, { perStep = 6, max = 64 } = {}) {
  const keep = new Map(path.map((id, i) => [id, { score: 0.92, hop: 0, step: i }]));

  for (const id of path) {
    const neighbors = g
      .mapNeighbors(id, (nb) => ({ id: nb, weight: g.getEdgeAttribute(g.edge(id, nb), 'weight') }))
      .filter((n) => !keep.has(n.id))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, perStep);
    for (const n of neighbors) {
      if (keep.size >= max) break;
      const cur = keep.get(n.id);
      if (!cur || n.weight * 0.55 > cur.score) keep.set(n.id, { score: n.weight * 0.55, hop: 1 });
    }
  }

  const out = new Graph({ type: 'undirected' });
  for (const [id, meta] of keep) {
    const attrs = g.getNodeAttributes(id);
    out.addNode(id, { ...attrs, score: meta.score, hop: meta.hop });
  }
  g.forEachEdge((_e, attrs, source, target) => {
    if (keep.has(source) && keep.has(target)) out.addEdge(source, target, { weight: attrs.weight });
  });

  out.mergeNodeAttributes(ends.a, { seed: true, anchor: 'start', score: 1 });
  out.mergeNodeAttributes(ends.b, { seed: true, anchor: 'end', score: 1 });
  return out;
}

// A small map of just the two ends and their nearest neighbors, so the canvas
// shows both destinations while the search between them runs.
function previewGraph(g, ends, rings) {
  const out = new Graph({ type: 'undirected' });
  for (const side of ['a', 'b']) {
    const id = ends[side];
    out.addNode(id, { ...g.getNodeAttributes(id), seed: true, anchor: side === 'a' ? 'start' : 'end', score: 1 });
    for (const item of rings[side].slice(0, 8)) {
      const nbId = idFor(g.getNodeAttribute(id, 'kind'), item);
      if (nbId === id || out.hasNode(nbId) || !g.hasNode(nbId)) continue;
      out.addNode(nbId, { ...g.getNodeAttributes(nbId), score: item.match * 0.5, hop: 1 });
      out.addEdge(id, nbId, { weight: item.match });
    }
  }
  return out;
}

// ---------- Routing songs through artists ----------

/**
 * Walks an artist path and chooses one song per artist along the way. At each
 * step the candidates are songs by that artist that Last.fm links to the song
 * already chosen, plus the artist's most played songs; each is scored on how
 * well it follows the previous pick and leads toward the next stop. This is
 * the seed of the playlist engine: key and tempo will join the score later.
 */
async function songsAlongArtists(g, artistPath, startSong, endSong, ctx) {
  const chosen = [startSong];
  const absorbSimilar = (song, items) => {
    const hubId = trackId(song.artist, song.label);
    for (const item of items) {
      const id = trackId(item.artist, item.name);
      if (id === hubId) continue;
      upsertNode(g, id, nodeFor('track', item, Math.max(0.1, item.match), 2));
      upsertEdge(g, hubId, id, item.match);
    }
  };
  const matchFor = (items, song) =>
    items.find((t) => sameName(t.artist, song.artist) && sameName(t.name, song.label))?.match ?? 0;
  const bestByArtist = (items, artist) =>
    items.reduce((best, t) => (sameName(t.artist, artist) && t.match > best ? t.match : best), 0);

  for (let i = 1; i < artistPath.length - 1; i++) {
    const artist = artistPath[i];
    const prev = chosen[chosen.length - 1];
    const nextArtist = artistPath[i + 1];
    const nextIsEnd = i + 1 === artistPath.length - 1;
    ctx.progress(`Picking a song by ${artist}`);

    // Songs by this artist that Last.fm already links to the previous pick.
    let prevSim = [];
    try {
      prevSim = await lf.similarTracks(prev.artist, prev.label, 100);
      absorbSimilar(prev, prevSim);
    } catch (err) {
      rethrowStale(err);
    }
    ctx.check();
    const linked = prevSim.filter((t) => sameName(t.artist, artist)).sort((x, y) => y.match - x.match);

    let tops = [];
    try {
      tops = await lf.artistTopTracks(artist, 4);
    } catch (err) {
      rethrowStale(err);
    }
    ctx.check();

    const candidates = [];
    const seenNames = new Set();
    for (const t of [...linked.slice(0, 2), ...tops]) {
      const key = t.name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      candidates.push({ label: t.name, artist: t.artist || artist, back: t.match ?? 0, rank: candidates.length });
    }
    if (!candidates.length) continue; // Nothing known for this artist; skip the stop.

    // One fetch per candidate scores both directions: does it follow the
    // previous song, and does it lead toward the next stop?
    const scored = await Promise.all(
      candidates.slice(0, 5).map(async (c) => {
        let sim = [];
        try {
          sim = await lf.similarTracks(c.artist, c.label, 60);
          absorbSimilar(c, sim);
        } catch (err) {
          rethrowStale(err);
        }
        const back = Math.max(c.back, matchFor(sim, prev));
        const forward = nextIsEnd ? matchFor(sim, endSong) : bestByArtist(sim, nextArtist);
        return { ...c, back, forward, score: back + forward + 0.04 * (4 - Math.min(4, c.rank)) };
      }),
    );
    ctx.check();

    const pick = scored.sort((x, y) => y.score - x.score)[0];
    const pickId = trackId(pick.artist, pick.label);
    upsertNode(g, pickId, nodeFor('track', { name: pick.label, artist: pick.artist }, 0.9, 1));
    // Consecutive picks always get an edge; a weak one if Last.fm has no direct link.
    upsertEdge(g, trackId(prev.artist, prev.label), pickId, Math.max(0.3, pick.back));
    chosen.push({ label: pick.label, artist: pick.artist });
  }

  const last = chosen[chosen.length - 1];
  const lastId = trackId(last.artist, last.label);
  const endId = trackId(endSong.artist, endSong.label);
  if (lastId !== endId) {
    let weight = 0.3;
    try {
      weight = Math.max(weight, matchFor(await lf.similarTracks(last.artist, last.label, 100), endSong));
    } catch (err) {
      rethrowStale(err);
    }
    upsertEdge(g, lastId, endId, weight);
    chosen.push(endSong);
  }
  return chosen.map((s) => trackId(s.artist, s.label));
}

async function routeSongsViaArtists(g, ends, songA, songB, ctx, { budget }) {
  ctx.progress("Songs don't link directly. Routing through their artists");
  const ag = new Graph({ type: 'undirected' });
  const [seedA, seedB] = await Promise.all([
    seedSide({ kind: 'artist', name: songA.artist }, 'artist'),
    seedSide({ kind: 'artist', name: songB.artist }, 'artist'),
  ]);
  ctx.check();

  const aEnds = { a: artistId(seedA.node.label), b: artistId(seedB.node.label) };
  let artistPath;
  let checked = 2;
  if (aEnds.a === aEnds.b) {
    artistPath = [seedA.node.label];
  } else {
    ag.addNode(aEnds.a, nodeFor('artist', { name: seedA.node.label }, 1, 0));
    ag.addNode(aEnds.b, nodeFor('artist', { name: seedB.node.label }, 1, 0));
    const result = await searchBothEnds(ag, 'artist', aEnds, { a: seedA.items, b: seedB.items }, ctx, {
      budget,
      noun: 'artists',
    });
    checked = result.checked;
    if (!result.meeting) return { ...result, path: null };
    await enrichAround(ag, 'artist', smoothestPath(ag, aEnds.a, aEnds.b), result.fetched, ctx);
    artistPath = smoothestPath(ag, aEnds.a, aEnds.b).map((id) => ag.getNodeAttribute(id, 'label'));
  }

  const path = await songsAlongArtists(g, artistPath, songA, songB, ctx);
  ctx.check();
  return { path, checked, artistPath, meeting: true, exhausted: false };
}

// ---------- Building a path map ----------

export async function buildPathMap(fromEp, toEp, ctx, { budget = PATH_BUDGET.default } = {}) {
  const kind = fromEp.kind;
  const noun = kind === 'artist' ? 'artists' : 'songs';

  ctx.progress('Looking up both ends');
  const dest = await matchKind(toEp, kind);
  ctx.check();
  const [seedA, seedB] = await Promise.all([seedSide(fromEp, kind), seedSide(dest, kind)]);
  ctx.check();

  const g = new Graph({ type: 'undirected' });
  const ends = {
    a: idFor(kind, { name: seedA.node.label, artist: seedA.node.artist }),
    b: idFor(kind, { name: seedB.node.label, artist: seedB.node.artist }),
  };
  if (ends.a === ends.b) {
    throw new EmptyMapError('Both ends of the path are the same. Pick two different starting points.');
  }
  for (const side of ['a', 'b']) {
    const seed = side === 'a' ? seedA : seedB;
    g.addNode(ends[side], nodeFor(kind, { name: seed.node.label, artist: seed.node.artist }, 1, 0));
  }

  const seeds = { a: seedA.items, b: seedB.items };
  const direct = await searchBothEnds(g, kind, ends, seeds, ctx, {
    budget: kind === 'track' ? Math.min(budget, PATH_BUDGET.songDirect) : budget,
    noun,
  });
  ctx.update(previewGraph(g, ends, seeds), { fresh: true, centerId: null });

  let path = null;
  let via = 'direct';
  let checked = direct.checked;
  let artistPath = null;

  if (direct.meeting) {
    await enrichAround(g, kind, smoothestPath(g, ends.a, ends.b), direct.fetched, ctx);
    path = smoothestPath(g, ends.a, ends.b);
  }

  if (!path && kind === 'track') {
    const routed = await routeSongsViaArtists(g, ends, seedA.node, seedB.node, ctx, { budget });
    ctx.check();
    checked += routed.checked;
    if (routed.path) {
      path = routed.path;
      via = 'artists';
      artistPath = routed.artistPath;
    } else if (routed.exhausted) {
      throw new PathNotFoundError(
        `No route connects ${seedA.node.artist} and ${seedB.node.artist}, so there's no way to walk from ${seedA.node.label} to ${seedB.node.label}. Every strong link from both artists was followed and the two sides never met.`,
        { checked, exhausted: true },
      );
    }
  }

  if (!path) {
    throw new PathNotFoundError(
      direct.exhausted
        ? `No route connects ${seedA.node.label} and ${seedB.node.label}. Every strong link from both ends was followed — ${checked} ${noun} in all — and the two sides never met.`
        : `No route turned up between ${seedA.node.label} and ${seedB.node.label} after checking ${checked} ${noun}.`,
      { checked, exhausted: direct.exhausted },
    );
  }

  return {
    graph: corridorGraph(g, path, ends),
    path,
    ends,
    via,
    artistPath,
    fromLabel: seedA.node.label,
    toLabel: seedB.node.label,
    converted: dest.convertedFrom ? { from: dest.convertedFrom, to: seedB.node.label } : null,
    checked,
    kind,
  };
}
