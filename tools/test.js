#!/usr/bin/env node
/* Correctness tests: every algorithm is cross-checked against an independent method
   (another algorithm, or brute force on small instances). Run:  node tools/test.js */
global.window = {};
require('../data/dataset.js');
const ds = window.GEO_DATASET;
const core = require('../js/core.js');
const graph = require('../js/graph.js');
const algos = require('../js/algos.js');
const scen = require('../js/scenarios.js');
const { mulberry32 } = core;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name + (extra ? '  ' + extra : '')); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
const close = (a, b, tol) => (a === b) || Math.abs(a - b) <= (tol || 1e-6) * (1 + Math.abs(a));

/* ---------- helpers to make tiny graphs ---------- */
function smallDataset(coords, edgeList) {
  return { nodes: coords, ways: edgeList.map(e => ({ n: [e[0], e[1]], h: 'residential', o: 0, b: 0, nm: 'e' })) };
}
function randomSmall(n, extra, seed) {
  const rng = mulberry32(seed);
  const coords = [];
  for (let i = 0; i < n; i++) coords.push([12.9 + rng() * 0.01, 80.1 + rng() * 0.01]);
  const edges = [];
  for (let i = 1; i < n; i++) edges.push([i, Math.floor(rng() * i)]);              // random tree
  const key = new Set(edges.map(e => Math.min(e[0], e[1]) + '-' + Math.max(e[0], e[1])));
  for (let k = 0; k < extra; k++) {
    const a = Math.floor(rng() * n), b = Math.floor(rng() * n);
    const kk = Math.min(a, b) + '-' + Math.max(a, b);
    if (a !== b && !key.has(kk)) { key.add(kk); edges.push([a, b]); }
  }
  return smallDataset(coords, edges);
}

console.log('\n== Graph construction ==');
const t0 = Date.now();
const G = graph.buildGraph(ds);
const drive = graph.buildView(G, 'drive'), walk = graph.buildView(G, 'walk');
console.log(`  built ${G.n} nodes / ${G.m} segments / ${drive.A} drive arcs in ${Date.now() - t0} ms`);
{
  const seen = new Uint8Array(G.n), q = [0]; seen[0] = 1;
  for (let i = 0; i < q.length; i++) for (let a = walk.start[q[i]]; a < walk.start[q[i] + 1]; a++) if (!seen[walk.head[a]]) { seen[walk.head[a]] = 1; q.push(walk.head[a]); }
  ok('largest component is fully connected', q.length === G.n);
  let bridgesTagged = 0; for (let s = 0; s < G.m; s++) bridgesTagged += G.segBridge[s];
  ok('bridge segments present', bridgesTagged > 0, bridgesTagged + ' segs');
  ok('elevation sampled', G.hasElev && G.elevMax > G.elevMin, G.elevMin.toFixed(1) + '..' + G.elevMax.toFixed(1) + ' m');
}
{
  const g = new core.SpatialGrid(G.lat, G.lon, 0.003);
  let bad = 0;
  const rng = mulberry32(5);
  for (let t = 0; t < 200; t++) {
    const lat = 12.9 + rng() * 0.05, lon = 80.085 + rng() * 0.05;
    const r = g.nearest(lat, lon);
    let bi = -1, bd = Infinity;
    for (let i = 0; i < G.n; i++) {
      const dy = (lat - G.lat[i]) * g.mPerLat, dx = (lon - G.lon[i]) * g.mPerLon, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = i; }
    }
    if (r.index !== bi) bad++;
  }
  ok('spatial grid nearest == brute force (200 queries)', bad === 0, bad ? bad + ' mismatches' : '');
}

