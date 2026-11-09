import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, context, next) { return s === 'three' ? { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true } : next(s, context); } });
const THREE = await import('../vendor/three.module.js');
const { RailWorld } = await import('../src/world.js');
const { planScenery, DENSITY_OPTIONS, compatibleScenery, indexGroundPads, paddedHeight } = await import('../src/scenery-plan.js');
const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));
const base = { length: 5, seed: 'V5-COMPOSITION', stations: 3, elevationLimit: 100, biomeA: 'Rural', biomeB: 'Pastoral', density: 5000, features: true };
const makeWorld = overrides => new RailWorld(new THREE.Scene(), { manifest }, { ...base, ...overrides });

test('all eleven stress densities, including 5000 and 12000, fill the selected population', async () => {
  assert.equal(DENSITY_OPTIONS.length, 11); assert.ok(DENSITY_OPTIONS.includes(5000)); assert.ok(DENSITY_OPTIONS.includes(12000));
  const world = makeWorld();
  for (const density of DENSITY_OPTIONS) {
    world.config.density = density;
    const plan = await planScenery(world);
    assert.equal(plan.placements.length, density);
    assert.equal(Object.values(plan.stats.models).reduce((a, b) => a + b, 0), density);
    assert.ok(plan.stats.uniqueModels >= 30, `variety at ${density}`);
  }
  world.dispose();
});

test('fixed seeds preserve composition and the same natural prefix as density increases', async () => {
  const a = makeWorld(), b = makeWorld({ density: 12000 });
  const low = await planScenery(a), high = await planScenery(b);
  assert.deepEqual(low.placements, high.placements.slice(0, 5000));
  assert.equal(low.stats.buildingCount, high.stats.buildingCount);
  assert.equal(low.stats.landmarkCount, high.stats.landmarkCount);
  assert.ok(low.stats.settlementCount >= 2); assert.ok(low.stats.farmCount >= 1);
  assert.ok(low.stats.buildingCount < 60, 'higher stress loads must not generate thousands of houses');
  for (const [id, count] of Object.entries(high.stats.models)) if (manifest.models[id].sceneRole === 'civic') assert.ok(count <= 1);
  assert.ok(low.placements.every(p => !['home', 'shop', 'workshop', 'civic'].includes(p.role) || p.district.startsWith('settlement-')));
  for (const village of low.districts) assert.equal(new Set(village.buildings.map(p => p.id)).size, village.buildings.length, 'no repeated house in a single hamlet');
  a.dispose(); b.dispose();
});

test('mixed nature respects biome compatibility, full rail clearance and real water levels in all eight regions', async () => {
  for (const [biomeA, biomeB] of [['Forest', 'Hills'], ['Pastoral', 'Rural'], ['Desert', 'Lakeside'], ['Snow', 'Volcano']]) {
    const world = makeWorld({ biomeA, biomeB, density: 5000, seed: `V5-${biomeA}-${biomeB}` });
    const plan = await planScenery(world);
    for (const p of plan.placements) {
      const info = manifest.models[p.id];
      assert.ok(info.compatibleBiomes.includes(p.biome), `${p.id} / ${p.biome}`);
      assert.ok(world.route.distanceTo(p.x, p.z, p.radius + 8) >= p.radius + 6.99, `${p.id}: rail footprint`);
      assert.ok(world.stations.every(s => Math.hypot(p.x - s.x, p.z - s.z) >= 23 + p.radius - 1e-7));
      assert.ok(!manifest.scenery.deferredModels[p.id]);
      if (p.role === 'aquatic') assert.ok(Math.abs(p.y + info.placement.surfaceDatumLocalY * p.scale - world.lake.level) < 1e-8);
      if (p.role === 'crop') assert.ok(p.district.startsWith('farm-'));
    }
    assert.ok(plan.placements.some(p => p.id.includes('_Common_')), 'each climate has appropriate shared rock/plant silhouettes');
    if (biomeA === 'Desert') assert.ok(plan.placements.some(p => p.role === 'aquatic'));
    assert.ok(plan.stats.landmarkCount >= 2 && plan.stats.landmarkCount <= 4);
    world.dispose();
  }
  const reed = manifest.models.Plant_Common_DryReedTuft_001;
  assert.equal(compatibleScenery(reed, 'Desert', 'wild', false), false);
  assert.equal(compatibleScenery(reed, 'Desert', 'wild', true), true);
});

