import { clamp, smoothstep, randomGenerator, wrap } from './core.js?v=8.0.0';

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
  tunnel.halfWidth = 58; tunnel.hillHeight = 24; tunnel.approachLength = 72;
  // The river is a single continuous corridor shared by water, earthworks,
  // bank colouring, scenery exclusion and the minimap. Never tile straight
  // river models independently of the actual carved channel.
  bridge.river = { phase: random() * Math.PI * 2, amplitude: 28 + random() * 9,
    wideSide: random() < 0.5 ? -1 : 1, start: -420, end: 420 };
  for (const sign of [-1, 1]) {
    let limit = Math.min(440, route.squareSize * 0.72);
    for (let b = 40; b < limit; b += 8) {
      const p = riverPoint(bridge, b * sign), r = riverProfile(bridge, b * sign);
      const nearest = route.nearestTo(p.x, p.z, r.halfWidth + 35);
      const otherTrack = nearest.distanceAlong !== undefined && (nearest.distanceAlong < bridge.start - 12 || nearest.distanceAlong > bridge.end + 12);
      if (Math.abs(p.x) > route.squareSize - 24 || Math.abs(p.z) > route.squareSize / 2 - 24 || otherTrack && nearest.distance < r.halfWidth + 28) {
        limit = Math.max(70, b - 28); break;
      }
    }
    bridge.river[sign < 0 ? 'start' : 'end'] = limit * sign;
  }
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
export function riverBend(along, bridge) {
  const phase = bridge?.river?.phase || 0, amplitude = bridge?.river?.amplitude || 32;
  // Keep the bridge crossing centred, then open into clearly visible S bends.
  const bend = Math.sin(along / 92 + phase) - Math.sin(phase) + 0.25 * (Math.sin(along / 41 + phase * 0.7) - Math.sin(phase * 0.7));
  return amplitude * bend * smoothstep(22, 85, Math.abs(along));
}
export function riverProfile(bridge, along) {
  const river = bridge?.river || { start: -420, end: 420, wideSide: 1, phase: 0 };
  // Elliptical end caps form small rounded head / tail pools, rather than a
  // pointed ribbon that appears to vanish abruptly in the grass.
  const cap = (distance, length = 18) => distance >= length ? 1 : Math.sqrt(clamp(1 - (1 - Math.max(0, distance) / length) ** 2, 0, 1));
  const fade = cap(along - river.start) * cap(river.end - along);
  const reach = Math.exp(-(((along - river.wideSide * Math.min(210, (river.end - river.start) * 0.28)) / 76) ** 2));
  const scallop = (1 + Math.sin(along / 47 + river.phase)) * 0.8 * smoothstep(24, 110, Math.abs(along));
  const halfWidth = (5.8 + 12.5 * reach + scallop) * fade;
  const slope = (riverBend(along + 0.2, bridge) - riverBend(along - 0.2, bridge)) / 0.4;
  return { along, centre: riverBend(along, bridge), halfWidth, slope, fade, waterY: bridge.y - 6.54 + along * 0.004 };
}
export function riverPoint(bridge, along, offset = 0) {
  const p = riverProfile(bridge, along), inv = 1 / Math.hypot(1, p.slope);
  const nx = (bridge.tx - bridge.nx * p.slope) * inv, nz = (bridge.tz - bridge.nz * p.slope) * inv;
  return { x: bridge.x + bridge.nx * along + bridge.tx * p.centre + nx * offset,
    z: bridge.z + bridge.nz * along + bridge.tz * p.centre + nz * offset,
    y: p.waterY, nx, nz, ...p };
}
export function riverLocation(bridge, x, z) {
  const p = bridgeCoordinates(bridge, x, z);
  let along = p.along;
  // Closest point on a curved bank; measuring only in the bridge's X direction
  // would make the outer banks pinch and expose water through bends.
  for (let i = 0; i < 4; i++) {
    const r = riverProfile(bridge, along);
    const curvature = (riverBend(along + 0.5, bridge) - 2 * r.centre + riverBend(along - 0.5, bridge)) / 0.25;
    const denominator = Math.max(0.4, 1 + r.slope ** 2 + (r.centre - p.across) * curvature);
    along -= clamp((along - p.along + (r.centre - p.across) * r.slope) / denominator, -18, 18);
  }
  const r = riverProfile(bridge, along);
  return { ...r, distance: Math.hypot(along - p.along, r.centre - p.across), signedDistance: (p.across - r.centre) / Math.hypot(1, r.slope) };
}
export function bridgeGroundHeight(bridge, x, z, normalHeight) {
  if (!bridge) return normalHeight;
  const local = bridgeCoordinates(bridge, x, z), river = bridge.river || { start: -420, end: 420 };
  if (local.along < river.start - 45 || local.along > river.end + 45 || Math.abs(local.across) > 140) return normalHeight;
  const p = riverLocation(bridge, x, z), across = p.distance;
  const endWeight = smoothstep(river.start - 16, river.start, p.along) * (1 - smoothstep(river.end, river.end + 16, p.along));
  const weight = (1 - smoothstep(p.halfWidth + 7, p.halfWidth + 25, across)) * endWeight;
  const bed = p.waterY - 0.65 - 1.55 * (1 - smoothstep(p.halfWidth * 0.45, Math.max(0.1, p.halfWidth), across))
    + 2.2 * smoothstep(p.halfWidth, p.halfWidth + 7, across);
  const height = normalHeight + (bed - normalHeight) * weight;
  // Keep the complete bridge span clear, including the dry approaches to its
  // abutments; a narrow central stream must not bury the end deck modules.
  const underDeck = (1 - smoothstep(bridge.length / 2 - 4, bridge.length / 2 + 2, Math.abs(local.across)))
    * (1 - smoothstep(4, 20, Math.abs(local.along)));
  return Math.min(height, normalHeight - 1.4 * underDeck);
}
