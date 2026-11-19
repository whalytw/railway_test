import { TAU, MAX_GRADE, MIN_VERTICAL_RADIUS, clamp, lerp, wrap, smoothstep, randomGenerator, createRoute, routeFromPolyline } from './core.js?v=13.0.0';

export const FLYOVER_RAIL_SEPARATION = 6.2;
const STATION_HALF_LENGTH = 32;
const OUTLINE_GRADE = MAX_GRADE * 0.986;
const OUTLINE_CURVATURE = 0.985 / MIN_VERTICAL_RADIUS;
const smoothQuintic = t => t ** 3 * (10 + t * (-15 + 6 * t));

export function turnIndexAt(route, distance) {
  const s = distance >= 0 && distance < route.length ? distance : wrap(distance, route.length);
  return (route.turnStarts || [0]).findLastIndex(start => start <= s);
}

// A level-to-level vertical curve: parabolic ends and a constant grade between
// them. Its longest usable ramp is selected before adding optional grades.
function riseBetween(s, start, end, height, ease) {
  if (s <= start) return 0;
  if (s >= end) return height;
  const length = end - start, run = s - start, grade = height / (length - ease);
  if (run < ease) return grade * run ** 2 / (2 * ease);
  if (run > length - ease) return height - grade * (length - run) ** 2 / (2 * ease);
  return grade * (run - ease / 2);
}