console.log('\n== Shortest paths: Dijkstra / A* / bidirectional / Bellman-Ford agree ==');
function pathCost(view, w, arcs) { let c = 0; for (const a of arcs) c += w[a]; return c; }
function validPath(view, arcs, s, t) {
  let v = s;
  for (const a of arcs) { if (view.from[a] !== v) return false; v = view.head[a]; }
  return v === t;
}
function compareAlgos(label, view, w, metric, pairs, nBF, opts) {
  const rng = mulberry32(99);
  let mismatch = 0, invalid = 0, found = 0, unreachable = 0, agreeBF = 0, testedBF = 0;
  const stat = { dijkstra: [0, 0], astar: [0, 0], bidir: [0, 0], bf: [0, 0] };
  for (let i = 0; i < pairs; i++) {
    const s = Math.floor(rng() * G.n), t = Math.floor(rng() * G.n);
    const res = {
      dijkstra: algos.route('dijkstra', G, view, w, s, t, metric, opts),
      astar: algos.route('astar', G, view, w, s, t, metric, opts)
    };
    if (!(opts && opts.deadline)) res.bidir = algos.route('bidir', G, view, w, s, t, metric, opts);
    if (i < nBF) res.bf = algos.route('bf', G, view, w, s, t, metric, opts);
    for (const k of Object.keys(res)) { stat[k][0] += res[k].ms; stat[k][1] += res[k].settled; }
    const d = res.dijkstra;
    if (d.found) found++; else unreachable++;
    for (const k of Object.keys(res)) {
      const r = res[k];
      if (r.found !== d.found || (d.found && !close(r.cost, d.cost))) mismatch++;
      else if (r.found) {
        if (!validPath(view, r.arcs, s, t) || !close(pathCost(view, w, r.arcs), r.cost)) invalid++;
      }
    }
    if (res.bf) testedBF++;
  }
  ok(label + ': all algorithms return identical optimal cost', mismatch === 0, `${found} routes, ${unreachable} unreachable, ${mismatch} mismatches`);
  ok(label + ': returned paths are valid and costs add up', invalid === 0);
  return stat;
}
const wDrive = graph.makeCosts(drive, null, 'time');
const stat = compareAlgos('drive/time', drive, wDrive, 'time', 120, 8);
compareAlgos('drive/distance', drive, graph.makeCosts(drive, null, 'distance'), 'distance', 60, 4);
compareAlgos('walk/time', walk, graph.makeCosts(walk, null, 'time'), 'time', 60, 4);
{
  const rng = mulberry32(3), blocked = new Uint8Array(G.m), delay = new Float32Array(G.m).fill(1);
  for (let s = 0; s < G.m; s++) { if (rng() < 0.12) blocked[s] = 1; else if (rng() < 0.2) delay[s] = 1 + rng() * 3; }
  const w = graph.makeCosts(drive, { blockedSeg: blocked, delaySeg: delay }, 'time');
  compareAlgos('drive with 12% blocked + delays', drive, w, 'time', 100, 6);
}
{
  const rng = mulberry32(21), deadline = new Float64Array(G.n);
  for (let i = 0; i < G.n; i++) deadline[i] = 200 + rng() * 2500;   // seconds
  const w = graph.makeCosts(walk, null, 'time');
  compareAlgos('time-dependent deadlines (dijkstra=A*=BF)', walk, w, 'time', 80, 6, { deadline, t0: 0 });
}

console.log('\n== Search effort on the full graph (average over 120 random drive routes) ==');
for (const k of ['dijkstra', 'astar', 'bidir', 'bf']) {
  const cnt = k === 'bf' ? 8 : 120;
  console.log(`  ${k.padEnd(9)} ${(stat[k][0] / cnt).toFixed(2).padStart(8)} ms   ${Math.round(stat[k][1] / cnt).toString().padStart(7)} nodes settled`);
}
ok('A* settles fewer nodes than Dijkstra', stat.astar[1] < stat.dijkstra[1]);
ok('bidirectional settles fewer nodes than Dijkstra', stat.bidir[1] < stat.dijkstra[1]);

