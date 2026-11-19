import { clamp, lerp, MAX_GRADE, MIN_VERTICAL_RADIUS, routeFromPolyline, seedNumber } from './core.js?v=13.0.0';

export const STRAIGHT_LENGTHS = [3, 4, 5, 6, 7, 8, 9, 10];
const LANE_GAP = 24;
const HALF_DEPTH = 580;
const SAMPLES = 4096;
const BUMP_SECTIONS = [[0.06, 0.54], [0.54, 0.94]];

function bump(phase, [start, end]) {
  if (phase <= start || phase >= end) return 0;
  return Math.sin(Math.PI * (phase - start) / (end - start)) ** 4;
}

function maximumBump(segmentMetres) {
  const grade = MAX_GRADE * segmentMetres / (3 * Math.sqrt(3) * Math.PI / 4);
  const curvature = segmentMetres ** 2 / (MIN_VERTICAL_RADIUS * 4 * Math.PI ** 2);
  return 0.98 * Math.min(grade, curvature);
}

export function createStraightRoute(length, seed, options = {}) {
  if (!STRAIGHT_LENGTHS.includes(length / 1000)) throw new Error('直線賽道每條長度須為 3～10 公里，並以整公里為單位。');
  const limit = options.elevationLimit ?? 0;
  if (!Number.isFinite(limit) || limit < 0 || limit > 500) throw new Error('軌道起伏上限必須為 0～500 公尺。');
  const feasible = BUMP_SECTIONS.map(([start, end]) => maximumBump(length * 0.99 * (end - start) / 2));
  const commonHeight = Math.min(limit * 0.75, feasible[0]);
  const laneHeight = Math.min(limit * 0.25, feasible[1], 4);
  const waves = Array.from({ length: SAMPLES + 1 }, (_, index) => {
    const leg = Math.min(1, Math.floor(index / (SAMPLES / 2)));
    const phase = index / (SAMPLES / 2) - leg;
    return { leg, common: commonHeight * bump(phase, BUMP_SECTIONS[0]),
      local: laneHeight * bump(phase, BUMP_SECTIONS[1]) };
  });
  const reference = waves.map(({ common, local }) => common + local);
  function arcLength(horizontalLength) {
    const dx = horizontalLength / SAMPLES;
    let total = 0;
    for (let i = 1; i <= SAMPLES; i++) total += Math.hypot(dx, reference[i] - reference[i - 1]);
    return total;
  }
  // The banks and crossings line up in world space. Each lane traverses the
  // same absolute gradients and arc length, with an opposite bump in a
  // different leg. The flat setting gives all three cars identical tracks.
  let low = length * 0.99, high = length;
  for (let i = 0; i < 33; i++) {
    const middle = (low + high) / 2;
    if (arcLength(middle) > length) high = middle; else low = middle;
  }
  const horizontalLength = limit ? (high + low) / 2 : length;
  const startX = -horizontalLength / 2, squareSize = horizontalLength / 2 + 225;
  const variation = [[1, -1], [1, 1], [-1, 1]], order = seedNumber(seed) % 3;
  const lanes = variation.map((_, laneIndex) => {
    const signs = variation[(laneIndex + order) % variation.length], z = (1 - laneIndex) * LANE_GAP;
    const points = waves.map((wave, i) => ({
      x: startX + horizontalLength * i / SAMPLES,
      y: laneHeight + wave.common + signs[wave.leg] * wave.local,
      z,
    }));
    const distances = new Float64Array(SAMPLES + 1);
    for (let i = 1; i <= SAMPLES; i++) distances[i] = distances[i - 1] + Math.hypot(
      horizontalLength / SAMPLES, points[i].y - points[i - 1].y,
    );
    const measuredLength = distances[SAMPLES];
    for (let i = 1; i < SAMPLES; i++) distances[i] *= length / measuredLength;
    distances[SAMPLES] = length;
    return routeFromPolyline(points, distances, length, squareSize, {
      range: Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y)), requested: limit,
    }, { closed: false });
  });
  function nearestOnTurn(lane, x, z, maxDistance = 100, out = {}) {
    const { points, distances } = lanes[lane];
    const longitudinal = clamp(x, startX, -startX);
    const position = (longitudinal - startX) / horizontalLength * SAMPLES;
    const i = Math.min(SAMPLES - 1, Math.floor(position)), f = position - i;
    const a = points[i], b = points[i + 1];
    const distance = Math.hypot(x - longitudinal, z - a.z);
    out.distance = Math.min(distance, maxDistance);
    const near = distance < maxDistance;
    out.y = near ? lerp(a.y, b.y, f) : undefined;
    out.distanceAlong = near ? lerp(distances[i], distances[i + 1], f) : undefined;
    out.grade = near ? (b.y - a.y) / (b.x - a.x) : 0;
    return out;
  }
  function nearestTo(x, z, maxDistance = 100, out = {}) {
    const lane = clamp(Math.round(1 - z / LANE_GAP), 0, lanes.length - 1);
    return nearestOnTurn(lane, x, z, maxDistance, out);
  }
  const maxHeight = laneHeight + Math.max(commonHeight, laneHeight);
  return { ...lanes[1], lanes, halfDepth: HALF_DEPTH, turns: 1, turnStarts: [0], crossings: [], overpass: null,
    nearestOnTurn, nearestTo, distanceTo: (x, z, maxDistance) => nearestTo(x, z, maxDistance).distance,
    elevation: { min: 0, max: maxHeight, range: maxHeight, requested: limit },
  };
}

export function straightStations(route, count) {
  return Array.from({ length: count }, (_, index) => {
    const distance = route.length * index / (count - 1);
    const name = index === 0 ? '起點站' : index === count - 1 ? '終點站' : '林野站';
    const passes = route.lanes.map((lane, turnIndex) => ({ index, name, distance, turnIndex, ...lane.sample(distance) }));
    return { ...passes.at(-1), passes };
  });
}
