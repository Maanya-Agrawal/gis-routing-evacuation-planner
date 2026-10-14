#!/usr/bin/env node
/* Generates a SYNTHETIC test city (jittered street grid, a river with 3 bridges, hospitals, schools,
   buildings, elevation) in the same schema as the real OpenStreetMap export, so the app and the
   tests can run without network access. It is NOT Tambaram — the UI shows a red warning banner.
   Real data: node tools/fetch-osm.js */
const fs = require('fs');
const path = require('path');
const { mulberry32 } = require('../js/core.js');

const N = +(process.argv[2] || 170);          // grid is N x N intersections
const OUT = process.argv[3] || path.join(__dirname, '..', 'data', 'dataset.js');
const rng = mulberry32(2026);
const LAT0 = 12.9000, LON0 = 80.0850, SP = 32; // metres between intersections
const dLat = SP / 111320, dLon = SP / (111320 * Math.cos(12.925 * Math.PI / 180));
const round6 = (x) => Math.round(x * 1e6) / 1e6;

const nodes = [];
const id = (r, c) => r * N + c;
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    const jr = (rng() - 0.5) * 0.5, jc = (rng() - 0.5) * 0.5;
    nodes.push([round6(LAT0 + (r + jr) * dLat), round6(LON0 + (c + jc) * dLon)]);
  }
}
const RIVER_LO = Math.floor(N * 0.45), RIVER_HI = RIVER_LO + 3;      // rows that are water
const BRIDGE_COLS = [Math.floor(N * 0.2), Math.floor(N * 0.52), Math.floor(N * 0.83)];
const clsOfLine = (i) => (i % 24 === 0 ? 'primary' : i % 12 === 0 ? 'secondary' : i % 4 === 0 ? 'tertiary' : 'residential');

const ways = [];
function pushWay(cells, h, o, b, nm) {
  if (cells.length >= 2) ways.push({ n: cells, h, o, b, nm });
}
// horizontal streets (west-east); rows inside the river band are water (no street)
for (let r = 0; r < N; r++) {
  if (r >= RIVER_LO && r <= RIVER_HI) continue;
  const h = clsOfLine(r);
  const oneway = (h === 'residential' && r % 5 === 1) ? (r % 2 ? 1 : -1) : 0;
  const gap = h === 'residential' ? 0.07 : 0.015;
  let cur = [];
  for (let c = 0; c < N; c++) {
    cur.push(id(r, c));
    if (c < N - 1 && rng() < gap) { pushWay(cur, h, oneway, 0, 'East-West Street ' + r); cur = []; }
  }
  pushWay(cur, h, oneway, 0, 'East-West Street ' + r);
}
// vertical streets (south-north); they only cross the river at the three bridge columns
const BANK_LO = RIVER_LO - 1, BANK_HI = RIVER_HI + 1;
for (let c = 0; c < N; c++) {
  const h = clsOfLine(c);
  const oneway = (h === 'residential' && c % 5 === 3) ? (c % 2 ? 1 : -1) : 0;
  const isBr = BRIDGE_COLS.includes(c);
  const gap = h === 'residential' ? 0.07 : 0.015;
  const sections = isBr ? [[0, BANK_LO, 0], [BANK_LO, BANK_HI, 1], [BANK_HI, N - 1, 0]]
                        : [[0, BANK_LO, 0], [BANK_HI, N - 1, 0]];
  for (const sec of sections) {
    const r0 = sec[0], r1 = sec[1], br = sec[2];
    let cur = [];
    for (let r = r0; r <= r1; r++) {
      cur.push(id(r, c));
      if (!br && r < r1 && rng() < gap) { pushWay(cur, h, oneway, 0, 'North-South Street ' + c); cur = []; }
    }
    pushWay(cur, br ? 'primary' : h, oneway, br, 'North-South Street ' + c + (br ? ' (bridge)' : ''));
  }
}

// elevation grid: river valley (low) rising away from it, plus gentle undulation
const ER = 28, EC = 28, elevV = [];
for (let i = 0; i < ER; i++) {
  for (let j = 0; j < EC; j++) {
    const rowFrac = i / (ER - 1);
    const riverFrac = (RIVER_LO + 1.5) / N;
    const dist = Math.abs(rowFrac - riverFrac);
    elevV.push(Math.round((11 + dist * 24 + 1.2 * Math.sin(j * 0.7) + 0.8 * Math.cos(i * 0.9 + j * 0.3)) * 10) / 10);
  }
}
const south = LAT0, west = LON0, north = LAT0 + (N - 1) * dLat, east = LON0 + (N - 1) * dLon;

// POIs placed at random road nodes outside the river band
const pois = [];
function addPois(type, count, prefix) {
  let k = 0;
  while (k < count) {
    const r = Math.floor(rng() * N), c = Math.floor(rng() * N);
    if (r >= RIVER_LO - 1 && r <= RIVER_HI + 1) continue;
    const nd = nodes[id(r, c)];
    pois.push({ lat: nd[0] + 0.00008, lon: nd[1] + 0.00008, type, name: prefix + ' ' + (k + 1) });
    k++;
  }
}
addPois('hospital', 5, 'Test Hospital');
addPois('school', 22, 'Test School');
addPois('college', 3, 'Test College');
addPois('community_centre', 6, 'Test Community Hall');
addPois('fire_station', 4, 'Test Fire Station');

// buildings: clustered gaussian blobs
const buildings = [];
const centers = [];
for (let i = 0; i < 14; i++) centers.push([rng() * N, rng() * N, 6 + rng() * 14]);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
while (buildings.length < 24000) {
  const ctr = centers[Math.floor(rng() * centers.length)];
  const r = ctr[0] + gauss() * ctr[2], c = ctr[1] + gauss() * ctr[2];
  if (r < 0 || c < 0 || r >= N - 1 || c >= N - 1) continue;
  if (r >= RIVER_LO - 0.5 && r <= RIVER_HI + 1.5) continue;
  buildings.push([round6(LAT0 + r * dLat), round6(LON0 + c * dLon)]);
}

const ds = {
  meta: {
    name: 'SYNTHETIC TEST CITY (not Tambaram)', synthetic: true, source: 'tools/make-synthetic.js',
    bbox: [south, west, north, east], elevation: true, buildings: true
  },
  nodes, ways, pois, buildings,
  elev: { s: south, w: west, n: north, e: east, rows: ER, cols: EC, v: elevV }
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, 'window.GEO_DATASET = ' + JSON.stringify(ds) + ';\n');
console.log(`synthetic dataset: ${nodes.length} nodes, ${ways.length} ways, ${pois.length} POIs, ${buildings.length} buildings -> ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
