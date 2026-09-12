import Graph from 'graphology';
import * as lf from '../api/lastfm.js';

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
