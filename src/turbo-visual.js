import * as THREE from 'three';
import { TURBO_DROP_SECONDS, clamp, lerp, smoothstep } from './core.js?v=13.0.0';

export const TURBO_ASSET_ID = 'Prop_Aircraft_TurbofanExterior_LowPoly_001';
const DEPLOY_SECONDS = 0.18;
const MODEL_SCALE = 0.58;

export function createTurboResources(world) {
  // Both flames use the same low-sided mesh shape. They emit colour locally
  // without adding lights or widening the shadow pass.
  const flame = new THREE.ConeGeometry(0.24, 1.65, 10);
  flame.rotateX(-Math.PI / 2);
  flame.translate(0, 0, -0.825);
  const bracket = new THREE.BoxGeometry(1, 0.14, 0.38);
  const blue = new THREE.MeshBasicMaterial({ color: '#208cff', transparent: true, opacity: 0.82, depthWrite: false, toneMapped: false });
  const cyan = new THREE.MeshBasicMaterial({ color: '#a4faff', toneMapped: false });
  const steel = new THREE.MeshStandardMaterial({ color: '#4a575a', roughness: 0.65, metalness: 0.2 });
  world.ownedGeometry.push(flame, bracket);
  world.ownedMaterials.push(blue, cyan, steel);
  return { flame, bracket, blue, cyan, steel };
}

export class TurboPair {
  constructor(world, cart, cartHalfWidth, resources) {
    const asset = world.store.get(TURBO_ASSET_ID);
    const radius = Math.max(Math.abs(asset.bounds.min.x), Math.abs(asset.bounds.max.x)) * MODEL_SCALE;
    this.root = new THREE.Group(); this.root.name = 'CartTurbofans'; this.root.visible = false;
    this.cart = cart;
    this.cartHalfWidth = cartHalfWidth;
    this.extension = cartHalfWidth + radius + 0.14;
    this.pods = [-1, 1].map(side => {
      const mount = new THREE.Group(); mount.name = side < 0 ? 'LeftTurbofan' : 'RightTurbofan';
      const intake = asset.root.clone(true), rotor = intake.getObjectByName('FanRotor');
      intake.scale.multiplyScalar(MODEL_SCALE);
      intake.position.y = -(asset.bounds.max.y + asset.bounds.min.y) * MODEL_SCALE * 0.5;
      intake.traverse(part => { if (part.isMesh) { part.castShadow = Boolean(world.config.shadows); part.receiveShadow = true; } });
      rotor?.traverse(part => { part.castShadow = false; });
      const mixer = new THREE.AnimationMixer(intake);
      const clip = asset.animations.find(action => action.name === 'FanSpin');
      if (clip) mixer.clipAction(clip).play();
      const exhaust = new THREE.Group(); exhaust.name = 'BlueExhaust';
      exhaust.position.z = asset.bounds.min.z * MODEL_SCALE + 0.03;
      const outside = new THREE.Mesh(resources.flame, resources.blue);
      const core = new THREE.Mesh(resources.flame, resources.cyan); core.scale.set(0.47, 0.47, 0.72);
      exhaust.add(outside, core);
      const bracket = new THREE.Mesh(resources.bracket, resources.steel);
      bracket.position.set(-side * (radius + 0.14) / 2, -0.10, 0.12);
      bracket.scale.x = radius + 0.36;
      mount.add(bracket, intake, exhaust); this.root.add(mount);
      return { side, mount, intake, mixer, exhaust, bracket };
    });
    world.group.add(this.root);
    this.enabled = false; this.changedAt = 0; this.scale = 0; this.startScale = 0;
  }
  setEnabled(enabled, elapsed) {
    if (enabled === this.enabled) return;
    this.enabled = enabled; this.changedAt = elapsed; this.startScale = this.scale;
  }
  update(elapsed, firing) {
    const transitionTime = elapsed - this.changedAt;
    const phase = clamp(transitionTime / (this.enabled ? DEPLOY_SECONDS : TURBO_DROP_SECONDS), 0, 1);
    const fallProgress = this.enabled ? 0 : phase;
    this.scale = this.enabled
      ? lerp(this.startScale, 1, smoothstep(0, 1, phase))
      : this.startScale * (1 - smoothstep(0.28, 1, phase));
    this.root.visible = this.scale > 0.001;
    if (!this.root.visible) return;
    this.root.position.copy(this.cart.position);
    this.root.quaternion.copy(this.cart.quaternion);
    for (const { side, mount, exhaust, mixer, bracket } of this.pods) {
      const offset = lerp(this.cartHalfWidth * 0.7, this.extension, this.enabled ? this.scale : this.startScale);
      mount.position.set(side * (offset + fallProgress * 0.32), 0.96 - fallProgress * fallProgress * 1.65, -0.20 - fallProgress * 0.85);
      mount.rotation.set(-fallProgress * 0.43, 0, side * -fallProgress * 0.9);
      mount.scale.setScalar(this.scale);
      bracket.visible = this.enabled;
      exhaust.visible = this.enabled && firing;
      if (exhaust.visible) {
        const pulse = 0.91 + 0.09 * Math.sin(elapsed * 57 + side);
        exhaust.scale.set(pulse, pulse, 0.92 + 0.16 * Math.sin(elapsed * 83 + side));
      }
      mixer.setTime(elapsed * 8.5);
    }
  }
  dispose() {
    for (const { mixer, intake } of this.pods) mixer.uncacheRoot(intake);
  }
}
