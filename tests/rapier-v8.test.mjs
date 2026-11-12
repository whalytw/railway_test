import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CART_MASS, FIXED_STEP, MAX_FORWARD, MAX_REVERSE, createPhysics, createRoute, stepPhysics } from '../src/core.js';
import { initRapier, RapierRailPhysics, RAPIER_VERSION } from '../src/rapier-rail.js';

await initRapier();
const flatRoute = { sample(distance, out = {}) { return Object.assign(out, { x: distance, y: 0, z: 0, ty: 0, grade: 0 }); } };
function setup(values = {}, route = flatRoute) {
  const state = Object.assign(createPhysics(), { countdown: 0 }, values);
  const engine = new RapierRailPhysics(route);
  engine.reset(state);
  return { engine, state };
}
function run(engine, state, seconds, throttle = state.throttle, grade = 0) {
  for (let i = 0; i < Math.round(seconds / FIXED_STEP); i++) engine.step(state, FIXED_STEP, throttle, grade);
}

test('pinned compat module initializes with every network fetch blocked', () => {
  const url = new URL('../src/rapier-rail.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `globalThis.fetch=()=>{throw new Error('Network disabled')};const p=await import(${JSON.stringify(url)});console.log(await p.initRapier());`],
  { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), RAPIER_VERSION);
});

test('two actual dynamic bodies have 650 kg total and follow the force law', () => {
  const { engine, state } = setup({ throttle: 0.8 });
  const reference = { ...state };
  try {
    for (let i = 0; i < 1200; i++) {
      engine.step(state, FIXED_STEP, 0.8, 0);
      stepPhysics(reference, FIXED_STEP, 0.8, 0);
    }
    const diagnostics = engine.diagnostics();
    assert.equal(diagnostics.actualMassKg, CART_MASS);
    assert.equal(diagnostics.bogieMassKg, 130);
    assert.equal(diagnostics.sprungMassKg, 520);
    assert.ok(Math.abs(state.speed - reference.speed) < 0.02, `${state.speed} versus ${reference.speed}`);
    assert.ok(Math.abs(state.distance - reference.distance) < 0.1);
    assert.equal(state.rapierSteps, 1200);
    assert.equal(state.solverVersion, RAPIER_VERSION);
  } finally { engine.dispose(); }
});

test('neutral coasts down on flat track and rolls downhill with the correct sign', () => {
  const flat = setup({ speed: 12, throttle: 0 });
  const uphill = setup({ throttle: 0 });
  const downhill = setup({ throttle: 0 });
  try {
    run(flat.engine, flat.state, 10, 0, 0);
    run(uphill.engine, uphill.state, 10, 0, 0.02);
    run(downhill.engine, downhill.state, 10, 0, -0.02);
    assert.ok(flat.state.speed > 0 && flat.state.speed < 12);
    assert.ok(uphill.state.speed < -1 && uphill.state.distance < 0);
    assert.ok(downhill.state.speed > 1 && downhill.state.distance > 0);
    assert.ok(Math.abs(uphill.state.speed + downhill.state.speed) < 0.002);
  } finally { flat.engine.dispose(); uphill.engine.dispose(); downhill.engine.dispose(); }
});

test('static rolling resistance holds a level cart and reverse braking permits reversal', () => {
  const stopped = setup({ throttle: 0 });
  const reversing = setup({ speed: 15, throttle: -0.8 });
  try {
    run(stopped.engine, stopped.state, 20, 0, 0);
    assert.ok(Math.abs(stopped.state.speed) < 1e-5);
    assert.ok(Math.abs(stopped.state.distance) < 1e-5);
    run(reversing.engine, reversing.state, 25, -0.8, 0);
    assert.ok(reversing.state.speed < -1);
    assert.ok(reversing.state.speed >= -MAX_REVERSE - 1e-5);
  } finally { stopped.engine.dispose(); reversing.engine.dispose(); }
});

test('forward and reverse governors remove excess speed on long descents', () => {
  const forward = setup({ speed: MAX_FORWARD, throttle: 1 });
  const reverse = setup({ speed: -MAX_REVERSE, throttle: -1 });
  try {
    run(forward.engine, forward.state, 20, 1, -0.025);
    run(reverse.engine, reverse.state, 20, -1, 0.025);
    assert.ok(forward.state.speed <= MAX_FORWARD + 1e-5);
    assert.ok(reverse.state.speed >= -MAX_REVERSE - 1e-5);
    assert.ok(forward.state.governor || Math.abs(forward.state.speed - MAX_FORWARD) < 0.001);
    assert.ok(reverse.state.governor || Math.abs(reverse.state.speed + MAX_REVERSE) < 0.001);
  } finally { forward.engine.dispose(); reverse.engine.dispose(); }
});

test('countdown freezes the solver; fixed-step outcomes survive irregular render cadence', () => {
  const a = setup({ countdown: 3, throttle: 0.5 });
  const b = setup({ countdown: 3, throttle: 0.5 });
  try {
    for (let i = 0; i < 240; i++) a.engine.step(a.state, FIXED_STEP, 0.5, 0);
    assert.equal(a.state.rapierSteps, 0);
    assert.equal(a.state.distance, 0);
    assert.ok(Math.abs(a.state.elapsed - 2) < 1e-10);
    for (let i = 240; i < 1200; i++) a.engine.step(a.state, FIXED_STEP, 0.5, 0);
    let accumulator = 0, steps = 0, frame = 0;
    const frames = [1 / 144, 1 / 30, 1 / 60, 1 / 48];
    while (steps < 1200) {
      accumulator += frames[frame++ % frames.length];
      while (accumulator >= FIXED_STEP && steps < 1200) {
        b.engine.step(b.state, FIXED_STEP, 0.5, 0); accumulator -= FIXED_STEP; steps++;
      }
    }
    assert.equal(a.state.speed, b.state.speed);
    assert.equal(a.state.distance, b.state.distance);
    assert.equal(a.state.rapierSteps, b.state.rapierSteps);
  } finally { a.engine.dispose(); b.engine.dispose(); }
});

