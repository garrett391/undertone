import * as d3 from 'd3';
import { createSpectrum } from '../graph/color.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function createGraphView(container, handlers = {}) {
  const svg = d3
    .select(container)
    .append('svg')
    .attr('class', 'map')
    .attr('role', 'group')
    .attr('aria-label', 'Music map');

  svg
    .append('defs')
    .append('filter')
    .attr('id', 'halo-blur')
    .attr('x', '-100%')
    .attr('y', '-100%')
    .attr('width', '300%')
    .attr('height', '300%')
    .append('feGaussianBlur')
    .attr('stdDeviation', 6);

  const root = svg.append('g');
  const edgeLayer = root.append('g').attr('class', 'edges');
  const haloLayer = root.append('g').attr('class', 'halos').attr('filter', 'url(#halo-blur)');
  const nodeLayer = root.append('g').attr('class', 'nodes');

  const tooltip = d3.select(container).append('div').attr('class', 'tooltip').attr('aria-hidden', 'true');

  let nodes = [];
  let links = [];
  let byId = new Map();
  let degree = new Map();
  let centerId = null;
  let bridges = new Set();
  let selectedId = null;
  let hoverId = null;
  let path = null;
  let active = null;
  let needsFit = false;
  let tickCount = 0;
  let transform = d3.zoomIdentity;
  let inset = { top: 0, right: 0, bottom: 0, left: 0 };

  let edgeSel = edgeLayer.selectAll('line');
  let haloSel = haloLayer.selectAll('circle');
  let nodeSel = nodeLayer.selectAll('g.node');

  // ---------- Zoom and pan ----------

  const zoom = d3
    .zoom()
    .scaleExtent([0.2, 5])
    .on('zoom', (event) => {
      transform = event.transform;
      root.attr('transform', transform);
      updateLabels();
    });

  svg.call(zoom).on('dblclick.zoom', null);
  svg.on('click', (event) => {
    if (event.target === svg.node()) handlers.onBackground?.();
  });

  function viewport() {
    const { width, height } = container.getBoundingClientRect();
    const w = Math.max(80, width - inset.left - inset.right);
    const h = Math.max(80, height - inset.top - inset.bottom);
    return { w, h, cx: inset.left + w / 2, cy: inset.top + h / 2 };
  }

  function centerView() {
    const { cx, cy } = viewport();
    svg.call(zoom.transform, d3.zoomIdentity.translate(cx, cy));
  }
  centerView();

  // ---------- Force simulation ----------

  const sim = d3
    .forceSimulation()
    .force(
      'link',
      d3
        .forceLink()
        .id((d) => d.id)
        .distance((l) => 36 + (1 - l.weight) * 130)
        .strength((l) => {
          const lesser = Math.min(degree.get(l.source.id) || 1, degree.get(l.target.id) || 1);
          return (0.3 + 0.7 * l.weight) / Math.max(1, lesser);
        }),
    )
    .force('charge', d3.forceManyBody().strength((d) => -80 - d.r * 9).distanceMax(420))
    .force('x', d3.forceX(0).strength(0.045))
    .force('y', d3.forceY(0).strength(0.045))
    .force('collide', d3.forceCollide((d) => d.r + 6))
    .alphaDecay(0.035)
    .on('tick', render);
  sim.stop();

  const drag = d3
    .drag()
    .on('start', (event, d) => {
      if (!event.active && !reduceMotion) sim.alphaTarget(0.2).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
      if (reduceMotion) {
        d.x = event.x;
        d.y = event.y;
        render();
      }
    })
    .on('end', (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      if (d.pinned) return; // Anchored ends stay where they're dropped.
      d.fx = null;
      d.fy = null;
    });

  // ---------- Data ----------

  function setGraph(graph, options = {}) {
    if ('centerId' in options) centerId = options.centerId;
    if (options.bridges) bridges = new Set(options.bridges);
    if (options.fresh) {
      byId = new Map();
      path = null;
      selectedId = null;
      centerView();
    }

    const previous = byId;
    byId = new Map();
    nodes = graph.mapNodes((id, attrs) => {
      const node = previous.get(id) || { id };
      const hadAnchor = node.anchor;
      Object.assign(node, attrs);
      node.r = attrs.seed ? 15 : 5 + (attrs.score ?? 0.3) * 9;
      if (node.x == null || (attrs.anchor && !hadAnchor)) placeNear(node, graph, previous);
      if (!attrs.anchor && node.pinned) {
        node.anchor = undefined;
        node.pinned = false;
        node.fx = null;
        node.fy = null;
      }
      byId.set(id, node);
      return node;
    });

    links = graph.mapEdges((id, attrs, source, target) => ({ id, source, target, weight: attrs.weight }));
    degree = new Map();
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) || 0) + 1);
      degree.set(l.target, (degree.get(l.target) || 0) + 1);
    }

    sim.nodes(nodes);
    sim.force('link').links(links);
    join();

    if (options.fresh) needsFit = true;
    if (reduceMotion) {
      sim.alpha(1);
      for (let i = 0; i < 300; i++) sim.tick();
      render();
      if (needsFit) fit(false);
    } else {
      sim.alpha(options.fresh ? 0.9 : Math.max(sim.alpha(), 0.3)).restart();
    }
    applyEmphasis();
  }

  function placeNear(node, graph, previous) {
    // Path maps have two anchored ends, pinned apart so the route reads across the map.
    if (node.anchor) {
      node.x = node.anchor === 'start' ? -230 : 230;
      node.y = 0;
      node.fx = node.x;
      node.fy = node.y;
      node.pinned = true;
      return;
    }
    const near = graph
      .neighbors(node.id)
      .map((id) => previous.get(id) || byId.get(id))
      .find((n) => n && n.x != null);
    if (near) {
      node.x = near.x + (Math.random() - 0.5) * 50;
      node.y = near.y + (Math.random() - 0.5) * 50;
    } else if (node.seed) {
      node.x = 0;
      node.y = 0;
    } else {
      const angle = Math.random() * Math.PI * 2;
      const radius = 70 + Math.random() * 140;
      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
    }
  }

  function join() {
    edgeSel = edgeLayer
      .selectAll('line')
      .data(links, (d) => d.id)
      .join('line')
      .attr('stroke-width', (d) => 0.6 + d.weight * 2.2)
      .style('--w', (d) => (d.weight * d.weight).toFixed(3));

    haloSel = haloLayer
      .selectAll('circle')
      .data(nodes, (d) => d.id)
      .join('circle')
      .attr('r', (d) => d.r * 2);

    nodeSel = nodeLayer
      .selectAll('g.node')
      .data(nodes, (d) => d.id)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'node').attr('tabindex', 0).attr('role', 'button');
        g.append('circle').attr('class', 'ring');
        g.append('circle').attr('class', 'core');
        g.append('text').attr('class', 'label');
        g.on('mouseenter', (event, d) => {
          hoverId = d.id;
          applyEmphasis();
          showTip(event, d);
        })
          .on('mousemove', moveTip)
          .on('mouseleave', () => {
            hoverId = null;
            applyEmphasis();
            hideTip();
          })
          .on('focus', (_event, d) => {
            hoverId = d.id;
            applyEmphasis();
          })
          .on('blur', () => {
            hoverId = null;
            applyEmphasis();
          })
          .on('click', (event, d) => {
            event.stopPropagation();
            handlers.onSelect?.(d.id);
          })
          .on('dblclick', (event, d) => {
            event.stopPropagation();
            handlers.onExpand?.(d.id);
          })
          .on('keydown', (event, d) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handlers.onSelect?.(d.id);
            }
          })
          .call(drag);
        return g;
      });

    nodeSel
      .attr('aria-label', (d) => (d.kind === 'track' ? `${d.label} by ${d.artist}` : d.label))
      .classed('seed', (d) => Boolean(d.seed))
      .classed('bridge', (d) => bridges.has(d.id));
    nodeSel.select('circle.core').attr('r', (d) => d.r);
    nodeSel.select('circle.ring').attr('r', (d) => d.r + 5);
    nodeSel.select('text.label').text((d) => truncate(d.label, 26));
    updateLabels();
  }

  // ---------- Drawing ----------

  function render() {
    const colorAt = createSpectrum(nodes, centerId);
    for (const n of nodes) n.color = colorAt(n.x, n.y);

    edgeSel
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y)
      .style('stroke', (d) => colorAt((d.source.x + d.target.x) / 2, (d.source.y + d.target.y) / 2));

    haloSel
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y)
      .style('fill', (d) => d.color);

    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
    nodeSel.select('circle.core').style('fill', (d) => d.color);

    // Re-place labels every few frames while the layout settles.
    if (++tickCount % 8 === 0) updateLabels();

    if (needsFit && sim.alpha() < 0.12) fit(true);
  }

  function applyEmphasis() {
    const focusId = hoverId || selectedId;
    let activeEdges = null;
    active = null;

    if (path) {
      active = path.nodes;
      activeEdges = path.edges;
    } else if (focusId && byId.has(focusId)) {
      active = new Set([focusId]);
      activeEdges = new Set();
      for (const l of links) {
        if (l.source.id === focusId || l.target.id === focusId) {
          active.add(l.source.id);
          active.add(l.target.id);
          activeEdges.add(l.id);
        }
      }
    }

    svg.classed('showing-path', Boolean(path));
    nodeSel
      .classed('dim', (d) => Boolean(active && !active.has(d.id)))
      .classed('selected', (d) => d.id === selectedId)
      .classed('on-path', (d) => Boolean(path?.nodes.has(d.id)));
    haloSel.classed('dim', (d) => Boolean(active && !active.has(d.id)));
    edgeSel
      .classed('lit', (d) => Boolean(activeEdges?.has(d.id)))
      .classed('dim', (d) => Boolean(active && !activeEdges.has(d.id)))
      .classed('path', (d) => Boolean(path?.edges.has(d.id)));
    updateLabels();
  }

  function updateLabels() {
    const k = transform.k;
    const threshold = k > 1.8 ? 0 : k > 1.25 ? 0.3 : k > 0.85 ? 0.5 : 0.75;
    const size = 12 / Math.min(1.6, Math.max(0.75, k));

    const priority = (d) => {
      if (d.id === hoverId || d.id === selectedId) return 3;
      if (d.seed) return 2;
      return d.score ?? 0;
    };
    const wanted = nodes
      .filter((d) => {
        if (d.seed || d.id === selectedId || d.id === hoverId) return true;
        if (active) return active.has(d.id);
        return (d.score ?? 0) >= threshold;
      })
      .sort((a, b) => priority(b) - priority(a));

    // Greedy label placement: higher-priority labels claim space first, and a
    // label that would overlap one already placed stays hidden until you zoom in.
    const placed = [];
    const shown = new Set();
    const circles = nodes.map((n) => ({ id: n.id, x0: n.x - n.r, x1: n.x + n.r, y0: n.y - n.r, y1: n.y + n.r }));
    for (const d of wanted) {
      const text = truncate(d.label, 26);
      const w = text.length * size * 0.56;
      const box = { x0: d.x - w / 2, x1: d.x + w / 2, y0: d.y + d.r + 3, y1: d.y + d.r + 3 + size * 1.15 };
      const hits = (b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0;
      const overlaps = placed.some(hits) || circles.some((c) => c.id !== d.id && hits(c));
      if (!overlaps || priority(d) >= 2) {
        placed.push(box);
        shown.add(d.id);
      }
    }

    nodeSel
      .select('text.label')
      .attr('font-size', size.toFixed(2))
      .attr('y', (d) => d.r + size + 3)
      .classed('shown', (d) => shown.has(d.id));
  }

  // ---------- Tooltip ----------

  // Touch has no hover: a tap fires mouseenter with no mouseleave to follow, so
  // the tooltip would stick. The detail panel carries the same information.
  const hasHover = window.matchMedia('(hover: hover)').matches;

  function showTip(event, d) {
    if (!hasHover) return;
    const info = handlers.describe?.(d) || { title: d.label };
    tooltip.selectAll('*').remove();
    tooltip.append('strong').text(info.title);
    if (info.subtitle) tooltip.append('span').text(info.subtitle);
    if (info.note) tooltip.append('span').attr('class', 'tip-note').text(info.note);
    tooltip.classed('visible', true);
    moveTip(event);
  }

  function moveTip(event) {
    const [x, y] = d3.pointer(event, container);
    tooltip.style('transform', `translate(${Math.round(x + 14)}px, ${Math.round(y + 14)}px)`);
  }

  function hideTip() {
    tooltip.classed('visible', false);
  }

  // ---------- Camera ----------

  function fit(animate = true) {
    needsFit = false;
    if (!nodes.length) return;
    const { w, h, cx, cy } = viewport();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x - n.r - 40);
      x1 = Math.max(x1, n.x + n.r + 40);
      y0 = Math.min(y0, n.y - n.r - 20);
      y1 = Math.max(y1, n.y + n.r + 30);
    }
    const k = Math.min(1.5, 0.94 * Math.min(w / (x1 - x0), h / (y1 - y0)));
    const target = d3.zoomIdentity.translate(cx - k * ((x0 + x1) / 2), cy - k * ((y0 + y1) / 2)).scale(k);
    if (animate && !reduceMotion) svg.transition().duration(700).ease(d3.easeCubicOut).call(zoom.transform, target);
    else svg.call(zoom.transform, target);
  }

  function focusNode(id) {
    const n = byId.get(id);
    if (!n) return;
    const { cx, cy } = viewport();
    const run = reduceMotion ? svg : svg.transition().duration(600).ease(d3.easeCubicOut);
    run.call(zoom.translateTo, n.x, n.y, [cx, cy]);
  }

  function zoomBy(factor) {
    const run = reduceMotion ? svg : svg.transition().duration(250);
    run.call(zoom.scaleBy, factor);
  }

  // ---------- Public ----------

  return {
    setGraph,
    fit,
    focusNode,
    zoomBy,
    clear() {
      nodes = [];
      links = [];
      byId = new Map();
      path = null;
      selectedId = null;
      sim.stop();
      sim.nodes([]);
      sim.force('link').links([]);
      join();
      hideTip();
    },
    select(id) {
      selectedId = id;
      applyEmphasis();
    },
    setPath(ids) {
      if (!ids) {
        path = null;
      } else {
        const edges = new Set();
        for (let i = 0; i < ids.length - 1; i++) {
          const l = links.find(
            (x) =>
              (x.source.id === ids[i] && x.target.id === ids[i + 1]) ||
              (x.source.id === ids[i + 1] && x.target.id === ids[i]),
          );
          if (l) edges.add(l.id);
        }
        path = { nodes: new Set(ids), edges };
      }
      applyEmphasis();
    },
    setInset(next) {
      inset = { ...inset, ...next };
    },
    setPickMode(on) {
      svg.classed('picking', on);
    },
    setBridges(ids) {
      bridges = new Set(ids);
      nodeSel.classed('bridge', (d) => bridges.has(d.id));
    },
  };
}
