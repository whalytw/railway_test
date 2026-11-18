import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';

registerHooks({ resolve(specifier, context, next) {
  return specifier === 'three' ? { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const THREE = await import('../vendor/three.module.js');
const { FIXED_STEP, MAX_FORWARD, MAX_GRADE, MIN_VERTICAL_RADIUS, createPhysics, createRoute, stationsFor } = await import('../src/core.js');
const { FLYOVER_RAIL_SEPARATION, createCircuitRoute, turnIndexAt } = await import('../src/circuit-route.js');
const { planRouteFeatures } = await import('../src/route-features.js');
const { RailWorld } = await import('../src/world.js');
const { buildGirderBridge } = await import('../src/scenery.js');
const { initRapier, RapierRailPhysics } = await import('../src/rapier-rail.js');

const separation = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const config = { length: 5, turns: 3, stations: 3, elevationLimit: 0, biomeA: 'Rural', biomeB: 'Hills', seed: 'V6-SHORT' };

test('each station pass follows the right-to-left order around one continuous route', () => {
  for (const turns of [2, 3]) for (const length of [5000, 8000, 15000]) {
    const route = createCircuitRoute(length, 'CIRCUIT-PASSES', { turns, stations: 3 });
    assert.ok(Math.abs(route.distances.at(-1) - length) < 1e-7);
    const passes = stationsFor(route, 3)[0].passes;
    const right = passes[0];
    assert.ok(right.x < 0, 'the initial platform belongs to A');
    for (const [turn, pass] of passes.entries()) {
      const previousTurn = (turn + turns - 1) % turns;
      assert.equal(pass.distance, route.turnStarts[turn]);
      assert.equal(turnIndexAt(route, pass.distance - 0.01), previousTurn);
      assert.equal(turnIndexAt(route, pass.distance + 0.01), turn);
      assert.equal(turnIndexAt(route, pass.distance + 0.01 - 2 * length), turn);
      const leftNeighbour = passes[turn + 1];
      if (leftNeighbour) assert.ok((pass.x - leftNeighbour.x) * right.nx + (pass.z - leftNeighbour.z) * right.nz > 26);
      const before = route.sample(pass.distance - 0.1), after = route.sample(pass.distance + 0.1);
      assert.ok(Math.abs(separation(before, after) - 0.2) < 0.001);
      assert.ok(before.tx3 * after.tx3 + before.ty * after.ty + before.tz3 * after.tz3 > 0.9999);
    }
    assert.equal(turnIndexAt(route, length), 0);
  }
  const original = createRoute(8000, 'CIRCUIT-PASSES', 8192, { stations: 2, elevationLimit: 250 });
  const single = createCircuitRoute(8000, 'CIRCUIT-PASSES', { turns: 1, stations: 2, elevationLimit: 250 });
  assert.deepEqual(single.points, original.points);
  assert.equal(turnIndexAt(single, -150), 0);
});

test('grade-separated crossovers keep the exact clearance, vertical limits and level stations', () => {
  for (const turns of [2, 3]) for (const length of [5000, 15000]) for (const stations of [2, 3]) {
    for (const [seed, elevationLimit] of [['SHORT-CURVE', 0], ['WIDE-CURVE', 500]]) {
      const route = createCircuitRoute(length, seed, { turns, stations, elevationLimit });
      assert.ok(route.elevation.range <= Math.max(FLYOVER_RAIL_SEPARATION, elevationLimit) + 1e-6);
      let lastGrade, lastRun;
      for (let i = 1; i < route.points.length; i++) {
        const [a, b] = [route.points[i - 1], route.points[i]];
        const run = Math.hypot(a.x - b.x, a.z - b.z), grade = (b.y - a.y) / run;
        assert.ok(Math.abs(grade) <= MAX_GRADE);
        if (i > 1) assert.ok(Math.abs(grade - lastGrade) / ((run + lastRun) * 0.5) <= 1 / MIN_VERTICAL_RADIUS);
        lastGrade = grade; lastRun = run;
      }
      for (const station of stationsFor(route, stations)) for (const pass of station.passes) {
        assert.ok(Math.abs(route.sample(pass.distance - 18).y - pass.y) < 0.001);
        assert.ok(Math.abs(route.sample(pass.distance + 18).y - pass.y) < 0.001);
      }
      assert.equal(route.crossings.length, turns - 1);
      for (const crossing of route.crossings) {
        const upper = route.sample(crossing.upperDistance), lower = route.sample(crossing.lowerDistance);
        assert.ok(Math.hypot(upper.x - lower.x, upper.z - lower.z) < 0.005);
        assert.ok(Math.abs(upper.y - lower.y - FLYOVER_RAIL_SEPARATION) < 1e-6);
        assert.ok(crossing.upperDistance > route.overpass.start && crossing.upperDistance < route.overpass.end);
      }
      const near = route.sample(route.distanceAtPhase(0, 0.015)), near2 = route.sample(route.distanceAtPhase(1, 0.015));
      const hill = route.tracksideHill;
      assert.ok(Math.hypot(near.x - near2.x, near.z - near2.z) < 43);
      assert.ok(hill.halfWidth * 2 / 0.82 > 46);
    }
  }
});

test('a shared river has a separate bridge for each turn and the tunnel leaves neighbouring rails clear', () => {
  const route = createCircuitRoute(5000, config.seed, config);
  const { bridge, tunnel } = planRouteFeatures(route, stationsFor(route, config.stations), config.seed);
  assert.deepEqual(bridge.spans.map(span => span.turnIndex).sort(), [0, 1, 2]);
  for (const span of bridge.spans) {
    assert.ok(span.length >= 40);
    assert.equal(turnIndexAt(route, span.centre), span.turnIndex);
    for (const pass of stationsFor(route, config.stations).flatMap(station => station.passes)) {
      assert.ok(pass.distance < span.start - 30 || pass.distance > span.end + 30);
    }
  }
  for (let s = tunnel.start; s <= tunnel.end; s += 4) {
    const p = route.sample(s);
    for (const turn of [0, 1, 2]) if (turn !== tunnel.turnIndex) {
      assert.ok(route.nearestOnTurn(turn, p.x, p.z, tunnel.halfWidth + 30).distance > tunnel.halfWidth + 2);
    }
  }
});

test('rendered flyover clears both lower railways with scenery features switched off', async () => {
  const world = new RailWorld(new THREE.Scene(), {}, { ...config, features: false });
  assert.deepEqual(world.structures.map(feature => feature.kind).sort(), ['overpass', 'underpass', 'underpass']);
  await world.buildTerrain();
  buildGirderBridge(world, world.route.overpass, 2);
  world.group.updateMatrixWorld(true);
  const bridge = world.group.getObjectByName('grade-separated-flyover');
  const ray = new THREE.Raycaster(), up = new THREE.Vector3(0, 1, 0);
  for (const crossing of world.route.crossings) {
    for (let offset = -22; offset <= 22; offset += 2) for (const side of [-1.2, 0, 1.2]) {
      const p = world.route.sample(crossing.lowerDistance + offset), x = p.x + p.nx * side, z = p.z + p.nz * side;
      assert.ok(world.groundHeight(x, z) < p.y + 0.17);
      ray.set(new THREE.Vector3(x, p.y + 0.405, z), up);
      const hit = ray.intersectObjects(bridge.children, false)[0];
      if (offset === 0) assert.ok(hit && hit.distance < 6.2, 'bridge deck must pass over the lower rail');
      if (hit) assert.ok(hit.distance > 4.4, 'deck or pier must stay above the lower passage');
    }
  }
  world.dispose();
});

test('stations share a visible village on each climate with a path clear of every track', async () => {
  const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));
  for (const options of [
    { turns: 1, seed: 'V6-HAMLETS', biomeB: 'Hills' },
    { turns: 1, seed: 'V6-HAMLETS', biomeB: 'Volcano' },
    { turns: 2, seed: 'V6-RIVER', biomeA: 'Snow', biomeB: 'Volcano' },
    { turns: 3, seed: 'V6-LAKE', biomeA: 'Desert', biomeB: 'Lakeside' }
  ]) {
    const world = new RailWorld(new THREE.Scene(), { manifest }, { ...config, ...options, density: 1000, elevationLimit: 250, features: true });
    await world.prepareScenery();
    assert.equal(world.stationPasses.length, config.stations * options.turns);
    const villages = world.sceneryPlan.districts.filter(district => district.station);
    assert.equal(villages.length, config.stations);
    for (const village of villages) {
      assert.ok(village.buildings.length >= 3);
      assert.ok(village.buildings.some(p => p.role === 'home'));
      assert.equal(new Set(village.buildings.map(p => p.id)).size, village.buildings.length);
      const [a, b] = village.accessPath;
      for (let i = 0; i <= 10; i++) {
        assert.ok(world.route.distanceTo(a.x + (b.x - a.x) * i / 10, a.z + (b.z - a.z) * i / 10, 70) > 10);
      }
    }
    world.dispose();
  }
});

test('four-biome percentages still cover the full route, with gradual land colour between turns', async () => {
  const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));
  const biomeMix = [{ biome: 'Forest', percent: 27 }, { biome: 'Hills', percent: 23 }, { biome: 'Pastoral', percent: 25 }, { biome: 'Lakeside', percent: 25 }];
  const world = new RailWorld(new THREE.Scene(), { manifest }, { ...config, biomeA: undefined, biomeB: undefined, biomeMix, density: 5000, features: true });
  const { route, biomeLayout } = world;
  for (const region of world.biomeReport.regions) {
    assert.ok(Math.abs(region.actualPercent - region.requestedPercent) < 0.002);
  }
  const aDistance = route.distanceAtPhase(0, 0.32), bDistance = route.distanceAtPhase(1, 0.32);
  const a = route.sample(aDistance), b = route.sample(bDistance);
  const expectedA = biomeLayout.dominant(biomeLayout.weightsAtDistance(aDistance));
  const expectedB = biomeLayout.dominant(biomeLayout.weightsAtDistance(bDistance));
  assert.notEqual(expectedA, expectedB);
  assert.equal(world.dominantBiomeAt(a.x, a.z), expectedA);
  assert.equal(world.dominantBiomeAt(b.x, b.z), expectedB);
  let previous = world.weightsAt(a.x, a.z);
  for (let i = 1; i <= 100; i++) {
    const t = i / 100, w = world.weightsAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    assert.ok(Math.abs(Object.values(w).reduce((sum, v) => sum + v, 0) - 1) < 1e-9);
    assert.ok(Math.abs(w[expectedA] - previous[expectedA]) < 0.08);
    previous = w;
  }
  await world.prepareScenery();
  assert.equal(world.sceneryStats.placed, 5000);
  assert.ok(Object.keys(world.sceneryStats.naturePack.modelCounts).length >= 20);
  assert.equal(world.sceneryPlan.districts.filter(d => d.station && d.buildings.length >= 3).length, 3);
  world.dispose();
});