test('a fixed bumper produces actual contact impulses and changes cart motion at 120 km/h', () => {
  const { engine, state } = setup({ speed: MAX_FORWARD, throttle: 0 });
  engine.placeBumper(8);
  let furthest = -Infinity, peakImpulse = 0;
  try {
    for (let i = 0; i < 240; i++) {
      const beforeSpeed = state.speed;
      engine.step(state, FIXED_STEP, 0, 0);
      furthest = Math.max(furthest, state.distance);
      peakImpulse = Math.max(peakImpulse, state.contactImpulse);
      if (state.contactImpulse > 1000) assert.ok(Math.abs(state.contactImpulse - CART_MASS * Math.abs(state.speed - beforeSpeed)) < 10,
        'Reported impact impulse must match the actual coupled-body momentum change');
    }
    assert.ok(furthest < 7.1, `CCD failed: cart reached ${furthest} m`);
    assert.ok(state.collisionCount >= 1);
    assert.ok(peakImpulse > 1000);
    assert.ok(Math.abs(state.speed) < 3);
    engine.clearBumper();
    assert.equal(engine.diagnostics().bumperDistance, null);
  } finally { engine.dispose(); }
});

test('the physical spring responds to an impulse, settles, and reacts to rail vertical acceleration', () => {
  const { engine, state } = setup({ throttle: 0 });
  try {
    engine.applySuspensionImpulse(50);
    let travel = 0;
    for (let i = 0; i < 120; i++) {
      engine.step(state, FIXED_STEP, 0, 0);
      travel = Math.max(travel, Math.abs(state.suspensionY));
    }
    assert.ok(travel > 0.002 && travel < 0.03, `Unexpected suspension travel ${travel}`);
    run(engine, state, 4, 0, 0);
    assert.ok(Math.abs(state.suspensionY) < 1e-4);
    assert.ok(Math.abs(state.suspensionVelocity) < 1e-4);
  } finally { engine.dispose(); }
  const route = createRoute(5000, 'SUSPENSION', 8192, { elevationLimit: 500, stations: 3 });
  const moving = setup({ speed: 28, distance: 200, throttle: 1 }, route);
  let normalLoad = 0, travel = 0;
  try {
    for (let i = 0; i < 4800; i++) {
      const grade = route.sample(moving.state.distance).grade;
      moving.engine.step(moving.state, FIXED_STEP, 1, grade);
      normalLoad = Math.max(normalLoad, Math.abs(moving.engine.diagnostics().normalAccelerationMps2));
      travel = Math.max(travel, Math.abs(moving.state.suspensionY));
    }
    assert.ok(normalLoad > 0.01);
    assert.ok(travel > 0.0001 && travel < 0.02);
  } finally { moving.engine.dispose(); }
});

test('coordinate rebasing preserves distant unwrapped travel and bumper contacts', () => {
  const start = 1_000_000_000;
  const { engine, state } = setup({ speed: 20, distance: start, throttle: 1 });
  try {
    run(engine, state, 120, 1, 0);
    const diagnostics = engine.diagnostics();
    assert.ok(state.distance > start + 3000);
    assert.ok(diagnostics.rebaseCount > 10);
    assert.ok(Math.abs(diagnostics.localX) < 192);
    assert.ok(diagnostics.maxAbsLocalX < 192.3);
    assert.ok(Math.abs(diagnostics.originMetres + diagnostics.localX - state.distance) < 1e-6);
    assert.ok(Math.abs(state.odometer - (state.distance - start)) < 0.01);
    engine.placeBumper(state.distance + 210);
    const bumperDistance = engine.diagnostics().bumperDistance;
    run(engine, state, 15, 0, 0);
    assert.ok(state.collisionCount >= 1, 'Bumper must remain coherent across a rebase');
    assert.ok(state.distance < bumperDistance - 1);
    assert.ok(Math.abs(state.speed) < 3);
  } finally { engine.dispose(); }
});

test('reset and dispose release worlds repeatedly and reset visible counters', () => {
  const { engine, state } = setup({ throttle: 0.5 });
  for (let i = 0; i < 25; i++) {
    engine.step(state, FIXED_STEP, 0.5, 0);
    engine.placeBumper(state.distance + 100);
    const next = engine.reset();
    assert.equal(next, state);
    assert.equal(state.distance, 0);
    assert.equal(state.rapierSteps, 0);
    assert.equal(state.collisionCount, 0);
    assert.equal(engine.diagnostics().bumperDistance, null);
    assert.equal(engine.diagnostics().actualMassKg, CART_MASS);
  }
  engine.dispose(); engine.dispose();
  assert.equal(engine.diagnostics().disposed, true);
  assert.throws(() => engine.step(state, FIXED_STEP, 0, 0), /disposed/);
});
