// Metre-based landscape rules shared by renderers, planning and validation.
// No imported photographs, textures or additional third-party licenses.
import { clamp, smoothstep } from './core.js?v=7.0.0';

export function farmCoordinates(farm, x, z) {
  const dx = x - farm.x, dz = z - farm.z, c = Math.cos(farm.yaw), s = Math.sin(farm.yaw);
  return { u: c * dx - s * dz, v: s * dx + c * dz };
}
export function inFarm(farm, x, z, margin = 0) {
  const p = farmCoordinates(farm, x, z);
  return Math.abs(p.u) < farm.halfWidth + margin && Math.abs(p.v) < farm.halfLength + margin;
}

export const GRASS_HABITAT = { Forest: 0.85, Hills: 1, Pastoral: 1, Rural: 0.9, Lakeside: 0.85, Desert: 0, Snow: 0, Volcano: 0 };
const fract = n => n - Math.floor(n);
function hash(x, z) { return fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453123); }
export function landNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = fract(x), fz = fract(z);
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
export function grassPatch(x, z) {
  return smoothstep(0.36, 0.68, landNoise(x / 22, z / 22) * 0.70 + landNoise(x / 7, z / 7) * 0.30);
}

// The mountain continues well past the portal. Only the excavated mouth has a
// rock face; approach slopes taper continuously into the surrounding ground.
export function tunnelFrontShift(tunnel, x) {
  const a = Math.max(0, Math.abs(x) - 2.35);
  return -Math.min(6.2, a * a * 0.15) * (1 - smoothstep(10, 24, Math.abs(x)));
}
export function tunnelMoundHeight(tunnel, localS, x) {
  const length = tunnel.length, approach = tunnel.approachLength || 72;
  const outer = smoothstep(-approach, -8, localS) * (1 - smoothstep(length + 8, length + approach, localS));
  const t = clamp(localS / length, 0, 1), flank = Math.max(0, 1 - (Math.abs(x) / tunnel.halfWidth) ** 2) ** 1.7;
  const crown = (6.6 + tunnel.hillHeight * Math.sin(t * Math.PI) ** 1.2) * flank;
  // Staggered shoulders break the symmetry of a single half-cylinder mound.
  const left = 6.8 * Math.exp(-(((x + 22) / 16) ** 2)) * (0.65 + 0.35 * Math.sin(t * Math.PI + 0.8));
  const right = 4.5 * Math.exp(-(((x - 19) / 18) ** 2)) * (0.65 + 0.35 * Math.sin(t * Math.PI - 0.5));
  const variation = (landNoise(x * 0.13, localS * 0.10) - 0.5) * 1.1 * flank;
  return (crown + variation + (left + right) * (1 - smoothstep(tunnel.halfWidth - 10, tunnel.halfWidth, Math.abs(x)))) * outer;
}
export function tunnelCutFactor(localS, x, length) {
  const outside = Math.max(0, -localS, localS - length);
  return smoothstep(2.35 + outside * 0.07, 9 + outside * 0.25, Math.abs(x));
}
