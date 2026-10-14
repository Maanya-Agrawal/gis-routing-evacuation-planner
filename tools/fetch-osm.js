#!/usr/bin/env node
/* Downloads REAL map data and writes data/dataset.js for the app.
     roads      OpenStreetMap via the Overpass API
     POIs       hospitals, schools, colleges, fire stations, community centres, ...
     buildings  building centroids (used as a population proxy)
     elevation  SRTM 30 m via the OpenTopoData public API (coarse grid, interpolated in the app)

   Usage (Node 18+, needs internet):
     node tools/fetch-osm.js                              # default Tambaram bounding box
     node tools/fetch-osm.js --bbox 12.90,80.06,12.95,80.13 --name "Tambaram, Chennai"
     node tools/fetch-osm.js --no-buildings --no-elevation
   bbox order is south,west,north,east. Smaller box = faster app. */
const fs = require('fs');
const path = require('path');

const DEFAULT_BBOX = [12.9000, 80.0600, 12.9500, 80.1300];
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const UA = 'tambaram-geo-planner/1.0 (student DAA project; contact: local)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/* ------------------------ pure processing functions (unit-tested) ------------------------ */

function onewayCode(tags) {
  const v = tags.oneway;
  if (v === 'yes' || v === 'true' || v === '1') return 1;
  if (v === '-1' || v === 'reverse') return -1;
  if (v === 'no') return 0;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 1;
  return 0;
}

/** Overpass elements (ways + nodes) -> {nodes:[[lat,lon]], ways:[{n,h,o,b,nm}]} with dense node indices. */
function processRoads(elements) {
  const coord = new Map();
  for (const e of elements) if (e.type === 'node') coord.set(e.id, [e.lat, e.lon]);
  const index = new Map(), nodes = [], ways = [];
  for (const e of elements) {
    if (e.type !== 'way' || !e.tags || !e.tags.highway || !e.nodes) continue;
    const idxs = [];
    for (const id of e.nodes) {
      const c = coord.get(id);
      if (!c) continue;
      let i = index.get(id);
      if (i === undefined) { i = nodes.length; index.set(id, i); nodes.push([r6(c[0]), r6(c[1])]); }
      idxs.push(i);
    }
    if (idxs.length < 2) continue;
    const t = e.tags;
    ways.push({
      n: idxs, h: t.highway.replace('_link', ''), o: onewayCode(t),
      b: (t.bridge && t.bridge !== 'no') ? 1 : 0, nm: t.name || t.ref || ''
    });
  }
  return { nodes, ways };
}

const POI_TYPES = { hospital: 'hospital', clinic: 'clinic', school: 'school', college: 'college', university: 'college',
  fire_station: 'fire_station', community_centre: 'community_centre', shelter: 'shelter', police: 'police' };

function processPois(elements) {
  const out = [];
  for (const e of elements) {
    const t = e.tags || {};
    const lat = e.lat !== undefined ? e.lat : (e.center ? e.center.lat : undefined);
    const lon = e.lon !== undefined ? e.lon : (e.center ? e.center.lon : undefined);
    if (lat === undefined) continue;
    let type = POI_TYPES[t.amenity];
    if (!type && t.emergency === 'assembly_point') type = 'assembly_point';
    if (!type) continue;
    out.push({ lat: r6(lat), lon: r6(lon), type, name: t.name || (type.replace('_', ' ') + ' (unnamed)') });
  }
  return out;
}

function processBuildings(elements) {
  const out = [];
  for (const e of elements) {
    const c = e.center || (e.lat !== undefined ? { lat: e.lat, lon: e.lon } : null);
    if (c) out.push([Math.round(c.lat * 1e5) / 1e5, Math.round(c.lon * 1e5) / 1e5]);
  }
  return out;
}

/** Replace null cells by the mean of valid neighbours (repeat until the grid is full). */
function fillGrid(v, rows, cols) {
  const out = v.slice();
  let missing = out.filter(x => x === null || x === undefined || Number.isNaN(x)).length;
  if (missing === out.length) return null;
  let guard = 0;
  while (missing > 0 && guard++ < rows + cols) {
    const next = out.slice();
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const k = i * cols + j;
      if (out[k] !== null && out[k] !== undefined && !Number.isNaN(out[k])) continue;
      let s = 0, c = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= rows || jj >= cols) continue;
        const x = out[ii * cols + jj];
        if (x !== null && x !== undefined && !Number.isNaN(x)) { s += x; c++; }
      }
      if (c) next[k] = s / c;
    }
    for (let k = 0; k < out.length; k++) out[k] = next[k];
    missing = out.filter(x => x === null || x === undefined || Number.isNaN(x)).length;
  }
  return out.map(x => Math.round(x * 10) / 10);
}

/* ------------------------ network access ------------------------ */

