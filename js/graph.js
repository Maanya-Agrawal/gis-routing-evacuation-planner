/* graph.js — builds the road graph from the dataset (OpenStreetMap JSON schema),
   CSR adjacency "views" for driving / walking, and per-scenario cost arrays. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else { root.Geo = root.Geo || {}; root.Geo.graph = factory(root.Geo.core); }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';
  const { haversine, UnionFind, SpatialGrid } = core;

  const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'other'];
  // Assumed free-flow urban speeds (km/h) by road class — an assumption, stated in the report.
  const DRIVE_KMH = [70, 50, 40, 32, 26, 22, 18, 10, 15];
  // Rush-hour slowdown multipliers by road class (assumption).
  const RUSH_MULT = [1.6, 1.9, 1.9, 1.7, 1.4, 1.2, 1.1, 1.0, 1.1];
  const WALK_MS = 1.35; // m/s

  function classIndex(h) {
    if (!h) return 8;
    const i = CLASSES.indexOf(String(h).replace('_link', ''));
    return i < 0 ? 8 : i;
  }

  /** Bilinear interpolation on the coarse elevation grid stored in the dataset. */
  function sampleElevation(g, lat, lon) {
    const fy = Math.min(g.rows - 1, Math.max(0, (lat - g.s) / (g.n - g.s) * (g.rows - 1)));
    const fx = Math.min(g.cols - 1, Math.max(0, (lon - g.w) / (g.e - g.w) * (g.cols - 1)));
    const y0 = Math.floor(fy), x0 = Math.floor(fx);
    const y1 = Math.min(g.rows - 1, y0 + 1), x1 = Math.min(g.cols - 1, x0 + 1);
    const ty = fy - y0, tx = fx - x0;
    const v = g.v, c = g.cols;
    const a = v[y0 * c + x0], b = v[y0 * c + x1], d = v[y1 * c + x0], e = v[y1 * c + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  }

  /** Dataset -> compact undirected segment graph (largest connected component only). */
  function buildGraph(ds) {
    const rawN = ds.nodes.length, ways = ds.ways;
    let total = 0;
    for (const w of ways) total += Math.max(0, w.n.length - 1);
    const rA = new Int32Array(total), rB = new Int32Array(total), rW = new Int32Array(total);
    let k = 0;
    for (let wi = 0; wi < ways.length; wi++) {
      const nn = ways[wi].n;
      for (let j = 0; j < nn.length - 1; j++) {
        if (nn[j] === nn[j + 1]) continue;
        rA[k] = nn[j]; rB[k] = nn[j + 1]; rW[k] = wi; k++;
      }
    }
    const m0 = k;
    const uf = new UnionFind(rawN), used = new Uint8Array(rawN);
    for (let i = 0; i < m0; i++) { uf.union(rA[i], rB[i]); used[rA[i]] = 1; used[rB[i]] = 1; }
    const comp = new Int32Array(rawN);
    for (let v = 0; v < rawN; v++) if (used[v]) comp[uf.find(v)]++;
    let best = -1, bestSize = 0;
    for (let v = 0; v < rawN; v++) if (comp[v] > bestSize) { bestSize = comp[v]; best = v; }

    const map = new Int32Array(rawN).fill(-1);
    let n = 0;
    for (let v = 0; v < rawN; v++) if (used[v] && uf.find(v) === best) map[v] = n++;
    const lat = new Float64Array(n), lon = new Float64Array(n);
    for (let v = 0; v < rawN; v++) if (map[v] >= 0) { lat[map[v]] = ds.nodes[v][0]; lon[map[v]] = ds.nodes[v][1]; }

    let m = 0;
    for (let i = 0; i < m0; i++) if (map[rA[i]] >= 0) m++;
    const segA = new Int32Array(m), segB = new Int32Array(m), segWay = new Int32Array(m);
    const segLen = new Float64Array(m), segClass = new Uint8Array(m);
    const segOneway = new Int8Array(m), segBridge = new Uint8Array(m);
    let q = 0;
    for (let i = 0; i < m0; i++) {
      if (map[rA[i]] < 0) continue;
      const a = map[rA[i]], b = map[rB[i]], w = ways[rW[i]];
      segA[q] = a; segB[q] = b; segWay[q] = rW[i];
      segLen[q] = Math.max(0.5, haversine(lat[a], lon[a], lat[b], lon[b]));
      segClass[q] = classIndex(w.h);
      segOneway[q] = w.o || 0;
      segBridge[q] = w.b ? 1 : 0;
      q++;
    }
    const G = {
      n, m, lat, lon, segA, segB, segLen, segClass, segOneway, segBridge, segWay,
      wayName: ways.map(w => w.nm || ''), wayClass: ways.map(w => classIndex(w.h)),
      droppedNodes: rawN - n
    };
    G.elev = new Float64Array(n).fill(NaN);
    G.hasElev = false; G.elevMin = NaN; G.elevMax = NaN;
    if (ds.elev && ds.elev.v && ds.elev.v.length) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const e = sampleElevation(ds.elev, lat[i], lon[i]);
        G.elev[i] = e; if (e < lo) lo = e; if (e > hi) hi = e;
      }
      G.hasElev = true; G.elevMin = lo; G.elevMax = hi;
    }
    G.grid = new SpatialGrid(lat, lon, 0.003);
    return G;
  }

  /** Directed CSR adjacency for a travel mode ('drive' honours one-way streets, 'walk' ignores them). */
  function buildView(G, mode) {
    const n = G.n, m = G.m, walk = mode === 'walk';
    let A = 0;
    for (let s = 0; s < m; s++) A += (walk || G.segOneway[s] === 0) ? 2 : 1;
    const from = new Int32Array(A), head = new Int32Array(A), seg = new Int32Array(A);
    const len = new Float64Array(A), base = new Float64Array(A);
    const deg = new Int32Array(n + 1);
    const arcsTmp = [];
    // First pass: count out-degree.
    for (let s = 0; s < m; s++) {
      const ow = walk ? 0 : G.segOneway[s];
      if (ow >= 0) deg[G.segA[s] + 1]++;
      if (ow <= 0) deg[G.segB[s] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const start = deg.slice(0, n + 1);
    const pos = deg.slice(0, n);
    for (let s = 0; s < m; s++) {
      const ow = walk ? 0 : G.segOneway[s];
      const a = G.segA[s], b = G.segB[s];
      const speed = walk ? WALK_MS : DRIVE_KMH[G.segClass[s]] / 3.6;
      if (ow >= 0) { const p = pos[a]++; from[p] = a; head[p] = b; seg[p] = s; len[p] = G.segLen[s]; base[p] = G.segLen[s] / speed; }
      if (ow <= 0) { const p = pos[b]++; from[p] = b; head[p] = a; seg[p] = s; len[p] = G.segLen[s]; base[p] = G.segLen[s] / speed; }
    }
    // Reverse adjacency (incoming arcs) — needed for bidirectional search and "who can reach X".
    const rdeg = new Int32Array(n + 1);
    for (let a = 0; a < A; a++) rdeg[head[a] + 1]++;
    for (let i = 0; i < n; i++) rdeg[i + 1] += rdeg[i];
    const rstart = rdeg.slice(0, n + 1), rpos = rdeg.slice(0, n);
    const rhead = new Int32Array(A), rarc = new Int32Array(A);
    for (let a = 0; a < A; a++) { const p = rpos[head[a]]++; rhead[p] = from[a]; rarc[p] = a; }
    // Admissible A* heuristic factor: cheapest possible seconds per metre.
    let hTime = Infinity;
    for (let a = 0; a < A; a++) { const r = base[a] / len[a]; if (r < hTime) hTime = r; }
    return { mode, n, A, start, head, from, seg, len, base, rstart, rhead, rarc, hFactor: { time: hTime, distance: 1 } };
  }

  /** Cost array for one scenario. blockedSeg/delaySeg are per-segment (undirected) arrays. */
  function makeCosts(view, scn, metric) {
    scn = scn || {};
    const blocked = scn.blockedSeg || null, delay = scn.delaySeg || null;
    const w = new Float64Array(view.A);
    const distance = metric === 'distance';
    for (let a = 0; a < view.A; a++) {
      const s = view.seg[a];
      if (blocked && blocked[s]) { w[a] = Infinity; continue; }
      let c = distance ? view.len[a] : view.base[a];
      if (delay && !distance) c *= delay[s];
      w[a] = c;
    }
    return w;
  }

  function arcStats(view, arcs, delaySeg) {
    let meters = 0, seconds = 0;
    for (const a of arcs) {
      meters += view.len[a];
      seconds += view.base[a] * (delaySeg ? delaySeg[view.seg[a]] : 1);
    }
    return { meters, seconds };
  }

  /** Flat [lat,lon,lat,lon,...] list of the given segments, for drawing. */
  function segCoords(G, segIds) {
    const out = new Float64Array(segIds.length * 4);
    for (let i = 0; i < segIds.length; i++) {
      const s = segIds[i], a = G.segA[s], b = G.segB[s];
      out[i * 4] = G.lat[a]; out[i * 4 + 1] = G.lon[a]; out[i * 4 + 2] = G.lat[b]; out[i * 4 + 3] = G.lon[b];
    }
    return out;
  }
  function arcCoords(G, view, arcs) {
    const out = new Float64Array(arcs.length * 4);
    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i], u = view.from[a], v = view.head[a];
      out[i * 4] = G.lat[u]; out[i * 4 + 1] = G.lon[u]; out[i * 4 + 2] = G.lat[v]; out[i * 4 + 3] = G.lon[v];
    }
    return out;
  }

  function nearestNode(G, lat, lon, maxMeters) { return G.grid.nearest(lat, lon, maxMeters); }

  return {
    CLASSES, DRIVE_KMH, RUSH_MULT, WALK_MS, classIndex, buildGraph, buildView, makeCosts,
    arcStats, segCoords, arcCoords, nearestNode, sampleElevation
  };
});
