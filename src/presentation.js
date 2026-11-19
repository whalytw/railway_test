import { clamp, lerp } from './core.js?v=13.0.0';

export function copyMotion(state, out = {}) {
  out.distance = state.distance; out.odometer = state.odometer; out.speed = state.speed;
  out.suspensionY = state.suspensionY || 0; out.suspensionVelocity = state.suspensionVelocity || 0;
  return out;
}
export function interpolateMotion(previous, current, alpha, out = {}) {
  const t = clamp(alpha, 0, 1);
  out.distance = lerp(previous.distance, current.distance, t);
  out.odometer = lerp(previous.odometer, current.odometer, t);
  out.speed = lerp(previous.speed, current.speed, t);
  out.suspensionY = lerp(previous.suspensionY || 0, current.suspensionY || 0, t);
  out.suspensionVelocity = lerp(previous.suspensionVelocity || 0, current.suspensionVelocity || 0, t);
  return out;
}

export function zoomView(mode, distance, deltaY, preview = false) {
  if (mode === 'overview') return { mode, distance };
  const next = clamp((mode === 'cab' ? 0 : distance) + deltaY * 0.025, preview ? 7 : 0, 80);
  return { mode: !preview && next < 0.001 ? 'cab' : 'chase', distance: next };
}

// Divide the real framebuffer so fractional render resolutions leave no gaps.
export function partitionViewports(width, height, pixelRatio, count, left = 0) {
  const inset = Math.max(0, Math.min(width - count, Math.round(left * pixelRatio)));
  const playableWidth = width - inset;
  return Array.from({ length: count }, (_, i) => {
    const start = inset + Math.floor(playableWidth * i / count);
    const end = inset + Math.floor(playableWidth * (i + 1) / count);
    return { x: start / pixelRatio, y: 0, width: (end - start) / pixelRatio, height: height / pixelRatio };
  });
}

// Damping world positions makes the cart alternately catch and leave the
// camera when render intervals vary. Dampen only the offset from the same
// interpolated cart anchor used to draw the vehicle.
export function anchorCamera(camera, anchor, desired, target, offset, lookOffset, dt, snap = false, rate = 10) {
  const blend = snap ? 1 : 1 - Math.exp(-dt * rate);
  offset.multiplyScalar(1 - blend).addScaledVector(desired, blend).addScaledVector(anchor, -blend);
  lookOffset.multiplyScalar(1 - blend).addScaledVector(target, blend).addScaledVector(anchor, -blend);
  camera.position.copy(anchor).add(offset);
  camera.lookAt(target.copy(anchor).add(lookOffset));
}