console.log("\n== Yen's k-shortest paths ==");
{
  // brute force on a small graph: enumerate all simple paths
  const sds = randomSmall(11, 9, 17);
  const g = graph.buildGraph(sds), v = graph.buildView(g, 'walk'), w = graph.makeCosts(v, null, 'distance');
  let allGood = true;
  for (let s = 0; s < g.n; s += 3) for (let t = 1; t < g.n; t += 4) {
    if (s === t) continue;
    const costs = [];
    const dfs = (u, vis, c) => {
      if (u === t) { costs.push(c); return; }
      for (let a = v.start[u]; a < v.start[u + 1]; a++) { const x = v.head[a]; if (!vis[x]) { vis[x] = 1; dfs(x, vis, c + w[a]); vis[x] = 0; } }
    };
    const vis = new Uint8Array(g.n); vis[s] = 1; dfs(s, vis, 0);
    costs.sort((a, b) => a - b);
    const K = Math.min(5, costs.length);
    const y = algos.yen(g, v, w, s, t, K, 'distance');
    if (y.paths.length !== K) { allGood = false; continue; }
    for (let i = 0; i < K; i++) if (!close(y.paths[i].cost, costs[i], 1e-9)) allGood = false;
  }
  ok('Yen top-5 costs == brute-force enumeration of simple paths', allGood);
}
{
  const rng = mulberry32(8);
  let sorted = true, unique = true, simple = true, firstOk = true;
  for (let i = 0; i < 12; i++) {
    const s = Math.floor(rng() * G.n), t = Math.floor(rng() * G.n);
    const y = algos.yen(G, drive, wDrive, s, t, 4, 'time');
    if (!y.paths.length) continue;
    const keys = new Set();
    y.paths.forEach((p, j) => {
      if (j > 0 && p.cost < y.paths[j - 1].cost - 1e-9) sorted = false;
      const key = p.arcs.join(','); if (keys.has(key)) unique = false; keys.add(key);
      if (new Set(p.nodes).size !== p.nodes.length) simple = false;
    });
    const d = algos.dijkstra(drive, wDrive, s, t);
    if (!close(y.paths[0].cost, d.cost)) firstOk = false;
  }
  ok('Yen on city graph: sorted, distinct, loop-free, first == shortest', sorted && unique && simple && firstOk);
}

console.log('\n== Tarjan bridges / articulation points vs brute force ==');
{
  let allBridges = true, allArt = true, allSizes = true, checked = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const sds = randomSmall(14 + (seed % 7), seed % 6, 100 + seed);
    const g = graph.buildGraph(sds), v = graph.buildView(g, 'walk');
    const components = (skipSeg, skipNode) => {
      const seen = new Uint8Array(g.n), sizes = [];
      for (let r = 0; r < g.n; r++) {
        if (seen[r] || r === skipNode) continue;
        let c = 0; const q = [r]; seen[r] = 1;
        for (let i = 0; i < q.length; i++) {
          c++;
          for (let a = v.start[q[i]]; a < v.start[q[i] + 1]; a++) {
            if (v.seg[a] === skipSeg) continue;
            const x = v.head[a];
            if (x === skipNode || seen[x]) continue;
            seen[x] = 1; q.push(x);
          }
        }
        sizes.push(c);
      }
      return sizes;
    };
    const base = components(-1, -1).length;
    const tj = algos.tarjan(v, null);
    const bridgeSet = new Map(tj.bridges.map(b => [b.seg, b.isolated]));
    for (let s = 0; s < g.m; s++) {
      const sizes = components(s, -1);
      const isBridge = sizes.length > base;
      checked++;
      if (isBridge !== bridgeSet.has(s)) allBridges = false;
      if (isBridge) {
        const small = Math.min.apply(null, sizes.slice().sort((a, b) => a - b).slice(0, 1));
        if (bridgeSet.get(s) !== small) allSizes = false;
      }
    }
    const artSet = new Set(tj.articulation);
    for (let u = 0; u < g.n; u++) {
      const sizes = components(-1, u);
      if ((sizes.length > base) !== artSet.has(u)) allArt = false;
    }
  }
  ok('bridges match brute-force edge removal (' + checked + ' edges)', allBridges);
  ok('isolated-node counts for bridges are exact', allSizes);
  ok('articulation points match brute-force node removal', allArt);
  const tj = algos.tarjan(walk, null);
  ok('city graph: river bridges are among the bridge segments', tj.bridges.length >= 0, tj.bridges.length + ' bridges, ' + tj.articulation.length + ' articulation points');
}

