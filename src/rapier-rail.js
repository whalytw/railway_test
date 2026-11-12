import * as RAPIER from '../vendor/rapier/rapier.mjs';
import { CART_MASS, FIXED_STEP, GRAVITY, MAX_FORWARD, MAX_REVERSE, clamp, createPhysics, stepPhysics } from './core.js?v=8.0.0';

export const RAPIER_VERSION = '0.21.0';
const BOGIE_MASS = CART_MASS * 0.2;
const SPRUNG_MASS = CART_MASS - BOGIE_MASS;
const SPRING_REST = 0.4;
const BUMPER_HALF_LENGTH = 0.18;
let initialization;
let initialized = false;

// The pinned compatibility module embeds its WASM; initialization needs no fetch.
export function initRapier() {
  if (!initialization) initialization = RAPIER.init().then(() => {
    if (RAPIER.version() !== RAPIER_VERSION) throw new Error('Bundled Rapier version does not match the pinned railway solver.');
    initialized = true;
    return RAPIER_VERSION;
  }).catch(error => { initialization = null; throw error; });
  return initialization;
}

/**
 * A constrained railway model in generalized coordinates. Rapier X is unwrapped
 * rail arc distance, Y is sprung suspension travel, and Z/rotations are locked.
 * Route geometry maps that distance back into the visible three-dimensional rail.
 * These are dynamic bodies: traction, the suspension joint, and actual collider
 * contacts change their velocity. This is not a wheel/flange/derailment model.
 */
export class RapierRailPhysics {
  constructor(route, options = {}) {
    if (!initialized) throw new Error('Call and await initRapier() before creating railway physics.');
    if (!route || typeof route.sample !== 'function') throw new Error('Railway physics requires a route with sample(distance).');
    this.route = route;
    this.options = {
      rebaseDistance: options.rebaseDistance ?? 192,
      suspensionStiffness: options.suspensionStiffness ?? 60000,
      suspensionDamping: options.suspensionDamping ?? 9000
    };
    const { rebaseDistance, suspensionStiffness, suspensionDamping } = this.options;
    if (!(rebaseDistance >= 100 && rebaseDistance <= 300)) throw new Error('Rebase distance must be 100–300 metres.');
    if (!(suspensionStiffness >= 20000 && suspensionStiffness <= 200000)) throw new Error('Suspension stiffness is outside the supported range.');
    if (!(suspensionDamping >= 1000 && suspensionDamping <= 30000)) throw new Error('Suspension damping is outside the supported range.');
    this.equilibriumY = SPRING_REST - SPRUNG_MASS * GRAVITY / suspensionStiffness;
    this.reference = createPhysics();
    this.sampleBehind = {}; this.sampleAhead = {};
    this.disposed = false;
    this.boundState = null;
    this.reset();
  }