async function overpass(query, label) {
  let lastErr;
  for (let round = 0; round < 4; round++) {
    for (const ep of ENDPOINTS) {
      try {
        process.stdout.write(`  ${label}: querying ${new URL(ep).host} ... `);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 240000);
        const res = await fetch(ep, {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Accept': 'application/json' },
          body: 'data=' + encodeURIComponent(query)
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        console.log('ok (' + json.elements.length + ' elements)');
        return json.elements;
      } catch (err) {
        lastErr = err;
        console.log('failed (' + err.message + ')');
        // 429 / 504 mean the public server is busy: back off before the next try
        await sleep(/429|504|502|503/.test(err.message) ? 15000 : 3000);
      }
    }
  }
  throw new Error(label + ' failed on every Overpass endpoint: ' + lastErr.message);
}

async function fetchElevation(bbox, rows, cols) {
  const [s, w, n, e] = bbox;
  const pts = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) pts.push([s + (n - s) * i / (rows - 1), w + (e - w) * j / (cols - 1)]);
  const vals = new Array(pts.length).fill(null);
  for (let off = 0; off < pts.length; off += 100) {
    const chunk = pts.slice(off, off + 100);
    let got = null;
    try {
      const url = 'https://api.opentopodata.org/v1/srtm30m?locations=' + chunk.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join('|');
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      got = j.results.map(r => r.elevation);
    } catch (err) {
      try {
        const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ locations: chunk.map(p => ({ latitude: p[0], longitude: p[1] })) })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        got = (await res.json()).results.map(r => r.elevation);
      } catch (err2) { console.log('  elevation chunk failed: ' + err.message + ' / ' + err2.message); }
    }
    if (got) for (let k = 0; k < got.length; k++) vals[off + k] = got[k];
    process.stdout.write(`\r  elevation: ${Math.min(off + 100, pts.length)}/${pts.length} points`);
    await sleep(1200); // public API allows ~1 request per second
  }
  console.log('');
  const filled = fillGrid(vals, rows, cols);
  if (!filled) return null;
  return { s, w, n, e, rows, cols, v: filled };
}

/* ------------------------ main ------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const has = (k) => args.includes('--' + k);
  const bbox = get('bbox', DEFAULT_BBOX.join(',')).split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(Number.isNaN)) throw new Error('--bbox must be south,west,north,east');
  const name = get('name', 'Tambaram, Chennai');
  const out = get('out', path.join(__dirname, '..', 'data', 'dataset.js'));
  const grid = +get('grid', 24);
  const B = `(${bbox.join(',')})`;
  console.log(`Fetching "${name}"  bbox=${bbox.join(',')}`);

  const roadsEl = await overpass(
    `[out:json][timeout:180];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road)$"]${B};out body;>;out skel qt;`,
    'roads');
  const roads = processRoads(roadsEl);
  console.log(`  -> ${roads.nodes.length} nodes, ${roads.ways.length} ways`);

  await sleep(5000); // be polite to the free server between queries
  let poiEl = [];
  try { poiEl = await overpass(
    `[out:json][timeout:120];(nwr["amenity"~"^(hospital|clinic|school|college|university|fire_station|community_centre|shelter|police)$"]${B};nwr["emergency"="assembly_point"]${B};);out center tags;`,
    'places'); }
  catch (err) { console.log('  !! places skipped: ' + err.message + '\n  !! the app will have no hospitals/shelters; re-run later to fix'); }
  const pois = processPois(poiEl);
  const counts = {}; pois.forEach(p => counts[p.type] = (counts[p.type] || 0) + 1);
  console.log('  -> places:', JSON.stringify(counts));

  let buildings = [];
  await sleep(5000);
  if (!has('no-buildings')) {
    try {
      let el;
      try { el = await overpass(`[out:json][timeout:180];way["building"]${B};out ids center qt;`, 'buildings'); }
      catch (e) { el = await overpass(`[out:json][timeout:180];way["building"]${B};out center qt;`, 'buildings (retry)'); }
      buildings = processBuildings(el);
      console.log(`  -> ${buildings.length} buildings`);
    } catch (err) { console.log('  buildings skipped: ' + err.message); }
  }

  let elev = null;
  if (!has('no-elevation')) {
    try { elev = await fetchElevation(bbox, grid, grid); }
    catch (err) { console.log('  elevation skipped: ' + err.message); }
    if (elev) { const lo = Math.min(...elev.v), hi = Math.max(...elev.v); console.log(`  -> elevation ${lo}..${hi} m`); }
    else console.log('  !! no elevation: the Flood scenario will be disabled');
  }

  const ds = {
    meta: { name, synthetic: false, source: 'OpenStreetMap contributors (Overpass API); SRTM 30m via OpenTopoData',
      fetched: new Date().toISOString(), bbox, elevation: !!elev, buildings: buildings.length > 0 },
    nodes: roads.nodes, ways: roads.ways, pois, buildings
  };
  if (elev) ds.elev = elev;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'window.GEO_DATASET = ' + JSON.stringify(ds) + ';\n');
  console.log(`\nWrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB). Open index.html to use it.`);
}

module.exports = { onewayCode, processRoads, processPois, processBuildings, fillGrid };
if (require.main === module) main().catch(e => { console.error('\nERROR: ' + e.message); process.exit(1); });
