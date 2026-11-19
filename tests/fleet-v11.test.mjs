import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { CART_MASS, createPhysics, FIXED_STEP, flatResistanceForce, MAX_FORWARD, MAX_REVERSE, TURBO_SPEED } from '../src/core.js';
import { initRapier, RapierRailPhysics } from '../src/rapier-rail.js';
import { partitionViewports } from '../src/presentation.js';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three') return { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  }
});
const THREE = await import('../vendor/three.module.js');
const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
const { AssetStore, RailWorld } = await import('../src/world.js');
const { buildBridgeAndRiver, buildGirderBridge, buildTunnel } = await import('../src/scenery.js');
const { TURBO_ASSET_ID } = await import('../src/turbo-visual.js');
const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));
const config = { length: 6, stations: 3, elevationLimit: 100, biomeA: 'Lakeside', biomeB: 'Volcano',
  seed: 'V11-THREE-CHASE', features: true, shadows: true };

globalThis.self = globalThis;
globalThis.ProgressEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
globalThis.createImageBitmap = async blob => {
  const png = Buffer.from(await blob.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), close() {} };
};

async function loadModels(ids) {
  const store = new AssetStore(manifest), loader = new GLTFLoader();
  for (const id of ids) {
    const bytes = await readFile(new URL('../' + manifest.models[id].url, import.meta.url));
    const { scene: root, animations } = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse(node => {
      if (node.isMesh) parts.push({ geometry: node.geometry, material: node.material, matrix: node.matrixWorld.clone() });
    });
    store.cache.set(id, { root, parts, animations, bounds: new THREE.Box3().setFromObject(root, true) });
  }
  return store;
}

test('the three framebuffer views cover every pixel once at fractional render resolutions', () => {
  for (const ratio of [0.75, 1, 1.5, 1.75]) {
    for (const width of [767, 1001, 1920]) {
      const views = partitionViewports(width, 913, ratio, 3);
      const widths = views.map(view => Math.round(view.width * ratio));
      assert.ok(Math.max(...widths) - Math.min(...widths) <= 1);
      let right = 0;
      views.forEach((view, i) => {
        assert.equal(Math.round(view.x * ratio), right);
        assert.equal(Math.round(view.height * ratio), 913);
        right += widths[i];
      });
      assert.equal(right, width);
    }
  }
  const [title] = partitionViewports(1001, 720, 0.75, 1, 408);
  assert.equal(title.x, 408);
  assert.equal(Math.round((title.x + title.width) * 0.75), 1001);
});

test('Rapier applies and removes a single 30 km/h boost through fixed-step forces', async () => {
  await initRapier();
  const route = { sample(distance, out) { return Object.assign(out, { y: 0, ty: 0 }); } };
  const state = Object.assign(createPhysics(), {
    speed: MAX_FORWARD, countdown: 0, throttle: 1, driveAcceleration: flatResistanceForce(MAX_FORWARD) / CART_MASS
  });
  const engine = new RapierRailPhysics(route, { state });
  function run(seconds, boost, throttle = 1) {
    for (let i = 0; i < Math.round(seconds / FIXED_STEP); i++) engine.step(state, FIXED_STEP, throttle, 0, boost);
  }
  try {
    for (let i = 0; i < 2; i++) {
      run(0.15, true);
      assert.ok(state.speed > MAX_FORWARD && state.speed < MAX_FORWARD + TURBO_SPEED);
      run(0.28, true);
      assert.ok(Math.abs(state.speed - (MAX_FORWARD + TURBO_SPEED)) < 0.01);
      run(0.40, false);
      assert.ok(Math.abs(state.speed - MAX_FORWARD) < 0.01);
      assert.equal(state.turboKmh, 0);
    }
    engine.reset(Object.assign(state, {
      speed: -MAX_REVERSE, throttle: -1, driveAcceleration: -flatResistanceForce(MAX_REVERSE) / CART_MASS
    }));
    run(1, true, -1);
    assert.ok(Math.abs(state.speed + MAX_REVERSE) < 0.01);
    assert.equal(state.turboKmh, 0);
  } finally { engine.dispose(); }
});

