import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoute, stationsFor, trackSegments, createElevationProfile, createPhysics, stepPhysics, leverReference, leverForSpeed,
  MAX_GRADE, MIN_VERTICAL_RADIUS, CART_MASS, GRAVITY, ROLLING_COEFFICIENT, AIR_DRAG, RATED_POWER } from '../src/core.js';

function run(state, seconds, lever, grade = 0) {
  for (let i = 0; i < seconds * 120; i++) stepPhysics(state, 1 / 120, lever, grade);
  return state.speed * 3.6;
}
const near = (a, b, tolerance) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);

test('all 21 elevation ceilings are respected for both station counts', () => {
  for (let limit = 0; limit <= 500; limit += 25) for (const stations of [2, 3]) for (const length of [5000, 15000]) {
    const profile = createElevationProfile(length, limit, stations);
    assert.ok(profile.range <= limit + 1e-8);
    assert.ok(profile.slopes.every(g => Math.abs(g) <= MAX_GRADE));
    for (let i = 0; i <= 20; i++) near(profile.sample(i * length / stations), profile.sample(i * length / stations + 15), 1e-7);
    near(profile.sample(0), profile.sample(length), 1e-10);
  }
});

test('the elevated route retains its selected true 3D length and closes vertically', () => {
  for (const length of [5000, 8000, 15000]) for (const stations of [2, 3]) for (const elevationLimit of [0, 25, 500]) {
    const r = createRoute(length, 'vertical', 8192, { elevationLimit, stations });
    near(r.distances.at(-1), length, 1e-7); assert.ok(r.elevation.range <= elevationLimit + 1e-7);
    assert.ok(r.elevation.maxGrade <= MAX_GRADE);
    const a = r.sample(0), b = r.sample(length - 0.001);
    near(a.y, b.y, 0.00001); near(a.ty, b.ty, 0.00001);
    for (const station of stationsFor(r, stations)) {
      assert.ok(Math.abs(station.grade) < 0.00001, 'station must be level');
      near(r.sample(station.distance - 15).y, r.sample(station.distance + 15).y, 0.00001);
    }
  }
});

test('vertical transitions are smooth with at least a 5000 m vertical radius', () => {
  for (const length of [5000, 15000]) for (const stations of [2, 3]) {
    const r = createRoute(length, 'radius', 8192, { elevationLimit: 500, stations });
    for (let i = 1; i < r.samples; i++) {
      const a = r.points[i - 1], b = r.points[i], c = r.points[i + 1];
      const h1 = Math.hypot(b.x - a.x, b.z - a.z), h2 = Math.hypot(c.x - b.x, c.z - b.z);
      const curvature = Math.abs((c.y - b.y) / h2 - (b.y - a.y) / h1) / ((h1 + h2) / 2);
      assert.ok(curvature < 1 / MIN_VERTICAL_RADIUS, `vertical curve is too sharp: ${1 / curvature} m`);
    }
  }
});

test('adaptive visible rails follow all three coordinates of the driving route', () => {
  const route = createRoute(8000, 'inclined-rails', 8192, { elevationLimit: 500, stations: 3 });
  for (const s of trackSegments(route)) {
    const a = route.sample(s.start), b = route.sample(s.end), middle = route.sample((s.start + s.end) / 2);
    assert.ok(Math.hypot(middle.x - (a.x + b.x) / 2, middle.y - (a.y + b.y) / 2, middle.z - (a.z + b.z) / 2) <= 0.007);
    assert.ok(Math.abs(s.pitch) <= Math.atan(MAX_GRADE));
  }
});

test('lever calibration has 90 km/h near the old 53% position and 100% rated power at the top', () => {
  near(leverReference(0.53).kmh, 90, 0.4);
  near(leverReference(1).powerPercent, 100, 1e-12);
  assert.equal(leverReference(0).powerPercent, 0);
  for (const speed of [-30, -15, 0, 30, 60, 90, 120]) near(leverReference(leverForSpeed(speed)).kmh, speed, 1e-10);
});

test('lowering the lever from full speed settles to 90 rather than staying at 120', () => {
  const state = createPhysics(); run(state, 180, 1); assert.ok(state.speed * 3.6 > 119.9);
  const before = state.speed; stepPhysics(state, 1 / 120, leverForSpeed(90)); assert.ok(Math.abs(state.speed - before) < 0.05);
  near(run(state, 180, leverForSpeed(90)), 90, 0.01);
  near(run(state, 180, leverForSpeed(60)), 60, 0.02);
});

test('the same 90 km/h flat power setting is slower uphill and faster downhill', () => {
  const up = createPhysics(), flat = createPhysics(), down = createPhysics(), lever = leverForSpeed(90);
  const u = run(up, 240, lever, 0.025), f = run(flat, 240, lever), d = run(down, 240, lever, -0.025);
  near(f, 90, 0.01); assert.ok(u > 70 && u < 85); assert.ok(d > 95 && d < 110);
  const full = createPhysics(); const fullUp = run(full, 240, 1, 0.025); assert.ok(fullUp < 119 && fullUp > 100);
});

test('neutral acceleration obeys mg sin(theta), rolling resistance and aerodynamic drag', () => {
  for (const grade of [-0.025, 0, 0.025]) {
    const state = createPhysics(); state.countdown = 0; state.speed = 10;
    const expected = -GRAVITY * grade / Math.sqrt(1 + grade * grade)
      - ROLLING_COEFFICIENT * GRAVITY / Math.sqrt(1 + grade * grade) - AIR_DRAG / CART_MASS * 100;
    stepPhysics(state, 1 / 120, 0, grade); near(state.acceleration, expected, 1e-10);
  }
});

test('neutral can roll downhill from rest, while a level cart remains stopped', () => {
  const up = createPhysics(), down = createPhysics(), flat = createPhysics();
  up.countdown = down.countdown = flat.countdown = 0;
  assert.ok(run(up, 10, 0, 0.025) < 0); assert.ok(run(down, 10, 0, -0.025) > 0); assert.equal(run(flat, 10, 0, 0), 0);
});

test('a downhill speed governor dissipates energy and keeps both original speed limits', () => {
  const forward = createPhysics(), reverse = createPhysics();
  run(forward, 180, 1, -0.025); run(reverse, 180, -1, 0.025);
  assert.ok(forward.speed * 3.6 <= 120.000001); assert.ok(reverse.speed * 3.6 >= -30.000001);
  assert.ok(RATED_POWER > 20000 && RATED_POWER < 30000);
});
