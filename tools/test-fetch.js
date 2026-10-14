#!/usr/bin/env node
/* Offline test of the OSM parsing code using a hand-written Overpass-style response. */
const assert = require('assert');
const f = require('./fetch-osm.js');
const graph = require('../js/graph.js');

const elements = [
  { type: 'node', id: 11, lat: 12.9250, lon: 80.1000 }, { type: 'node', id: 12, lat: 12.9251, lon: 80.1010 },
  { type: 'node', id: 13, lat: 12.9252, lon: 80.1020 }, { type: 'node', id: 14, lat: 12.9260, lon: 80.1010 },
  { type: 'node', id: 15, lat: 12.9300, lon: 80.1300 },                       // isolated island
  { type: 'node', id: 16, lat: 12.9301, lon: 80.1301 },
  { type: 'way', id: 1, nodes: [11, 12, 13], tags: { highway: 'primary', name: 'GST Road', oneway: 'yes' } },
  { type: 'way', id: 2, nodes: [12, 14], tags: { highway: 'residential_link', oneway: '-1' } },
  { type: 'way', id: 3, nodes: [13, 14], tags: { highway: 'secondary', bridge: 'viaduct', ref: 'SH-1' } },
  { type: 'way', id: 4, nodes: [15, 16], tags: { highway: 'residential' } },    // disconnected component
  { type: 'way', id: 5, nodes: [11, 99], tags: { highway: 'residential' } },    // refers to a missing node
  { type: 'way', id: 6, nodes: [11, 12], tags: { building: 'yes' } }            // not a road
];
const roads = f.processRoads(elements);
assert.strictEqual(roads.ways.length, 4, 'four highway ways kept');
assert.strictEqual(roads.ways[0].o, 1); assert.strictEqual(roads.ways[1].o, -1);
assert.strictEqual(roads.ways[1].h, 'residential', '_link suffix stripped');
assert.strictEqual(roads.ways[2].b, 1, 'bridge flag'); assert.strictEqual(roads.ways[2].nm, 'SH-1', 'ref used as name');
assert.strictEqual(roads.ways[0].nm, 'GST Road');

const G = graph.buildGraph({ nodes: roads.nodes, ways: roads.ways });
assert.strictEqual(G.n, 4, 'island component dropped, 4 nodes remain');
assert.strictEqual(G.m, 4, 'segments: 2 + 1 + 1 (the dangling 11-99 way has a single known node and is dropped)');

const pois = f.processPois([
  { type: 'node', lat: 12.92, lon: 80.10, tags: { amenity: 'hospital', name: 'Test Hospital' } },
  { type: 'way', center: { lat: 12.93, lon: 80.11 }, tags: { amenity: 'university' } },
  { type: 'node', lat: 12.94, lon: 80.12, tags: { emergency: 'assembly_point' } },
  { type: 'node', lat: 12.95, lon: 80.12, tags: { amenity: 'cafe' } }
]);
assert.strictEqual(pois.length, 3); assert.strictEqual(pois[1].type, 'college');

const b = f.processBuildings([{ type: 'way', id: 1, center: { lat: 12.923456789, lon: 80.1 } }, { type: 'way', id: 2 }]);
assert.strictEqual(b.length, 1); assert.strictEqual(b[0][0], 12.92346);

const grid = f.fillGrid([10, null, 12, 13, null, 15, 16, 17, 18], 3, 3);
assert.ok(grid.every(x => typeof x === 'number'), 'null cells filled from neighbours');
assert.strictEqual(f.fillGrid([null, null, null, null], 2, 2), null, 'all-null grid -> null');

console.log('fetch-osm parsing tests: all passed');
