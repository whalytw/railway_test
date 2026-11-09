import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
registerHooks({ resolve(specifier, context, next) { return specifier === 'three' ? { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
const THREE = await import('../vendor/three.module.js');
const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
const { chooseDriver, createStandingDriver, DRIVER_SEATS } = await import('../src/drivers.js');
const { RailWorld } = await import('../src/world.js');
const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));
globalThis.self = globalThis;
globalThis.ProgressEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
let decodedPNGs = 0;
globalThis.createImageBitmap = async blob => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  const chunks = [];
  for (let p = 8; p < bytes.length;) {
    const n = bytes.readUInt32BE(p);
    if (bytes.subarray(p + 4, p + 8).toString() === 'IDAT') chunks.push(bytes.subarray(p + 8, p + 8 + n));
    p += n + 12;
  }
  assert.ok(inflateSync(Buffer.concat(chunks)).length > 0);
  ++decodedPNGs;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), close() {} };
};
let fixture;
async function models() {
  if (!fixture) fixture = (async () => {
    const loader = new GLTFLoader(), assets = new Map();
    for (const id of [...manifest.drivers, ...manifest.vehicles]) {
      const bytes = await readFile(new URL('../' + manifest.models[id].url, import.meta.url));
      const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
      assets.set(id, { root: gltf.scene, animations: gltf.animations });
    }
    return assets;
  })();
  return fixture;
}
function transformSnapshot(root) {
  const nodes = [];
  root.traverse(node => nodes.push([node.uuid, node.position.toArray(), node.quaternion.toArray(), node.scale.toArray()]));
  return nodes;
}

test('specified and random driver choices are valid; reroll can avoid the previous animal', () => {
  for (const id of manifest.drivers) assert.equal(chooseDriver(id, manifest.drivers), id);
  assert.equal(chooseDriver('random', manifest.drivers, () => 0), manifest.drivers[0]);
  assert.equal(chooseDriver('random', manifest.drivers, () => 1), manifest.drivers.at(-1));
  for (let i = 0; i < 100; i++) assert.notEqual(chooseDriver('random', manifest.drivers, () => i / 100, manifest.drivers[0]), manifest.drivers[0]);
  assert.throws(() => chooseDriver('missing', manifest.drivers));
  assert.throws(() => chooseDriver('random', []));
});

test('all 24 original GLBs load with eight clips, CC0 records and embedded PNGs', async () => {
  const assets = await models();
  assert.equal(new Set(manifest.drivers).size, 24);
  for (const id of manifest.drivers) {
    assert.equal(manifest.models[id].license, 'CC0-1.0');
    assert.equal(assets.get(id).animations.length, 8);
    assert.ok(assets.get(id).animations.some(c => c.name === 'static'));
    assert.ok(!assets.get(id).root.getObjectByProperty('isSkinnedMesh', true));
    assets.get(id).root.traverse(node => {
      if (!node.isMesh) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        assert.ok(material.map?.image?.width > 0, id + ': palette texture must load');
      }
    });
  }
  assert.ok(decodedPNGs >= 24);
  const proof = await readFile(new URL('../assets/licenses/Kenney_CubePets/License.txt', import.meta.url), 'utf8');
  assert.match(proof, /CC0/); assert.match(proof, /Kenney/); assert.match(proof, /2\.0/);
});

test('all 72 animal/cart pairs use a standing pose with uniform scale, exact seat height and interior clearance', async () => {
  const assets = await models(), results = [];
  for (const cart of manifest.vehicles) for (const id of manifest.drivers) {
    const source = assets.get(id), original = transformSnapshot(source.root);
    const driver = createStandingDriver(source.root, cart, { id, staticClip: source.animations.find(c => c.name === 'static') });
    const box = new THREE.Box3().setFromObject(driver, true), size = box.getSize(new THREE.Vector3());
    const seat = DRIVER_SEATS[cart], scaled = driver.children[0].scale;
    assert.ok(Math.abs(box.min.y - seat.top) < 1e-6, id);
    assert.ok(Math.abs(box.min.x + box.max.x) < 1e-6, id);
    assert.ok(size.x <= seat.targetWidth + 1e-6, id);
    assert.ok(box.min.z >= seat.rear - 1e-6 && box.max.z <= seat.front + 1e-6, id);
    assert.ok(Math.abs(size.x - seat.targetWidth) < 1e-5 || Math.abs(size.z - (seat.front - seat.rear)) < 1e-5, id);
    assert.ok(Math.abs(scaled.x - scaled.y) < 1e-6 && Math.abs(scaled.y - scaled.z) < 1e-6, id);
    assert.equal(driver.userData.driver.posture, 'standing'); assert.equal(driver.userData.driver.poseClip, 'static');
    assert.deepEqual(transformSnapshot(source.root), original, 'the cached source model must be unchanged');
    results.push({ animal: id, cart, ...driver.userData.driver });
  }
  await writeFile(new URL('../validation/drivers-v6.json', import.meta.url), JSON.stringify({ passed: true, combinations: results.length, cases: results }, null, 2));
});

test('replacing a driver leaves exactly one passenger and all cars carry it through forward/reverse slopes', async () => {
  const assets = await models();
  const store = { manifest, get: id => assets.get(id) };
  for (const vehicle of manifest.vehicles) {
    const world = new RailWorld(new THREE.Scene(), store, {
      length: 5, stations: 3, elevationLimit: 75, seed: 'ANIMAL-FOLLOW', biomeA: 'Forest', biomeB: 'Hills',
      vehicle, driver: manifest.drivers[0], features: false, shadows: false
    });
    world.buildCart();
    for (const id of manifest.drivers) {
      world.attachDriver(id);
      assert.equal(world.cart.getObjectsByProperty('name', 'AnimalDriver').length, 1);
      for (const distance of [-52, 0, 1350, 4980]) {
        world.updateCart(distance, Math.abs(distance), .3); world.cart.updateMatrixWorld(true);
        assert.deepEqual(world.driver.matrixWorld.elements, world.cart.matrixWorld.elements);
      }
    }
    world.dispose();
  }
});

test('late animal loads cannot replace a more recent selection or resurrect a disposed scene', async () => {
  const pending = new Map(), calls = [];
  const world = { driverRequest: 0, disposed: false, store: { load: ([id]) => new Promise(resolve => pending.set(id, resolve)) }, attachDriver: id => calls.push(id) };
  const a = RailWorld.prototype.setDriver.call(world, 'a'), b = RailWorld.prototype.setDriver.call(world, 'b');
  pending.get('b')(); assert.equal(await b, true); pending.get('a')(); assert.equal(await a, false); assert.deepEqual(calls, ['b']);
  const c = RailWorld.prototype.setDriver.call(world, 'c'); world.disposed = true; pending.get('c')();
  assert.equal(await c, false); assert.deepEqual(calls, ['b']);
});
