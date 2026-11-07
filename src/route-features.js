import { clamp, smoothstep, randomGenerator, wrap } from './core.js?v=3.0.0';

export function sleeperLayout(length, spacing = 0.75, seed = 'sleepers') {
  const random = randomGenerator(`${seed}:sleepers`), count = Math.round(length / spacing), pitch = length / count, result = [];
  for (let i = 0; i < count; i++) result.push({ distance: (i + 0.5 + (random() - 0.5) * 0.14) * pitch, tone: 0.90 + random() * 0.16 });
  return { placements: result, pitch };
}

export function sleeperFilter(speed, frameSeconds, pitch, enabled = true) {
  if (!enabled) return { exposure: 0, contrastReduction: 0, enabled: 0 };
  const displacement = Math.abs(speed) * clamp(frameSeconds, 1 / 144, 1 / 20);
  return { exposure: Math.min(1.5, displacement * 0.95), contrastReduction: smoothstep(0.18, 0.65, displacement / pitch) * 0.65, enabled: 1 };
}
// Reference box-filter integral used by the sleeper material's GLSL version.
export function exposureCoverage(z, exposure, halfWidth = 0.15) {
  if (exposure < 0.00001) return Math.abs(z) <= halfWidth ? 1 : 0;
  return clamp((Math.min(halfWidth, z + exposure / 2) - Math.max(-halfWidth, z - exposure / 2)) / exposure, 0, 1);
}

function stationClearance(distance, stations, length) {
  return Math.min(...stations.map(s => Math.abs(wrap(distance - s.distance + length / 2, length) - length / 2)));
}
export function planRouteFeatures(route, stations, seed = 'features') {
  const random = randomGenerator(`${seed}:features`);
  function choose(target, length, kind, previous) {
    let best = null, score = Infinity;
    for (let i = -45; i <= 45; i++) {
      const centre = target + i * 10;
      if (centre < 180 || centre > route.length - 180 || stationClearance(centre, stations, route.length) < length / 2 + 100) continue;
      if (previous && Math.abs(centre - previous.centre) < 350) continue;
      let error = 0;
      const module = kind === 'bridge' ? 8 : 4;
      for (let s = centre - length / 2; s < centre + length / 2; s += module) {
        const a = route.sample(s), b = route.sample(s + module), m = route.sample(s + module / 2);
        error = Math.max(error, Math.hypot(m.x - (a.x + b.x) / 2, m.y - (a.y + b.y) / 2, m.z - (a.z + b.z) / 2));
      }
      const value = error * 1600 + Math.abs(centre - target) * 0.004;
      if (value < score) { score = value; best = { kind, centre, start: centre - length / 2, end: centre + length / 2, length, moduleDeviation: error, ...route.sample(centre) }; }
    }
    if (!best) throw new Error('找不到避開車站的橋隧位置。');
    return best;
  }
  const bridge = choose(route.length * (0.26 + random() * 0.015), 64, 'bridge');
  const tunnel = choose(route.length * (0.72 + random() * 0.015), 80, 'tunnel', bridge);
  bridge.name = '河谷鋼橋'; tunnel.name = '山脈隧道';
  tunnel.halfWidth = 34; tunnel.hillHeight = 18;
  return { bridge, tunnel };
}
export function featureAt(features, distance, routeLength, padding = 0) {
  const s = wrap(distance, routeLength);
  return [features?.bridge, features?.tunnel].find(f => f && s >= f.start - padding && s <= f.end + padding) || null;
}
export function bridgeCoordinates(bridge, x, z) {
  const dx = x - bridge.x, dz = z - bridge.z;
  return { across: dx * bridge.tx + dz * bridge.tz, along: dx * bridge.nx + dz * bridge.nz };
}
export const riverBend = along => Math.sin(along / 47) * 2.7;
export function bridgeGroundHeight(bridge, x, z, normalHeight) {
  if (!bridge) return normalHeight;
  const p = bridgeCoordinates(bridge, x, z), across = Math.abs(p.across - riverBend(p.along));
  const weight = (1 - smoothstep(12, 36, across)) * (1 - smoothstep(145, 204, Math.abs(p.along)));
  const bank = bridge.y - 6 + p.along * 0.004;
  // Dig below the dry-bed model in the channel, but meet its outer bank datum
  // near |x|=10.4 m so the model's closed sides do not become display slabs.
  const bed = bank - 0.08 - 2.15 * (1 - smoothstep(5.2, 10.4, across));
  return normalHeight + (Math.min(normalHeight, bed) - normalHeight) * weight;
}
