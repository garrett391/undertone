import { createStore, get, set, clear } from 'idb-keyval';

// Responses are cached in memory for the session and in IndexedDB for a week,
// so maps you've already explored load instantly and stay under rate limits.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const memory = new Map();
let store = null;

function getStore() {
  if (store) return store;
  try {
    if (typeof indexedDB !== 'undefined') store = createStore('undertone', 'responses');
  } catch {
    store = null; // Private browsing or disabled storage: fall back to memory only.
  }
  return store;
}

export async function cached(key, fetcher) {
  if (memory.has(key)) return memory.get(key);

  const db = getStore();
  if (db) {
    try {
      const hit = await get(key, db);
      if (hit && Date.now() - hit.t < TTL_MS) {
        memory.set(key, hit.v);
        return hit.v;
      }
    } catch {
      /* ignore storage errors */
    }
  }

  // Store the in-flight promise so simultaneous requests for the same key share one fetch.
  const pending = fetcher();
  memory.set(key, pending);
  try {
    const value = await pending;
    memory.set(key, value);
    if (db) set(key, { t: Date.now(), v: value }, db).catch(() => {});
    return value;
  } catch (err) {
    memory.delete(key);
    throw err;
  }
}

export async function clearCache() {
  memory.clear();
  const db = getStore();
  if (db) await clear(db);
}
