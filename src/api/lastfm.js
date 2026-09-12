import { cached } from './cache.js';

const BASE = 'https://ws.audioscrobbler.com/2.0/';
const KEY_STORAGE = 'undertone.lastfmKey';

// Last.fm asks clients to stay under ~5 requests per second.
const MIN_GAP_MS = 220;

export class LastfmError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- API key ----------

export function getApiKey() {
  const fromEnv = import.meta.env?.VITE_LASTFM_API_KEY;
  if (fromEnv) return fromEnv.trim();
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function saveApiKey(key) {
  localStorage.setItem(KEY_STORAGE, key.trim());
}

export function keyFromEnv() {
  return Boolean(import.meta.env?.VITE_LASTFM_API_KEY);
}

// ---------- Request plumbing ----------

let lastStart = 0;
let queue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throttle(task) {
  const turn = queue.then(async () => {
    const wait = Math.max(0, lastStart + MIN_GAP_MS - Date.now());
    if (wait) await sleep(wait);
    lastStart = Date.now();
  });
  queue = turn.catch(() => {});
  return turn.then(task);
}

async function call(method, params, { apiKey } = {}) {
  const key = apiKey || getApiKey();
  if (!key) throw new LastfmError(10, 'Add a Last.fm API key to start exploring.');

  const cacheKey =
    method + '?' + new URLSearchParams(Object.entries(params).sort()).toString().toLowerCase();

  const request = () =>
    throttle(async () => {
      const qs = new URLSearchParams({ method, api_key: key, format: 'json', ...params });
      let res;
      try {
        res = await fetch(`${BASE}?${qs}`);
      } catch {
        throw new LastfmError(-1, "Couldn't reach Last.fm. Check your internet connection and try again.");
      }
      let data;
      try {
        data = await res.json();
      } catch {
        throw new LastfmError(res.status, `Last.fm sent an unexpected response (HTTP ${res.status}). Try again in a moment.`);
      }
      if (data.error) throw new LastfmError(data.error, friendlyError(data.error, data.message));
      return data;
    });

  // Key checks bypass the cache so a bad key is never remembered as good.
  return apiKey ? request() : cached(cacheKey, request);
}

function friendlyError(code, message) {
  switch (code) {
    case 10:
    case 26:
      return "Last.fm didn't accept this API key. Check it in settings and paste it again.";
    case 29:
      return 'Last.fm is limiting requests right now. Wait a minute, then try again.';
    case 6:
      return message || "Last.fm couldn't find that.";
    default:
      return message || 'Last.fm returned an error. Try again in a moment.';
  }
}

// ---------- Normalizers ----------

// Last.fm returns a bare object instead of an array when there's exactly one result.
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const num = (x) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : 0;
};

const NOISE_TAGS = new Set([
  'seen live', 'favorites', 'favourites', 'favorite', 'favourite', 'my favorite',
  'my favourite', 'albums i own', 'love', 'awesome', 'spotify', 'check out',
  'under 2000 listeners', 'all', 'good', 'best', 'amazing', 'cool', 'fav', 'favs',
]);

function cleanTags(names, ownerName = '') {
  const owner = ownerName.toLowerCase();
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const t = String(raw || '').trim().toLowerCase();
    if (!t || t.length > 32 || NOISE_TAGS.has(t) || t === owner || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function stripBio(html = '') {
  return html
    .replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/i, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Public API ----------

export async function verifyKey(apiKey) {
  await call('chart.getTopTags', { limit: 1 }, { apiKey });
  return true;
}

export async function searchArtists(query, limit = 5) {
  const d = await call('artist.search', { artist: query, limit });
  return asArray(d.results?.artistmatches?.artist).map((a) => ({
    name: a.name,
    listeners: num(a.listeners),
  }));
}

export async function searchTracks(query, limit = 5) {
  const d = await call('track.search', { track: query, limit });
  return asArray(d.results?.trackmatches?.track).map((t) => ({
    name: t.name,
    artist: t.artist,
    listeners: num(t.listeners),
  }));
}

export async function similarArtists(name, limit = 30) {
  const d = await call('artist.getSimilar', { artist: name, limit, autocorrect: 1 });
  return {
    name: d.similarartists?.['@attr']?.artist || name,
    items: asArray(d.similarartists?.artist).map((a) => ({ name: a.name, match: num(a.match) })),
  };
}

export async function artistInfo(name) {
  const d = await call('artist.getInfo', { artist: name, autocorrect: 1 });
  const a = d.artist || {};
  return {
    name: a.name || name,
    url: a.url,
    listeners: num(a.stats?.listeners),
    tags: cleanTags(asArray(a.tags?.tag).map((t) => t.name), a.name),
    bio: stripBio(a.bio?.summary),
  };
}

export async function artistTopTags(name) {
  const d = await call('artist.getTopTags', { artist: name, autocorrect: 1 });
  return cleanTags(asArray(d.toptags?.tag).map((t) => t.name), name).slice(0, 10);
}

export async function artistTopTracks(name, limit = 6) {
  const d = await call('artist.getTopTracks', { artist: name, limit, autocorrect: 1 });
  return asArray(d.toptracks?.track).map((t) => ({
    name: t.name,
    artist: t.artist?.name || name,
    listeners: num(t.listeners),
  }));
}

export async function similarTracks(artist, track, limit = 30) {
  const d = await call('track.getSimilar', { artist, track, limit, autocorrect: 1 });
  return asArray(d.similartracks?.track)
    .filter((t) => t.name && t.artist?.name)
    .map((t) => ({ name: t.name, artist: t.artist.name, match: num(t.match) }));
}

export async function trackInfo(artist, track) {
  const d = await call('track.getInfo', { artist, track, autocorrect: 1 });
  const t = d.track || {};
  const artistName = t.artist?.name || artist;
  return {
    name: t.name || track,
    artist: artistName,
    album: t.album?.title || '',
    url: t.url,
    listeners: num(t.listeners),
    tags: cleanTags(asArray(t.toptags?.tag).map((x) => x.name), artistName),
  };
}

export async function tagTopArtists(tag, limit = 60) {
  const d = await call('tag.getTopArtists', { tag, limit });
  return asArray(d.topartists?.artist).map((a, i) => ({ name: a.name, rank: i }));
}

export async function popularTags(limit = 500) {
  const d = await call('chart.getTopTags', { limit });
  return cleanTags(asArray(d.tags?.tag).map((t) => t.name));
}
