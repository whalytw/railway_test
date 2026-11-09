import * as THREE from 'three';

// Coordinates are in the cart's local GLB space: +Y up, +Z forward, metres.
// These three existing carts share their cushion and tapered interior geometry.
const SEAT = Object.freeze({ top: 1.045, centreZ: -0.44, targetWidth: 1.30, rear: -0.93, front: 0.93 });
export const DRIVER_SEATS = Object.freeze({
  Vehicle_Minecart_GoldenOak_001: SEAT,
  Vehicle_Minecart_AzureLake_001: SEAT,
  Vehicle_Minecart_RedCopper_001: SEAT
});

export function chooseDriver(choice, available, random = Math.random, exclude = null) {
  if (!available.length) throw new Error('沒有可使用的動物駕駛。');
  if (choice !== 'random') {
    if (!available.includes(choice)) throw new Error('找不到指定的動物駕駛。');
    return choice;
  }
  const candidates = available.length > 1 && exclude ? available.filter(id => id !== exclude) : available;
  const sample = Math.max(0, Math.min(1 - Number.EPSILON, Number(random()) || 0));
  return candidates[Math.floor(sample * candidates.length)];
}

export function createStandingDriver(source, vehicleId, { id = '', name = '', shadows = false, staticClip = null } = {}) {
  const seat = DRIVER_SEATS[vehicleId];
  if (!seat) throw new Error('這款礦車尚未設定動物座位。');
  const holder = new THREE.Group(); holder.name = 'AnimalDriver';
  const model = source.clone(true); holder.add(model);
  if (staticClip) {
    // Sample Kenney's authored static pose once. Do not play walk/run or a seated motion.
    const mixer = new THREE.AnimationMixer(model), action = mixer.clipAction(staticClip);
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play(); mixer.setTime(0);
  }
  holder.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model, true);
  const size = bounds.getSize(new THREE.Vector3());
  if (![size.x, size.y, size.z].every(v => Number.isFinite(v) && v > 0)) throw new Error('動物模型尺寸不正確。');
  // Preserve proportions. Tails on long species must also stay inside the cart.
  const scale = Math.min(seat.targetWidth / size.x, (seat.front - seat.rear) / size.z);
  model.scale.multiplyScalar(scale); holder.updateMatrixWorld(true);
  bounds.setFromObject(model, true);
  const centre = bounds.getCenter(new THREE.Vector3());
  const depth = bounds.max.z - bounds.min.z;
  const centreZ = Math.max(seat.rear + depth / 2, Math.min(seat.front - depth / 2, seat.centreZ));
  model.position.add(new THREE.Vector3(-centre.x, seat.top - bounds.min.y, centreZ - centre.z));
  model.traverse(node => { if (node.isMesh) { node.castShadow = shadows; node.receiveShadow = true; } });
  holder.updateMatrixWorld(true); bounds.setFromObject(model, true);
  holder.userData.driver = {
    id, name, license: 'CC0-1.0', posture: 'standing', poseClip: staticClip?.name || 'default', scale,
    seatTopMetres: seat.top, targetWidthMetres: seat.targetWidth,
    actualWidthMetres: bounds.max.x - bounds.min.x,
    bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }
  };
  return holder;
}
