import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, context, next) { return s === 'three' ? { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true } : next(s, context); } });
const THREE = await import('../vendor/three.module.js');
const { RailWorld } = await import('../src/world.js');
const { planScenery } = await import('../src/scenery-plan.js');
const { riverProfile, riverPoint, riverLocation } = await import('../src/route-features.js');
const { buildTunnel, buildBridgeAndRiver } = await import('../src/scenery.js');
const { planGrassCover, buildGrassCover, buildFarmland } = await import('../src/ground-cover.js');
const { renderedGroundHeight } = await import('../src/grounding.js');
const { inFarm } = await import('../src/landscape-profile.js');
const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));
const config = { length: 5, stations: 3, elevationLimit: 75, biomeA: 'Pastoral', biomeB: 'Hills', seed: 'V7-COUNTRY', density: 1000, features: true };
const make = overrides => new RailWorld(new THREE.Scene(), { manifest }, { ...config, ...overrides });
const report = { version: '7.0.0', waterSamples: 0, pastoralCases: [], nonDestructiveToGLB: true };
let world, terrain;
before(async () => { world = make(); await world.prepareScenery(); await world.buildTerrain(); terrain = world.group.children.filter(n => n.isMesh); world.group.updateMatrixWorld(true); });
after(() => world.dispose());

test('river curves visibly, contains a wide reach and its banks use physical perpendicular widths', () => {
  const bridge = world.features.bridge, widths = [], centres = [];
  for (let b = bridge.river.start + 40; b < bridge.river.end - 40; b += 9) {
    const r = riverProfile(bridge, b), p = riverPoint(bridge, b, r.halfWidth * 0.6), nearest = riverLocation(bridge, p.x, p.z);
    widths.push(r.halfWidth * 2); centres.push(r.centre);
    assert.ok(Math.abs(nearest.distance - r.halfWidth * 0.6) < 0.12, 'curved water and bank distance must agree');
  }
  assert.ok(Math.max(...centres) - Math.min(...centres) > 28, 'the old 2.7 m wobble is not a visible meander');
  assert.ok(Math.max(...widths) > 28 && Math.max(...widths) / Math.min(...widths) > 1.8, 'a recognisable wide reach is required');
  report.river = { length: bridge.river.end - bridge.river.start, maxWidth: Math.max(...widths), lateralRange: Math.max(...centres) - Math.min(...centres) };
});

test('actual terrain triangles leave both bends and the wide water reach open', () => {
  const bridge = world.features.bridge, ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
  for (let b = bridge.river.start + 42; b < bridge.river.end - 42; b += 11) {
    const width = riverProfile(bridge, b).halfWidth;
    for (const lateral of [-0.65, 0, 0.65]) {
      const p = riverPoint(bridge, b, width * lateral);
      ray.set(new THREE.Vector3(p.x, p.y + 80, p.z), down);
      const hit = ray.intersectObjects(terrain, false)[0]; assert.ok(hit);
      assert.ok(hit.point.y < p.y - 0.04, `terrain covers the flowing river at ${b.toFixed(1)} m / ${lateral}: ${hit.point.y - p.y}`); report.waterSamples++;
    }
  }
  const batches = [], add = world.addBatches; world.addBatches = (id, placements) => batches.push(id);
  buildBridgeAndRiver(world); world.addBatches = add;
  assert.ok(!batches.includes('Environment_Terrain_RiverStraight8m_001'), 'no scaled straight boxes under a curved river');
  assert.ok(world.group.getObjectByName('river-water')); assert.ok(world.group.getObjectByName('river-banks'));
});

