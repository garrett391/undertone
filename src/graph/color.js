/**
 * Colors come from the layout itself. The center of the map (the seed, or the
 * strongest matches for a vibe) is near-white, like unsplit light. Moving outward,
 * color gets more vivid, and the direction you move in sets the hue. Because the
 * force layout pulls similar music together, neighbors share hues and distant
 * corners land on opposite sides of the color wheel.
 *
 * OKLCH keeps lightness perceptually even across hues, so yellow doesn't glare
 * and blue doesn't sink.
 */
export function createSpectrum(nodes, centerId) {
  let cx = 0;
  let cy = 0;
  const center = centerId ? nodes.find((n) => n.id === centerId) : null;

  if (center) {
    cx = center.x;
    cy = center.y;
  } else if (nodes.length) {
    let total = 0;
    for (const n of nodes) {
      const w = 0.2 + (n.score ?? 0);
      cx += n.x * w;
      cy += n.y * w;
      total += w;
    }
    cx /= total;
    cy /= total;
  }

  const distances = nodes.map((n) => Math.hypot(n.x - cx, n.y - cy)).sort((a, b) => a - b);
  const reach = Math.max(80, distances[Math.floor(distances.length * 0.9)] || 80);

  return function colorAt(x, y) {
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.min(1, Math.hypot(dx, dy) / reach);
    const t = Math.sqrt(r);
    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 380) % 360;
    const lightness = 0.955 - 0.17 * t;
    const chroma = 0.012 + 0.138 * t;
    return `oklch(${lightness.toFixed(3)} ${chroma.toFixed(3)} ${hue.toFixed(1)})`;
  };
}