test('Rapier runs through all three turns and the bumper remains on its intended pass', async () => {
  await initRapier();
  const route = createCircuitRoute(5000, config.seed, config);
  const engine = new RapierRailPhysics(route);
  const state = { ...createPhysics(), countdown: 0, throttle: 1 };
  const slope = {};
  function tick() {
    route.sample(state.distance + state.speed * FIXED_STEP * 0.5, slope);
    engine.step(state, FIXED_STEP, state.throttle, slope.grade);
  }
  try {
    engine.reset(state);
    const seen = [0];
    for (let i = 0; i < 400 / FIXED_STEP && state.distance < route.length + 5; i++) {
      tick();
      const turn = turnIndexAt(route, state.distance);
      if (turn !== seen.at(-1)) seen.push(turn);
    }
    assert.deepEqual(seen, [0, 1, 2, 0]);
    assert.ok(state.distance > route.length && state.speed <= MAX_FORWARD + 1e-6);

    Object.assign(state, createPhysics(), { countdown: 0, speed: MAX_FORWARD, distance: route.turnStarts[1] - 40, throttle: 1 });
    engine.reset(state);
    const bumper = state.distance + 80;
    engine.placeBumper(bumper);
    for (let i = 0; i < 8 / FIXED_STEP && !state.collisionCount; i++) tick();
    assert.ok(state.collisionCount >= 1 && Math.abs(state.distance - bumper) < 6);
    assert.equal(turnIndexAt(route, state.distance), 1);
  } finally { engine.dispose(); }
});
