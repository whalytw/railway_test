import { clamp, smoothstep, randomGenerator, wrap } from './core.js?v=13.0.0';

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
  if (route.turns > 1 || route.lanes) return planParallelFeatures(route, stations, seed);
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

// One river can be crossed on several turns. Each physical crossing gets its
// own deck, so the river never removes the ground from a neighboring track.
const CIRCUIT_BRIDGE_HALF_SPAN = 40;
function planParallelFeatures(route, stations, seed) {
  const random = randomGenerator(`${seed}:circuit-water`);
  const count = route.lanes?.length ?? route.turns, midLane = Math.floor(count / 2);
  const turnIds = Array.from({ length: count }, (_, i) => i);
  const halfDepth = route.halfDepth ?? route.squareSize / 2;
  const sample = (lane, distance) => (route.lanes?.[lane] ?? route).sample(distance);
  const distanceAtPhase = (lane, u) => route.lanes ? route.length * u : route.distanceAtPhase(lane, u);
  const allPlatforms = stations.flatMap(station => station.passes);
  const riverPhase = (stations.length === 3 ? 0.16 : 0.24) + (random() - 0.5) * 0.045;
  const riverPhaseAngle = random() * Math.PI * 2, wideSide = random() < 0.5 ? -1 : 1;
  let bridge = null;
  for (const offset of [0, -0.02, 0.02, -0.045, 0.045, -0.07, 0.07]) {
    const u = riverPhase + offset, centre = distanceAtPhase(midLane, u);
    const frame = sample(midLane, centre);
    const spans = [], bankPositions = [];
    for (const lane of turnIds) {
      const s = distanceAtPhase(lane, u);
      const crossCoordinate = distance => {
        const p = sample(lane, distance);
        return bridgeCoordinates(frame, p.x, p.z).across;
      };
      const edge = (target, lo, hi) => {
        if (crossCoordinate(lo) > target || crossCoordinate(hi) < target) return null;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          if (crossCoordinate(mid) < target) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
      };
      const start = edge(-CIRCUIT_BRIDGE_HALF_SPAN, s - 130, s + 130), end = edge(CIRCUIT_BRIDGE_HALF_SPAN, s - 130, s + 130);
      const crossing = edge(0, s - 90, s + 90);
      if (start === null || end === null || crossing === null || end - start > 150) break;
      const point = sample(lane, crossing);
      const closeStation = stationClearance(crossing, allPlatforms, route.length) < (end - start) / 2 + 65;
      if (closeStation || Math.abs(point.x) > route.squareSize - 100 || Math.abs(point.z) > halfDepth - 95) break;
      for (const at of [start, crossing, end]) {
        const p = sample(lane, at);
        bankPositions.push(bridgeCoordinates(frame, p.x, p.z).along);
      }
      spans.push({ kind: 'bridge', name: '河谷橋', start, end, centre: crossing, length: end - start, turnIndex: lane, ...point });
    }
    if (spans.length !== count) continue;
    const minRail = Math.min(...spans.flatMap(span => [sample(span.turnIndex, span.start).y, span.y, sample(span.turnIndex, span.end).y]));
    const deckMin = Math.min(...bankPositions), deckMax = Math.max(...bankPositions);
    const river = { phase: riverPhaseAngle, wideSide, amplitude: 27, datum: minRail, deckMin, deckMax,
      straightHalfLength: Math.max(-deckMin, deckMax) + 14, start: Math.min(deckMin - 42, -128), end: Math.max(deckMax + 42, 128) };
    const candidate = { ...frame, centre, kind: 'bridge', name: '河谷橋群', spans, river };
    // Cap the bends at the map edge while leaving a reach beyond each deck.
    for (const sign of [-1, 1]) {
      const side = sign < 0 ? 'start' : 'end', lastDeck = sign < 0 ? -deckMin : deckMax;
      const goal = Math.max(lastDeck + 56, 172);
      let extent = lastDeck + 35;
      for (; extent < goal; extent += 6) {
        const p = riverPoint(candidate, extent * sign);
        if (Math.abs(p.x) > route.squareSize - 24 || Math.abs(p.z) > halfDepth - 24) break;
      }
      river[side] = extent * sign;
    }
    const avoidsOtherTrack = route.points.every((p, i) => {
      if (i % 12 || spans.some(span => route.distances[i] >= span.start && route.distances[i] <= span.end)) return true;
      const q = bridgeCoordinates(frame, p.x, p.z);
      if (q.along < river.start - 16 || q.along > river.end + 16) return true;
      const profile = riverProfile(candidate, q.along);
      return Math.abs(q.across - profile.centre) > profile.halfWidth + 25;
    });
    if (!avoidsOtherTrack) continue;
    bridge = candidate;
    break;
  }

  let tunnel = null, best = -Infinity;
  const approachLength = 26;
  const lastPhase = route.exchangePhases?.[0] ?? 1;
  for (const lane of turnIds) for (let i = 0; i < 39; i++) {
    const u = 0.10 + i * 0.015, centre = distanceAtPhase(lane, u), start = centre - 40, end = centre + 40;
    if (u > lastPhase - 0.035 || end + approachLength + 10 >= distanceAtPhase(lane, lastPhase)
      || stationClearance(centre, allPlatforms, route.length) < 115) continue;
    let available = 35;
    for (let s = start - approachLength - 6; s <= end + approachLength + 6; s += 5) {
      const p = sample(lane, s);
      if (bridge) {
        const q = bridgeCoordinates(bridge, p.x, p.z);
        if (q.along > bridge.river.start - 26 && q.along < bridge.river.end + 26
          && Math.abs(q.across - riverBend(q.along, bridge)) < 59) { available = 0; break; }
      }
      for (const other of turnIds) {
        if (other !== lane) available = Math.min(available, route.nearestOnTurn(other, p.x, p.z, 46).distance - 7);
      }
    }
    if (available < 12) continue;
    let moduleDeviation = 0;
    for (let s = start; s < end; s += 4) {
      const a = sample(lane, s), b = sample(lane, s + 4), m = sample(lane, s + 2);
      moduleDeviation = Math.max(moduleDeviation, Math.hypot(m.x - (a.x + b.x) / 2, m.y - (a.y + b.y) / 2, m.z - (a.z + b.z) / 2));
    }
    const score = available - moduleDeviation * 70 - Math.abs(u - 0.59) * 19;
    if (score <= best || moduleDeviation > 0.08) continue;
    best = score;
    tunnel = { kind: 'tunnel', name: '山脈隧道', centre, start, end, length: 80, halfWidth: Math.min(25, available),
      hillHeight: Math.min(14, available * 0.68), approachLength, moduleDeviation, turnIndex: lane, ...sample(lane, centre) };
  }
  return { bridge, tunnel };
}

