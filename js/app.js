/* app.js — user interface. All the algorithms live in core/graph/algos/scenarios; this file only
   wires them to the map and the sidebar. Everything displayed is computed from window.GEO_DATASET. */
(function () {
  'use strict';
  const { haversine, mulberry32 } = Geo.core;
  const gr = Geo.graph, al = Geo.algos, scen = Geo.scen;
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now();

  /* ---- UI configuration (tunable, no data values) ---- */
  const CFG = {
    snapM: 800,               // max distance from a click to the nearest road node
    facilitySnapM: 1500,      // facilities further than this from any road are ignored
    zoneSnapM: 3000,
    wadeDepthM: 0.5, wadeSlow: 3,     // walking through shallow floodwater
    quakeBridgeMult: 15, quakeRings: [1000, 3000, 6000],
    maxStops: 12, maxExplored: 9000, seed: 11,
    roadColors: ['#7a5c1e', '#8b6a25', '#9a7a30', '#a8905a', '#a39d84', '#a9a48c', '#b3ae97', '#b8b49f', '#aaa690'],
    roadWidths: [3.4, 3.1, 2.7, 2.3, 1.7, 1.2, 1.0, 0.8, 0.8]
  };
  const COL = { green: '#1e7a46', red: '#b93a32', amber: '#c1852a', water: '#3b7f8f', ink: '#22261f', pale: '#e0b96a' };
  const POI_LETTER = { hospital: 'H', clinic: '+', fire_station: 'F', school: 'S', college: 'C', community_centre: 'C', shelter: 'S', assembly_point: 'A', police: 'P' };
  const SHELTER_TYPES = ['school', 'college', 'community_centre', 'shelter', 'assembly_point'];
  const CAP_INPUT = { school: 'capSchool', college: 'capCollege', community_centre: 'capCommunity' };

  const fmtDist = (m) => m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
  const fmtTime = (s) => {
    if (!isFinite(s)) return '–';
    const m = Math.floor(s / 60);
    if (m >= 60) return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
    return m > 0 ? m + ' min ' + Math.round(s % 60) + ' s' : Math.round(s) + ' s';
  };
  const fmtN = (x) => Math.round(x).toLocaleString('en-IN');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const compass = (d) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];
  const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
  const idsWhere = (arr) => { const o = []; for (let i = 0; i < arr.length; i++) if (arr[i]) o.push(i); return Int32Array.from(o); };
  const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (f) => setTimeout(f, 16);

  const ds = window.GEO_DATASET;
  if (!ds) {
    $('dsName').textContent = 'No dataset found';
    $('banner').className = 'banner bad';
    $('banner').textContent = 'data/dataset.js is missing. Run: node tools/fetch-osm.js';
    return;
  }

  /* ================================================================== */
  /*  Data and graph                                                     */
  /* ================================================================== */
  const G = gr.buildGraph(ds);
  const V = { drive: gr.buildView(G, 'drive'), walk: gr.buildView(G, 'walk') };
  const meta = ds.meta || {};

  // Facilities: every place snapped to its nearest road node.
  function makeFacilities() {
    const snap = (p) => {
      const h = G.grid.nearest(p.lat, p.lon, CFG.facilitySnapM);
      return h ? { node: h.index, name: p.name, type: p.type, lat: p.lat, lon: p.lon } : null;
    };
    const all = (ds.pois || []).map(snap).filter(Boolean);
    let hosp = all.filter((f) => f.type === 'hospital');
    if (!hosp.length) hosp = all.filter((f) => f.type === 'clinic');
    return {
      all,
      hospital: hosp,
      fire_station: all.filter((f) => f.type === 'fire_station'),
      shelter: all.filter((f) => SHELTER_TYPES.includes(f.type))
    };
  }
  const FAC = makeFacilities();

  /* ================================================================== */
  /*  State                                                              */
  /* ================================================================== */
  const S = {
    scenario: 'everyday', mode: 'drive', rush: false, pick: null,
    origin: null, dest: null, stops: [],
    flood: { level: 0, src: null },
    fire: { ign: [] },
    quake: { epi: null, prob: null, failed: null, seed: 1 },
    scn: { blockedSeg: null, delaySeg: null, deadline: null, t0: 0 },
    zones: null, zonesKey: '', lastRoute: null, legend: {}
  };
  const markers = { A: null, B: null, flood: null, quake: null, fire: [], stops: [], rings: [] };
  const groups = {};

  /* ================================================================== */
  /*  Map and canvas overlay                                             */
  /* ================================================================== */
  const bb = (function () {
    if (meta.bbox) return meta.bbox;
    let s = 90, w = 180, n = -90, e = -180;
    for (let i = 0; i < G.n; i++) { s = Math.min(s, G.lat[i]); n = Math.max(n, G.lat[i]); w = Math.min(w, G.lon[i]); e = Math.max(e, G.lon[i]); }
    return [s, w, n, e];
  })();
  const map = L.map('map', { zoomControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false, preferCanvas: true, zoomSnap: 0.5 });
  map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]]);
  // Base map. Carto needs an API key and OpenStreetMap's own servers block pages opened from a file,
  // so the default is Esri's public street map. Change with ?tiles=osm (needs http://localhost) or ?tiles=none.
  const TILES = {
    esri: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', attr: 'Tiles &copy; Esri' },
    osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap contributors' }
  };
  const tileChoice = (location.search.match(/[?&]tiles=(\w+)/) || [])[1] || 'esri';
  if (!meta.synthetic && TILES[tileChoice]) {
    L.tileLayer(TILES[tileChoice].url, { maxZoom: 19, attribution: TILES[tileChoice].attr }).addTo(map);
  }
  L.control.scale({ imperial: false }).addTo(map);

  const merc = (flat) => {
    const out = new Float64Array(flat.length);
    for (let i = 0; i < flat.length; i += 2) {
      out[i + 1] = 0.5 - Math.log(Math.tan(Math.PI / 4 + flat[i] * Math.PI / 360)) / (2 * Math.PI);
      out[i] = (flat[i + 1] + 180) / 360;
    }
    return out; // (lat,lon) pairs in, normalised Web-Mercator (x,y) pairs out
  };

  const Overlay = L.Layer.extend({
    initialize() { this.items = new Map(); this._raf = 0; },
    onAdd(m) {
      this._map = m;
      this._c = L.DomUtil.create('canvas', 'geo-canvas');
      this._c.style.position = 'absolute'; this._c.style.pointerEvents = 'none';
      m.getPanes().overlayPane.appendChild(this._c);
      m.on('moveend zoomend resize', this.redraw, this);
      this.redraw();
    },
    onRemove(m) { L.DomUtil.remove(this._c); m.off('moveend zoomend resize', this.redraw, this); },
    set(name, item) { this.items.set(name, item); this.redraw(); },
    get(name) { return this.items.get(name); },
    remove(name) { if (this.items.delete(name)) this.redraw(); },
    removePrefix(p) { let ch = false; for (const k of Array.from(this.items.keys())) if (k.startsWith(p)) { this.items.delete(k); ch = true; } if (ch) this.redraw(); },
    show(name, on) { const it = this.items.get(name); if (it) { it.hidden = !on; this.redraw(); } },
    redraw() { if (this._raf) return; this._raf = raf(() => { this._raf = 0; this._draw(); }); },
    _draw() {
      const m = this._map; if (!m) return;
      const size = m.getSize(), pad = 200, W = size.x + 2 * pad, H = size.y + 2 * pad, dpr = window.devicePixelRatio || 1;
      const c = this._c;
      c.width = Math.max(1, Math.round(W * dpr)); c.height = Math.max(1, Math.round(H * dpr));
      c.style.width = W + 'px'; c.style.height = H + 'px';
      L.DomUtil.setPosition(c, m.containerPointToLayerPoint([-pad, -pad]));
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const z = m.getZoom(), scale = 256 * Math.pow(2, z);
      const o = m.project(m.containerPointToLatLng([-pad, -pad]), z);
      const zf = Math.max(0.55, Math.min(2.4, 0.55 + (z - 12) * 0.3));
      const items = Array.from(this.items.values()).filter((it) => !it.hidden).sort((a, b) => (a.z || 0) - (b.z || 0));
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const it of items) {
        const xy = it.xy;
        ctx.globalAlpha = it.alpha === undefined ? 1 : it.alpha;
        if (it.kind === 'lines') {
          ctx.strokeStyle = it.color; ctx.lineWidth = it.width * (it.noZoom ? 1 : zf);
          ctx.setLineDash(it.dash || []);
          ctx.beginPath();
          for (let i = 0; i + 3 < xy.length; i += 4) {
            const x1 = xy[i] * scale - o.x, y1 = xy[i + 1] * scale - o.y, x2 = xy[i + 2] * scale - o.x, y2 = xy[i + 3] * scale - o.y;
            if ((x1 < 0 && x2 < 0) || (x1 > W && x2 > W) || (y1 < 0 && y2 < 0) || (y1 > H && y2 > H)) continue;
            ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
          }
          ctx.stroke();
        } else {
          ctx.fillStyle = it.color; const r = it.radius * (it.noZoom ? 1 : Math.max(0.8, zf));
          ctx.beginPath();
          for (let i = 0; i + 1 < xy.length; i += 2) {
            const x = xy[i] * scale - o.x, y = xy[i + 1] * scale - o.y;
            if (x < -r || x > W + r || y < -r || y > H + r) continue;
            ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832);
          }
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    }
  });
  const overlay = new Overlay();
  overlay.addTo(map);

  /** Draw a flat [lat,lon,lat,lon,...] list as line segments (4 numbers each) or points (2 each). */
  function lines(name, flat, color, width, extra) {
    if (!flat || !flat.length) { overlay.remove(name); return; }
    overlay.set(name, Object.assign({ kind: 'lines', xy: merc(flat), color, width }, extra));
  }
  function points(name, flat, color, radius, extra) {
    if (!flat || !flat.length) { overlay.remove(name); return; }
    overlay.set(name, Object.assign({ kind: 'points', xy: merc(flat), color, radius }, extra));
  }
  const nodeFlat = (nodes) => { const f = new Float64Array(nodes.length * 2); for (let i = 0; i < nodes.length; i++) { f[2 * i] = G.lat[nodes[i]]; f[2 * i + 1] = G.lon[nodes[i]]; } return f; };

  // Base road network, one layer per road class.
  (function drawBase() {
    const per = gr.CLASSES.map(() => []);
    const bridges = [];
    for (let s = 0; s < G.m; s++) { per[G.segClass[s]].push(s); if (G.segBridge[s]) bridges.push(s); }
    for (let c = gr.CLASSES.length - 1; c >= 0; c--) {
      if (!per[c].length) continue;
      lines('base' + c, gr.segCoords(G, per[c]), CFG.roadColors[c], CFG.roadWidths[c], { z: 10 - c * 0.1, alpha: 0.95 });
    }
    if (bridges.length) lines('bridges', gr.segCoords(G, bridges), COL.water, 2.6, { z: 11, alpha: 0.9 });
  })();

  /* ---------------- markers ---------------- */
  function pinIcon(cls, text) { return L.divIcon({ className: 'pinwrap', html: '<div class="pin ' + cls + '">' + text + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] }); }
  function addPin(cls, text, lat, lon, drag, onDrop) {
    const mk = L.marker([lat, lon], { icon: pinIcon(cls, text), draggable: !!drag, zIndexOffset: 500 }).addTo(map);
    if (drag) mk.on('dragend', () => {
      const p = mk.getLatLng(), h = G.grid.nearest(p.lat, p.lng, CFG.snapM * 2);
      if (!h) { toast('No road near that spot'); mk.setLatLng([G.lat[onDrop.node()], G.lon[onDrop.node()]]); return; }
      mk.setLatLng([G.lat[h.index], G.lon[h.index]]); onDrop.set(h.index);
    });
    return mk;
  }
  function drop(mk) { if (mk) map.removeLayer(mk); }

  // Places (hospitals, schools, ...)
  groups.places = L.layerGroup();
  for (const f of FAC.all) {
    const mk = L.marker([f.lat, f.lon], { icon: L.divIcon({ className: 'pinwrap', html: '<div class="poi ' + f.type + '">' + (POI_LETTER[f.type] || '?') + '</div>', iconSize: [18, 18], iconAnchor: [9, 9] }) });
    mk.bindTooltip(esc(f.name) + ' <i>(' + f.type.replace('_', ' ') + ')</i>');
    mk.addTo(groups.places);
  }
  groups.places.addTo(map);
  groups.zones = L.layerGroup().addTo(map);
  groups.new = L.layerGroup().addTo(map);

  /* ---------------- toast, legend, hint ---------------- */
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3800);
  }
  function setLegend(key, items) {
    if (items && items.length) S.legend[key] = items; else delete S.legend[key];
    const all = [].concat(...Object.values(S.legend));
    const el = $('legend');
    el.innerHTML = all.map((i) => '<div><i class="' + (i.dot ? 'dot' : '') + '" style="background:' + i.c + '"></i>' + esc(i.t) + '</div>').join('');
    el.classList.toggle('hidden', !all.length);
  }
  const PICK_TEXT = {
    A: 'Click the map to set the origin (A)', B: 'Click the map to set the destination (B)',
    flood: 'Click a road to place the flood source', fire: 'Click roads to add ignition points. Click the button again to stop.',
    quake: 'Click anywhere to place the epicentre', stop: 'Click roads to add stops (Done when finished)'
  };
  function setPick(kind) {
    S.pick = kind;
    const h = $('pickHint');
    h.textContent = kind ? PICK_TEXT[kind] : ''; h.classList.toggle('hidden', !kind);
    map.getContainer().style.cursor = kind ? 'crosshair' : '';
    for (const [id, k] of [['pickA', 'A'], ['pickB', 'B'], ['floodPick', 'flood'], ['fireAdd', 'fire'], ['quakePick', 'quake'], ['stopAdd', 'stop']]) $(id).classList.toggle('active', kind === k);
  }
  function fitNodes(nodes) {
    if (!nodes || !nodes.length) return;
    let s = 90, w = 180, n = -90, e = -180;
    for (const v of nodes) { s = Math.min(s, G.lat[v]); n = Math.max(n, G.lat[v]); w = Math.min(w, G.lon[v]); e = Math.max(e, G.lon[v]); }
    map.fitBounds([[s, w], [n, e]], { padding: [60, 60], maxZoom: 17 });
  }

  /* ================================================================== */
  /*  Scenario → modified graph                                          */
  /* ================================================================== */
  function clearHazard() {
    overlay.removePrefix('hz');
    markers.rings.forEach(drop); markers.rings = [];
    setLegend('hazard', null);
  }

  // Scenario pins only show while their scenario is active (no stray flood pin during a fire).
  function syncPins() {
    const want = { flood: [markers.flood], fire: markers.fire, quake: [markers.quake] };
    for (const k of Object.keys(want)) for (const mk of want[k]) {
      if (!mk) continue;
      if (S.scenario === k) { if (!map.hasLayer(mk)) mk.addTo(map); } else if (map.hasLayer(mk)) map.removeLayer(mk);
    }
  }

  function computeScenario() {
    clearHazard();
    syncPins();
    const walk = S.mode === 'walk';
    const scn = { blockedSeg: null, delaySeg: null, deadline: null, t0: 0 };
    let delay = (S.rush && !walk) ? scen.rushDelay(G) : null;
    let info = '';

    if (S.scenario === 'flood' && G.hasElev) {
      const src = S.flood.src;
      const f = scen.flood(G, V.walk, { level: S.flood.level, src, connected: $('floodConn').checked && src !== null });
      let blocked = f.floodedSeg, cut = f.segs, wade = 0;
      if (walk) {
        blocked = new Uint8Array(G.m); cut = 0;
        const d = new Float32Array(G.m).fill(1);
        for (let s = 0; s < G.m; s++) if (f.floodedSeg[s]) {
          const depth = S.flood.level - (G.elev[G.segA[s]] + G.elev[G.segB[s]]) / 2;
          if (depth <= CFG.wadeDepthM) { d[s] = CFG.wadeSlow; wade++; } else { blocked[s] = 1; cut++; }
        }
        delay = scen.mulDelay(delay, d, G.m);
      }
      scn.blockedSeg = blocked;
      lines('hz-flood', gr.segCoords(G, idsWhere(f.floodedSeg)), COL.water, 3.4, { z: 20, alpha: 0.9 });
      setLegend('hazard', [{ c: COL.water, t: 'Flooded road' }]);
      info = 'Flood at ' + S.flood.level.toFixed(1) + ' m: ' + fmtN(f.nodes) + ' intersections under water, ' + fmtN(cut) + ' road segments cut' +
        (walk && wade ? ', ' + fmtN(wade) + ' wadeable (×' + CFG.wadeSlow + ' slower)' : '') +
        (src === null ? '. No source placed, so every low-lying road floods.' : '.');
    } else if (S.scenario === 'fire' && S.fire.ign.length) {
      const f = S.fire, tSec = f.t * 60;
      const arrival = scen.fireArrival(G, V.walk, { ignitions: f.ign, speedMPerMin: f.speed, windDeg: f.wind, windK: f.windK });
      f.arrival = arrival;
      const fb = scen.fireBlocked(G, arrival, tSec);
      scn.blockedSeg = fb.blockedSeg; scn.t0 = tSec;
      scn.deadline = new Float64Array(G.n);
      for (let i = 0; i < G.n; i++) scn.deadline[i] = arrival[i] - f.margin;
      const bins = [[], [], []], lim = [tSec, tSec + 300, tSec + 900];
      for (let s = 0; s < G.m; s++) {
        const a = Math.min(arrival[G.segA[s]], arrival[G.segB[s]]);
        for (let b = 0; b < 3; b++) if (a <= lim[b]) { bins[b].push(s); break; }
      }
      lines('hz-fire3', gr.segCoords(G, bins[2]), COL.pale, 3, { z: 20, alpha: 0.85 });
      lines('hz-fire2', gr.segCoords(G, bins[1]), COL.amber, 3.2, { z: 21, alpha: 0.95 });
      lines('hz-fire1', gr.segCoords(G, bins[0]), COL.red, 3.6, { z: 22 });
      setLegend('hazard', [{ c: COL.red, t: 'Burning now' }, { c: COL.amber, t: 'Fire arrives within 5 min' }, { c: COL.pale, t: 'Within 15 min' }]);
      info = 'Fire after ' + f.t + ' min: ' + fmtN(fb.segs) + ' road segments burning. Routes must pass every road node ' + f.margin + ' s before the fire arrives.';
    } else if (S.scenario === 'quake' && S.quake.epi) {
      const q = S.quake;
      q.prob = scen.quakeProb(G, { epiLat: q.epi.lat, epiLon: q.epi.lon, mag: q.mag, fragility: q.frag, bridgeMult: CFG.quakeBridgeMult });
      const r = scen.sampleFailures(q.prob, mulberry32(q.seed));
      q.failed = r.failed; scn.blockedSeg = r.failed;
      lines('hz-quake', gr.segCoords(G, idsWhere(r.failed)), COL.red, 3.4, { z: 22 });
      CFG.quakeRings.forEach((rad) => markers.rings.push(L.circle([q.epi.lat, q.epi.lon], { radius: rad, color: COL.amber, weight: 1.5, dashArray: '5 5', fill: false, interactive: false }).addTo(map)));
      setLegend('hazard', [{ c: COL.red, t: 'Collapsed / damaged road (one random outcome)' }]);
      info = 'Magnitude ' + q.mag.toFixed(1) + ': this draw damages ' + fmtN(r.count) + ' of ' + fmtN(G.m) + ' segments (' + (100 * r.count / G.m).toFixed(1) + '%).';
    } else if (S.scenario === 'flood' && !G.hasElev) {
      info = 'This dataset has no elevation data, so the flood scenario is unavailable. Re-run fetch-osm without --no-elevation.';
    } else if (S.scenario !== 'everyday') {
      info = { fire: 'Add at least one ignition point.', quake: 'Place an epicentre.', flood: '' }[S.scenario] || '';
    }
    if (S.rush && !walk) info += (info ? ' ' : '') + 'Rush hour slows main roads by up to ×' + Math.max(...gr.RUSH_MULT) + '.';
    scn.delaySeg = delay;
    S.scn = scn;
    $('scnInfo').textContent = info;
  }

  /* Cost helper: fire deadlines are time-based, so they force the time metric. */
  function setup(metricWanted) {
    const view = V[S.mode], forced = S.scn.deadline && metricWanted === 'distance';
    const metric = forced ? 'time' : metricWanted;
    const opts = S.scn.deadline ? { deadline: S.scn.deadline, t0: S.scn.t0 } : undefined;
    return { view, metric, w: gr.makeCosts(view, S.scn, metric), opts, forced };
  }

  /* ================================================================== */
  /*  Routing                                                            */
  /* ================================================================== */
  function directions(view, arcs) {
    const steps = [];
    for (const a of arcs) {
      const nm = G.wayName[G.segWay[view.seg[a]]] || 'unnamed road';
      const last = steps[steps.length - 1];
      if (last && last.name === nm) last.m += view.len[a]; else steps.push({ name: nm, m: view.len[a] });
    }
    return steps;
  }

  function setOrigin(node, fly) {
    S.origin = node; drop(markers.A);
    markers.A = addPin('A', 'A', G.lat[node], G.lon[node], true, { node: () => S.origin, set: (n) => { S.origin = n; autoRoute(); } });
    autoRoute();
  }
  function setDest(node) {
    S.dest = node; $('nearType').value = ''; drop(markers.B);
    markers.B = addPin('B', 'B', G.lat[node], G.lon[node], true, { node: () => S.dest, set: (n) => { S.dest = n; $('nearType').value = ''; autoRoute(); } });
    autoRoute();
  }
  function autoRoute() { if (S.origin !== null && (S.dest !== null || $('nearType').value)) doRoute(); }

  function doRoute() {
    overlay.removePrefix('route');
    const out = $('routeOut');
    if (S.origin === null) { out.innerHTML = '<div class="note">Set an origin (A) first.</div>'; return; }
    const near = $('nearType').value;
    if (!near && S.dest === null) { out.innerHTML = '<div class="note">Set a destination (B) or choose a nearest facility.</div>'; return; }
    const K = Math.max(1, Math.min(5, +$('kAlt').value || 1));
    const { view, metric, w, opts, forced } = setup($('metric').value);
    const algoSel = $('algo').value, algoName = $('algo').selectedOptions[0].text;
    let notes = '';
    if (forced) notes += '<div class="note">Fire deadlines are time-based, so the search optimises travel time.</div>';
    let res, paths = null, A2;

    if (near) {
      const facs = FAC[near];
      if (!facs.length) { out.innerHTML = '<div class="note bad">No ' + esc(near) + ' in this dataset.</div>'; return; }
      const t0 = now();
      const r = al.sssp(view, w, [S.origin], Object.assign({ collect: true }, opts));
      let best = null;
      for (const f of facs) if (r.dist[f.node] < Infinity && (!best || r.dist[f.node] < r.dist[best.node])) best = f;
      if (!best) { out.innerHTML = '<div class="note bad">No ' + esc(near.replace('_', ' ')) + ' can be reached under the current scenario.</div>'; return; }
      const arcs = al.pathFromPrev(view, r.prev, S.origin, best.node);
      res = { found: true, arcs, nodes: al.arcsToNodes(view, arcs, S.origin), cost: r.dist[best.node], settled: r.settled, ms: now() - t0, order: r.order };
      A2 = 'Dijkstra (multi-target)';
      S.dest = best.node; drop(markers.B);
      markers.B = addPin('B', 'B', G.lat[best.node], G.lon[best.node], false);
      notes += '<div class="note good">Nearest ' + esc(near.replace('_', ' ')) + ': <b>' + esc(best.name) + '</b></div>';
    } else if (K > 1) {
      const y = al.yen(G, view, w, S.origin, S.dest, K, metric, opts);
      paths = y.paths;
      res = paths.length ? { found: true, arcs: paths[0].arcs, nodes: paths[0].nodes, cost: paths[0].cost, settled: null, ms: y.ms } : { found: false, ms: y.ms };
      A2 = "Yen's k-shortest (A* spurs)";
    } else {
      let name = algoSel;
      if (name === 'bidir' && opts) { name = 'astar'; notes += '<div class="note">Bidirectional search cannot handle fire deadlines (they depend on arrival time), so A* was used.</div>'; }
      res = al.route(name, G, view, w, S.origin, S.dest, metric, opts);
      A2 = name === algoSel ? algoName : 'A*';
    }

    if (!res.found) {
      S.lastRoute = null;
      let why = '';
      if (S.scenario === 'fire' && opts && S.dest !== null) {
        // Diagnose: ignore the fire deadlines and see which condition actually fails.
        const free = al.sssp(view, w, [S.origin], {});
        const need = free.dist[S.dest], haveA = S.scn.deadline[S.origin] - S.scn.t0, haveB = S.scn.deadline[S.dest] - S.scn.t0;
        if (haveA <= 0) why = ' <b>A is already inside the fire zone (or inside the safety margin).</b>';
        else if (haveB <= 0) why = ' <b>B is already inside the fire zone (or inside the safety margin).</b>';
        else if (need < Infinity && need > haveB) why = ' <b>B</b> is reached by the fire in ' + fmtTime(haveB) + ' (after the safety margin) but the drive takes ' + fmtTime(need) + '.';
        else if (need < Infinity) why = ' A road on the way burns before you could pass it, even though both ends are still safe (the roads between may look empty, but they are cut off from A by burning roads).';
        else why = ' The road network itself does not connect A to B (one-way streets).';
      }
      out.innerHTML = notes + '<div class="note bad"><b>No route.</b>' + why + ' ' + (why && S.scenario === 'fire' ? 'Try a lower time since ignition, a smaller safety margin, or points further from the fire.' : { flood: 'The flood has cut A off from B. Lower the water level or move A or B out of the water.', fire: 'The fire reaches the roads around A or B before anyone could get through. Lower the time since ignition, add a bigger safety margin, or move A away from the fire.', quake: 'The damaged roads cut A off from B. Lower the magnitude or fragility, or re-roll the damage.' }[S.scenario] || 'No road connects A and B (check the one-way streets).') + '</div>';
      return;
    }
    // Draw
    if (paths && paths.length > 1) for (let i = paths.length - 1; i >= 1; i--) lines('route-alt' + i, gr.arcCoords(G, view, paths[i].arcs), COL.amber, 4, { z: 30 + i, noZoom: true, dash: [8, 6] });
    if ($('showExplored').checked && res.order && res.order.length) {
      const o = res.order, step = Math.max(1, Math.ceil(o.length / CFG.maxExplored)), pick = [];
      for (let i = 0; i < o.length; i += step) pick.push(o[i]);
      points('route-explored', nodeFlat(pick), COL.amber, 2, { z: 25, alpha: 0.5, noZoom: true });
    }
    lines('route-main', gr.arcCoords(G, view, res.arcs), COL.green, 5.5, { z: 40, noZoom: true });
    const segs = Array.from(res.arcs, (a) => view.seg[a]);
    S.lastRoute = { segs };
    fitNodes(res.nodes);

    const st = gr.arcStats(view, res.arcs, S.scn.delaySeg);
    let html = notes + '<div class="kv"><span>Distance</span><b>' + fmtDist(st.meters) + '</b><span>Travel time</span><b>' + fmtTime(st.seconds) +
      '</b><span>Algorithm</span><b>' + esc(A2) + '</b>' +
      (res.settled !== null && res.settled !== undefined ? '<span>Nodes settled</span><b>' + fmtN(res.settled) + '</b>' : '') +
      '<span>Search time</span><b>' + res.ms.toFixed(1) + ' ms</b></div>';
    if (paths && paths.length > 1) {
      html += '<table class="tbl"><tr><th>Route</th><th>Distance</th><th>Time</th></tr>' + paths.map((p, i) => {
        const s2 = gr.arcStats(view, p.arcs, S.scn.delaySeg);
        return '<tr class="' + (i === 0 ? 'best' : '') + '"><td>' + (i === 0 ? 'Best' : 'Alt ' + i) + '</td><td>' + fmtDist(s2.meters) + '</td><td>' + fmtTime(s2.seconds) + '</td></tr>';
      }).join('') + '</table>';
    }
    const steps = directions(view, res.arcs);
    html += '<details><summary>Directions (' + steps.length + ' steps)</summary><ol style="margin:6px 0 0 18px;padding:0">' +
      steps.slice(0, 40).map((s) => '<li>' + esc(s.name) + ' <span style="color:var(--dim)">' + fmtDist(s.m) + '</span></li>').join('') + '</ol></details>';
    out.innerHTML = html;
  }

  /* ---------------- compare all algorithms / benchmark ---------------- */
  function algoList() { return Array.from($('algo').options).map((o) => ({ id: o.value, name: o.text })); }

  function doCompare() {
    const out = $('cmpOut');
    if (S.origin === null || S.dest === null) { out.innerHTML = '<div class="note">Set A and B first.</div>'; return; }
    const { view, metric, w, opts } = setup($('metric').value);
    const rows = [];
    for (const a of algoList()) {
      if (a.id === 'bidir' && opts) { rows.push({ name: a.name, skip: 'n/a with deadlines' }); continue; }
      let best = null;
      for (let i = 0; i < 3; i++) { const r = al.route(a.id, G, view, w, S.origin, S.dest, metric, opts); if (!best || r.ms < best.ms) best = r; }
      rows.push({ name: a.name, r: best });
    }
    const ref = rows.find((r) => r.r && r.r.found);
    const maxSet = Math.max(1, ...rows.filter((r) => r.r && r.r.settled).map((r) => r.r.settled));
    const minMs = Math.min(...rows.filter((r) => r.r).map((r) => r.r.ms));
    out.innerHTML = '<table class="tbl"><tr><th>Algorithm</th><th>Time</th><th>Settled</th><th>Cost</th></tr>' + rows.map((r) => {
      if (r.skip) return '<tr><td>' + esc(r.name) + '</td><td colspan="3">' + r.skip + '</td></tr>';
      const x = r.r;
      if (!x.found) return '<tr><td>' + esc(r.name) + '</td><td colspan="3">no route</td></tr>';
      const same = ref && Math.abs(x.cost - ref.r.cost) <= 1e-6 * Math.max(1, ref.r.cost);
      return '<tr class="' + (x.ms === minMs ? 'best' : '') + '"><td>' + esc(r.name) + '</td><td>' + x.ms.toFixed(2) + ' ms</td><td>' + fmtN(x.settled) +
        '<span class="bar ' + (x.settled > maxSet * 0.6 ? 'amber' : '') + '" style="width:' + Math.max(3, 100 * x.settled / maxSet) + '%"></span></td><td>' +
        (metric === 'distance' ? fmtDist(x.cost) : fmtTime(x.cost)) + (same ? '' : ' !') + '</td></tr>';
    }).join('') + '</table><p class="hint">Best of 3 runs. Every algorithm must return the same cost (a “!” flags a mismatch). A* and bidirectional search settle fewer nodes than Dijkstra; Bellman-Ford relaxes every edge repeatedly.</p>';
  }

  let benchRunning = false;
  function doBench() {
    if (benchRunning) return;
    const out = $('cmpOut'), N = Math.max(5, Math.min(200, +$('benchN').value || 30));
    const { view, metric, w, opts } = setup($('metric').value);
    const rng = mulberry32(42), algos = algoList().filter((a) => !(a.id === 'bidir' && opts));
    const pairs = [], bfCap = 10;
    let guard = 0;
    while (pairs.length < N && guard++ < N * 20) {
      const s = Math.floor(rng() * G.n), t = Math.floor(rng() * G.n);
      if (s !== t && haversine(G.lat[s], G.lon[s], G.lat[t], G.lon[t]) > 800) pairs.push([s, t]);
    }
    const tot = {}; algos.forEach((a) => tot[a.id] = { ms: 0, settled: 0, n: 0 });
    benchRunning = true; $('btnBench').disabled = true;
    let i = 0;
    (function step() {
      const [s, t] = pairs[i];
      for (const a of algos) {
        if (a.id === 'bf' && i >= bfCap) continue;
        const r = al.route(a.id, G, view, w, s, t, metric, opts);
        if (r.found) { tot[a.id].ms += r.ms; tot[a.id].settled += r.settled; tot[a.id].n++; }
      }
      i++;
      if (i < pairs.length) {
        out.innerHTML = '<div class="note">Benchmarking… ' + i + ' / ' + pairs.length + '</div>';
        setTimeout(step, 0);
      } else {
        benchRunning = false; $('btnBench').disabled = false;
        const base = tot.dijkstra && tot.dijkstra.n ? tot.dijkstra.ms / tot.dijkstra.n : null;
        out.innerHTML = '<table class="tbl"><tr><th>Algorithm</th><th>Avg time</th><th>Avg settled</th><th>vs Dijkstra</th></tr>' + algos.map((a) => {
          const x = tot[a.id]; if (!x.n) return '<tr><td>' + esc(a.name) + '</td><td colspan="3">no data</td></tr>';
          const avg = x.ms / x.n;
          return '<tr><td>' + esc(a.name) + (a.id === 'bf' ? ' (' + x.n + ' pairs)' : '') + '</td><td>' + avg.toFixed(2) + ' ms</td><td>' + fmtN(x.settled / x.n) + '</td><td>' + (base ? (base / avg).toFixed(2) + '×' : '–') + '</td></tr>';
        }).join('') + '</table><p class="hint">' + pairs.length + ' random origin–destination pairs on this road network (' + fmtN(G.n) + ' nodes). Bellman-Ford is limited to ' + bfCap + ' pairs because it is O(VE).</p>';
      }
    })();
  }

  /* ================================================================== */
  /*  Population zones                                                   */
  /* ================================================================== */
  function ensureZones() {
    const per = Math.max(1, +$('evPer').value || 1), k = Math.max(5, Math.min(150, +$('evZones').value || 40));
    const key = per + '|' + k;
    if (S.zones && S.zonesKey === key) return S.zones;
    let pts, usingRoads = false;
    if (ds.buildings && ds.buildings.length) { pts = new Float64Array(ds.buildings.length * 2); ds.buildings.forEach((b, i) => { pts[2 * i] = b[0]; pts[2 * i + 1] = b[1]; }); }
    else { usingRoads = true; pts = new Float64Array(G.n * 2); for (let i = 0; i < G.n; i++) { pts[2 * i] = G.lat[i]; pts[2 * i + 1] = G.lon[i]; } }
    const zones = [];
    for (const c of al.kmeans(pts, k, CFG.seed, 25)) {
      const h = G.grid.nearest(c.lat, c.lon, CFG.zoneSnapM);
      if (h) zones.push({ lat: c.lat, lon: c.lon, pop: Math.max(1, Math.round(c.count * per)), node: h.index });
    }
    S.zones = zones; S.zonesKey = key;
    $('popNote').textContent = (usingRoads ? 'No building data: population is spread over road intersections. ' : '') + zones.length + ' zones, ' + fmtN(zones.reduce((a, z) => a + z.pop, 0)) +
      ' people in total (' + (usingRoads ? 'intersections' : 'buildings') + ' × people per building; OSM has no census data, so this is an assumption).';
    return zones;
  }
  function drawZones(colorOf, tipOf) {
    groups.zones.clearLayers();
    for (let i = 0; i < S.zones.length; i++) {
      const z = S.zones[i], col = colorOf(i);
      L.circleMarker([z.lat, z.lon], { radius: 4 + Math.sqrt(z.pop) / 5, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: 0.85 })
        .bindTooltip(tipOf(i)).addTo(groups.zones);
    }
  }
  const shelterCap = (f) => Math.max(0, +$(CAP_INPUT[f.type] || 'capOther').value || 0);

  /* ================================================================== */
  /*  Service area                                                       */
  /* ================================================================== */
  function doService() {
    const type = $('svcType').value, minutes = Math.max(1, +$('svcMax').value || 15);
    const out = $('svcOut'), facs = FAC[type];
    overlay.removePrefix('svc');
    if (!facs.length) { out.innerHTML = '<div class="note bad">No ' + esc(type) + ' in this dataset.</div>'; return; }
    const { view, w } = setup('time');
    const t0 = now();
    const r = al.sssp(view, w, facs.map((f) => f.node), { reverse: true, maxCost: minutes * 60 });
    const ms = now() - t0;
    const third = minutes * 60 / 3, bins = [[], [], []];
    for (let s = 0; s < G.m; s++) {
      const d = Math.max(r.dist[G.segA[s]], r.dist[G.segB[s]]);
      if (d <= third) bins[0].push(s); else if (d <= 2 * third) bins[1].push(s); else if (d < Infinity) bins[2].push(s);
    }
    lines('svc3', gr.segCoords(G, bins[2]), COL.red, 3, { z: 20, alpha: 0.85 });
    lines('svc2', gr.segCoords(G, bins[1]), COL.amber, 3, { z: 21, alpha: 0.9 });
    lines('svc1', gr.segCoords(G, bins[0]), COL.green, 3, { z: 22 });
    setLegend('svc', [{ c: COL.green, t: 'Within ' + Math.round(minutes / 3) + ' min' }, { c: COL.amber, t: 'Within ' + Math.round(2 * minutes / 3) + ' min' }, { c: COL.red, t: 'Within ' + minutes + ' min' }]);
    const zones = ensureZones();
    let total = 0, covered = 0, uncovered = [];
    zones.forEach((z) => { total += z.pop; if (r.dist[z.node] <= minutes * 60) covered += z.pop; else uncovered.push(z); });
    const served = new Map();
    zones.forEach((z) => { if (r.dist[z.node] <= minutes * 60) served.set(r.label[z.node], (served.get(r.label[z.node]) || 0) + z.pop); });
    const top = Array.from(served.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const pct = total ? 100 * covered / total : 0;
    out.innerHTML = '<div class="kv"><span>Facilities</span><b>' + facs.length + '</b><span>Population within ' + minutes + ' min (' + (S.mode === 'walk' ? 'walking' : 'driving') + ')</span><b>' + pct.toFixed(1) + '%</b>' +
      '<span>Zones outside the catchment</span><b>' + uncovered.length + ' / ' + zones.length + '</b><span>One reverse search</span><b>' + ms.toFixed(1) + ' ms</b></div>' +
      (top.length ? '<table class="tbl"><tr><th>Busiest ' + esc(type.replace('_', ' ')) + '</th><th>People nearest</th></tr>' + top.map(([i, p]) => '<tr><td>' + esc(facs[i].name) + '</td><td>' + fmtN(p) + '</td></tr>').join('') + '</table>' : '') +
      '<span class="bar ' + (pct < 50 ? 'red' : pct < 80 ? 'amber' : '') + '" style="width:' + pct + '%"></span>';
    drawZones((i) => r.dist[zones[i].node] <= minutes * 60 ? COL.green : COL.red, (i) => 'Zone ' + (i + 1) + ': ' + fmtN(zones[i].pop) + ' people, ' + (r.dist[zones[i].node] < Infinity ? fmtTime(r.dist[zones[i].node]) + ' from nearest' : 'unreachable'));
  }

  /* ================================================================== */
  /*  Evacuation plan (min-cost max-flow)                                */
  /* ================================================================== */
  function doPlan() {
    const out = $('evOut'), zones = ensureZones(), shel = FAC.shelter;
    overlay.removePrefix('ev'); groups.zones.clearLayers();
    if (!shel.length) { out.innerHTML = '<div class="note bad">No shelters (schools, colleges, community halls) in this dataset.</div>'; return; }
    const { view, w, opts } = setup('time');
    const Z = zones.length, Sn = shel.length, cap = shel.map(shelterCap);
    const t0 = now();
    const T = zones.map((z) => { const r = al.sssp(view, w, [z.node], opts); return shel.map((f) => r.dist[f.node]); });
    // Flow network: source -> zones -> shelters -> sink
    const src = 0, sink = Z + Sn + 1, edges = [], pairIdx = [];
    zones.forEach((z, i) => edges.push({ u: src, v: 1 + i, cap: z.pop, cost: 0 }));
    for (let i = 0; i < Z; i++) for (let j = 0; j < Sn; j++) if (T[i][j] < Infinity && cap[j] > 0) { pairIdx.push({ i, j, e: edges.length }); edges.push({ u: 1 + i, v: 1 + Z + j, cap: zones[i].pop, cost: T[i][j] }); }
    for (let j = 0; j < Sn; j++) edges.push({ u: 1 + Z + j, v: sink, cap: cap[j], cost: 0 });
    const flow = al.minCostMaxFlow(Z + Sn + 2, edges, src, sink);
    const ms = now() - t0;
    const totalPop = zones.reduce((a, z) => a + z.pop, 0), totalCap = cap.reduce((a, b) => a + b, 0);
    const assign = zones.map(() => []), load = new Float64Array(Sn);
    let maxT = 0;
    for (const p of pairIdx) { const f = flow.edgeFlow[p.e]; if (f > 0.5) { assign[p.i].push({ j: p.j, n: Math.round(f) }); load[p.j] += Math.round(f); maxT = Math.max(maxT, T[p.i][p.j]); } }
    // Baseline: everyone to the nearest shelter, ignoring capacity
    const bLoad = new Float64Array(Sn); let bCost = 0, bMax = 0, bServed = 0;
    zones.forEach((z, i) => { let bj = -1; for (let j = 0; j < Sn; j++) if (T[i][j] < (bj < 0 ? Infinity : T[i][bj])) bj = j; if (bj >= 0) { bLoad[bj] += z.pop; bCost += z.pop * T[i][bj]; bMax = Math.max(bMax, T[i][bj]); bServed += z.pop; } });
    let bOver = 0; for (let j = 0; j < Sn; j++) bOver += Math.max(0, bLoad[j] - cap[j]);
    // Road load from the optimal assignment
    const segLoad = new Float64Array(G.m);
    zones.forEach((z, i) => {
      if (!assign[i].length) return;
      const r = al.sssp(view, w, [z.node], opts);
      for (const a of assign[i]) {
        const arcs = al.pathFromPrev(view, r.prev, z.node, shel[a.j].node);
        if (arcs) for (const x of arcs) segLoad[view.seg[x]] += a.n;
      }
    });
    let maxLoad = 0; for (let s = 0; s < G.m; s++) maxLoad = Math.max(maxLoad, segLoad[s]);
    const lb = [[], [], []];
    for (let s = 0; s < G.m; s++) if (segLoad[s] > 0) { const f = segLoad[s] / maxLoad; lb[f > 0.5 ? 2 : f > 0.15 ? 1 : 0].push(s); }
    lines('ev-load1', gr.segCoords(G, lb[0]), COL.green, 3.2, { z: 20, alpha: 0.9 });
    lines('ev-load2', gr.segCoords(G, lb[1]), COL.amber, 4, { z: 21 });
    lines('ev-load3', gr.segCoords(G, lb[2]), COL.red, 5, { z: 22 });
    overlay.show('ev-load1', $('evLoad').checked); overlay.show('ev-load2', $('evLoad').checked); overlay.show('ev-load3', $('evLoad').checked);
    setLegend('ev', [{ c: COL.green, t: 'Evacuation route: light traffic' }, { c: COL.amber, t: 'Moderate' }, { c: COL.red, t: 'Heavy (people sharing the road)' }]);
    drawZones((i) => { const got = assign[i].reduce((a, x) => a + x.n, 0); return got >= zones[i].pop ? COL.green : got > 0 ? COL.amber : COL.red; },
      (i) => 'Zone ' + (i + 1) + ': ' + fmtN(zones[i].pop) + ' people<br>' + (assign[i].length ? assign[i].map((a) => fmtN(a.n) + ' → ' + esc(shel[a.j].name) + ' (' + fmtTime(T[i][a.j]) + ')').join('<br>') : 'no reachable shelter with space'));
    shel.forEach((f, j) => { if (load[j] > 0) L.circleMarker([f.lat, f.lon], { radius: 12, color: COL.green, weight: 3, fill: false }).bindTooltip(esc(f.name) + ': ' + fmtN(load[j]) + ' / ' + fmtN(cap[j])).addTo(groups.zones); });

    const avg = flow.flow ? flow.cost / flow.flow : NaN, bAvg = bServed ? bCost / bServed : NaN;
    const rank = Array.from({ length: Sn }, (_, j) => j).filter((j) => load[j] > 0 || bLoad[j] > 0).sort((a, b) => Math.max(bLoad[b], load[b]) - Math.max(bLoad[a], load[a])).slice(0, 8);
    out.innerHTML = (totalCap < totalPop ? '<div class="note bad">Total shelter capacity (' + fmtN(totalCap) + ') is below the population (' + fmtN(totalPop) + '), so some people cannot be placed.</div>' : '') +
      '<table class="tbl"><tr><th>Method</th><th>Mean trip</th><th>Longest</th><th>Over capacity</th></tr>' +
      '<tr class="best"><td>Min-cost flow</td><td>' + fmtTime(avg) + '</td><td>' + fmtTime(maxT) + '</td><td>0</td></tr>' +
      '<tr><td>Nearest shelter</td><td>' + fmtTime(bAvg) + '</td><td>' + fmtTime(bMax) + '</td><td>' + fmtN(bOver) + '</td></tr></table>' +
      '<div class="kv"><span>People placed</span><b>' + fmtN(flow.flow) + ' / ' + fmtN(totalPop) + '</b><span>Mode</span><b>' + (S.mode === 'walk' ? 'on foot' : 'by car') + '</b><span>Augmenting paths</span><b>' + flow.augmentations + '</b><span>Compute time</span><b>' + ms.toFixed(0) + ' ms</b></div>' +
      '<table class="tbl"><tr><th>Shelter</th><th>Cap.</th><th>Flow plan</th><th>Nearest-only</th></tr>' + rank.map((j) =>
        '<tr><td>' + esc(shel[j].name) + '</td><td>' + fmtN(cap[j]) + '</td><td>' + fmtN(load[j]) + '</td><td' + (bLoad[j] > cap[j] ? ' style="color:var(--red);font-weight:700"' : '') + '>' + fmtN(bLoad[j]) + '</td></tr>').join('') + '</table>' +
      '<p class="hint">The flow plan may send some people to a slightly farther shelter so that no shelter is overfull. Hover a zone to see where its people go.</p>';
  }

  /* ---------------- shelter placement ---------------- */
  function doPlace() {
    const out = $('plOut'), zones = ensureZones();
    groups.new.clearLayers();
    const k = Math.max(1, Math.min(15, +$('plK').value || 5)), minutes = Math.max(1, +$('plT').value || 10);
    const { view, w, opts } = setup('time');
    const limit = minutes * 60, pop = zones.map((z) => z.pop);
    const zoneAt = new Map(); zones.forEach((z, i) => { if (!zoneAt.has(z.node)) zoneAt.set(z.node, []); zoneAt.get(z.node).push(i); });
    // Existing shelters: which zones already reach one in time?
    const pre = new Uint8Array(zones.length);
    if (FAC.shelter.length) {
      const r0 = al.sssp(view, w, FAC.shelter.map((f) => f.node), { reverse: true, maxCost: limit });
      zones.forEach((z, i) => { if (r0.dist[z.node] <= limit) pre[i] = 1; });
    }
    // Candidate sites: every zone centre plus random intersections
    const rng = mulberry32(CFG.seed), cands = new Set(zones.map((z) => z.node));
    const extra = Math.min(G.n, 300);
    for (let i = 0; i < extra; i++) cands.add(Math.floor(rng() * G.n));
    const candList = Array.from(cands), covers = [];
    for (const c of candList) {
      const r = al.sssp(view, w, [c], { reverse: true, maxCost: limit });
      const zs = []; zones.forEach((z, i) => { if (r.dist[z.node] <= limit) zs.push(i); });
      covers.push(zs);
    }
    const res = al.greedyCoverage(pop, covers, k, pre);
    // Random baseline: mean coverage over 200 random choices of k sites
    let rndSum = 0; const trials = 200, rr = mulberry32(5);
    for (let t = 0; t < trials; t++) {
      const cov = Uint8Array.from(pre);
      for (let j = 0; j < k; j++) for (const z of covers[Math.floor(rr() * covers.length)]) cov[z] = 1;
      let c = 0; zones.forEach((z, i) => { if (cov[i]) c += z.pop; }); rndSum += c / res.total;
    }
    res.chosen.forEach((ci, n) => {
      const nd = candList[ci];
      L.marker([G.lat[nd], G.lon[nd]], { icon: pinIcon('new', n + 1), zIndexOffset: 700 })
        .bindTooltip('Suggested shelter ' + (n + 1) + ': +' + fmtN(res.gains[n].gain) + ' people covered').addTo(groups.new);
    });
    const last = res.gains.length ? res.gains[res.gains.length - 1].coverage : res.baseCoverage;
    out.innerHTML = '<div class="kv"><span>Covered by existing shelters</span><b>' + (100 * res.baseCoverage).toFixed(1) + '%</b><span>With ' + res.chosen.length + ' new (greedy)</span><b>' + (100 * last).toFixed(1) + '%</b>' +
      '<span>With ' + k + ' random sites</span><b>' + (100 * rndSum / trials).toFixed(1) + '%</b><span>Candidate sites tried</span><b>' + candList.length + '</b></div>' +
      '<table class="tbl"><tr><th>Site</th><th>New people</th><th>Total coverage</th></tr>' + res.gains.map((g, i) => '<tr><td>#' + (i + 1) + '</td><td>' + fmtN(g.gain) + '</td><td>' + (100 * g.coverage).toFixed(1) + '%</td></tr>').join('') + '</table>' +
      '<p class="hint">“Covered” = a zone can reach the shelter within ' + minutes + ' min (' + (S.mode === 'walk' ? 'on foot' : 'by car') + '). Greedy max-coverage is within a factor (1 − 1/e) ≈ 63% of the best possible choice.</p>';
  }

  /* ================================================================== */
  /*  Network analysis                                                   */
  /* ================================================================== */
  function nameOfSeg(s) { return G.wayName[G.segWay[s]] || 'unnamed road'; }
  function flyToSeg(s) { map.setView([(G.lat[G.segA[s]] + G.lat[G.segB[s]]) / 2, (G.lon[G.segA[s]] + G.lon[G.segB[s]]) / 2], Math.max(map.getZoom(), 16)); }

  function doBridges() {
    const out = $('netOut'); overlay.removePrefix('net');
    const t0 = now(), r = al.tarjan(V.walk, S.scn.blockedSeg), ms = now() - t0;
    const bridges = r.bridges.filter((b) => b.isolated >= 1);
    const big = bridges.filter((b) => b.isolated >= 10);
    lines('net-bridges', gr.segCoords(G, Int32Array.from(bridges.map((b) => b.seg))), COL.amber, 3, { z: 26, noZoom: false });
    lines('net-big', gr.segCoords(G, Int32Array.from(big.map((b) => b.seg))), COL.red, 4.5, { z: 27 });
    points('net-art', nodeFlat(r.articulation), COL.ink, 2.2, { z: 28, noZoom: true });
    setLegend('net', [{ c: COL.red, t: 'Bridge cutting off 10+ intersections' }, { c: COL.amber, t: 'Other bridge (single point of failure)' }, { c: COL.ink, t: 'Articulation point', dot: true }]);
    out.innerHTML = '<div class="kv"><span>Bridge segments</span><b>' + fmtN(bridges.length) + '</b><span>… cutting off 10+ nodes</span><b>' + fmtN(big.length) + '</b><span>Articulation points</span><b>' + fmtN(r.articulation.length) + '</b><span>Time (O(V+E))</span><b>' + ms.toFixed(1) + ' ms</b></div>' +
      '<table class="tbl"><tr><th>Most critical road</th><th>Cut off</th></tr>' + bridges.slice(0, 8).map((b) => '<tr style="cursor:pointer" data-seg="' + b.seg + '"><td>' + esc(nameOfSeg(b.seg)) + '</td><td>' + fmtN(b.isolated) + '</td></tr>').join('') + '</table>' +
      '<p class="hint">A bridge is a road whose loss disconnects part of the network. “Cut off” counts the intersections on the smaller side. Click a row to zoom to it.</p>';
  }

  function doBetweenness() {
    const out = $('netOut'); overlay.removePrefix('net');
    const k = Math.max(10, Math.min(400, +$('bcK').value || 80));
    const { view, w } = setup('time');
    const t0 = now(), bc = al.edgeBetweenness(view, w, G.m, k, 7), ms = now() - t0;
    const order = Array.from({ length: G.m }, (_, i) => i).filter((i) => bc[i] > 0).sort((a, b) => bc[b] - bc[a]);
    const nTop = Math.min(order.length, Math.max(60, Math.round(G.m * 0.01)));
    const top = order.slice(0, nTop), q = Math.ceil(nTop / 3);
    lines('net-bc3', gr.segCoords(G, Int32Array.from(top.slice(2 * q))), COL.pale, 3, { z: 26 });
    lines('net-bc2', gr.segCoords(G, Int32Array.from(top.slice(q, 2 * q))), COL.amber, 3.6, { z: 27 });
    lines('net-bc1', gr.segCoords(G, Int32Array.from(top.slice(0, q))), COL.red, 4.4, { z: 28 });
    setLegend('net', [{ c: COL.red, t: 'Carries the most shortest paths' }, { c: COL.amber, t: 'High' }, { c: COL.pale, t: 'Elevated' }]);
    const byName = new Map();
    for (const s of order.slice(0, nTop * 3)) { const nm = nameOfSeg(s); if (nm === 'unnamed road') continue; byName.set(nm, (byName.get(nm) || 0) + bc[s]); }
    const names = Array.from(byName.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8), mx = names.length ? names[0][1] : 1;
    out.innerHTML = '<div class="kv"><span>Source nodes sampled</span><b>' + k + '</b><span>Time (Brandes, ' + k + ' searches)</span><b>' + ms.toFixed(0) + ' ms</b></div>' +
      '<table class="tbl"><tr><th>Road</th><th>Importance</th></tr>' + names.map(([nm, v]) => '<tr><td>' + esc(nm) + '</td><td><span class="bar red" style="width:' + (100 * v / mx) + '%"></span></td></tr>').join('') + '</table>' +
      '<p class="hint">Edge betweenness = how many shortest paths use a road. Blocking the top roads hurts the network most. Sampled from ' + k + ' random sources (approximation).</p>';
  }

  /* ================================================================== */
  /*  Earthquake Monte Carlo                                             */
  /* ================================================================== */
  function doMonteCarlo() {
    const out = $('qOut'), q = S.quake;
    if (!q.epi || !q.prob) { out.innerHTML = '<div class="note">Place an epicentre first.</div>'; return; }
    const trials = Math.max(10, Math.min(500, +$('qTrials').value || 100));
    const zones = ensureZones(), safe = FAC.shelter.concat(FAC.hospital).map((f) => f.node);
    const t0 = now();
    const mc = scen.quakeMonteCarlo(G, q.prob, trials, 99, {
      pair: S.origin !== null && S.dest !== null ? [S.origin, S.dest] : null,
      routeSegs: S.lastRoute ? S.lastRoute.segs : null,
      zoneNodes: zones.map((z) => z.node), safeNodes: safe
    });
    const ms = now() - t0, tp = zones.reduce((a, z) => a + z.pop, 0);
    let expIso = 0; zones.forEach((z, i) => { expIso += z.pop * mc.zoneIsolated[i]; });
    const pct = (x) => (100 * x).toFixed(0) + '%';
    const ord = zones.map((z, i) => i).sort((a, b) => mc.zoneIsolated[b] - mc.zoneIsolated[a]).slice(0, 6);
    out.innerHTML = '<div class="kv"><span>Trials</span><b>' + trials + ' (' + ms.toFixed(0) + ' ms)</b><span>Avg. segments damaged</span><b>' + fmtN(mc.meanFailedSegs) + '</b>' +
      (mc.pRouteIntact !== null ? '<span>Planned route survives</span><b>' + pct(mc.pRouteIntact) + '</b>' : '') +
      (mc.pConnected !== null ? '<span>A and B still connected</span><b>' + pct(mc.pConnected) + '</b>' : '') +
      '<span>Expected people cut off from every shelter / hospital</span><b>' + fmtN(expIso) + ' (' + (tp ? (100 * expIso / tp).toFixed(1) : 0) + '%)</b></div>' +
      (mc.pRouteIntact !== null && mc.pConnected !== null ? '<p class="hint">The gap between “route survives” and “still connected” is the value of having an alternative route.</p>' : '<p class="hint">Plan a route (A and B) first to see route survival and connectivity.</p>') +
      '<table class="tbl"><tr><th>Most at-risk zone</th><th>People</th><th>P(isolated)</th></tr>' + ord.map((i) => '<tr><td>Zone ' + (i + 1) + '</td><td>' + fmtN(zones[i].pop) + '</td><td>' + pct(mc.zoneIsolated[i]) + '</td></tr>').join('') + '</table>';
    drawZones((i) => mc.zoneIsolated[i] > 0.5 ? COL.red : mc.zoneIsolated[i] > 0.15 ? COL.amber : COL.green,
      (i) => 'Zone ' + (i + 1) + ': ' + fmtN(zones[i].pop) + ' people<br>P(cut off) = ' + pct(mc.zoneIsolated[i]));
  }

  /* ================================================================== */
  /*  Multi-stop trip (TSP)                                              */
  /* ================================================================== */
  function addStop(node) {
    if (S.stops.length >= CFG.maxStops) { toast('Maximum ' + CFG.maxStops + ' stops'); return; }
    S.stops.push(node);
    markers.stops.push(addPin('stop', S.stops.length, G.lat[node], G.lon[node], false));
  }
  function clearStops() { S.stops = []; markers.stops.forEach(drop); markers.stops = []; overlay.removePrefix('trip'); $('tripOut').innerHTML = ''; }

  function doTrip() {
    const out = $('tripOut'); overlay.removePrefix('trip');
    if (S.stops.length < 3) { out.innerHTML = '<div class="note">Add at least 3 stops.</div>'; return; }
    const { view, w, opts } = setup('time'), n = S.stops.length;
    const D = S.stops.map((s) => { const r = al.sssp(view, w, [s], opts); return S.stops.map((t) => r.dist[t]); });
    if (D.some((row, i) => row.some((x, j) => i !== j && !isFinite(x)))) { out.innerHTML = '<div class="note bad">Some stops cannot reach each other under this scenario.</div>'; return; }
    const run = (f) => { const t = now(), tour = f(); return { tour, ms: now() - t, cost: al.tourCost(D, tour) }; };
    const nn = run(() => al.tspNearestNeighbour(D));
    const opt2 = run(() => al.tsp2opt(D, nn.tour));
    const hk = n <= CFG.maxStops ? run(() => al.tspHeldKarp(D)) : null;
    const best = hk || opt2, ref = best.cost;
    const rows = [['Nearest neighbour', nn], ['2-opt improvement', opt2]]; if (hk) rows.push(['Held-Karp (exact)', hk]);
    const flat = [];
    for (let i = 0; i < n; i++) {
      const a = S.stops[best.tour[i]], b = S.stops[best.tour[(i + 1) % n]];
      const r = al.dijkstra(view, w, a, b, opts);
      if (r.found) flat.push(gr.arcCoords(G, view, r.arcs));
    }
    const tot = flat.reduce((a, f) => a + f.length, 0), all = new Float64Array(tot);
    let o = 0; for (const f of flat) { all.set(f, o); o += f.length; }
    lines('trip', all, COL.ink, 5, { z: 40, noZoom: true });
    fitNodes(S.stops);
    out.innerHTML = '<table class="tbl"><tr><th>Method</th><th>Round trip</th><th>vs best</th><th>Time</th></tr>' + rows.map(([nm, r]) =>
      '<tr class="' + (r === best ? 'best' : '') + '"><td>' + nm + '</td><td>' + fmtTime(r.cost) + '</td><td>' + (r.cost <= ref + 1e-6 ? 'best' : '+' + (100 * (r.cost / ref - 1)).toFixed(1) + '%') + '</td><td>' + r.ms.toFixed(1) + ' ms</td></tr>').join('') + '</table>' +
      '<div class="kv"><span>Visiting order</span><b>' + best.tour.concat(best.tour[0]).map((i) => i + 1).join(' → ') + '</b></div>' +
      '<p class="hint">Costs are real road travel times between stops (shortest paths), not straight lines. Held-Karp is O(n²·2ⁿ), practical only for small n.</p>';
  }

  /* ================================================================== */
  /*  Wiring                                                             */
  /* ================================================================== */
  const scenarioChanged = debounce(() => { computeScenario(); invalidate(); autoRoute(); }, 40);
  function invalidate() {
    overlay.removePrefix('ev'); overlay.removePrefix('svc'); overlay.removePrefix('net');
    groups.zones.clearLayers(); groups.new.clearLayers();
    ['evOut', 'svcOut', 'netOut', 'plOut', 'qOut', 'cmpOut'].forEach((id) => { $(id).innerHTML = ''; });
    setLegend('ev', null); setLegend('svc', null); setLegend('net', null);
  }

  function sync() {
    $('floodLvlV').textContent = S.flood.level.toFixed(1) + ' m';
    $('fireTV').textContent = S.fire.t + ' min'; $('fireSV').textContent = S.fire.speed + ' m/min';
    $('fireWV').textContent = compass(S.fire.wind) + ' (' + S.fire.wind + '°)'; $('fireKV').textContent = S.fire.windK.toFixed(2);
    $('fireMV').textContent = S.fire.margin + ' s';
    $('qMagV').textContent = S.quake.mag.toFixed(1); $('qFragV').textContent = S.quake.frag.toFixed(2) + '×';
  }

  function init() {
    $('dsName').textContent = meta.name || 'Road network';
    $('dsStats').textContent = fmtN(G.n) + ' intersections · ' + fmtN(G.m) + ' segments · ' + (ds.buildings ? fmtN(ds.buildings.length) + ' buildings · ' : '') + FAC.all.length + ' places' + (G.hasElev ? ' · elevation ' + G.elevMin.toFixed(0) + '–' + G.elevMax.toFixed(0) + ' m' : '');
    if (meta.synthetic) { const b = $('banner'); b.className = 'banner bad'; b.textContent = 'SYNTHETIC TEST CITY, not a real place. Run “node tools/fetch-osm.js” to load real Tambaram data.'; }

    const f = $('floodLvl');
    if (G.hasElev) {
      const lo = Math.floor(G.elevMin * 10) / 10, range = G.elevMax - G.elevMin;
      f.min = lo; f.max = (lo + Math.max(1, range * 0.6)).toFixed(1);
      S.flood.level = Math.round((lo + range * 0.15) * 10) / 10; f.value = S.flood.level;
    } else { f.disabled = true; $('floodPick').disabled = true; S.flood.level = 0; }
    S.fire.t = +$('fireT').value; S.fire.speed = +$('fireS').value; S.fire.wind = +$('fireW').value; S.fire.windK = +$('fireK').value / 100; S.fire.margin = +$('fireM').value;
    S.quake.mag = +$('qMag').value; S.quake.frag = +$('qFrag').value;
    sync();

    // scenario / mode / rush
    $('scnBtns').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      S.scenario = b.dataset.scn; setPick(null);
      document.querySelectorAll('#scnBtns button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('#scnPanels .scn').forEach((p) => p.classList.toggle('hidden', p.dataset.scn !== S.scenario));
      scenarioChanged();
    });
    $('modeBtns').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      S.mode = b.dataset.mode;
      document.querySelectorAll('#modeBtns button').forEach((x) => x.classList.toggle('on', x === b));
      scenarioChanged();
    });
    $('rush').addEventListener('change', () => { S.rush = $('rush').checked; scenarioChanged(); });

    // flood
    $('floodLvl').addEventListener('input', () => { S.flood.level = +$('floodLvl').value; sync(); scenarioChanged(); });
    $('floodConn').addEventListener('change', scenarioChanged);
    $('floodPick').addEventListener('click', () => setPick(S.pick === 'flood' ? null : 'flood'));
    $('floodClear').addEventListener('click', () => { S.flood.src = null; drop(markers.flood); markers.flood = null; scenarioChanged(); });
    // fire
    const fireSliders = [['fireT', 't', 1], ['fireS', 'speed', 1], ['fireW', 'wind', 1], ['fireK', 'windK', 0.01], ['fireM', 'margin', 1]];
    for (const [id, key, mul] of fireSliders) $(id).addEventListener('input', () => { S.fire[key] = +$(id).value * mul; sync(); scenarioChanged(); });
    $('fireAdd').addEventListener('click', () => setPick(S.pick === 'fire' ? null : 'fire'));
    $('fireClear').addEventListener('click', () => { S.fire.ign = []; markers.fire.forEach(drop); markers.fire = []; setPick(null); scenarioChanged(); });
    // quake
    $('quakePick').addEventListener('click', () => setPick(S.pick === 'quake' ? null : 'quake'));
    $('quakeClear').addEventListener('click', () => { S.quake.epi = null; S.quake.prob = null; drop(markers.quake); markers.quake = null; scenarioChanged(); });
    $('qMag').addEventListener('input', () => { S.quake.mag = +$('qMag').value; sync(); scenarioChanged(); });
    $('qFrag').addEventListener('input', () => { S.quake.frag = +$('qFrag').value; sync(); scenarioChanged(); });
    $('qReroll').addEventListener('click', () => { S.quake.seed = Math.floor(Math.random() * 1e9); scenarioChanged(); });
    $('qMC').addEventListener('click', doMonteCarlo);

    // tabs
    $('tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
      setPick(null);
    });

    // route tab
    $('pickA').addEventListener('click', () => setPick(S.pick === 'A' ? null : 'A'));
    $('pickB').addEventListener('click', () => setPick(S.pick === 'B' ? null : 'B'));
    $('swapAB').addEventListener('click', () => {
      if (S.origin === null || S.dest === null) return;
      const a = S.origin, b = S.dest;
      S.dest = null; setOrigin(b); setDest(a);
    });
    $('clearAB').addEventListener('click', () => {
      S.origin = S.dest = null; drop(markers.A); drop(markers.B); markers.A = markers.B = null; S.lastRoute = null;
      overlay.removePrefix('route'); $('routeOut').innerHTML = ''; $('nearType').value = '';
    });
    ['algo', 'metric', 'kAlt', 'nearType'].forEach((id) => $(id).addEventListener('change', () => { if (id === 'nearType' && !$('nearType').value) return; autoRoute(); }));
    $('showExplored').addEventListener('change', autoRoute);
    $('btnCompare').addEventListener('click', doCompare);
    $('btnBench').addEventListener('click', doBench);

    // other tabs
    $('btnService').addEventListener('click', doService);
    $('btnPlan').addEventListener('click', doPlan);
    $('evLoad').addEventListener('change', () => ['ev-load1', 'ev-load2', 'ev-load3'].forEach((n) => overlay.show(n, $('evLoad').checked)));
    ['evPer', 'evZones'].forEach((id) => $(id).addEventListener('change', () => { S.zonesKey = ''; ensureZones(); }));
    $('btnPlace').addEventListener('click', doPlace);
    $('btnBridges').addEventListener('click', doBridges);
    $('btnBC').addEventListener('click', doBetweenness);
    $('btnNetClear').addEventListener('click', () => { overlay.removePrefix('net'); setLegend('net', null); $('netOut').innerHTML = ''; });
    $('netOut').addEventListener('click', (e) => { const r = e.target.closest('tr[data-seg]'); if (r) flyToSeg(+r.dataset.seg); });
    $('stopAdd').addEventListener('click', () => setPick(S.pick === 'stop' ? null : 'stop'));
    $('stopDone').addEventListener('click', () => setPick(null));
    $('stopClear').addEventListener('click', clearStops);
    $('btnTrip').addEventListener('click', doTrip);
    $('showPlaces').addEventListener('change', () => { if ($('showPlaces').checked) groups.places.addTo(map); else map.removeLayer(groups.places); });

    map.on('click', (e) => handleClick(e.latlng));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setPick(null); });
    ensureZones();
    computeScenario();
  }

  function handleClick(ll) {
    const kind = S.pick; if (!kind) return;
    if (kind === 'quake') {
      S.quake.epi = { lat: ll.lat, lon: ll.lng }; drop(markers.quake);
      markers.quake = addPin('quake', 'Q', ll.lat, ll.lng, false);
      setPick(null); scenarioChanged(); return;
    }
    const h = G.grid.nearest(ll.lat, ll.lng, CFG.snapM);
    if (!h) { toast('No road within ' + CFG.snapM + ' m of that spot'); return; }
    const node = h.index;
    if (kind === 'A') { setPick(S.dest === null ? 'B' : null); setOrigin(node); }
    else if (kind === 'B') { setPick(null); setDest(node); }
    else if (kind === 'flood') { S.flood.src = node; drop(markers.flood); markers.flood = addPin('flood', 'W', G.lat[node], G.lon[node], false); setPick(null); scenarioChanged(); }
    else if (kind === 'fire') { S.fire.ign.push(node); markers.fire.push(addPin('fire', 'F', G.lat[node], G.lon[node], false)); scenarioChanged(); }
    else if (kind === 'stop') addStop(node);
  }

  init();
  window.GeoApp = { S, G, V, FAC, overlay, map, computeScenario, doRoute, doCompare, doService, doPlan, doPlace, doBridges, doBetweenness, doMonteCarlo, doTrip, ensureZones, setOrigin, setDest, handleClick, setPick, addStop };
})();