test('all three selected carts mount two copies of the original animated low-poly turbofan', async () => {
  const drivers = ['Animal_CubePet_Bunny_001', 'Animal_CubePet_Fox_001', 'Animal_CubePet_Deer_001'];
  const fleet = manifest.vehicles.map((vehicle, index) => ({ vehicle, driver: drivers[index] }));
  const store = await loadModels([...manifest.vehicles, ...drivers, TURBO_ASSET_ID]);
  const definition = manifest.models[TURBO_ASSET_ID];
  const source = store.get(TURBO_ASSET_ID);
  const bytes = await readFile(new URL('../' + definition.url, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '1c0194fd3ff83982f8b9831d011f3662b02aca4ea6659495094236b18fc64a61');
  assert.ok(source.animations.some(clip => clip.name === 'FanSpin'));
  const world = new RailWorld(new THREE.Scene(), store, { ...config, turns: 3, fleet, playable: true });
  try {
    world.buildCart();
    assert.deepEqual(world.carts.map(cart => cart.departure), [...world.route.turnStarts].reverse());
    assert.equal(world.primaryCart, world.carts[1]);
    for (const [i, cart] of world.carts.entries()) {
      assert.equal(cart.driver.userData.driver.id, drivers[i]);
      assert.equal(cart.wheels.length, 4);
      const turbo = cart.turbo;
      assert.equal(turbo.root.visible, false);
      turbo.setEnabled(true, 1);
      turbo.update(1.2, true);
      assert.equal(turbo.root.visible, true);
      assert.equal(turbo.pods.length, 2);
      for (const pod of turbo.pods) {
        assert.ok(Math.abs(pod.mount.position.x) > 1.6);
        assert.ok(pod.exhaust.visible && pod.exhaust.position.z < -0.8);
        const rotor = pod.intake.getObjectByName('FanRotor'), orientation = rotor.quaternion.clone();
        turbo.update(1.227, true);
        assert.ok(rotor.quaternion.angleTo(orientation) > 0.05);
        turbo.update(1.2, true);
      }
      turbo.setEnabled(false, 2);
      turbo.update(2.2, false);
      assert.equal(turbo.root.visible, true);
      assert.ok(turbo.pods.every(pod => !pod.exhaust.visible && pod.mount.position.y < 0.65));
      turbo.update(2.4, false);
      assert.equal(turbo.root.visible, false);
    }
  } finally { world.dispose(); store.dispose(); }
});

// Sample the swept width of the engine pods and the tallest standing rider.
function checkClearance(world, meshes, start, end) {
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3(), direction = new THREE.Vector3();
  const sections = [
    { x: 0, y: 3.69, direction: [0, 1, 0] },
    { x: -0.65, y: 3.55, direction: [0, 1, 0] },
    { x: 0.65, y: 3.55, direction: [0, 1, 0] },
    ...[0.86, 1.40, 1.92].flatMap(y => [-1, 1].map(side => ({ x: side * 2.18, y, direction: [side, 0, 0] })))
  ];
  for (const { x, y, direction: localRay } of sections) {
    let previous = null;
    for (let s = start; s <= end + 1e-6; s += 0.5) {
      const route = world.route.sample(s);
      origin.set(route.x + x * route.nx + y * route.upX, route.y + y * route.upY, route.z + x * route.nz + y * route.upZ);
      if (previous) {
        direction.subVectors(origin, previous);
        ray.far = direction.length() + 0.001;
        ray.set(previous, direction.normalize());
        assert.equal(ray.intersectObjects(meshes, true).length, 0, `obstruction at ${s.toFixed(1)} m, offset ${x}/${y}`);
      }
      // Shoot from the centre of the clearance envelope outward to also catch
      // a wall or roof that remains within the envelope along the whole span.
      const [dx, dy] = localRay;
      const clearance = dx ? Math.abs(x) : y - 0.45;
      direction.set(dx * route.nx + dy * route.upX, dy * route.upY, dx * route.nz + dy * route.upZ);
      ray.set(origin.clone().addScaledVector(direction, -clearance), direction);
      ray.far = clearance;
      assert.equal(ray.intersectObjects(meshes, true).length, 0, `cross-section obstruction at ${s.toFixed(1)} m, offset ${x}/${y}`);
      previous = origin.clone();
    }
  }
}

test('rabbit and boosted-cart clearances run through the real portal, lining and flanking earthwork', async () => {
  const store = await loadModels(['Building_Tunnel_StonePortal_001', 'Building_Tunnel_RockStraight4m_001']);
  try {
    for (const turns of [1, 3]) {
      const world = new RailWorld(new THREE.Scene(), store, { ...config, turns });
      try {
        buildTunnel(world);
        world.group.updateMatrixWorld(true);
        const { start, end } = world.features.tunnel;
        checkClearance(world, world.group.children, start - 4, end + 4);
      } finally { world.dispose(); }
    }
  } finally { store.dispose(); }
});

test('timber, steel and multi-track bridge railings leave room for the rabbit and both engines', async () => {
  const store = await loadModels(['Building_Bridge_TimberDeck4m_001', 'Building_Bridge_SteelTruss8m_001',
    'Building_Bridge_StonePier4m_001', 'Building_Bridge_Abutment_001']);
  try {
    for (const style of ['steel', 'wood', 'girder']) {
      const world = new RailWorld(new THREE.Scene(), store, { ...config, turns: style === 'girder' ? 3 : 1 });
      try {
        const { bridge, overpass } = world.features;
        if (style === 'girder') buildGirderBridge(world, overpass, 2);
        else {
          bridge.style = style;
          buildBridgeAndRiver(world);
        }
        world.group.updateMatrixWorld(true);
        const span = style === 'girder' ? overpass : bridge;
        const groups = world.group.children.filter(mesh => mesh.name.startsWith('bridge:') || mesh.name === 'grade-separated-flyover');
        assert.ok(groups.length);
        checkClearance(world, groups, span.start - 1, Math.min(span.end + 1, span.start + 96));
      } finally { world.dispose(); }
    }
  } finally { store.dispose(); }
});
