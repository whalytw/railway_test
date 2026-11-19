import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { planSharedShadow, SHADOW_DEPTH } from '../src/shared-shadow.js';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three') return { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  }
});
const THREE = await import('../vendor/three.module.js');
const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
const { RailWorld } = await import('../src/world.js');
const { buildGirderBridge } = await import('../src/scenery.js');
const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));
const provenance = JSON.parse(await readFile(new URL('../assets/provenance/render-meshes-v12.json', import.meta.url), 'utf8'));
const profile = { quality: 'near', mapSize: 1024, radius: 80 };

globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

async function loadModel(path) {
  const bytes = await readFile(new URL('../' + path, import.meta.url));
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const parts = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(node => {
    if (node.isMesh) parts.push({ geometry: node.geometry, material: node.material, matrix: node.matrixWorld.clone() });
  });
  const triangles = parts.reduce((sum, { geometry }) => sum + (geometry.index?.count ?? geometry.attributes.position.count) / 3, 0);
  return { root: gltf.scene, parts, triangles, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('distant rails and sleepers preserve placement dimensions, UVs and the sleeper shader', async () => {
  const models = new Map();
  for (const [id, triangles] of [['Environment_Rail_RailSection_1m_001', 60], ['Environment_Rail_Sleeper_001', 12]]) {
    const info = manifest.models[id];
    const near = await loadModel(info.url), far = await loadModel(info.lod.url);
    models.set(id, [near, far]);
    assert.equal(far.triangles, triangles);
    assert.ok(far.parts[0].geometry.attributes.uv, 'the distant mesh uses the original atlas');
    assert.ok(near.parts[0].matrix.equals(far.parts[0].matrix), 'instanced placement is identical after swapping meshes');
    const a = new THREE.Box3().setFromObject(near.root), b = new THREE.Box3().setFromObject(far.root);
    assert.ok(a.min.distanceTo(b.min) < 1e-6 && a.max.distanceTo(b.max) < 1e-6);
  }
  const store = { manifest, get: (id, level = 0) => models.get(id)[level] };
  const world = new RailWorld(new THREE.Scene(), store, { length: 5, seed: 'V12-LOD', stations: 3, biomeA: 'Rural', biomeB: 'Hills' });
  world.overviewTrack = new THREE.Group();
  world.prepareSleeperMaterial();
  for (const id of models.keys()) world.addBatches(id, [{ x: 0, z: 0 }, { x: 53, z: 0 }], { kind: id.includes('Sleeper') ? 'sleepers' : 'track', size: 56 });
  const [rail, sleeper] = world.cullGroups.map(item => item.group.children[0]);
  const initialMaterial = sleeper.material;
  const lens = { position: { x: 50, z: 0 } };
  world.setVisibility(lens, 300);
  assert.equal(rail.geometry, rail.userData.sceneryLOD.nearGeometry);
  assert.equal(sleeper.geometry, sleeper.userData.sceneryLOD.nearGeometry);
  lens.position.x = 160;
  world.setVisibility(lens, 300);
  assert.equal(rail.geometry, rail.userData.sceneryLOD.farGeometry);
  assert.equal(sleeper.geometry, sleeper.userData.sceneryLOD.farGeometry);
  assert.equal(sleeper.material, initialMaterial);
  assert.equal(sleeper.count, 2);
  lens.position.x = 50;
  world.setVisibility(lens, 300);
  assert.equal(sleeper.geometry, sleeper.userData.sceneryLOD.nearGeometry);
  world.dispose();
});

test('the simplified rock arches and walls retain the continuous envelope and provenance', async () => {
  const source = provenance.meshes.find(row => row.url.endsWith('_v12_Lining.glb'));
  const old = await loadModel(source.source), lining = await loadModel(source.url);
  assert.equal(old.sha256, source.sourceSha256);
  assert.equal(lining.sha256, source.sha256);
  assert.equal(old.triangles, 9380);
  assert.equal(lining.triangles, 3751);
  assert.equal(lining.parts.length, old.parts.length);
  const ray = new THREE.Raycaster();
  for (let z = 0.05; z < 4; z += 0.18) {
    for (const x of [-0.65, 0, 0.65]) {
      ray.set(new THREE.Vector3(x, 0.55, z), new THREE.Vector3(0, 1, 0));
      const nearRoof = ray.intersectObject(old.root, true)[0], roof = ray.intersectObject(lining.root, true)[0];
      assert.ok(nearRoof && roof, `lining gap at ${x}, ${z}`);
      assert.ok(Math.abs(roof.distance - nearRoof.distance) < 0.12, 'arched inner roof silhouette is retained');
    }
    for (const side of [-1, 1]) {
      ray.set(new THREE.Vector3(0, 1.4, z), new THREE.Vector3(side, 0, 0));
      const original = ray.intersectObject(old.root, true)[0], wall = ray.intersectObject(lining.root, true)[0];
      assert.ok(original && wall && wall.distance >= 1.50);
      assert.ok(Math.abs(wall.distance - original.distance) < 0.08, 'the inner wall and ribs retain their width');
    }
  }
});

test('a shared shadow projection covers all original maps at identical metres per texel', () => {
  const foci = [{ x: -18.2, y: 10, z: 0 }, { x: 32.2, y: 13, z: 22 }, { x: 91.5, y: 11, z: 34 }];
  const frame = planSharedShadow(profile, foci, 4096);
  assert.ok(frame);
  assert.deepEqual([frame.width, frame.height], [1792, 1280]);
  const step = profile.radius * 2 / profile.mapSize;
  assert.equal(frame.halfX * 2 / frame.width, step);
  assert.equal(frame.halfY * 2 / frame.height, step);
  assert.ok(frame.width * frame.height < 3 * 1024 ** 2);
  for (const focus of foci) {
    assert.ok(Math.abs(frame.x - Math.round(focus.x / step) * step) + profile.radius <= frame.halfX);
    assert.ok(Math.abs(frame.y - Math.round(focus.y / step) * step) + profile.radius <= frame.halfY);
    assert.ok(frame.z - focus.z + SHADOW_DEPTH <= frame.far);
  }
  assert.equal(planSharedShadow(profile, [...foci, { x: -290, y: 105, z: 0 }], 4096), null);
  assert.equal(planSharedShadow(profile, foci, 1024), null);
  assert.equal(planSharedShadow({ ...profile, quality: 'wide' }, foci, 4096), null);
});

test('shared shadow collection restores visible main groups even when the depth draw throws', () => {
  const world = new RailWorld(new THREE.Scene(), {}, {
    length: 5, stations: 3, seed: 'V12-SHADOW-RESTORE', biomeA: 'Rural', biomeB: 'Hills', viewDistance: 300
  });
  const hidden = new THREE.Mesh(), outside = new THREE.Mesh();
  for (const mesh of [hidden, outside]) { mesh.visible = false; mesh.castShadow = true; }
  world.cullGroups = [{ group: hidden, x: 340, z: 0, radius: 3 }, { group: outside, x: 1040, z: 0, radius: 3 }];
  const views = [{ position: { x: 0, z: 0 } }, { position: { x: 65, z: 0 } }];
  assert.throws(() => world.withSharedShadowCasters(views, () => {
    assert.equal(hidden.visible, true);
    assert.equal(outside.visible, false);
    throw new Error('depth draw failure');
  }), /depth draw failure/);
  assert.equal(hidden.visible, false);
  world.dispose();
});

test('an 80 m girder span uses 30 railing posts with continuous rails on both sides', () => {
  const world = new RailWorld(new THREE.Scene(), {}, {
    length: 6, turns: 3, stations: 3, elevationLimit: 100, seed: 'V11-THREE-CHASE', biomeA: 'Lakeside', biomeB: 'Volcano', features: true
  });
  const span = world.features.bridge.spans[0];
  buildGirderBridge(world, span, span.turnIndex);
  const bridge = world.group.getObjectByName('river-rail-bridge');
  const firstInstanced = bridge.children.findIndex(mesh => mesh.isInstancedMesh);
  assert.equal(firstInstanced, 7, 'deck, runs and steel girders retain full-length geometry');
  assert.equal(bridge.children[firstInstanced].count, 30);
  assert.equal(bridge.children[firstInstanced].geometry.index.count / 3, 12);
  world.dispose();
});
