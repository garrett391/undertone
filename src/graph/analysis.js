import louvain from 'graphology-communities-louvain';
import betweenness from 'graphology-metrics/centrality/betweenness';

// Strong similarity = short distance. The small floor keeps every hop from being free.
const cost = (weight) => 1.05 - Math.min(1, weight);

/**
 * Scenes come from Louvain community detection. Bridges are nodes with high
 * betweenness centrality whose neighbors sit in more than one scene: the
 * artists or songs that connect different corners of the map.
 */
export function analyze(g, seedId) {
  const result = { communities: {}, sceneCount: 0, bridges: [] };
  if (g.order < 4 || g.size < 3) return result;

  try {
    result.communities = louvain(g, { getEdgeWeight: 'weight' });
  } catch {
    return result;
  }
  result.sceneCount = new Set(Object.values(result.communities)).size;

  const centrality = betweenness(g, {
    getEdgeWeight: (_edge, attrs) => cost(attrs.weight),
    normalized: true,
  });

  const candidates = [];
  g.forEachNode((id) => {
    if (id === seedId) return;
    const scenes = new Set([result.communities[id]]);
    g.forEachNeighbor(id, (nb) => scenes.add(result.communities[nb]));
    if (scenes.size >= 2 && centrality[id] > 0) candidates.push({ id, score: centrality[id] });
  });
  result.bridges = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.id);
  return result;
}

// Plain Dijkstra; maps stay small (a few hundred nodes at most).
export function shortestDistances(g, source) {
  const dist = new Map([[source, 0]]);
  const prev = new Map();
  const done = new Set();
  const frontier = new Set([source]);

  while (frontier.size) {
    let current = null;
    for (const id of frontier) if (current === null || dist.get(id) < dist.get(current)) current = id;
    frontier.delete(current);
    done.add(current);

    g.forEachEdge(current, (_e, attrs, s, t) => {
      const next = s === current ? t : s;
      if (done.has(next)) return;
      const d = dist.get(current) + cost(attrs.weight);
      if (!dist.has(next) || d < dist.get(next)) {
        dist.set(next, d);
        prev.set(next, current);
        frontier.add(next);
      }
    });
  }
  return { dist, prev };
}

export function smoothestPath(g, from, to) {
  if (!g.hasNode(from) || !g.hasNode(to)) return null;
  const { dist, prev } = shortestDistances(g, from);
  if (!dist.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]));
  return path;
}

export function hopsBetween(g, from, to) {
  const path = smoothestPath(g, from, to);
  return path ? path.length - 1 : null;
}

export function farthestFrom(g, source) {
  const { dist } = shortestDistances(g, source);
  let best = null;
  for (const [id, d] of dist) if (id !== source && (best === null || d > dist.get(best))) best = id;
  return best;
}
