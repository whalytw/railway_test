import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, context, next) { return s === 'three' ? { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true } : next(s, context); } });
const THREE = await import('../vendor/three.module.js');
const { FIXED_STEP } = await import('../src/core.js');
const { copyMotion, interpolateMotion, zoomView, anchorCamera } = await import('../src/presentation.js');

test('rendered motion stays continuous across fractional physics steps at variable refresh rates and in reverse', () => {
  for (const speed of [120 / 3.6, -30 / 3.6]) for (const fps of [30, 60, 75, 144]) {
    const current = { distance: 15000 - 0.2, odometer: 0, speed }, previous = copyMotion(current);
    let accumulator = 0, time = 0, previousRender;
    for (let frame = 0; frame < fps * 4; frame++) {
      const dt = (1 + Math.sin(frame * 1.7) * 0.12) / fps; time += dt; accumulator += dt;
      while (accumulator >= FIXED_STEP) { copyMotion(current, previous); current.distance += speed * FIXED_STEP; current.odometer += Math.abs(speed) * FIXED_STEP; accumulator -= FIXED_STEP; }
      const rendered = interpolateMotion(previous, current, accumulator / FIXED_STEP);
      if (previousRender && time > 0.08) assert.ok(Math.abs(rendered.distance - previousRender.distance - speed * dt) < 1e-8);
      previousRender = rendered;
    }
  }
});

test('anchored chase camera keeps a steady cart screen position despite irregular render intervals', () => {
  const camera = new THREE.PerspectiveCamera(63, 16 / 10, 0.12, 18000), offset = new THREE.Vector3(), lookOffset = new THREE.Vector3();
  const cart = new THREE.Vector3(), desired = new THREE.Vector3(), target = new THREE.Vector3();
  let baseline, time = 0;
  for (let i = 0; i < 600; i++) {
    const dt = (1 + 0.32 * Math.sin(i * 2.1)) / 60; time += dt;
    cart.set(0, 0.381, time * 120 / 3.6); desired.copy(cart).add(new THREE.Vector3(-3, 5, -18)); target.copy(cart).add(new THREE.Vector3(0, 1.4, 8));
    anchorCamera(camera, cart, desired, target, offset, lookOffset, dt, i === 0);
    camera.updateMatrixWorld(); const screen = cart.clone().project(camera);
    if (!baseline) baseline = screen; else assert.ok(screen.distanceTo(baseline) < 1e-10, 'camera must not alternately catch and leave the cart');
  }
});

test('wheel zoom reaches a freely rotatable cab and can return to chase without changing overview or preview behavior', () => {
  assert.deepEqual(zoomView('chase', 18, -10000), { mode: 'cab', distance: 0 });
  assert.deepEqual(zoomView('cab', 0, -120), { mode: 'cab', distance: 0 });
  assert.deepEqual(zoomView('cab', 0, 120), { mode: 'chase', distance: 3 });
  assert.deepEqual(zoomView('overview', 18, -10000), { mode: 'overview', distance: 18 });
  assert.deepEqual(zoomView('chase', 18, -10000, true), { mode: 'chase', distance: 7 });
});