export function routeStructures(features) {
  const bridge = features?.bridge;
  return [...(bridge?.spans ?? (bridge ? [bridge] : [])), ...[features?.tunnel, features?.overpass].filter(Boolean), ...(features?.underpasses || [])];
}

export function featureAt(features, distance, routeLength, padding = 0) {
  const s = wrap(distance, routeLength);
  return routeStructures(features).find(f => s >= f.start - padding && s <= f.end + padding) || null;
}
export function bridgeCoordinates(bridge, x, z) {
  const dx = x - bridge.x, dz = z - bridge.z;
  return { across: dx * bridge.tx + dz * bridge.tz, along: dx * bridge.nx + dz * bridge.nz };
}
export function riverBend(along, bridge) {
  const phase = bridge?.river?.phase || 0, amplitude = bridge?.river?.amplitude || 32;
  const straight = bridge?.river?.straightHalfLength ?? 22;
  // Keep the bridge crossing centred, then open into clearly visible S bends.
  const bend = Math.sin(along / 92 + phase) - Math.sin(phase) + 0.25 * (Math.sin(along / 41 + phase * 0.7) - Math.sin(phase * 0.7));
  return amplitude * bend * smoothstep(straight, straight + 63, Math.abs(along));
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
  return { along, centre: riverBend(along, bridge), halfWidth, slope, fade, waterY: (river.datum ?? bridge.y) - 6.54 + along * 0.004 };
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
  const halfSpan = bridge.spans ? CIRCUIT_BRIDGE_HALF_SPAN : bridge.length / 2;
  const alongDeck = bridge.spans
    ? smoothstep(river.deckMin - 10, river.deckMin - 3, local.along) * (1 - smoothstep(river.deckMax + 3, river.deckMax + 10, local.along))
    : 1 - smoothstep(4, 20, Math.abs(local.along));
  const underDeck = (1 - smoothstep(halfSpan - 4, halfSpan + 2, Math.abs(local.across))) * alongDeck;
  return Math.min(height, normalHeight - 1.4 * underDeck);
}
