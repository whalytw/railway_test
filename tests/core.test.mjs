import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoute, stationsFor, biomeMix, resolveBiomes, randomGenerator, createPhysics, stepPhysics, FIXED_STEP, MAX_FORWARD, MAX_REVERSE, wrap, trackSegments } from '../src/core.js';

function simulate(state, seconds, throttle) { for (let i = 0; i < Math.round(seconds / FIXED_STEP); i++) stepPhysics(state, FIXED_STEP, throttle); return state; }
const almost = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test('each of the eleven selectable lengths is a closed physical 5–15 km route', () => {
  for (let km = 5; km <= 15; km++) {
    const route = createRoute(km * 1000, 'route-test');
    almost(route.distances.at(-1), km * 1000);
    const start = route.sample(0), end = route.sample(route.length), backwards = route.sample(-0.001);
    almost(start.x, end.x); almost(start.z, end.z);
    assert.ok(Math.hypot(start.x - backwards.x, start.z - backwards.z) < 0.002);
    assert.ok(start.tx * backwards.tx + start.tz * backwards.tz > 0.999);
    assert.ok(start.x < 0, 'departure station must be in biome A');
    const d = route.squareSize;
    assert.ok(route.points.every(p => Math.abs(p.x) < d && Math.abs(p.z) < d / 2));
    assert.equal(d * d, (2 * d * d) / 2, 'both biome regions have the same square area');
  }
});

test('a seed reproduces the exact path while new seeds change the bends', () => {
  const a = createRoute(8000, 'HELLO'), b = createRoute(8000, 'HELLO'), c = createRoute(8000, 'WORLD');
  assert.deepEqual(a.sample(1234), b.sample(1234));
  assert.notDeepEqual(a.sample(1234), c.sample(1234));
});

test('adaptive original GLB rail segments stay within 7 mm of the cart path', () => {
  for (const length of [5000, 15000]) for (const seed of ['a', 'b', 'c', 'd', 'LOOP-PREVIEW']) {
    const route = createRoute(length, seed), segments = trackSegments(route);
    almost(segments[0].start, 0); almost(segments.at(-1).end, length);
    for (const segment of segments) {
      const a = route.sample(segment.start), b = route.sample(segment.end), mid = route.sample((segment.start + segment.end) / 2);
      assert.ok(Math.hypot(mid.x - (a.x + b.x) / 2, mid.z - (a.z + b.z) / 2) <= 0.007);
    }
  }
});

test('two or three stations are equally spaced and the start is in A', () => {
  const route = createRoute(9000, 'stations');
  for (const count of [2, 3]) {
    const stations = stationsFor(route, count);
    assert.equal(stations.length, count); assert.ok(stations[0].x < 0);
    for (let i = 0; i < count; i++) almost(wrap(stations[(i + 1) % count].distance - stations[i].distance, route.length), route.length / count);
  }
});

test('the seam blends continuously and mixed biome choices are always different', () => {
  const choices = ['Forest', 'Hills', 'Pastoral', 'Desert', 'Rural', 'Lakeside', 'Snow', 'Volcano'];
  const random = randomGenerator('pair');
  for (let i = 0; i < 100; i++) {
    const pair = resolveBiomes('random', 'random', choices, random); assert.notEqual(pair[0], pair[1]);
    const fixed = resolveBiomes('Snow', 'random', choices, random); assert.equal(fixed[0], 'Snow'); assert.notEqual(fixed[1], 'Snow');
  }
  assert.throws(() => resolveBiomes('Forest', 'Forest', choices));
  for (let z = -500; z <= 500; z += 10) for (let x = -120; x < 120; x += 1) {
    assert.ok(Math.abs(biomeMix(x + 1, z, 1000) - biomeMix(x, z, 1000)) < 0.009);
  }
});

test('three-second departure countdown counts seconds without moving the cart', () => {
  const state = createPhysics(); simulate(state, 2.99, 1);
  assert.equal(state.speed, 0); assert.equal(state.distance, 0); almost(state.elapsed, 2.9916666667, 1e-6);
  simulate(state, 1, 1); assert.equal(state.countdown, 0); assert.ok(state.speed > 0 && state.speed < 3);
});

test('full power approaches 120 km/h without exceeding the speed limit', () => {
  const state = createPhysics(); simulate(state, 180, 1); almost(state.speed, MAX_FORWARD, 0.01 / 3.6);
  const before = state.distance; simulate(state, 30, 1); assert.ok(state.speed <= MAX_FORWARD); almost(state.distance - before, 1000, 0.01);
});

test('neutral coasts with gradual friction and eventually rests without jitter', () => {
  const state = createPhysics(); simulate(state, 50, 1); const before = state.speed;
  stepPhysics(state, FIXED_STEP, 0); assert.ok(state.speed > before - 0.05);
  simulate(state, 300, 0); assert.equal(state.speed, 0);
  const distance = state.distance; simulate(state, 10, 0); assert.equal(state.distance, distance);
});

test('pulling down brakes continuously, then reverses to at most 30 km/h', () => {
  const state = createPhysics(); simulate(state, 24, 1); const before = state.speed;
  stepPhysics(state, FIXED_STEP, -1); assert.ok(state.speed > 0); assert.ok(Math.abs(state.speed - before) < 0.05);
  let min = 0, maxJump = 0;
  for (let i = 0; i < 12000; i++) { const v = state.speed; stepPhysics(state, FIXED_STEP, -1); min = Math.min(min, state.speed); maxJump = Math.max(maxJump, Math.abs(state.speed - v)); }
  assert.ok(state.speed < -28 / 3.6); assert.ok(min >= -MAX_REVERSE); assert.ok(maxJump < 0.05);
  simulate(state, 240, -1); almost(state.speed, -MAX_REVERSE, 0.01 / 3.6);
  simulate(state, 180, 1); almost(state.speed, MAX_FORWARD, 0.01 / 3.6);
});

test('distance wraps for arbitrary forward and reverse laps without an endpoint', () => {
  const route = createRoute(5000, 'infinite');
  for (const distance of [-10000001, -10001, -1, 0, 4999, 5000, 5001, 10000001]) {
    const a = route.sample(distance), b = route.sample(wrap(distance, route.length));
    almost(a.x, b.x); almost(a.z, b.z);
  }
  const state = createPhysics(); simulate(state, 600, 1);
  assert.ok(state.distance > route.length * 3, 'three complete laps must not end the simulation');
});
