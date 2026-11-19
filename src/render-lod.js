export function distanceToXZBounds(bounds, x, z) {
  const dx = Math.max(bounds.min.x - x, x - bounds.max.x, 0);
  const dz = Math.max(bounds.min.z - z, z - bounds.max.z, 0);
  return Math.hypot(dx, dz);
}

export function chooseFarGeometry(distance, threshold, previousFar, hysteresis) {
  return distance > threshold + (previousFar ? -hysteresis : hysteresis);
}
