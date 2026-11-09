import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
registerHooks({ resolve(s, context, next) { return s === 'three' ? { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true } : next(s, context); } });
const THREE = await import('../vendor/three.module.js');
const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
const { RailWorld } = await import('../src/world.js');
const { groundContactWeight, renderedGroundHeight, footprintMaximum, fitGroundContact, prepareGroundedParts, groundBatchGeometry, sampleGroundPatch } = await import('../src/grounding.js');
const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));

function testGrid(height) {
  const geometry = new THREE.PlaneGeometry(200, 200, 2, 2); geometry.rotateX(-Math.PI / 2);
  const a = geometry.attributes.position;
  // Match the terrain's row order and triangle diagonal.
  const points = [], indices = [];
  for (let z = 0; z <= 2; z++) for (let x = 0; x <= 2; x++) points.push(-100 + x * 100, height(-100 + x * 100, -100 + z * 100), -100 + z * 100);
  for (let z = 0; z < 2; z++) for (let x = 0; x < 2; x++) { const k = z * 3 + x; indices.push(k, k + 3, k + 1, k + 1, k + 3, k + 4); }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3)); geometry.setIndex(indices);
  return { d: 100, nx: 1, nz: 1, width: 200, depth: 200, tiles: [{ x0: -100, z0: -100, segments: 2, geometry }] };
}

test('lava root clearance uses the maximum of actual terrain triangles, including peaks between sample points', () => {
  const grid = testGrid((x, z) => !x && !z ? 6 : 0), placement = manifest.models.Environment_Volcano_LavaPool8m_001.placement;
  const p = { x: 2, z: 1, yaw: 0.4, scale: 1.2, y: 0 };
  assert.equal(renderedGroundHeight(grid, 0, 0), 6);
  assert.ok(Math.abs(footprintMaximum(grid, p, placement.footBounds) - 6) < 1e-10);
  fitGroundContact({ terrainGrid: grid }, p, placement);
  assert.ok(p.y + placement.rootPlacement.lavaLocalY * p.scale > 6);
  grid.tiles[0].geometry.dispose();
});

test('grounded volcano feet fit sloping rendered ground while upper cones and molten surfaces stay level', async () => {
  const grid = testGrid((x, z) => x * 0.14 - z * 0.08), loader = new GLTFLoader();
  for (const id of ['Environment_Volcano_Cone16m_001', 'Environment_Volcano_LavaPool8m_001', 'Environment_Volcano_LavaChannel8m_001', 'Environment_Volcano_BasaltCliff8m_001']) {
    const info = manifest.models[id], bytes = await readFile(new URL('../' + info.url, import.meta.url));
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ''); gltf.scene.updateMatrixWorld(true);
    const source = { parts: [] }; gltf.scene.traverse(n => { if (n.isMesh) source.parts.push({ geometry: n.geometry, matrix: n.matrixWorld.clone(), material: n.material }); });
    const owned = [], parts = prepareGroundedParts(source, info.placement, owned), p = fitGroundContact({ terrainGrid: grid }, { x: 15, z: 10, yaw: 0.48, scale: 1.3 }, info.placement);
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw); let feet = 0, protectedVertices = 0;
    for (const part of parts) {
      const geometry = groundBatchGeometry(part, [p]), a = geometry.attributes.position;
      assert.equal(geometry.attributes.iGround0.count, 1); assert.ok(part.depth, 'shadow caster must use the same foot deformation');
      for (let i = 0; i < a.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(part.matrix), weight = part.groundWeights.getX(i);
        const offset = weight * sampleGroundPatch(p.groundPatch, part.groundUV.getX(i), part.groundUV.getY(i));
        if (Math.abs(v.y) < 1e-6 && weight > 0.99999) {
          const wx = p.x + p.scale * (c * v.x + s * v.z), wz = p.z + p.scale * (-s * v.x + c * v.z);
          assert.ok(Math.abs(p.y + (v.y + offset) * p.scale - renderedGroundHeight(grid, wx, wz) + info.placement.embedMeters) < 2e-5, `${id}: contact edge floats above slope`); feet++;
        }
        if (id.includes('Cone') && v.y >= 1.65 || id.includes('LavaPool') && Math.abs(v.y + 0.12) < 1e-6 || id.includes('LavaChannel') && Math.abs(v.x) <= 1.4) {
          assert.equal(weight, 0, `${id}: protected upper surface deformed`); protectedVertices++;
        }
      }
      geometry.dispose();
    }
    assert.ok(feet > 8, `${id}: real ground contacts must be present`); assert.ok(protectedVertices > 8 || id.includes('Basalt'));
    owned.forEach(m => m.dispose()); source.parts.forEach(p => { p.geometry.dispose(); p.material.dispose(); });
  }
  grid.tiles[0].geometry.dispose();
});

test('map-object and vehicle shadows can be enabled independently for stress comparisons', () => {
  for (const shadows of [false, true]) for (const sceneryShadows of [false, true]) {
    const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial(), root = new THREE.Group(); root.add(new THREE.Mesh(geometry, material));
    const store = { get: () => ({ root, parts: [{ geometry, material, matrix: new THREE.Matrix4() }] }) };
    const world = new RailWorld(new THREE.Scene(), store, { length: 5, stations: 2, seed: 'SHADOWS', biomeA: 'Forest', biomeB: 'Hills', shadows, sceneryShadows, vehicle: 'Vehicle_GoldenOak' });
    for (const kind of ['scenery', 'landmark']) world.addBatches(kind, [{ x: 10, z: 10 }], { kind });
    for (const group of world.group.children) group.traverse(n => { if (n.isMesh) { assert.equal(n.castShadow, sceneryShadows); assert.equal(n.receiveShadow, true); } });
    world.buildCart(); world.cart.traverse(n => { if (n.isMesh) assert.equal(n.castShadow, shadows); });
    world.dispose(); geometry.dispose(); material.dispose();
  }
});

test('scenery generation fills the requested population while rejecting pedestal-like volcanic footprints', async () => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  const store = { manifest, get(id) { const b = manifest.models[id].bounds; return { bounds: new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)), parts: [{ geometry, material, matrix: new THREE.Matrix4() }] }; } };
  const world = new RailWorld(new THREE.Scene(), store, { length: 5, stations: 3, elevationLimit: 500, seed: 'V4-VOLCANO-SHADOWS', biomeA: 'Volcano', biomeB: 'Forest', density: 2000 });
  await world.buildTerrain(); await world.buildScenery(); assert.equal(world.sceneryCount, 2000);
  let cones = 0;
  for (const group of world.group.children) {
    const limit = group.name.includes('Cone16m') ? 1.2 : /LavaPool|LavaChannel/.test(group.name) ? 0.6 : null;
    if (limit === null) continue;
    const mesh = group.children[0]; if (group.name.includes('Cone16m')) cones += mesh.count;
    for (let i = 0; i < mesh.count; i++) {
      const offsets = [0, 1, 2, 3].flatMap(r => Array.from(mesh.geometry.attributes[`iGround${r}`].array.subarray(i * 4, i * 4 + 4)));
      assert.ok(Math.max(...offsets) - Math.min(...offsets) <= limit + 0.00001, 'steep ground must not create a tall artificial skirt');
    }
  }
  assert.ok(cones > 0, 'the volcano biome must still include real cones'); world.dispose(); geometry.dispose(); material.dispose();
});
