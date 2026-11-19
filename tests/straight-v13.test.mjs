import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { createPhysics, FIXED_STEP, MAX_GRADE, MIN_VERTICAL_RADIUS, MAX_FORWARD } from '../src/core.js';
import { createStraightRoute, straightStations, STRAIGHT_LENGTHS } from '../src/straight-route.js';
import { checkRaceBoundary, raceStandings } from '../src/straight-race.js';
import { planRouteFeatures } from '../src/route-features.js';
import { initRapier, RapierRailPhysics } from '../src/rapier-rail.js';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'three') return { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const THREE = await import('../vendor/three.module.js');
const { RailWorld } = await import('../src/world.js');
const { renderedGroundHeight } = await import('../src/grounding.js');
const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));

test('each whole-kilometre choice builds three bounded tracks of the selected physical length', () => {
  assert.deepEqual(STRAIGHT_LENGTHS, [3, 4, 5, 6, 7, 8, 9, 10]);
  for (const invalid of [2000, 3500, 10500, 11000]) assert.throws(() => createStraightRoute(invalid, 'BAD'));
  for (const km of STRAIGHT_LENGTHS) for (const elevationLimit of [0, 500]) {
    const length = km * 1000;
    const route = createStraightRoute(length, 'STRAIGHT-THREE-V13', { elevationLimit });
    assert.deepEqual(route.crossings, []);
    assert.equal(route.overpass, null);
    assert.equal(route.lanes.length, 3);
    const elevations = [];
    for (const [i, lane] of route.lanes.entries()) {
      assert.equal(lane.length, length);
      assert.deepEqual(lane.sample(-500), lane.sample(0));
      assert.deepEqual(lane.sample(length + 500), lane.sample(length));
      assert.equal(lane.sample(0).x, route.sample(0).x);
      assert.equal(lane.sample(length).x, route.sample(length).x);
      assert.equal(lane.sample(length).z, (1 - i) * 24);
      let physical = 0, previousGrade = 0;
      for (let n = 1; n < lane.points.length; n++) {
        const a = lane.points[n - 1], b = lane.points[n];
        const dx = b.x - a.x, dy = b.y - a.y, grade = dy / dx;
        assert.equal(a.z, b.z);
        assert.ok(dx > 0 && Math.abs(grade) <= MAX_GRADE);
        assert.ok(Math.abs(grade - previousGrade) / dx <= 1 / MIN_VERTICAL_RADIUS + 1e-8);
        physical += Math.hypot(dx, dy);
        previousGrade = grade;
        elevations.push(a.y);
      }
      assert.ok(Math.abs(physical - length) < 1e-6);
    }
    assert.ok(Math.max(...elevations) - Math.min(...elevations) <= elevationLimit + 1e-8);
  }
});

test('stations and bridges are aligned across the lanes, and nearby track queries respect the endpoints', () => {
  const route = createStraightRoute(3000, 'V13-CLEARANCE', { elevationLimit: 100 });
  for (const count of [2, 3]) {
    const stations = straightStations(route, count);
    assert.deepEqual(stations.map(station => station.distance), count === 2 ? [0, 3000] : [0, 1500, 3000]);
    assert.deepEqual([stations[0].name, stations.at(-1).name], ['起點站', '終點站']);
    assert.ok(stations.every(station => station.passes.length === 3 && station.passes.every(pass => Math.abs(pass.grade) < 1e-10)));
    const features = planRouteFeatures(route, stations, 'V13-CLEARANCE');
    assert.equal(features.bridge.spans.length, 3);
    for (const span of features.bridge.spans) {
      const point = route.lanes[span.turnIndex].sample(span.centre);
      assert.ok(Math.abs(point.x - features.bridge.x) < 0.001);
      assert.equal(point.z, span.z);
    }
    assert.ok(features.tunnel.halfWidth + 5 < 24);
  }
  const end = route.lanes[0].sample(3000);
  const proximity = route.nearestTo(end.x + 12, end.z);
  assert.equal(proximity.distanceAlong, 3000);
  assert.equal(proximity.distance, 12);
});

test('straight terrain fits all three separate tracks and the course remains inside a corridor', async () => {
  const world = new RailWorld(new THREE.Scene(), { manifest }, {
    routeMode: 'straight', length: 3, stations: 3, elevationLimit: 100, seed: 'V13-TERRAIN',
    biomeA: 'Forest', biomeB: 'Lakeside', biomeMix: [{ biome: 'Forest', percent: 60 }, { biome: 'Lakeside', percent: 40 }],
    density: 1000, features: false,
  });
  try {
    await world.buildTerrain();
    assert.equal(world.sceneryStats.placed, 1000);
    assert.ok(world.biomeReport.regions.every(row => Math.abs(row.requestedPercent - row.actualPercent) < 0.03));
    assert.equal(world.terrainGrid.halfDepth, world.route.halfDepth);
    for (const lane of world.route.lanes) for (let distance = 0; distance <= lane.length; distance += 7) {
      const rail = lane.sample(distance), ground = renderedGroundHeight(world.terrainGrid, rail.x, rail.z);
      assert.ok(ground <= rail.y + 0.04 && ground >= rail.y - 0.21, `invalid track bed at ${distance} m`);
    }
  } finally { world.dispose(); }
});

test('Rapier stops at both open ends and records the fractional finish tick once', async () => {
  await initRapier();
  const route = createStraightRoute(3000, 'V13-FINISH');
  const views = route.lanes.map(track => {
    const state = Object.assign(createPhysics(), { countdown: 0, distance: 2999.6, speed: MAX_FORWARD, elapsed: 103 });
    return { state, engine: new RapierRailPhysics(track, { state }), previous: {}, rig: { track }, finishTime: null };
  });
  try {
    for (const view of views) {
      const { state, engine } = view;
      for (let i = 0; i < 30 && view.finishTime === null; i++) {
        view.previous.distance = state.distance;
        const before = state.elapsed;
        engine.step(state, FIXED_STEP, 1);
        checkRaceBoundary(view, before);
      }
      assert.equal(state.distance, 3000);
      assert.equal(state.speed, 0);
      assert.ok(view.finishTime > 100 && view.finishTime < 100.02);
      assert.ok(Math.abs(state.odometer - 0.4) < 1e-9);
      assert.equal(engine.diagnostics().speed, 0);
    }
    const first = views[0], state = first.state;
    state.distance = 0; state.speed = -4;
    first.engine.reset(state); first.finishTime = null; first.previous.distance = 0;
    const before = state.elapsed;
    first.engine.step(state, FIXED_STEP, -1);
    checkRaceBoundary(first, before);
    assert.equal(state.distance, 0);
    assert.equal(state.speed, 0);
    assert.equal(first.finishTime, null);
  } finally { views.forEach(view => view.engine.dispose()); }
});

test('the standings are ordered by crossing time and allow equal displayed times', () => {
  assert.deepEqual(raceStandings([92.711, 91.4392, 91.4394]).map(row => [row.lane, row.rank]), [[1, 1], [2, 1], [0, 3]]);
});