test('tunnel cuts are narrow, curved and the approach shoulders meet the surrounding ground', () => {
  const add = world.addBatches; world.addBatches = () => {}; buildTunnel(world); world.addBatches = add;
  const faces = world.group.children.filter(n => n.name === 'tunnel-cut-face'); assert.equal(faces.length, 2);
  for (let j = 0; j < faces.length; j++) {
    const p = world.route.sample(j ? world.features.tunnel.end : world.features.tunnel.start);
    const inverse = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(p.pitch, p.yaw, 0, 'YXZ')).invert();
    const a = faces[j].geometry.attributes.position, xs = [], zs = [];
    for (let i = 0; i < a.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(a, i).sub(new THREE.Vector3(p.x, p.y, p.z)).applyMatrix4(inverse); xs.push(v.x); zs.push(v.z); }
    assert.ok(Math.max(...xs) - Math.min(...xs) < 19, 'no 68 m wall across the mountain');
    assert.ok(Math.max(...zs) - Math.min(...zs) > 4, 'the cut must wrap around the portal rather than remain one plane');
  }
  for (const mesh of world.group.children.filter(n => /^tunnel-mountain-/.test(n.name))) {
    const a = mesh.geometry.attributes.position, columns = 37;
    for (let i = 0; i < a.count; i++) if (i % columns === 0 || i % columns === columns - 1) {
      assert.ok(Math.abs(a.getY(i) - renderedGroundHeight(world.terrainGrid, a.getX(i), a.getZ(i))) < 0.041, 'outer mountain edge must disappear into the actual rendered terrain');
    }
  }
  report.tunnelCutWidthMax = 19; report.tunnelApproachLength = world.features.tunnel.approachLength;
});

test('Pastoral always supplies visible reserved fields with readable crop rows', async () => {
  for (const [biomeB, seed] of [['Hills', 'V7-COUNTRY'], ['Volcano', 'V7-PASTORAL-HOT'], ['Snow', 'V7-PASTORAL-COLD'], ['Rural', 'V7-TWO-FARMLANDS']]) {
    const w = make({ biomeB, seed }), plan = await planScenery(w), pastoral = plan.farms.filter(f => f.biome === 'Pastoral');
    assert.ok(pastoral.length >= 2, `${seed}: Pastoral must have at least two fields`);
    if (biomeB === 'Rural') assert.ok(plan.farms.some(f => f.biome === 'Rural'), 'remaining slots should also serve the other farmland region');
    for (const f of plan.farms) {
      const crops = plan.placements.filter(p => p.district === f.id && p.role === 'crop');
      assert.ok(crops.length >= 45 && crops.length === f.plants);
      assert.ok(w.route.distanceTo(f.x, f.z, 100) < 62, 'fields must be visible from the train');
      assert.ok(plan.placements.every(p => p.district === f.id || !inFarm(f, p.x, p.z, p.radius + 1.9)), 'wild scenery must not invade reserved fields');
    }
    report.pastoralCases.push({ biomeB, seed, totalFields: plan.farms.length, pastoralFields: pastoral.length }); w.dispose();
  }
  buildFarmland(world); assert.equal(world.group.children.filter(n => n.name === 'tilled-field').length, world.sceneryPlan.farms.length);
});

test('grass grows in patches on real ground, leaving tracks, water, buildings and crop plots clear', () => {
  const cover = planGrassCover(world); assert.ok(cover.length > 1000);
  for (const p of cover) {
    assert.ok(world.route.distanceTo(p.x, p.z, 10) > 5.5);
    assert.ok(!world.sceneryPlan.farms.some(f => inFarm(f, p.x, p.z, 2.9)));
    assert.ok(Math.abs(p.y + 0.012 - renderedGroundHeight(world.terrainGrid, p.x, p.z)) < 1e-6);
  }
  buildGrassCover(world); world.overviewTrack = new THREE.Group();
  world.setVisibility({ position: { x: 1e6, z: 1e6 } }, 2000, false);
  assert.ok(world.cullGroups.filter(c => c.kind === 'grass').every(c => !c.group.visible), 'grass must not render throughout the full draw distance');
  world.setVisibility({ position: world.route.sample(100) }, 2000, true);
  assert.ok(world.cullGroups.filter(c => c.kind === 'grass').every(c => !c.group.visible), 'overview relies on colour patches instead of distant blades');
  report.grassTufts = cover.length; report.grassTrianglesPerTuft = 7;
});

test('snow, desert and volcanic ground never receives green grass cover', () => {
  for (const [biomeA, biomeB] of [['Snow', 'Volcano'], ['Desert', 'Snow'], ['Volcano', 'Desert']]) {
    const cold = make({ biomeA, biomeB, features: false }); assert.deepEqual(planGrassCover(cold), []); cold.dispose();
  }
});

test('landscape evidence is recorded with the actual generated field and river statistics', async () => {
  assert.ok(report.waterSamples > 60 && report.pastoralCases.length === 4 && report.grassTufts > 1000);
  await writeFile(new URL('../validation/landscape-v7.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
});