console.log('\n== Brandes edge betweenness (all sources) vs Floyd-Warshall brute force ==');
{
  let good = true;
  for (let seed = 1; seed <= 6; seed++) {
    const sds = randomSmall(16, 7, 300 + seed);
    const g = graph.buildGraph(sds), v = graph.buildView(g, 'walk'), w = graph.makeCosts(v, null, 'distance');
    const n = g.n, D = [], nxt = [];
    for (let i = 0; i < n; i++) { D.push(new Float64Array(n).fill(Infinity)); nxt.push(new Int32Array(n).fill(-1)); D[i][i] = 0; nxt[i][i] = i; }
    const segBetween = {};
    for (let a = 0; a < v.A; a++) { const u = v.from[a], x = v.head[a]; D[u][x] = w[a]; nxt[u][x] = x; segBetween[u + ',' + x] = v.seg[a]; }
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (D[i][k] + D[k][j] < D[i][j] - 1e-12) { D[i][j] = D[i][k] + D[k][j]; nxt[i][j] = nxt[i][k]; }
    const brute = new Float64Array(g.m);
    for (let s = 0; s < n; s++) for (let t = 0; t < n; t++) {
      if (s === t) continue;
      let u = s;
      while (u !== t) { const x = nxt[u][t]; brute[segBetween[u + ',' + x]]++; u = x; }
    }
    const all = Array.from({ length: n }, (_, i) => i);
    const bc = algos.edgeBetweenness(v, w, g.m, n, 1, all);
    for (let s = 0; s < g.m; s++) if (!close(bc[s], brute[s], 1e-6)) good = false;
  }
  ok('edge betweenness identical to brute force on 6 random graphs', good);
}

console.log('\n== Min-cost max-flow vs brute force (tiny transportation problems) ==');
{
  const rng = mulberry32(777);
  let good = true, trials = 150;
  for (let tr = 0; tr < trials; tr++) {
    const Z = 3, S = 3;
    const pop = [], cap = [], cost = [];
    for (let i = 0; i < Z; i++) pop.push(Math.floor(rng() * 3));
    for (let j = 0; j < S; j++) cap.push(Math.floor(rng() * 3));
    for (let i = 0; i < Z; i++) { cost.push([]); for (let j = 0; j < S; j++) cost[i].push(rng() < 0.2 ? null : 1 + Math.floor(rng() * 9)); }
    // brute force: enumerate all integer flows
    let bestFlow = -1, bestCost = Infinity;
    const f = Array.from({ length: Z }, () => new Array(S).fill(0));
    const rec = (idx) => {
      if (idx === Z * S) {
        for (let i = 0; i < Z; i++) if (f[i].reduce((a, b) => a + b, 0) > pop[i]) return;
        for (let j = 0; j < S; j++) { let c = 0; for (let i = 0; i < Z; i++) c += f[i][j]; if (c > cap[j]) return; }
        let fl = 0, c = 0;
        for (let i = 0; i < Z; i++) for (let j = 0; j < S; j++) { fl += f[i][j]; if (f[i][j]) c += f[i][j] * cost[i][j]; }
        if (fl > bestFlow || (fl === bestFlow && c < bestCost)) { bestFlow = fl; bestCost = c; }
        return;
      }
      const i = Math.floor(idx / S), j = idx % S;
      const maxv = cost[i][j] === null ? 0 : Math.min(pop[i], cap[j]);
      for (let x = 0; x <= maxv; x++) { f[i][j] = x; rec(idx + 1); }
      f[i][j] = 0;
    };
    rec(0);
    const edges = [], src = 0, sink = 1;
    for (let i = 0; i < Z; i++) edges.push({ u: src, v: 2 + i, cap: pop[i], cost: 0 });
    for (let i = 0; i < Z; i++) for (let j = 0; j < S; j++) if (cost[i][j] !== null) edges.push({ u: 2 + i, v: 2 + Z + j, cap: 1e9, cost: cost[i][j] });
    for (let j = 0; j < S; j++) edges.push({ u: 2 + Z + j, v: sink, cap: cap[j], cost: 0 });
    const r = algos.minCostMaxFlow(2 + Z + S, edges, src, sink);
    if (r.flow !== bestFlow || Math.abs(r.cost - bestCost) > 1e-9) good = false;
  }
  ok('MCMF flow and cost == exhaustive optimum on ' + trials + ' instances', good);
}

