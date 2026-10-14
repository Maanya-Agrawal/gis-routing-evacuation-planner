/* core.js — geometry, binary heap, union-find, spatial index, seeded RNG.
   Works both in the browser (window.Geo.core) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Geo = root.Geo || {}; root.Geo.core = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const R = 6371008.8;
  const D2R = Math.PI / 180;

  /** Great-circle distance in metres. */
  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const a = s1 * s1 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Initial bearing in degrees (0 = north, clockwise). */
  function bearing(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }

  /** Deterministic PRNG so every demo run is reproducible. */
  function mulberry32(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Binary min-heap with parallel typed arrays (key, value). Lazy deletion. */
  class MinHeap {
    constructor(cap) {
      cap = cap || 1024;
      this.k = new Float64Array(cap);
      this.v = new Int32Array(cap);
      this.size = 0;
      this.topKey = 0;
    }
    _grow() {
      const cap = this.k.length * 2;
      const k = new Float64Array(cap); k.set(this.k);
      const v = new Int32Array(cap); v.set(this.v);
      this.k = k; this.v = v;
    }
    push(key, val) {
      if (this.size === this.k.length) this._grow();
      const k = this.k, v = this.v;
      let i = this.size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= key) break;
        k[i] = k[p]; v[i] = v[p];
        i = p;
      }
      k[i] = key; v[i] = val;
    }
    /** Removes and returns the value with the smallest key; its key is in this.topKey. */
    pop() {
      const k = this.k, v = this.v;
      const topV = v[0];
      this.topKey = k[0];
      const last = --this.size;
      if (last > 0) {
        const key = k[last], val = v[last];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= last) break;
          if (c + 1 < last && k[c + 1] < k[c]) c++;
          if (k[c] >= key) break;
          k[i] = k[c]; v[i] = v[c];
          i = c;
        }
        k[i] = key; v[i] = val;
      }
      return topV;
    }
  }

  class UnionFind {
    constructor(n) {
      this.p = new Int32Array(n);
      for (let i = 0; i < n; i++) this.p[i] = i;
    }
    find(x) {
      const p = this.p;
      while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
      return x;
    }
    union(a, b) {
      a = this.find(a); b = this.find(b);
      if (a !== b) this.p[a] = b;
    }
  }

  /** Uniform grid for nearest-point queries (snap a map click to the road network). */
  class SpatialGrid {
    constructor(lat, lon, cellDeg) {
      this.lat = lat; this.lon = lon;
      this.cell = cellDeg || 0.003;
      let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
      for (let i = 0; i < lat.length; i++) {
        if (lat[i] < minLat) minLat = lat[i];
        if (lat[i] > maxLat) maxLat = lat[i];
        if (lon[i] < minLon) minLon = lon[i];
        if (lon[i] > maxLon) maxLon = lon[i];
      }
      this.minLat = minLat; this.minLon = minLon;
      this.rows = Math.floor((maxLat - minLat) / this.cell) + 1;
      this.cols = Math.floor((maxLon - minLon) / this.cell) + 1;
      const cnt = new Int32Array(this.rows * this.cols + 1);
      const cellOf = new Int32Array(lat.length);
      for (let i = 0; i < lat.length; i++) {
        const c = this._cell(lat[i], lon[i]);
        cellOf[i] = c; cnt[c + 1]++;
      }
      for (let i = 0; i < this.rows * this.cols; i++) cnt[i + 1] += cnt[i];
      this.cellStart = cnt;
      this.items = new Int32Array(lat.length);
      const pos = cnt.slice(0, this.rows * this.cols);
      for (let i = 0; i < lat.length; i++) this.items[pos[cellOf[i]]++] = i;
      const mid = (minLat + maxLat) / 2;
      this.mPerLat = 111320;
      this.mPerLon = 111320 * Math.cos(mid * D2R);
    }
    _rc(lat, lon) {
      const r = Math.min(this.rows - 1, Math.max(0, Math.floor((lat - this.minLat) / this.cell)));
      const c = Math.min(this.cols - 1, Math.max(0, Math.floor((lon - this.minLon) / this.cell)));
      return [r, c];
    }
    _cell(lat, lon) { const rc = this._rc(lat, lon); return rc[0] * this.cols + rc[1]; }
    /** Returns {index, meters} of the closest point, or null if none within maxMeters. */
    nearest(lat, lon, maxMeters) {
      maxMeters = maxMeters === undefined ? Infinity : maxMeters;
      const rc = this._rc(lat, lon), r0 = rc[0], c0 = rc[1];
      const minCellM = Math.min(this.cell * this.mPerLat, this.cell * this.mPerLon);
      let best = -1, bestD = Infinity;
      const maxRing = Math.max(this.rows, this.cols);
      for (let ring = 0; ring <= maxRing; ring++) {
        for (let r = r0 - ring; r <= r0 + ring; r++) {
          if (r < 0 || r >= this.rows) continue;
          const edgeRow = (r === r0 - ring || r === r0 + ring);
          for (let c = c0 - ring; c <= c0 + ring; c++) {
            if (c < 0 || c >= this.cols) continue;
            if (!edgeRow && c !== c0 - ring && c !== c0 + ring) continue;
            const ci = r * this.cols + c;
            for (let q = this.cellStart[ci]; q < this.cellStart[ci + 1]; q++) {
              const i = this.items[q];
              const dy = (lat - this.lat[i]) * this.mPerLat;
              const dx = (lon - this.lon[i]) * this.mPerLon;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d < bestD) { bestD = d; best = i; }
            }
          }
        }
        if (best >= 0 && bestD <= ring * minCellM) break;
        if (ring * minCellM > maxMeters && best < 0) break;
      }
      if (best < 0 || bestD > maxMeters) return null;
      return { index: best, meters: bestD };
    }
  }

  return { R, D2R, haversine, bearing, mulberry32, MinHeap, UnionFind, SpatialGrid };
});