export function createCircuitRoute(length, seed, options = {}) {
  const turns = options.turns ?? 1, stationCount = options.stations ?? 3, requested = options.elevationLimit ?? 0;
  if (![1, 2, 3].includes(turns)) throw new Error('請選擇 1～3 圈軌道。');
  if (!(length >= 5000 && length <= 15000) || ![2, 3].includes(stationCount) || !(requested >= 0 && requested <= 500)) throw new Error('軌道路長、車站數或起伏上限超出設定範圍。');
  if (turns === 1) return { ...createRoute(length, seed, 8192, options), turns, turnStarts: [0], crossings: [], overpass: null };

  const random = randomGenerator(`${seed}:circuit`);
  const phaseA = random() * TAU, phaseB = random() * TAU, phaseC = random() * TAU;
  const exchangeCentre = 0.833 + (random() - 0.5) * 0.025;
  const exchangeWidth = (260 + random() * 38) / (length / turns);
  const exchangeStart = exchangeCentre - exchangeWidth / 2, exchangeEnd = exchangeCentre + exchangeWidth / 2;
  const hillPhase = stationCount === 3 ? 0.515 + random() * 0.047 : 0.623 + random() * 0.023;
  const hillGap = turns === 3 && random() < 0.5 ? 1 : 0;
  const stationPhases = stationCount === 3 ? [0, 1 / 3, 2 / 3] : [0, 0.5];

  const count = 3072, samples = count * turns;
  function basePosition(u) {
    const angle = u * TAU;
    const modulation = 1 + 0.038 * Math.sin(3 * angle + phaseA) + 0.023 * Math.sin(5 * angle + phaseB);
    return { x: -1.55 * Math.cos(angle) * modulation, z: -Math.sin(angle) * modulation };
  }
  let baseLength = 0, previous = basePosition(0);
  for (let i = 1; i <= count; i++) {
    const p = basePosition(i / count);
    baseLength += Math.hypot(p.x - previous.x, p.z - previous.z);
    previous = p;
  }
  const size = length / turns / baseLength;
  function laneOffset(lane, u) {
    const angle = TAU * u, gaps = [];
    for (let g = 0; g < turns - 1; g++) {
      const baseWidth = 30 + 7 * Math.sin(angle * (g + 2) + phaseB + g) + 6 * Math.cos(angle * 3 + phaseC + g * 2);
      const distanceToStation = Math.min(1 - u, ...stationPhases.map(v => Math.abs(u - v)));
      const width = baseWidth + Math.max(0, 29 - baseWidth) * (1 - smoothstep(0.018, 0.074, distanceToStation));
      const hill = g === hillGap ? 34 * (1 - smoothQuintic(clamp(Math.abs(u - hillPhase) / 0.124, 0, 1))) : 0;
      gaps.push(width + hill);
    }
    return gaps.reduce((sum, gap, i) => sum + (i < lane ? -0.5 : 0.5) * gap, 0);
  }
  function horizontal(lane, u) {
    const phase = u === 1 ? 0 : u, blend = smoothQuintic(clamp((u - exchangeStart) / (exchangeEnd - exchangeStart), 0, 1));
    const p = basePosition(phase);
    const offset = lerp(laneOffset(lane, phase), laneOffset((lane + 1) % turns, phase), blend);
    const scale = size + offset / Math.hypot(p.x, p.z);
    return { x: p.x * scale, y: 0, z: p.z * scale };
  }

  const points = Array.from({ length: samples + 1 }, (_, i) => horizontal(Math.min(turns - 1, Math.floor(i / count)), i === samples ? 1 : (i % count) / count));
  points[samples] = { ...points[0] };
  const flat = new Float64Array(samples + 1);
  for (let i = 1; i <= samples; i++) flat[i] = flat[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  const scale = length / flat[samples];
  for (let i = 0; i <= samples; i++) { points[i].x *= scale; points[i].z *= scale; flat[i] *= scale; }

  const nodeFor = (lane, u) => lane * count + u * count;
  function distanceAt(table, lane, u) {
    const f = nodeFor(lane, u), i = Math.floor(f);
    return lerp(table[i], table[Math.min(i + 1, samples)], f - i);
  }
  // Each pair crosses once. Since positions use the same polar angle, matching
  // their radii locates the crossing without searching unrelated track pieces.
  const exchanges = [];
  for (let lower = 0; lower < turns - 1; lower++) {
    let lo = exchangeStart, hi = exchangeEnd;
    for (let i = 0; i < 36; i++) {
      const u = (lo + hi) / 2, over = horizontal(turns - 1, u), under = horizontal(lower, u);
      if (Math.hypot(over.x, over.z) < Math.hypot(under.x, under.z)) lo = u; else hi = u;
    }
    exchanges.push({ u: (lo + hi) / 2, lower });
  }
  const firstExchange = Math.min(...exchanges.map(c => distanceAt(flat, turns - 1, c.u)));
  const lastExchange = Math.max(...exchanges.map(c => distanceAt(flat, turns - 1, c.u)));

  function rampsFor(lane, earliest, latest) {
    const sites = [...stationPhases, 1].map(u => distanceAt(flat, lane, u));
    return sites.slice(1).map((end, i) => ({
      start: Math.max(earliest, sites[i] + STATION_HALF_LENGTH),
      end: Math.min(latest, end - STATION_HALF_LENGTH)
    })).sort((a, b) => (b.end - b.start) - (a.end - a.start));
  }
  const rise = rampsFor(turns - 1, flat[(turns - 1) * count], firstExchange - 36)[0];
  const fall = rampsFor(0, 0, distanceAt(flat, 0, exchanges[0].u) - 40)[0];
  function easeFor(ramp) {
    const length = ramp.end - ramp.start;
    // The smaller root gives the shortest parabolic ends at the curvature cap.
    const discriminant = length ** 2 - 4 * FLYOVER_RAIL_SEPARATION / OUTLINE_CURVATURE;
    const minEase = (length - Math.sqrt(Math.max(0, discriminant))) / 2;
    const gradeEase = length - FLYOVER_RAIL_SEPARATION / OUTLINE_GRADE;
    if (discriminant < 0 || minEase > gradeEase + 0.01) throw new Error('這條路線的立體交會無法保持縱坡限制。');
    return Math.min(length / 2, minEase + 1);
  }
  const riseEase = easeFor(rise), fallEase = easeFor(fall);
  const required = flat.map(s => (s < flat[count] ? FLYOVER_RAIL_SEPARATION - riseBetween(s, fall.start, fall.end, FLYOVER_RAIL_SEPARATION, fallEase) : 0)
    + riseBetween(s, rise.start, rise.end, FLYOVER_RAIL_SEPARATION, riseEase));

  // Adjacent tracks share a broad height profile with a level stretch at every
  // station. Matching heights by phase keeps the crossing separation fixed.
  const phaseMarks = [...stationPhases, 1];
  const levelMarks = stationCount === 3 ? [0, 1, 0.44, 0] : [0, 1, 0];
  const shoulder = Math.min(0.079, 55 / (length / turns));
  const hills = flat.map((_, i) => {
    const u = (i % count) / count;
    const n = phaseMarks.findLastIndex(v => v <= u);
    const low = phaseMarks[n], high = phaseMarks[n + 1], pad = Math.min(shoulder, (high - low) * 0.32);
    return lerp(levelMarks[n], levelMarks[n + 1], smoothQuintic(clamp((u - low - pad) / (high - low - 2 * pad), 0, 1)));
  });
  let amplitude = 500;
  function constrain(base, unit, cap) {
    if (unit > 1e-10) amplitude = Math.min(amplitude, (cap - base) / unit);
    else if (unit < -1e-10) amplitude = Math.min(amplitude, (-cap - base) / unit);
  }
  let priorGrade = 0, priorUnit = 0, priorStep = 0;
  for (let i = 1; i <= samples; i++) {
    const step = flat[i] - flat[i - 1], grade = (required[i] - required[i - 1]) / step, unit = (hills[i] - hills[i - 1]) / step;
    constrain(grade, unit, MAX_GRADE * 0.994);
    if (i > 1) constrain(grade - priorGrade, unit - priorUnit, (step + priorStep) * 0.5 * 0.994 / MIN_VERTICAL_RADIUS);
    priorGrade = grade; priorUnit = unit; priorStep = step;
  }
  const feasibleAmplitude = Math.max(0, amplitude);
  function elevationRange(factor) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i <= samples; i++) {
      const y = required[i] + hills[i] * factor;
      min = Math.min(min, y); max = Math.max(max, y);
    }
    return { min, max, range: max - min };
  }
  const limit = Math.max(requested, FLYOVER_RAIL_SEPARATION);
  let lo = 0, hi = requested ? feasibleAmplitude : 0;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (elevationRange(mid).range <= limit) lo = mid; else hi = mid;
  }
  for (let i = 0; i <= samples; i++) points[i].y = required[i] + hills[i] * lo;

  // Scale horizontally to keep the requested length as true 3D arc length.
  let horizontalScale = 1;
  for (let iteration = 0; iteration < 3; iteration++) {
    let total = 0, derivative = 0;
    for (let i = 1; i <= samples; i++) {
      const dh = flat[i] - flat[i - 1], dy = points[i].y - points[i - 1].y;
      const segment = Math.hypot(dh * horizontalScale, dy);
      total += segment; derivative += dh * dh * horizontalScale / segment;
    }
    horizontalScale -= (total - length) / derivative;
  }
  const distances = new Float64Array(samples + 1);
  let maxGrade = 0, maxX = 0, maxZ = 0;
  for (let i = 0; i <= samples; i++) {
    points[i].x *= horizontalScale; points[i].z *= horizontalScale;
    maxX = Math.max(maxX, Math.abs(points[i].x)); maxZ = Math.max(maxZ, Math.abs(points[i].z));
    if (i) {
      const dh = (flat[i] - flat[i - 1]) * horizontalScale, dy = points[i].y - points[i - 1].y;
      distances[i] = distances[i - 1] + Math.hypot(dh, dy);
      maxGrade = Math.max(maxGrade, Math.abs(dy / dh));
    }
  }
  const squareSize = Math.max(maxX + 200, maxZ * 2 + 240);
  const elevation = { requested, ...elevationRange(lo), maxGrade, feasibleRange: elevationRange(feasibleAmplitude).range, crossingMinimum: FLYOVER_RAIL_SEPARATION };
  const route = routeFromPolyline(points, distances, length, squareSize, elevation);
  route.turns = turns;
  const lanes = Array.from({ length: turns }, (_, i) => i);
  route.turnStarts = lanes.map(lane => distanceAt(distances, lane, 0));
  route.turnPointCount = count;
  route.distanceAtPhase = (lane, u) => distanceAt(distances, lane, u);
  route.stationDistances = stationPhases.map(u => lanes.map(lane => route.distanceAtPhase(lane, u)));
  route.stationPhases = stationPhases;
  route.exchangePhases = [exchangeStart, exchangeEnd];
  route.crossings = exchanges.map(({ u, lower }) => {
    const upperDistance = route.distanceAtPhase(turns - 1, u), lowerDistance = route.distanceAtPhase(lower, u);
    const upper = route.sample(upperDistance), under = route.sample(lowerDistance);
    return { x: (upper.x + under.x) / 2, z: (upper.z + under.z) / 2, upperDistance, lowerDistance,
      upperY: upper.y, lowerY: under.y, railSeparation: upper.y - under.y, upperTurn: turns - 1, lowerTurn: lower };
  }).sort((a, b) => a.upperDistance - b.upperDistance);
  const upperTurn = turns - 1;
  function bridgeEdge(crossingDistance, direction) {
    for (let margin = 30; margin <= 146; margin += 4) {
      const s = crossingDistance + margin * direction, p = route.sample(s);
      if (lanes.slice(0, -1).every(turn => route.nearestTo(p.x, p.z, 17, {}, i => Math.floor(i / count) === turn).distance >= 16)) return s;
    }
    return crossingDistance + 146 * direction;
  }
  const start = bridgeEdge(route.crossings[0].upperDistance, -1), end = bridgeEdge(route.crossings.at(-1).upperDistance, 1);
  const centre = (start + end) / 2;
  route.overpass = { kind: 'overpass', name: '跨線高架橋', start, end, centre, length: end - start, ...route.sample(centre) };
  route.groundSegment = i => Math.floor(i / count) !== upperTurn || (distances[Math.min(samples, i + 4)] < start || distances[i] > end);
  route.nearestOnTurn = (lane, x, z, limit, out, ground = false) => route.nearestTo(x, z, limit, out,
    i => Math.floor(i / count) === lane && (!ground || route.groundSegment(i)));
  const hillA = route.sample(route.distanceAtPhase(hillGap, hillPhase)), hillB = route.sample(route.distanceAtPhase(hillGap + 1, hillPhase));
  route.tracksideHill = { x: (hillA.x + hillB.x) * 0.5, z: (hillA.z + hillB.z) * 0.5, tx: hillA.tx, tz: hillA.tz,
    halfWidth: Math.hypot(hillA.x - hillB.x, hillA.z - hillB.z) * 0.41, halfLength: 36 + random() * 18, height: 10 + random() * 8 };
  return route;
}