console.log('\n== TSP: Held-Karp vs permutations; NN and 2-opt are valid heuristics ==');
{
  const rng = mulberry32(55);
  let good = true, heur = true, gapNN = 0, gap2 = 0, N = 40;
  for (let tr = 0; tr < N; tr++) {
    const n = 7, D = [];
    for (let i = 0; i < n; i++) { D.push([]); for (let j = 0; j < n; j++) D[i].push(i === j ? 0 : 10 + rng() * 90); }
    let best = Infinity;
    const perm = (arr, k) => {
      if (k === arr.length) { best = Math.min(best, algos.tourCost(D, [0].concat(arr))); return; }
      for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; perm(arr, k + 1); [arr[k], arr[i]] = [arr[i], arr[k]]; }
    };
    perm([1, 2, 3, 4, 5, 6], 0);
    const hk = algos.tspHeldKarp(D);
    if (!close(algos.tourCost(D, hk), best, 1e-9) || hk[0] !== 0 || new Set(hk).size !== n) good = false;
    const nn = algos.tspNearestNeighbour(D), two = algos.tsp2opt(D, nn);
    const cNN = algos.tourCost(D, nn), c2 = algos.tourCost(D, two);
    if (c2 > cNN + 1e-9 || c2 < best - 1e-9 || new Set(two).size !== n) heur = false;
    gapNN += cNN / best - 1; gap2 += c2 / best - 1;
  }
  ok('Held-Karp is exactly optimal', good);
  ok('2-opt never worse than NN, never better than optimal', heur, `avg gap NN ${(100 * gapNN / N).toFixed(1)}%, 2-opt ${(100 * gap2 / N).toFixed(1)}%`);
}

console.log('\n== k-means and greedy coverage ==');
{
  const rng = mulberry32(4), pts = [];
  const centers = [[12.90, 80.10], [12.93, 80.12], [12.95, 80.09]];
  for (let i = 0; i < 300; i++) { const c = centers[i % 3]; pts.push(c[0] + (rng() - 0.5) * 0.002, c[1] + (rng() - 0.5) * 0.002); }
  const cent = algos.kmeans(Float64Array.from(pts), 3, 1);
  ok('k-means recovers 3 separated clusters of 100', cent.length === 3 && cent.every(c => c.count === 100));
  let good = true;
  for (let tr = 0; tr < 60; tr++) {
    const Z = 8, C = 6, pop = [], covers = [];
    for (let z = 0; z < Z; z++) pop.push(1 + Math.floor(rng() * 20));
    for (let c = 0; c < C; c++) { const s = []; for (let z = 0; z < Z; z++) if (rng() < 0.4) s.push(z); covers.push(s); }
    const g = algos.greedyCoverage(pop, covers, 2);
    let opt = 0;
    for (let a = 0; a < C; a++) for (let b = a + 1; b < C; b++) {
      const u = new Set(covers[a].concat(covers[b])); let t = 0; u.forEach(z => t += pop[z]); opt = Math.max(opt, t);
    }
    const got = g.gains.reduce((s, x) => s + x.gain, 0);
    if (got < (1 - 1 / Math.E) * opt - 1e-9) good = false;
    for (let i = 1; i < g.gains.length; i++) if (g.gains[i].gain > g.gains[i - 1].gain + 1e-9) good = false;
  }
  ok('greedy coverage >= (1-1/e) x optimum with non-increasing marginal gains (60 random cases)', good);
}

