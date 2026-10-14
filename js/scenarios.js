/* scenarios.js — hazard models. Each scenario only changes the graph (blocked / slowed segments,
   per-node deadlines); every routing algorithm then runs unchanged on the modified graph.
   These are deliberately simple, explainable models — not engineering-grade predictions. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./algos.js'), require('./graph.js'));
  else { root.Geo = root.Geo || {}; root.Geo.scen = factory(root.Geo.core, root.Geo.algos, root.Geo.graph); }
})(typeof self !== 'undefined' ? self : this, function (core, algos, graph) {
  'use strict';
  const { haversine, bearing, mulberry32, UnionFind } = core;

  /* ---------------- Flood ---------------- */

  /**
   * Water-level flood on the elevation model. Nodes with elevation <= level are under water.
   * With a source point and connectedOnly, water must be able to *reach* a node through other
   * flooded nodes (BFS over the road graph), so isolated high-ground pockets stay dry.
   */
  function flood(G, walkView, p) {
    const n = G.n, flooded = new Uint8Array(n);
    let count = 0;
    if (p.src !== null && p.src !== undefined && p.connected) {
      const q = [];
      if (G.elev[p.src] <= p.level) { flooded[p.src] = 1; q.push(p.src); }
      for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi];
        for (let a = walkView.start[u]; a < walkView.start[u + 1]; a++) {
          const v = walkView.head[a];
          if (!flooded[v] && G.elev[v] <= p.level) { flooded[v] = 1; q.push(v); }
        }
      }
    } else {
      for (let i = 0; i < n; i++) if (G.elev[i] <= p.level) flooded[i] = 1;
    }
    const floodedSeg = new Uint8Array(G.m);
    let segs = 0;
    for (let s = 0; s < G.m; s++) {
      // A road is impassable if either end is under water; bridges stay open.
      if ((flooded[G.segA[s]] || flooded[G.segB[s]]) && !G.segBridge[s]) { floodedSeg[s] = 1; segs++; }
    }
    for (let i = 0; i < n; i++) count += flooded[i];
    return { flooded, floodedSeg, nodes: count, segs };
  }

  /* ---------------- Fire ---------------- */

  /**
   * Fire arrival time (seconds) at every node: multi-source Dijkstra over the street graph where
   * spread along an arc is faster downwind and slower upwind.
   *   rate = speed * (1 + windK * cos(bearing - windDir)),  windDir = direction the fire is pushed towards.
   */
  function fireArrival(G, walkView, p) {
    const A = walkView.A, w = new Float64Array(A);
    const speed = p.speedMPerMin / 60;
    for (let a = 0; a < A; a++) {
      const u = walkView.from[a], v = walkView.head[a];
      const br = bearing(G.lat[u], G.lon[u], G.lat[v], G.lon[v]);
      const rate = speed * (1 + p.windK * Math.cos((br - p.windDeg) * Math.PI / 180));
      w[a] = walkView.len[a] / Math.max(rate, speed * 0.1);
    }
    const r = algos.sssp(walkView, w, p.ignitions, {});
    return r.dist;
  }

  /** Segments the fire has reached by time tSec (seconds). */
  function fireBlocked(G, arrival, tSec) {
    const blocked = new Uint8Array(G.m);
    let c = 0;
    for (let s = 0; s < G.m; s++) {
      if (arrival[G.segA[s]] <= tSec || arrival[G.segB[s]] <= tSec) { blocked[s] = 1; c++; }
    }
    return { blockedSeg: blocked, segs: c };
  }

  /* ---------------- Earthquake ---------------- */

  /**
   * Per-segment failure probability. Intensity falls off with log-distance from the epicentre
   * (a simple attenuation law); bridges are far more fragile than ordinary road segments.
   *   I = M - 3.2*log10(d_km + 0.5) - 4.6     base = logistic(1.5 I)     p = min(0.95, base*fragility*mult)
   */
  function quakeProb(G, p) {
    const out = new Float64Array(G.m);
    for (let s = 0; s < G.m; s++) {
      const a = G.segA[s], b = G.segB[s];
      const la = (G.lat[a] + G.lat[b]) / 2, lo = (G.lon[a] + G.lon[b]) / 2;
      const dKm = haversine(p.epiLat, p.epiLon, la, lo) / 1000;
      const intensity = p.mag - 3.2 * Math.log10(dKm + 0.5) - 4.6;
      const base = 1 / (1 + Math.exp(-1.5 * intensity));
      const mult = G.segBridge[s] ? p.bridgeMult : 1;
      out[s] = Math.min(0.95, base * p.fragility * mult);
    }
    return out;
  }

  function sampleFailures(prob, rng) {
    const f = new Uint8Array(prob.length);
    let c = 0;
    for (let i = 0; i < prob.length; i++) if (rng() < prob[i]) { f[i] = 1; c++; }
    return { failed: f, count: c };
  }

  /**
   * Monte Carlo reliability. For each random damage realisation we ask, using union-find on the
   * surviving segments: (a) is origin still connected to destination, (b) does the planned route
   * survive intact, (c) which zones are cut off from every shelter/hospital?
   */
  function quakeMonteCarlo(G, prob, trials, seed, q) {
    const rng = mulberry32(seed || 1);
    const zoneNodes = q.zoneNodes || [], safeNodes = q.safeNodes || [];
    const isolated = new Float64Array(zoneNodes.length);
    let connected = 0, intact = 0, failedTotal = 0;
    for (let t = 0; t < trials; t++) {
      const f = sampleFailures(prob, rng);
      failedTotal += f.count;
      const uf = new UnionFind(G.n);
      for (let s = 0; s < G.m; s++) if (!f.failed[s]) uf.union(G.segA[s], G.segB[s]);
      if (q.pair && uf.find(q.pair[0]) === uf.find(q.pair[1])) connected++;
      if (q.routeSegs) {
        let ok = true;
        for (let i = 0; i < q.routeSegs.length; i++) if (f.failed[q.routeSegs[i]]) { ok = false; break; }
        if (ok) intact++;
      }
      if (zoneNodes.length) {
        const safeRoots = new Set();
        for (const sn of safeNodes) safeRoots.add(uf.find(sn));
        for (let z = 0; z < zoneNodes.length; z++) if (!safeRoots.has(uf.find(zoneNodes[z]))) isolated[z]++;
      }
    }
    for (let z = 0; z < isolated.length; z++) isolated[z] /= trials;
    return {
      trials, pConnected: q.pair ? connected / trials : null, pRouteIntact: q.routeSegs ? intact / trials : null,
      zoneIsolated: isolated, meanFailedSegs: failedTotal / trials
    };
  }

  /* ---------------- Helpers ---------------- */

  /** Merge two per-segment delay arrays (null-safe) by multiplication. */
  function mulDelay(a, b, m) {
    if (!a && !b) return null;
    const out = new Float32Array(m);
    for (let i = 0; i < m; i++) out[i] = (a ? a[i] : 1) * (b ? b[i] : 1);
    return out;
  }
  function rushDelay(G) {
    const out = new Float32Array(G.m);
    for (let s = 0; s < G.m; s++) out[s] = graph.RUSH_MULT[G.segClass[s]];
    return out;
  }
  function mergeBlocked(a, b, m) {
    if (!a && !b) return null;
    const out = new Uint8Array(m);
    for (let i = 0; i < m; i++) out[i] = ((a && a[i]) || (b && b[i])) ? 1 : 0;
    return out;
  }

  return { flood, fireArrival, fireBlocked, quakeProb, sampleFailures, quakeMonteCarlo, mulDelay, rushDelay, mergeBlocked };
});