test('rare landmarks remain distinct, globally limited and widely spaced on short and long routes', async () => {
  for (const length of [5, 8, 15]) {
    const world = makeWorld({ length, density: 1000, biomeA: 'Desert', biomeB: 'Hills' });
    const { landmarks } = await planScenery(world);
    assert.ok(landmarks.length >= 2 && landmarks.length <= 4);
    assert.equal(new Set(landmarks.map(p => p.id)).size, landmarks.length);
    for (let i = 0; i < landmarks.length; i++) for (let j = 0; j < i; j++) {
      assert.ok(Math.hypot(landmarks[i].x - landmarks[j].x, landmarks[i].z - landmarks[j].z) >= 350);
      const gap = Math.abs(landmarks[i].along - landmarks[j].along); assert.ok(Math.min(gap, length * 1000 - gap) >= 800);
    }
    world.dispose();
  }
});

test('all 28 biome pairings fill a 5000-object scene and the dry / cold extremes also fill 50000', async () => {
  const biomes = Object.keys(manifest.biomes);
  for (let i = 0; i < biomes.length; i++) for (let j = 0; j < i; j++) {
    const world = makeWorld({ biomeA: biomes[i], biomeB: biomes[j], seed: `PAIR-${biomes[i]}-${biomes[j]}` });
    const plan = await planScenery(world); assert.equal(plan.placements.length, 5000); world.dispose();
  }
  for (const [biomeA, biomeB] of [['Snow', 'Volcano'], ['Desert', 'Hills']]) {
    const world = makeWorld({ biomeA, biomeB, density: 50000, seed: `EXTREME-${biomeA}` });
    const plan = await planScenery(world); assert.equal(plan.placements.length, 50000); world.dispose();
  }
});

test('terrain earthwork blending remains continuous between different footing levels', () => {
  const index = indexGroundPads([{ x: 0, z: 0, y: 1, inner: 8, outer: 18 }, { x: 24, z: 0, y: 2, inner: 8, outer: 18 }]);
  let previous = paddedHeight(index, -20, 0, 0);
  for (let x = -19.999; x < 45; x += 0.001) {
    const h = paddedHeight(index, x, 0, 0); assert.ok(Math.abs(h - previous) < 0.02, 'a feathered perimeter must never create a vertical seam'); previous = h;
  }
});

test('chunk LOD swaps geometry without duplicating instance counts or disabling object shadows', () => {
  const id = 'Plant_Common_UmbrellaTree_001', near = new THREE.BoxGeometry(2, 4, 2), far = new THREE.BoxGeometry(1.8, 4, 1.8), material = new THREE.MeshStandardMaterial();
  const store = { manifest, get(key, level) { return { parts: [{ geometry: level ? far : near, material, matrix: new THREE.Matrix4() }] }; } };
  const world = new RailWorld(new THREE.Scene(), store, { ...base, sceneryShadows: true });
  world.overviewTrack = new THREE.Group();
  world.addBatches(id, [{ x: 20, z: 20 }], { size: 80 });
  const mesh = world.group.children[0].children[0];
  world.setVisibility({ position: { x: 20, z: 20 } }, 1400); assert.equal(mesh.geometry, near);
  world.setVisibility({ position: { x: 500, z: 20 } }, 1400); assert.equal(mesh.geometry, far);
  world.setVisibility({ position: { x: 20, z: 20 } }, 1400); assert.equal(mesh.geometry, near);
  assert.equal(world.instanceCount, 1); assert.equal(mesh.castShadow, true);
  world.dispose(); near.dispose(); far.dispose(); material.dispose();
});