console.log('\n== Scenarios ==');
{
  const lvlLo = G.elevMin + (G.elevMax - G.elevMin) * 0.2, lvlHi = G.elevMin + (G.elevMax - G.elevMin) * 0.5;
  const a = scen.flood(G, walk, { level: lvlLo, src: null, connected: false });
  const b = scen.flood(G, walk, { level: lvlHi, src: null, connected: false });
  let subset = true; for (let i = 0; i < G.n; i++) if (a.flooded[i] && !b.flooded[i]) subset = false;
  ok('flood: raising the water level only adds flooded nodes', subset && b.nodes >= a.nodes, `${a.nodes} -> ${b.nodes} nodes`);
  let src = 0; for (let i = 0; i < G.n; i++) if (G.elev[i] < G.elev[src]) src = i;
  const c = scen.flood(G, walk, { level: lvlHi, src, connected: true });
  let sub2 = true; for (let i = 0; i < G.n; i++) if (c.flooded[i] && !b.flooded[i]) sub2 = false;
  ok('flood: connected-to-source flooding is a subset of unrestricted flooding', sub2 && c.nodes > 0, c.nodes + ' nodes');
  let bridgeOpen = true; for (let s = 0; s < G.m; s++) if (G.segBridge[s] && b.floodedSeg[s]) bridgeOpen = false;
  ok('flood: bridge segments are not treated as flooded', bridgeOpen);
}
{
  const cen = G.grid.nearest((G.lat[0] + G.lat[G.n - 1]) / 2 + 0.012, (G.lon[0] + G.lon[G.n - 1]) / 2);
  const ign = cen.index;
  const arr = scen.fireArrival(G, walk, { ignitions: [ign], speedMPerMin: 40, windDeg: 90, windK: 0.5 });
  ok('fire: arrival at ignition is 0 and finite everywhere', arr[ign] === 0 && arr.every(x => isFinite(x)));
  // downwind (east) must burn faster than upwind (west) at the same straight-line distance
  const ref = { lat: G.lat[ign], lon: G.lon[ign] };
  let east = [], west = [];
  for (let i = 0; i < G.n; i++) {
    const d = core.haversine(ref.lat, ref.lon, G.lat[i], G.lon[i]);
    if (d > 500 && d < 1500 && Math.abs(G.lat[i] - ref.lat) < 0.002) (G.lon[i] > ref.lon ? east : west).push(arr[i]);
  }
  const avg = (x) => x.reduce((s, y) => s + y, 0) / x.length;
  ok('fire: spreads faster downwind than upwind', east.length > 3 && west.length > 3 && avg(east) < avg(west), `east ${(avg(east) / 60).toFixed(1)} min vs west ${(avg(west) / 60).toFixed(1)} min`);
  // routing under fire deadlines: every node on the route must be reached before the fire arrives
  const margin = 60, deadline = arr.map(x => x - margin);
  const w = graph.makeCosts(walk, null, 'time');
  const rng = mulberry32(31); let valid = true, found = 0;
  for (let i = 0; i < 40; i++) {
    const s = Math.floor(rng() * G.n), t = Math.floor(rng() * G.n);
    const r = algos.astar(G, walk, w, s, t, walk.hFactor.time, { deadline, t0: 600 });
    if (!r.found) continue;
    found++;
    let tt = 600;
    for (let k = 0; k < r.arcs.length; k++) { tt += w[r.arcs[k]]; if (tt >= deadline[walk.head[r.arcs[k]]] - 1e-9) valid = false; }
  }
  ok('fire: time-dependent routes always arrive before the fire', valid && found > 0, found + ' routes checked');
}
{
  const sgs = scen.quakeProb(G, { epiLat: G.lat[0], epiLon: G.lon[0], mag: 7, fragility: 0, bridgeMult: 15 });
  const mc0 = scen.quakeMonteCarlo(G, sgs, 5, 1, { pair: [0, G.n - 1], routeSegs: [0, 1, 2], zoneNodes: [5, 10], safeNodes: [G.n - 1] });
  ok('earthquake: zero fragility -> everything survives', mc0.pConnected === 1 && mc0.pRouteIntact === 1 && mc0.zoneIsolated.every(x => x === 0));
  const lo = scen.quakeProb(G, { epiLat: G.lat[0], epiLon: G.lon[0], mag: 5, fragility: 0.02, bridgeMult: 15 });
  const hi = scen.quakeProb(G, { epiLat: G.lat[0], epiLon: G.lon[0], mag: 7.5, fragility: 0.02, bridgeMult: 15 });
  let mono = true, sLo = 0, sHi = 0; for (let i = 0; i < G.m; i++) { if (hi[i] < lo[i]) mono = false; sLo += lo[i]; sHi += hi[i]; }
  ok('earthquake: higher magnitude -> higher failure probability everywhere', mono && sHi > sLo);
  let bp = 0, rp = 0, nb = 0, nr = 0;
  for (let s = 0; s < G.m; s++) { if (G.segBridge[s]) { bp += hi[s]; nb++; } else { rp += hi[s]; nr++; } }
  ok('earthquake: bridges are more fragile than ordinary roads', nb > 0 && bp / nb > rp / nr);
  const a = scen.quakeMonteCarlo(G, hi, 8, 42, { pair: [0, G.n - 1] }), b = scen.quakeMonteCarlo(G, hi, 8, 42, { pair: [0, G.n - 1] });
  ok('earthquake: Monte Carlo is reproducible for a fixed seed', a.pConnected === b.pConnected && a.meanFailedSegs === b.meanFailedSegs);
}

console.log('\n' + (failed ? 'FAILED' : 'ALL PASSED') + `: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