  reset(state) {
    this.assertLive();
    const target = state || this.boundState || createPhysics();
    if (!state) Object.assign(target, createPhysics());
    if (!Number.isFinite(target.distance) || !Number.isFinite(target.speed)) throw new Error('Physics state requires finite distance and speed.');
    this.releaseWorld();
    this.boundState = target;
    this.origin = target.distance;
    this.steps = 0; this.rebaseCount = 0; this.collisions = 0;
    this.contactImpulse = 0; this.peakContactForce = 0; this.normalAcceleration = 0;
    this.maxAbsLocalX = 0;
    this.activeContacts = new Set();
    this.bumper = null; this.bumperDistance = null;
    const world = this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    world.timestep = FIXED_STEP;
    world.numSolverIterations = 8;
    world.integrationParameters.maxCcdSubsteps = 2;
    this.events = new RAPIER.EventQueue(true);
    this.bogie = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .enabledTranslations(true, false, false).lockRotations()
      .setCanSleep(false).setCcdEnabled(true).setLinvel(target.speed, 0, 0));
    this.chassis = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, this.equilibriumY, 0).enabledTranslations(true, true, false)
      .lockRotations().setCanSleep(false).setCcdEnabled(true).setLinvel(target.speed, 0, 0));
    const activeEvents = RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
    // One external envelope on the sprung mass resolves buffer shocks. The bogie
    // collider contributes its 130 kg without creating duplicate cart contacts.
    this.bogieCollider = world.createCollider(RAPIER.ColliderDesc.cuboid(1.05, 0.1, 0.55)
      .setMass(BOGIE_MASS).setCollisionGroups(0).setFriction(0).setRestitution(0.05)
      .setActiveEvents(activeEvents).setContactForceEventThreshold(1), this.bogie);
    this.chassisCollider = world.createCollider(RAPIER.ColliderDesc.cuboid(1.05, 0.2, 0.55)
      .setMass(SPRUNG_MASS).setFriction(0).setRestitution(0.05)
      .setActiveEvents(activeEvents).setContactForceEventThreshold(1), this.chassis);
    this.suspension = world.createImpulseJoint(RAPIER.JointData.prismatic(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), this.bogie, this.chassis, true);
    this.suspension.setContactsEnabled(false);
    this.suspension.setLimits(this.equilibriumY - 0.115, this.equilibriumY + 0.115);
    this.suspension.configureMotorModel(RAPIER.MotorModel.ForceBased);
    this.suspension.configureMotorPosition(SPRING_REST, this.options.suspensionStiffness, this.options.suspensionDamping);
    this.writeOutputs(target);
    return target;
  }

  step(state, dt, throttle = state.throttle, grade = 0) {
    this.assertLive();
    if (!(dt > 0 && dt <= 0.1)) throw new Error('Simulation requires a small positive timestep.');
    if (!Number.isFinite(throttle)) throw new Error('Throttle must be finite.');
    if (!Number.isFinite(grade)) throw new Error('Track grade must be finite.');
    if (state !== this.boundState) this.reset(state);
    const previousSpeed = this.bogie.linvel().x;
    const previousX = this.bogie.translation().x;
    const previousCountdown = Math.max(0, state.countdown);
    Object.assign(this.reference, state, { speed: previousSpeed });
    // Reuse the tested traction/brake/resistance law as a force reference only.
    // Its provisional speed and distance are never used as the physical result.
    stepPhysics(this.reference, dt, throttle, grade);
    for (const key of ['throttle', 'grade', 'elapsed', 'countdown', 'driveAcceleration', 'governor']) state[key] = this.reference[key];
    const activeDt = previousCountdown >= dt ? 0 : dt - previousCountdown;
    this.contactImpulse = 0;
    if (activeDt <= 1e-10) {
      this.writeOutputs(state);
      return state;
    }
    const cosTheta = 1 / Math.sqrt(1 + grade * grade);
    const distance = this.origin + previousX;
    const behind = this.route.sample(distance - 2, this.sampleBehind);
    const ahead = this.route.sample(distance + 2, this.sampleAhead);
    // Acceleration of the rail's moving normal frame changes the sprung load.
    // A four-metre derivative suppresses arc-table tangent quantization.
    const curvatureY = ((ahead.ty || 0) - (behind.ty || 0)) / 4;
    this.normalAcceleration = clamp(previousSpeed * previousSpeed * curvatureY, -1.2, 1.2);
    this.bogie.resetForces(true);
    this.chassis.resetForces(true);
    this.chassis.setGravityScale(cosTheta, true);
    const forceX = this.reference.acceleration * CART_MASS;
    const momentumBefore = BOGIE_MASS * previousSpeed + SPRUNG_MASS * this.chassis.linvel().x;
    this.bogie.addForce({ x: forceX, y: 0, z: 0 }, true);
    this.chassis.addForce({ x: 0, y: -SPRUNG_MASS * this.normalAcceleration, z: 0 }, true);
    this.world.timestep = activeDt;
    this.world.step(this.events);
    this.steps++;
    const bumperHandle = this.bumper?.handle;
    this.events.drainCollisionEvents((first, second, started) => {
      if (first !== bumperHandle && second !== bumperHandle) return;
      const other = first === bumperHandle ? second : first;
      if (started) {
        if (!this.activeContacts.size) this.collisions++;
        this.activeContacts.add(other);
      } else this.activeContacts.delete(other);
    });
    this.events.drainContactForceEvents(event => {
      if (event.collider1() !== bumperHandle && event.collider2() !== bumperHandle) return;
      const force = event.totalForceMagnitude();
      this.contactImpulse += force * activeDt;
      this.peakContactForce = Math.max(this.peakContactForce, force);
    });
    if (this.contactImpulse > 0) {
      // CCD event force magnitudes may span several solver substeps. Measure the
      // actual net collision impulse by momentum balance before the governor.
      const momentumAfter = BOGIE_MASS * this.bogie.linvel().x + SPRUNG_MASS * this.chassis.linvel().x;
      this.contactImpulse = Math.abs(momentumAfter - momentumBefore - forceX * activeDt);
    }
    let speed = this.bogie.linvel().x;
    const limited = clamp(speed, -MAX_REVERSE, MAX_FORWARD);
    if (limited !== speed) {
      // A dissipative governor: remove excess speed with a physical impulse.
      this.bogie.applyImpulse({ x: BOGIE_MASS * (limited - speed), y: 0, z: 0 }, true);
      this.chassis.applyImpulse({ x: SPRUNG_MASS * (limited - this.chassis.linvel().x), y: 0, z: 0 }, true);
      speed = this.bogie.linvel().x;
      state.governor = true;
    }
    const nextX = this.bogie.translation().x;
    state.distance = this.origin + nextX;
    state.odometer += Math.abs(nextX - previousX);
    state.speed = speed;
    state.acceleration = (speed - previousSpeed) / activeDt;
    this.maxAbsLocalX = Math.max(this.maxAbsLocalX, Math.abs(nextX));
    if (Math.abs(nextX) >= this.options.rebaseDistance) this.rebase(nextX);
    this.writeOutputs(state);
    return state;
  }

  rebase(shift) {
    // A shared change of coordinate origin preserves every separation/velocity.
    // This is not a per-frame route-position teleport or a collision bypass.
    for (const body of [this.bogie, this.chassis]) {
      const position = body.translation();
      body.setTranslation({ x: position.x - shift, y: position.y, z: position.z }, true);
    }
    this.origin += shift;
    if (this.bumper) this.bumper.setTranslation({ x: this.bumperDistance - this.origin, y: 0.2, z: 0 });
    this.world.propagateModifiedBodyPositionsToColliders();
    this.rebaseCount++;
  }

  placeBumper(unwrappedDistance) {
    this.assertLive();
    if (!Number.isFinite(unwrappedDistance)) throw new Error('Bumper distance must be finite.');
    this.clearBumper();
    this.bumperDistance = unwrappedDistance;
    this.bumper = this.world.createCollider(RAPIER.ColliderDesc.cuboid(BUMPER_HALF_LENGTH, 1, 0.9)
      .setTranslation(unwrappedDistance - this.origin, 0.2, 0).setFriction(0).setRestitution(0.05));
    return { distance: unwrappedDistance, halfLength: BUMPER_HALF_LENGTH, halfWidth: 0.9, height: 2 };
  }

  clearBumper() {
    this.assertLive();
    if (this.bumper) this.world.removeCollider(this.bumper, true);
    this.bumper = null; this.bumperDistance = null;
    this.activeContacts.clear();
    this.contactImpulse = 0;
  }

  applySuspensionImpulse(impulseNs) {
    this.assertLive();
    if (!Number.isFinite(impulseNs)) throw new Error('Suspension impulse must be finite.');
    this.chassis.applyImpulse({ x: 0, y: clamp(impulseNs, -100, 100), z: 0 }, true);
  }

  writeOutputs(state) {
    state.suspensionY = this.chassis.translation().y - this.equilibriumY;
    state.suspensionVelocity = this.chassis.linvel().y;
    state.contactImpulse = this.contactImpulse;
    state.collisionCount = this.collisions;
    state.rapierSteps = this.steps;
    state.solverVersion = RAPIER_VERSION;
  }

  diagnostics() {
    return {
      engine: 'Rapier', version: RAPIER_VERSION, disposed: this.disposed,
      model: 'Dynamic rail-distance bogie and sprung chassis; vertical prismatic force motor',
      massKg: CART_MASS, bogieMassKg: BOGIE_MASS, sprungMassKg: SPRUNG_MASS,
      actualMassKg: this.disposed ? null : this.bogie.mass() + this.chassis.mass(),
      fixedStepSeconds: FIXED_STEP, solverIterations: 8, ccd: true,
      rapierSteps: this.steps, collisionCount: this.collisions,
      contactImpulseNs: this.contactImpulse, peakContactForceN: this.peakContactForce,
      normalAccelerationMps2: this.normalAcceleration,
      rebaseCount: this.rebaseCount, rebaseDistanceMetres: this.options.rebaseDistance,
      maxAbsLocalX: this.maxAbsLocalX,
      originMetres: this.origin, localX: this.disposed ? null : this.bogie.translation().x,
      distance: this.boundState?.distance ?? 0, speed: this.boundState?.speed ?? 0,
      bumperDistance: this.bumperDistance,
      suspensionEquilibriumMetres: this.equilibriumY,
      suspensionStiffnessNpm: this.options.suspensionStiffness,
      suspensionDampingNspm: this.options.suspensionDamping
    };
  }

  assertLive() { if (this.disposed) throw new Error('Railway physics has been disposed.'); }

  releaseWorld() {
    if (this.events) { this.events.free(); this.events = null; }
    if (this.world) { this.world.free(); this.world = null; }
  }

  dispose() {
    if (this.disposed) return;
    this.releaseWorld();
    this.bogie = null; this.chassis = null; this.bumper = null;
    this.activeContacts.clear(); this.boundState = null;
    this.disposed = true;
  }
}
