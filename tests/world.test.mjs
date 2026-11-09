import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
registerHooks({ resolve(specifier, context, next) { return specifier === 'three' ? { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
const THREE = await import('../vendor/three.module.js');
const { RailWorld } = await import('../src/world.js');
const { trackSegments } = await import('../src/core.js');
const config = { length: 8, seed: 'V2-HILLS-RELIEF', stations: 3, elevationLimit: 500, biomeA: 'Rural', biomeB: 'Hills' };

test('both generated tunnel faces have a real open mouth on sloping track', async () => {
  const { buildTunnel } = await import('../src/scenery.js');
  const world = new RailWorld(new THREE.Scene(), {}, { ...config, features: true });
  for (const lap of [-3, -1, 0, 1, 4]) {
    assert.equal(world.tunnelFactor(world.features.tunnel.centre + lap * world.route.length), 1, 'tunnel lighting must repeat on forward and reverse laps');
    assert.equal(world.tunnelFactor(world.features.tunnel.end + 20 + lap * world.route.length), 0);
  }
  const placements = [];
  world.addBatches = (id, items) => placements.push({ id, count: items.length });
  buildTunnel(world); world.group.updateMatrixWorld(true);
  assert.equal(placements.find(p => p.id.includes('RockStraight')).count, 20);
  assert.equal(placements.find(p => p.id.includes('StonePortal')).count, 2);
  const meshes = world.group.children.filter(n => n.isMesh), ray = new THREE.Raycaster();
  for (const [s, sign] of [[world.features.tunnel.start, 1], [world.features.tunnel.end, -1]]) {
    const p = world.route.sample(s), euler = new THREE.Euler(p.pitch, p.yaw, 0, 'YXZ');
    const direction = new THREE.Vector3(0, 0, sign).applyEuler(euler);
    for (const height of [0.5, 1.6, 2.8]) {
      const origin = new THREE.Vector3(0, height, -0.5 * sign).applyEuler(euler).add(new THREE.Vector3(p.x, p.y, p.z));
      ray.set(origin, direction); ray.far = 0.9;
      assert.equal(ray.intersectObjects(meshes, false).length, 0, 'hill face must not close the tunnel mouth');
    }
    const rockOrigin = new THREE.Vector3(3, 1.6, -0.5 * sign).applyEuler(euler).add(new THREE.Vector3(p.x, p.y, p.z));
    ray.set(rockOrigin, direction);
    assert.ok(ray.intersectObjects(meshes, false).length > 0, 'the opening must remain surrounded by a solid mountain face');
  }
  world.dispose();
});

test('rendered river terrain leaves the water channel and bridge deck exposed', async () => {
  const { riverPoint } = await import('../src/route-features.js');
  const world = new RailWorld(new THREE.Scene(), {}, { ...config, length: 5, features: true, seed: 'V3-BRIDGE-TUNNEL', elevationLimit: 0 });
  await world.buildTerrain();
  const meshes = world.group.children.filter(n => n.isMesh), bridge = world.features.bridge;
  const ray = new THREE.Raycaster(), origin = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
  world.group.updateMatrixWorld(true);
  for (let b = -120; b <= 120; b += 7) for (const lateral of [-3, 0, 3]) {
    const p = riverPoint(bridge, b, lateral), { x, z } = p;
    origin.set(x, bridge.y + 100, z); ray.set(origin, down);
    const hit = ray.intersectObjects(meshes, false)[0]; assert.ok(hit, 'river must stay within ground meshes');
    const water = p.y;
    assert.ok(hit.point.y < water - 0.05, `ground covers water at river ${b} / ${lateral}: ${hit.point.y - water}`);
  }
  for (let s = bridge.start + 2; s < bridge.end - 2; s += 5) {
    const p = world.route.sample(s); origin.set(p.x, p.y + 100, p.z); ray.set(origin, down);
    assert.ok(ray.intersectObjects(meshes, false)[0].point.y < p.y - 0.25, 'bridge deck must remain above ground');
  }
  world.dispose();
});

test('terrain meets the elevated track instead of remaining on a y=0 plane', () => {
  const world = new RailWorld(new THREE.Scene(), {}, config);
  for (let s = 0; s < world.route.length; s += 61) {
    const p = world.route.sample(s); assert.ok(Math.abs(world.heightAt(p.x, p.z) - (p.y - 0.09)) < 0.004);
  }
  const peak = world.route.sample(world.route.length * 0.5);
  assert.ok(peak.y > 70); assert.ok(world.heightAt(peak.x, peak.z) > 70); world.dispose();
});

test('the rendered earthwork triangles keep the visible rails exposed', async () => {
  const world = new RailWorld(new THREE.Scene(), {}, config); await world.buildTerrain();
  const chunks = world.group.children.filter(node => node.isMesh);
  for (let s = 0; s < world.route.length; s += 29) {
    const p = world.route.sample(s);
    const mesh = chunks.find(mesh => { const a = mesh.geometry.attributes.position; return p.x >= a.getX(0) && p.x <= a.getX(a.count - 1) && p.z >= a.getZ(0) && p.z <= a.getZ(a.count - 1); });
    assert.ok(mesh, 'track must stay over a ground mesh');
    const a = mesh.geometry.attributes.position, n = 12, x0 = a.getX(0), z0 = a.getZ(0), x1 = a.getX(a.count - 1), z1 = a.getZ(a.count - 1);
    const fx = (p.x - x0) / (x1 - x0) * n, fz = (p.z - z0) / (z1 - z0) * n;
    const ix = Math.min(n - 1, Math.floor(fx)), iz = Math.min(n - 1, Math.floor(fz)), tx = fx - ix, tz = fz - iz, i = iz * (n + 1) + ix;
    const h0 = a.getY(i), h1 = a.getY(i + 1), h2 = a.getY(i + n + 1), h3 = a.getY(i + n + 2);
    const ground = tx + tz <= 1 ? h0 + tx * (h1 - h0) + tz * (h2 - h0) : h3 + (1 - tx) * (h2 - h3) + (1 - tz) * (h1 - h3);
    assert.ok(ground < p.y + 0.18, `terrain covers the sleepers at ${s} m: ${ground - p.y}`);
    assert.ok(ground > p.y - 0.25, `terrain floats below railway at ${s} m: ${ground - p.y}`);
  }
  world.dispose();
});

test('actual instancing transforms pitch rails and the cart along the 3D path', () => {
  const geometry = new THREE.BoxGeometry(1, 1, 2), material = new THREE.MeshBasicMaterial();
  const store = { get: () => ({ parts: [{ geometry, material, matrix: new THREE.Matrix4() }] }) };
  const world = new RailWorld(new THREE.Scene(), store, config), s = trackSegments(world.route).find(s => s.start > 1400);
  world.addBatches('test-track', [{ x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, sz: s.length / 2 }], { kind: 'track' });
  const matrix = new THREE.Matrix4(); world.group.children[0].children[0].getMatrixAt(0, matrix);
  const end = new THREE.Vector3(0, 0, 2).applyMatrix4(matrix), expected = world.route.sample(s.end);
  assert.ok(end.distanceTo(new THREE.Vector3(expected.x, expected.y, expected.z)) < 0.001);
  world.cart = new THREE.Group(); const p = world.updateCart(1400, 0, 0);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(world.cart.quaternion);
  assert.ok(forward.distanceTo(new THREE.Vector3(p.tx3, p.ty, p.tz3)) < 1e-10);
  assert.ok(world.cart.position.y > 25); world.dispose(); geometry.dispose(); material.dispose();
});

test('derived hill and dune meshes contain no negative-Y foundation or flat display top', async () => {
  const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
  const loader = new GLTFLoader();
  const ids = ['Environment_Hills_RoundHill16m_001', 'Environment_Hills_RollingRidge24m_001', 'Environment_Hills_DistantRidge48m_001', 'Environment_Desert_DuneTile16m_001'];
  for (const id of ids) {
    const bytes = await readFile(new URL(`../assets/models/${id}.glb`, import.meta.url));
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    let triangles = 0;
    gltf.scene.traverse(node => {
      if (!node.isMesh) return;
      const p = node.geometry.attributes.position, indices = node.geometry.index.array;
      for (let i = 0; i < indices.length; i += 3) {
        const ys = [p.getY(indices[i]), p.getY(indices[i + 1]), p.getY(indices[i + 2])];
        assert.ok(ys.every(y => y >= -1e-7), `${id}: foundation remains`);
        assert.ok(ys.some(y => y > 0.002), `${id}: flat display top remains`); triangles++;
      }
    });
    assert.ok(triangles > 300, 'natural landscape must remain');
  }
});
