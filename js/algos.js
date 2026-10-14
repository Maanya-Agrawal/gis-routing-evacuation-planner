/* algos.js — every algorithm is implemented from scratch (no graph library):
   Dijkstra, A*, bidirectional Dijkstra, Bellman-Ford, Yen's k-shortest paths,
   multi-source Dijkstra, Tarjan bridges/articulation points, Brandes edge betweenness,
   min-cost max-flow, k-means, greedy max-coverage, and exact/heuristic TSP. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else { root.Geo = root.Geo || {}; root.Geo.algos = factory(root.Geo.core); }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';
  const { MinHeap, haversine, mulberry32 } = core;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /* ------------------------------------------------------------------ */
  /*  Shortest-path family                                               */
  /* ------------------------------------------------------------------ */

  function pathFromPrev(view, prev, s, t) {
    const arcs = [];
    let v = t;
    while (v !== s) {
      const a = prev[v];
      if (a < 0) return null;
      arcs.push(a);
      v = view.from[a];
    }
    arcs.reverse();
    return arcs;
  }
  function arcsToNodes(view, arcs, s) {
    const nodes = [s];
    for (let i = 0; i < arcs.length; i++) nodes.push(view.head[arcs[i]]);
    return nodes;
  }

  /**
   * Generic Dijkstra: single/multi-source, forward or reverse, optional early stop at `target`,
   * cost cut-off (`maxCost`), blocked nodes, and per-node deadlines (time-dependent constraint:
   * a node may only be entered if t0 + dist < deadline[node]).
   */
  function sssp(view, w, sources, opts) {
    opts = opts || {};
    const n = view.n, reverse = !!opts.reverse;
    const start = reverse ? view.rstart : view.start;
    const nbr = reverse ? view.rhead : view.head;
    const arcOf = view.rarc;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const label = new Int32Array(n).fill(-1);
    const heap = new MinHeap(1024);
    const maxCost = opts.maxCost === undefined ? Infinity : opts.maxCost;
    const deadline = reverse ? null : opts.deadline, t0 = opts.t0 || 0;
    const blockedNode = opts.blockedNode, target = opts.target === undefined ? -1 : opts.target;
    const order = opts.collect ? [] : null;
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (deadline && t0 >= deadline[s]) continue;
      if (dist[s] > 0) { dist[s] = 0; label[s] = i; heap.push(0, s); }
    }
    let settled = 0, relaxed = 0;
    while (heap.size) {
      const u = heap.pop(), du = heap.topKey;
      if (du > dist[u]) continue;
      settled++;
      if (order) order.push(u);
      if (u === target) break;
      for (let i = start[u], e = start[u + 1]; i < e; i++) {
        const a = reverse ? arcOf[i] : i;
        const c = w[a];
        if (c === Infinity) continue;
        const v = nbr[i];
        if (blockedNode && blockedNode[v]) continue;
        const nd = du + c;
        if (nd >= dist[v] || nd > maxCost) continue;
        if (deadline && t0 + nd >= deadline[v]) continue;
        dist[v] = nd; prev[v] = a; label[v] = label[u];
        heap.push(nd, v); relaxed++;
      }
    }
    return { dist, prev, label, settled, relaxed, order };
  }

  function dijkstra(view, w, s, t, opts) {
    const t0 = now();
    const r = sssp(view, w, [s], Object.assign({}, opts, { target: t, collect: true }));
    const found = r.dist[t] < Infinity;
    const arcs = found ? pathFromPrev(view, r.prev, s, t) : null;
    return { algo: 'dijkstra', found, cost: r.dist[t], arcs, nodes: found ? arcsToNodes(view, arcs, s) : null,
      settled: r.settled, relaxed: r.relaxed, ms: now() - t0, order: r.order };
  }

  /** A* with the haversine heuristic scaled by the cheapest cost-per-metre in the network (admissible). */
  function astar(G, view, w, s, t, hFactor, opts) {
    opts = opts || {};
    const t0clock = now();
    const n = view.n, start = view.start, head = view.head;
    const lat = G.lat, lon = G.lon, tl = lat[t], tn = lon[t];
    const deadline = opts.deadline, t0 = opts.t0 || 0, blockedNode = opts.blockedNode;
    const g = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const hc = new Float64Array(n).fill(-1);
    const h = (u) => {
      let x = hc[u];
      if (x < 0) { x = haversine(lat[u], lon[u], tl, tn) * hFactor; hc[u] = x; }
      return x;
    };
    const heap = new MinHeap(1024), order = [];
    let settled = 0, relaxed = 0;
    if (!(deadline && t0 >= deadline[s])) { g[s] = 0; heap.push(h(s), s); }
    while (heap.size) {
      const u = heap.pop(), f = heap.topKey;
      if (f > g[u] + h(u) + 1e-9) continue;
      settled++; order.push(u);
      if (u === t) break;
      const gu = g[u];
      for (let i = start[u], e = start[u + 1]; i < e; i++) {
        const c = w[i];
        if (c === Infinity) continue;
        const v = head[i];
        if (blockedNode && blockedNode[v]) continue;
        const ng = gu + c;
        if (ng >= g[v]) continue;
        if (deadline && t0 + ng >= deadline[v]) continue;
        g[v] = ng; prev[v] = i;
        heap.push(ng + h(v), v); relaxed++;
      }
    }
    const found = g[t] < Infinity;
    const arcs = found ? pathFromPrev(view, prev, s, t) : null;
    return { algo: 'astar', found, cost: g[t], arcs, nodes: found ? arcsToNodes(view, arcs, s) : null,
      settled, relaxed, ms: now() - t0clock, order };
  }

  /** Bidirectional Dijkstra: forward from s on the graph, backward from t on the reverse graph. */
  function bidirectional(view, w, s, t) {
    const t0clock = now();
    const n = view.n;
    const distF = new Float64Array(n).fill(Infinity), distB = new Float64Array(n).fill(Infinity);
    const prevF = new Int32Array(n).fill(-1), prevB = new Int32Array(n).fill(-1);
    const hf = new MinHeap(1024), hb = new MinHeap(1024);
    const orderF = [], orderB = [];
    distF[s] = 0; distB[t] = 0; hf.push(0, s); hb.push(0, t);
    let mu = Infinity, meet = -1, relaxed = 0;
    if (s === t) { mu = 0; meet = s; }
    const clean = (h, d) => { while (h.size && h.k[0] > d[h.v[0]]) h.pop(); };
    while (hf.size && hb.size && mu > 0) {
      clean(hf, distF); clean(hb, distB);
      if (!hf.size || !hb.size) break;
      if (hf.k[0] + hb.k[0] >= mu) break;
      if (hf.size <= hb.size) {
        const u = hf.pop(), du = hf.topKey;
        if (du > distF[u]) continue;
        orderF.push(u);
        for (let i = view.start[u], e = view.start[u + 1]; i < e; i++) {
          const c = w[i]; if (c === Infinity) continue;
          const v = view.head[i], nd = du + c;
          if (nd < distF[v]) {
            distF[v] = nd; prevF[v] = i; hf.push(nd, v); relaxed++;
            if (distB[v] < Infinity && nd + distB[v] < mu) { mu = nd + distB[v]; meet = v; }
          }
        }
      } else {
        const u = hb.pop(), du = hb.topKey;
        if (du > distB[u]) continue;
        orderB.push(u);
        for (let i = view.rstart[u], e = view.rstart[u + 1]; i < e; i++) {
          const a = view.rarc[i], c = w[a]; if (c === Infinity) continue;
          const v = view.rhead[i], nd = du + c;
          if (nd < distB[v]) {
            distB[v] = nd; prevB[v] = a; hb.push(nd, v); relaxed++;
            if (distF[v] < Infinity && nd + distF[v] < mu) { mu = nd + distF[v]; meet = v; }
          }
        }
      }
    }
    const found = meet >= 0 && mu < Infinity;
    let arcs = null;
    if (found) {
      arcs = pathFromPrev(view, prevF, s, meet) || [];
      let v = meet;
      while (v !== t) { const a = prevB[v]; arcs.push(a); v = view.head[a]; }
    }
    return { algo: 'bidir', found, cost: found ? mu : Infinity, arcs, nodes: found ? arcsToNodes(view, arcs, s) : null,
      settled: orderF.length + orderB.length, relaxed, ms: now() - t0clock, orderF, orderB };
  }

  /** Classic Bellman-Ford, one full pass over all arcs per round, stopping when nothing changes. */
  function bellmanFord(view, w, s, t, opts) {
    opts = opts || {};
    const t0clock = now();
    const n = view.n, A = view.A, from = view.from, head = view.head;
    const deadline = opts.deadline, t0 = opts.t0 || 0;
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    dist[s] = 0;
    let rounds = 0, relaxed = 0, changed;
    do {
      changed = false; rounds++;
      for (let a = 0; a < A; a++) {
        const c = w[a]; if (c === Infinity) continue;
        const du = dist[from[a]]; if (du === Infinity) continue;
        const nd = du + c, v = head[a];
        if (nd < dist[v]) {
          if (deadline && t0 + nd >= deadline[v]) continue;
          dist[v] = nd; prev[v] = a; changed = true; relaxed++;
        }
      }
    } while (changed && rounds < n);
    let reached = 0;
    for (let i = 0; i < n; i++) if (dist[i] < Infinity) reached++;
    const found = dist[t] < Infinity;
    const arcs = found ? pathFromPrev(view, prev, s, t) : null;
    return { algo: 'bf', found, cost: dist[t], arcs, nodes: found ? arcsToNodes(view, arcs, s) : null,
      settled: reached, relaxed, rounds, ms: now() - t0clock };
  }

  /** Dispatch by name. */
  function route(name, G, view, w, s, t, metric, opts) {
    const hF = view.hFactor[metric === 'distance' ? 'distance' : 'time'];
    if (name === 'dijkstra') return dijkstra(view, w, s, t, opts);
    if (name === 'bidir') return bidirectional(view, w, s, t);
    if (name === 'bf') return bellmanFord(view, w, s, t, opts);
    return astar(G, view, w, s, t, hF, opts);
  }

  /** Yen's K-shortest loopless paths; spur searches use A*. */
  function yen(G, view, w, s, t, K, metric, opts) {
    opts = opts || {};
    const t0clock = now();
    const hF = view.hFactor[metric === 'distance' ? 'distance' : 'time'];
    const baseT0 = opts.t0 || 0;
    const first = astar(G, view, w, s, t, hF, opts);
    if (!first.found) return { paths: [], ms: now() - t0clock, spurs: 0 };
    const A = [{ arcs: first.arcs, cost: first.cost }], B = [];
    const seen = new Set([first.arcs.join(',')]);
    const blockedNode = new Uint8Array(view.n);
    let spurs = 0;
    for (let k = 1; k < K; k++) {
      const pa = A[k - 1].arcs;
      let rootCost = 0;
      for (let i = 0; i < pa.length; i++) {
        const spurNode = i === 0 ? s : view.head[pa[i - 1]];
        if (i > 0) rootCost += w[pa[i - 1]];
        const removed = [];
        for (const P of A) {
          if (P.arcs.length > i) {
            let same = true;
            for (let j = 0; j < i; j++) if (P.arcs[j] !== pa[j]) { same = false; break; }
            if (same) { const a = P.arcs[i]; if (w[a] !== Infinity) { removed.push(a, w[a]); w[a] = Infinity; } }
          }
        }
        const rootNodes = [];
        let v = s;
        for (let j = 0; j < i; j++) { blockedNode[v] = 1; rootNodes.push(v); v = view.head[pa[j]]; }
        let hasOut = false;
        for (let q = view.start[spurNode]; q < view.start[spurNode + 1]; q++) {
          if (w[q] !== Infinity && !blockedNode[view.head[q]]) { hasOut = true; break; }
        }
        if (hasOut) {
          spurs++;
          const sp = astar(G, view, w, spurNode, t, hF, Object.assign({}, opts, { blockedNode, t0: baseT0 + rootCost }));
          if (sp.found) {
            const arcs = pa.slice(0, i).concat(sp.arcs), key = arcs.join(',');
            if (!seen.has(key)) { seen.add(key); B.push({ arcs, cost: rootCost + sp.cost }); }
          }
        }
        for (let q = 0; q < removed.length; q += 2) w[removed[q]] = removed[q + 1];
        for (const x of rootNodes) blockedNode[x] = 0;
      }
      if (!B.length) break;
      let bi = 0;
      for (let j = 1; j < B.length; j++) if (B[j].cost < B[bi].cost) bi = j;
      A.push(B[bi]); B.splice(bi, 1);
    }
    return { paths: A.map(p => ({ arcs: p.arcs, cost: p.cost, nodes: arcsToNodes(view, p.arcs, s) })), ms: now() - t0clock, spurs };
  }

  /* ------------------------------------------------------------------ */
  /*  Structure: bridges / articulation points (Tarjan)                  */
  /* ------------------------------------------------------------------ */

  /**
   * Iterative Tarjan low-link DFS on the undirected graph (walk view, blocked segments removed).
   * Returns bridge segments with the number of nodes they would cut off, and articulation nodes.
   */
  function tarjan(view, blockedSeg) {
    const n = view.n, start = view.start, head = view.head, seg = view.seg;
    const disc = new Int32Array(n).fill(-1), low = new Int32Array(n), sz = new Int32Array(n);
    const parent = new Int32Array(n).fill(-1), parSeg = new Int32Array(n).fill(-1), rootOf = new Int32Array(n);
    const ptr = new Int32Array(n), stack = new Int32Array(n);
    const art = new Uint8Array(n), cut = new Int32Array(n), rootKids = new Int32Array(n);
    const bridges = [];
    let timer = 0;
    for (let r = 0; r < n; r++) {
      if (disc[r] !== -1) continue;
      let sp = 0;
      stack[sp++] = r; disc[r] = low[r] = timer++; sz[r] = 1; rootOf[r] = r; ptr[r] = start[r];
      while (sp > 0) {
        const u = stack[sp - 1];
        if (ptr[u] < start[u + 1]) {
          const a = ptr[u]++;
          const sg = seg[a];
          if (blockedSeg && blockedSeg[sg]) continue;
          if (sg === parSeg[u]) continue;
          const v = head[a];
          if (disc[v] === -1) {
            disc[v] = low[v] = timer++; sz[v] = 1; parent[v] = u; parSeg[v] = sg; rootOf[v] = r; ptr[v] = start[v];
            stack[sp++] = v;
          } else if (disc[v] < low[u]) low[u] = disc[v];
        } else {
          sp--;
          const p = parent[u];
          if (p >= 0) {
            if (low[u] < low[p]) low[p] = low[u];
            sz[p] += sz[u];
            if (low[u] > disc[p]) bridges.push({ seg: parSeg[u], child: u, below: sz[u], root: rootOf[u] });
            if (p !== r) { if (low[u] >= disc[p]) { art[p] = 1; if (sz[u] > cut[p]) cut[p] = sz[u]; } }
            else rootKids[r]++;
          }
        }
      }
      if (rootKids[r] >= 2) { art[r] = 1; cut[r] = Math.max(cut[r], 1); }
    }
    // Component size lets us report the *smaller* side that a bridge isolates.
    const out = bridges.map(b => {
      const comp = sz[b.root];
      return { seg: b.seg, isolated: Math.min(b.below, comp - b.below), component: comp };
    });
    out.sort((x, y) => y.isolated - x.isolated);
    const artNodes = [];
    for (let v = 0; v < n; v++) if (art[v]) artNodes.push(v);
    return { bridges: out, articulation: artNodes };
  }

  /* ------------------------------------------------------------------ */
  /*  Edge betweenness (Brandes, weighted, sampled sources)              */
  /* ------------------------------------------------------------------ */

  function edgeBetweenness(view, w, m, k, seed, sources) {
    const n = view.n, rng = mulberry32(seed || 7);
    const bc = new Float64Array(m);
    const dist = new Float64Array(n), sigma = new Float64Array(n), delta = new Float64Array(n);
    const order = new Int32Array(n), done = new Uint8Array(n);
    const heap = new MinHeap(1024);
    const eps = (d) => 1e-9 * (1 + d);
    for (let it = 0; it < k; it++) {
      const s = sources ? sources[it] : Math.floor(rng() * n);
      dist.fill(Infinity); sigma.fill(0); delta.fill(0); done.fill(0);
      dist[s] = 0; sigma[s] = 1; heap.size = 0; heap.push(0, s);
      let cnt = 0;
      while (heap.size) {
        const u = heap.pop(), du = heap.topKey;
        if (done[u] || du > dist[u]) continue;
        done[u] = 1; order[cnt++] = u;
        for (let a = view.start[u], e = view.start[u + 1]; a < e; a++) {
          const c = w[a]; if (c === Infinity) continue;
          const v = view.head[a], nd = du + c;
          if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
        }
      }
      for (let i = 0; i < cnt; i++) {
        const u = order[i];
        for (let a = view.start[u], e = view.start[u + 1]; a < e; a++) {
          const c = w[a]; if (c === Infinity) continue;
          const v = view.head[a];
          if (Math.abs(dist[u] + c - dist[v]) <= eps(dist[v])) sigma[v] += sigma[u];
        }
      }
      for (let i = cnt - 1; i >= 0; i--) {
        const x = order[i];
        for (let q = view.rstart[x], e = view.rstart[x + 1]; q < e; q++) {
          const a = view.rarc[q], c = w[a]; if (c === Infinity) continue;
          const v = view.rhead[q];
          if (dist[v] === Infinity) continue;
          if (Math.abs(dist[v] + c - dist[x]) <= eps(dist[x])) {
            const coef = (sigma[v] / sigma[x]) * (1 + delta[x]);
            delta[v] += coef; bc[view.seg[a]] += coef;
          }
        }
      }
    }
    return bc;
  }

  /* ------------------------------------------------------------------ */
  /*  Min-cost max-flow (successive shortest paths, SPFA)                */
  /* ------------------------------------------------------------------ */

  function minCostMaxFlow(N, edges, s, t, limit) {
    const to = [], cap = [], cost = [], nxt = [];
    const head = new Int32Array(N).fill(-1);
    const add = (u, v, c, w) => {
      to.push(v); cap.push(c); cost.push(w); nxt.push(head[u]); head[u] = to.length - 1;
      to.push(u); cap.push(0); cost.push(-w); nxt.push(head[v]); head[v] = to.length - 1;
    };
    for (const e of edges) add(e.u, e.v, e.cap, e.cost);
    let flow = 0, total = 0;
    limit = limit === undefined ? Infinity : limit;
    const dist = new Float64Array(N), inq = new Uint8Array(N), pe = new Int32Array(N);
    let augmentations = 0;
    while (flow < limit) {
      dist.fill(Infinity); pe.fill(-1); dist[s] = 0;
      const q = [s]; inq[s] = 1;
      for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi]; inq[u] = 0;
        for (let e = head[u]; e !== -1; e = nxt[e]) {
          if (cap[e] > 0 && dist[u] + cost[e] < dist[to[e]] - 1e-12) {
            dist[to[e]] = dist[u] + cost[e]; pe[to[e]] = e;
            if (!inq[to[e]]) { inq[to[e]] = 1; q.push(to[e]); }
          }
        }
        if (q.length > 4 * N * N + 100) break; // safety net against numeric cycling
      }
      if (dist[t] === Infinity) break;
      let f = limit - flow;
      for (let v = t; v !== s; v = to[pe[v] ^ 1]) f = Math.min(f, cap[pe[v]]);
      for (let v = t; v !== s; v = to[pe[v] ^ 1]) { cap[pe[v]] -= f; cap[pe[v] ^ 1] += f; }
      flow += f; total += f * dist[t]; augmentations++;
    }
    const edgeFlow = new Float64Array(edges.length);
    for (let i = 0; i < edges.length; i++) edgeFlow[i] = cap[2 * i + 1];
    return { flow, cost: total, edgeFlow, augmentations };
  }

  /* ------------------------------------------------------------------ */
  /*  Clustering and placement                                           */
  /* ------------------------------------------------------------------ */

  /** k-means++ on lat/lon pairs (flat array). Returns centroids and per-point counts. */
  function kmeans(pts, k, seed, iters) {
    const n = pts.length / 2;
    k = Math.min(k, n);
    iters = iters || 20;
    const rng = mulberry32(seed || 11);
    let lat0 = 0;
    for (let i = 0; i < n; i++) lat0 += pts[2 * i];
    lat0 /= n;
    const kx = Math.cos(lat0 * Math.PI / 180);
    const px = new Float64Array(n), py = new Float64Array(n);
    for (let i = 0; i < n; i++) { py[i] = pts[2 * i]; px[i] = pts[2 * i + 1] * kx; }
    const cx = new Float64Array(k), cy = new Float64Array(k);
    const first = Math.floor(rng() * n);
    cx[0] = px[first]; cy[0] = py[first];
    const d2 = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const dx = px[i] - cx[c - 1], dy = py[i] - cy[c - 1];
        const d = dx * dx + dy * dy;
        if (d < d2[i]) d2[i] = d;
        sum += d2[i];
      }
      let r = rng() * sum, pick = n - 1;
      for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
      cx[c] = px[pick]; cy[c] = py[pick];
    }
    const assign = new Int32Array(n).fill(-1), count = new Int32Array(k);
    for (let it = 0; it < iters; it++) {
      let moved = 0;
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const dx = px[i] - cx[c], dy = py[i] - cy[c], d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = c; }
        }
        if (assign[i] !== best) { assign[i] = best; moved++; }
      }
      const sx = new Float64Array(k), sy = new Float64Array(k);
      count.fill(0);
      for (let i = 0; i < n; i++) { sx[assign[i]] += px[i]; sy[assign[i]] += py[i]; count[assign[i]]++; }
      for (let c = 0; c < k; c++) if (count[c] > 0) { cx[c] = sx[c] / count[c]; cy[c] = sy[c] / count[c]; }
      if (moved === 0) break;
    }
    const cent = [];
    for (let c = 0; c < k; c++) if (count[c] > 0) cent.push({ lat: cy[c], lon: cx[c] / kx, count: count[c] });
    return cent;
  }

  /**
   * Greedy maximum coverage: repeatedly add the candidate covering the most still-uncovered population.
   * Guarantees at least (1 - 1/e) ~ 63% of the optimal coverage (submodular maximisation).
   */
  function greedyCoverage(pop, covers, k, preCovered) {
    const Z = pop.length;
    const covered = preCovered ? Uint8Array.from(preCovered) : new Uint8Array(Z);
    let base = 0, total = 0;
    for (let z = 0; z < Z; z++) { total += pop[z]; if (covered[z]) base += pop[z]; }
    const chosen = [], gains = [];
    const taken = new Uint8Array(covers.length);
    let acc = base;
    for (let step = 0; step < k; step++) {
      let best = -1, bestGain = 0;
      for (let c = 0; c < covers.length; c++) {
        if (taken[c]) continue;
        let g = 0;
        const zs = covers[c];
        for (let i = 0; i < zs.length; i++) if (!covered[zs[i]]) g += pop[zs[i]];
        if (g > bestGain) { bestGain = g; best = c; }
      }
      if (best < 0) break;
      taken[best] = 1;
      for (const z of covers[best]) covered[z] = 1;
      acc += bestGain;
      chosen.push(best); gains.push({ gain: bestGain, coverage: acc / total });
    }
    return { chosen, gains, baseCoverage: total ? base / total : 0, total };
  }

  /* ------------------------------------------------------------------ */
  /*  Multi-stop trips: Held-Karp (exact), nearest neighbour, 2-opt      */
  /* ------------------------------------------------------------------ */

  function tourCost(D, tour) {
    let c = 0;
    for (let i = 0; i < tour.length; i++) c += D[tour[i]][tour[(i + 1) % tour.length]];
    return c;
  }
  function tspNearestNeighbour(D) {
    const n = D.length, seen = new Uint8Array(n), tour = [0];
    seen[0] = 1;
    for (let i = 1; i < n; i++) {
      const last = tour[tour.length - 1];
      let best = -1, bd = Infinity;
      for (let j = 0; j < n; j++) if (!seen[j] && D[last][j] < bd) { bd = D[last][j]; best = j; }
      if (best < 0) return null;
      seen[best] = 1; tour.push(best);
    }
    return tour;
  }
  function tsp2opt(D, tour) {
    tour = tour.slice();
    let improved = true, cost = tourCost(D, tour);
    while (improved) {
      improved = false;
      for (let i = 1; i < tour.length - 1; i++) {
        for (let j = i + 1; j < tour.length; j++) {
          const cand = tour.slice(0, i).concat(tour.slice(i, j + 1).reverse(), tour.slice(j + 1));
          const c = tourCost(D, cand);
          if (c < cost - 1e-9) { tour = cand; cost = c; improved = true; }
        }
      }
    }
    return tour;
  }
  function tspHeldKarp(D) {
    const n = D.length;
    if (n <= 1) return [0];
    const m = n - 1, FULL = 1 << m;
    const dp = new Float64Array(FULL * m).fill(Infinity), par = new Int8Array(FULL * m).fill(-1);
    for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = D[0][j + 1];
    for (let mask = 1; mask < FULL; mask++) {
      for (let j = 0; j < m; j++) {
        if (!(mask & (1 << j))) continue;
        const cur = dp[mask * m + j];
        if (cur === Infinity) continue;
        for (let k = 0; k < m; k++) {
          if (mask & (1 << k)) continue;
          const nm = mask | (1 << k), val = cur + D[j + 1][k + 1];
          if (val < dp[nm * m + k]) { dp[nm * m + k] = val; par[nm * m + k] = j; }
        }
      }
    }
    let best = Infinity, bj = -1;
    for (let j = 0; j < m; j++) {
      const val = dp[(FULL - 1) * m + j] + D[j + 1][0];
      if (val < best) { best = val; bj = j; }
    }
    if (bj < 0) return null;
    const tour = [];
    let mask = FULL - 1, j = bj;
    while (j >= 0) { tour.push(j + 1); const pj = par[mask * m + j]; mask ^= (1 << j); j = pj; }
    tour.push(0);
    return tour.reverse();
  }

  return {
    sssp, dijkstra, astar, bidirectional, bellmanFord, route, yen, pathFromPrev, arcsToNodes,
    tarjan, edgeBetweenness, minCostMaxFlow, kmeans, greedyCoverage,
    tourCost, tspNearestNeighbour, tsp2opt, tspHeldKarp
  };
});
