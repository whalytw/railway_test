import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoute, stationsFor } from '../src/core.js';
import { sleeperLayout, sleeperFilter, exposureCoverage, planRouteFeatures, featureAt, bridgeGroundHeight } from '../src/route-features.js';

test('each route gets a bridge and tunnel clear of all stations with sufficiently gentle module bends', () => {
  for (const length of [5000, 8000, 15000]) for (const count of [2, 3]) for (const seed of ['A', 'B', 'V3-BRIDGE-TUNNEL']) {
    const route = createRoute(length, seed, 8192, { elevationLimit: 100, stations: count }), stations = stationsFor(route, count), features = planRouteFeatures(route, stations, seed);
    for (const f of [features.bridge, features.tunnel]) {
      assert.ok(f.start > 100 && f.end < length - 100);
      assert.ok(stations.every(s => s.distance < f.start - 90 || s.distance > f.end + 90));
      assert.ok(f.moduleDeviation < 0.12, `${f.kind} modules bend too sharply: ${f.moduleDeviation}`);
      assert.equal(featureAt(features, f.centre, length), f); assert.equal(featureAt(features, f.centre + length, length), f);
    }
    assert.ok(features.bridge.end + 100 < features.tunnel.start);
  }
});

test('bridge terrain is dug below the river bed and blends to natural bank height', () => {
  const route = createRoute(5000, 'water'), bridge = planRouteFeatures(route, stationsFor(route, 3), 'water').bridge;
  const ground = bridge.y - 0.09;
  assert.ok(bridgeGroundHeight(bridge, bridge.x, bridge.z, ground) < bridge.y - 8);
  const at = a => ({ x: bridge.x + bridge.tx * a, z: bridge.z + bridge.tz * a });
  const edge = at(12), distant = at(50);
  assert.ok(Math.abs(bridgeGroundHeight(bridge, edge.x, edge.z, ground) - (bridge.y - 6.08)) < 0.01);
  assert.equal(bridgeGroundHeight(bridge, distant.x, distant.z, ground), ground);
});

test('sleeper spacings have bounded deterministic variation and a continuous seam', () => {
  for (const pitch of [0.6, 0.75, 0.9]) {
    const a = sleeperLayout(5000, pitch, 'ties'), b = sleeperLayout(5000, pitch, 'ties');
    assert.deepEqual(a, b); assert.ok(Math.abs(a.pitch - pitch) < 0.0001);
    const gaps = a.placements.map((p, i) => (i ? p.distance - a.placements[i - 1].distance : p.distance + 5000 - a.placements.at(-1).distance));
    assert.ok(gaps.every(g => g > pitch * 0.85 && g < pitch * 1.15));
    assert.ok(new Set(gaps.map(g => g.toFixed(3))).size > 20, 'spacing must not remain perfectly periodic');
  }
});

test('the exposure filter tracks actual speed / frame interval and can be fully disabled', () => {
  const a = sleeperFilter(100 / 3.6, 1 / 60, 0.75), b = sleeperFilter(100 / 3.6, 1 / 30, 0.75);
  assert.ok(a.exposure > 0.4 && a.exposure < 0.5); assert.ok(b.exposure > a.exposure);
  assert.deepEqual(sleeperFilter(0, 1 / 60, 0.75), { exposure: 0, contrastReduction: 0, enabled: 1 });
  assert.deepEqual(sleeperFilter(120, 1 / 30, 0.75, false), { exposure: 0, contrastReduction: 0, enabled: 0 });
});

test('sleeper exposure conserves the original 0.30 m coverage and has no negative opacity', () => {
  for (const exposure of [0.01, 0.25, 0.5, 1.0, 1.5]) {
    let area = 0, step = 0.0005;
    for (let z = -1; z <= 1; z += step) { const a = exposureCoverage(z, exposure); assert.ok(a >= 0 && a <= 1); area += a * step; }
    assert.ok(Math.abs(area - 0.3) < 0.001);
    assert.equal(exposureCoverage(2, exposure), 0);
  }
});
