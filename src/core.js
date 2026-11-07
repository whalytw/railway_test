// Pure, deterministic simulation. One world unit is one metre; time is seconds.
export const TAU = Math.PI * 2;
export const MAX_FORWARD = 120 / 3.6;
export const MAX_REVERSE = 30 / 3.6;
export const FIXED_STEP = 1 / 120;
export const MAX_GRADE = 0.025;
export const MIN_VERTICAL_RADIUS = 5000;
export const GRAVITY = 9.80665;
export const CART_MASS = 650;
export const ROLLING_COEFFICIENT = 0.003;
export const AIR_DRAG = 0.5 * 1.225 * 1.1; // kg/m, rho=1.225 and CdA=1.1 m²
export const LEVER_CURVE = 1.85;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrap = (v, length) => ((v % length) + length) % length;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function seedNumber(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function randomGenerator(seed) {
  let a = typeof seed === 'number' ? seed : seedNumber(seed);
  return () => {
    a |= 0; a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function resolveBiomes(a, b, choices, random = Math.random) {
  let first = a, second = b;
  if (first === 'random') {
    const available = choices.filter(x => x !== second);
    first = available[Math.floor(random() * available.length)];
  }
  if (second === 'random') {
    const available = choices.filter(x => x !== first);
    second = available[Math.floor(random() * available.length)];
  }
  if (!choices.includes(first) || !choices.includes(second) || first === second) {
    throw new Error('請為 A、B 區選擇兩種不同地形，或使用隨機。');
  }
  return [first, second];
}

export function createElevationProfile(length, limit = 0, stations = 3, count = 4096) {
  if (limit < 0 || limit > 500) throw new Error('軌道起伏上限必須為 0–500 公尺。');
  const slopes = new Float64Array(count + 1), heights = new Float64Array(count + 1), step = length / count;
  for (let i = 0; i <= count; i++) {
    const s = i * step, stationSpacing = length / stations;
    const phase = wrap(s + stationSpacing / 2, stationSpacing) - stationSpacing / 2;
    // Level 60 m station zones; long vertical transitions instead of sharp ramps.
    slopes[i] = Math.tanh(4 * Math.sin(TAU * i / count)) * smoothstep(30, 250, Math.abs(phase));
    if (i) heights[i] = heights[i - 1] + (slopes[i - 1] + slopes[i]) * 0.5 * step;
  }
  let min = Infinity, max = -Infinity, peakGrade = 0, peakCurvature = 0;
  for (let i = 0; i <= count; i++) {
    min = Math.min(min, heights[i]); max = Math.max(max, heights[i]); peakGrade = Math.max(peakGrade, Math.abs(slopes[i]));
    if (i) peakCurvature = Math.max(peakCurvature, Math.abs(slopes[i] - slopes[i - 1]) / step);
  }
  const feasibleScale = Math.min(MAX_GRADE * 0.992 / peakGrade, 0.992 / (MIN_VERTICAL_RADIUS * peakCurvature));
  const feasibleRange = (max - min) * feasibleScale;
  const scale = Math.min(feasibleScale, limit / (max - min));
  for (let i = 0; i <= count; i++) { heights[i] = (heights[i] - min) * scale; slopes[i] *= scale; }
  heights[count] = heights[0]; slopes[count] = slopes[0];
  function sample(s) {
    const f = wrap(s, length) / step, i = Math.min(count - 1, Math.floor(f)), t = f - i;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * heights[i] + (t3 - 2 * t2 + t) * step * slopes[i]
      + (-2 * t3 + 3 * t2) * heights[i + 1] + (t3 - t2) * step * slopes[i + 1];
  }
  return { heights, slopes, range: (max - min) * scale, requested: limit, feasibleRange, sample };
}

// One shared THREE-DIMENSIONAL arc-length table for visible rails and driving.
export function createRoute(lengthMetres, seed = 1, samples = 8192, options = {}) {
  if (!(lengthMetres >= 5000 && lengthMetres <= 15000)) throw new Error('軌道長度必須為 5–15 公里。');
  const random = randomGenerator(seed);
  const phase = random() * TAU;
  const phase2 = random() * TAU;
  const points = [];
  const distances = new Float64Array(samples + 1);
  for (let i = 0; i <= samples; i++) {
    const t = i / samples * TAU + Math.PI;
    const r = 1 + 0.092 * Math.sin(5 * t + phase) + 0.036 * Math.sin(9 * t + phase2);
    const x = 1.72 * Math.cos(t) * r;
    const z = 0.75 * Math.sin(t) * (1 + 0.19 * Math.sin(6 * t + phase2));
    points.push({ x, y: 0, z });
    if (i) distances[i] = distances[i - 1] + Math.hypot(x - points[i - 1].x, z - points[i - 1].z);
  }
  points[samples] = { ...points[0] };
  distances[samples] = distances[samples - 1] + Math.hypot(points[samples].x - points[samples - 1].x, points[samples].z - points[samples - 1].z);
  const scale = lengthMetres / distances[samples];
  let maxX = 0, maxZ = 0;
  for (let i = 0; i <= samples; i++) {
    points[i].x *= scale; points[i].z *= scale; distances[i] *= scale;
  }
  const elevation = createElevationProfile(lengthMetres, options.elevationLimit || 0, options.stations || 3);
  for (let i = 0; i <= samples; i++) points[i].y = elevation.sample(distances[i]);
  points[samples].y = points[0].y;
  // Elevation must not silently make a selected 5 km route longer than 5 km.
  let horizontalScale = 1;
  if (elevation.range > 0) for (let iteration = 0; iteration < 4; iteration++) {
    let total = 0, derivative = 0;
    for (let i = 1; i <= samples; i++) {
      const ds = distances[i] - distances[i - 1], dy = points[i].y - points[i - 1].y;
      const segment = Math.hypot(ds * horizontalScale, dy);
      total += segment; derivative += ds * ds * horizontalScale / segment;
    }
    horizontalScale -= (total - lengthMetres) / derivative;
  }
  let maxGrade = 0, minHeight = Infinity, maxHeight = -Infinity;
  for (let i = 0; i <= samples; i++) {
    points[i].x *= horizontalScale; points[i].z *= horizontalScale;
    maxX = Math.max(maxX, Math.abs(points[i].x)); maxZ = Math.max(maxZ, Math.abs(points[i].z));
    minHeight = Math.min(minHeight, points[i].y); maxHeight = Math.max(maxHeight, points[i].y);
    if (i) {
      const a = points[i - 1], b = points[i], dh = Math.hypot(b.x - a.x, b.z - a.z), dy = b.y - a.y;
      distances[i] = distances[i - 1] + Math.hypot(dh, dy); maxGrade = Math.max(maxGrade, Math.abs(dy / dh));
    } else distances[0] = 0;
  }
  // Map is 2D × D: two adjoining, equal D × D biome squares.
  const squareSize = Math.max(maxX + 140, maxZ * 2 + 180);
  const spatial = new Map(), cell = 64;
  // Index segments, not just vertices, so distance queries remain accurate.
  for (let i = 0; i < samples; i += 4) {
    const p = points[i];
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
    if (!spatial.has(key)) spatial.set(key, []);
    spatial.get(key).push(i);
  }
  function sample(distance, out = {}) {
    const d = wrap(distance, lengthMetres);
    let lo = 0, hi = samples;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (distances[mid] <= d) lo = mid; else hi = mid; }
    const a = points[lo], b = points[lo + 1];
    const f = (d - distances[lo]) / (distances[lo + 1] - distances[lo]);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, magnitude = Math.hypot(dx, dz), distance3 = Math.hypot(magnitude, dy);
    out.x = lerp(a.x, b.x, f); out.y = lerp(a.y, b.y, f); out.z = lerp(a.z, b.z, f);
    out.tx = dx / magnitude; out.tz = dz / magnitude;
    out.ty = dy / distance3; out.tx3 = dx / distance3; out.tz3 = dz / distance3;
    out.grade = dy / magnitude; out.pitch = -Math.atan2(dy, magnitude);
    out.upX = -out.tx * out.ty; out.upY = magnitude / distance3; out.upZ = -out.tz * out.ty;
    out.nx = out.tz; out.nz = -out.tx;
    out.yaw = Math.atan2(out.tx, out.tz);
    return out;
  }
  function nearestTo(x, z, limit = 100, out = {}) {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell), radius = Math.ceil(limit / cell);
    let best = limit * limit;
    out.y = undefined; out.grade = 0; out.distanceAlong = undefined;
    for (let a = -radius; a <= radius; a++) for (let b = -radius; b <= radius; b++) {
      const entries = spatial.get(`${cx + a},${cz + b}`);
      if (!entries) continue;
      for (const i of entries) {
        const p = points[i], q = points[Math.min(i + 4, samples)];
        const dx = q.x - p.x, dz = q.z - p.z;
        const t = clamp(((x - p.x) * dx + (z - p.z) * dz) / (dx * dx + dz * dz), 0, 1);
        const squared = (x - p.x - t * dx) ** 2 + (z - p.z - t * dz) ** 2;
        if (squared < best) { best = squared; out.y = lerp(p.y, q.y, t); out.grade = (q.y - p.y) / Math.hypot(dx, dz); out.distanceAlong = lerp(distances[i], distances[Math.min(i + 4, samples)], t); }
      }
    }
    out.distance = Math.sqrt(best); return out;
  }
  const distanceTo = (x, z, limit = 100) => nearestTo(x, z, limit).distance;
  return { length: lengthMetres, points, distances, samples, squareSize, sample, distanceTo, nearestTo,
    elevation: { requested: elevation.requested, range: maxHeight - minHeight, min: minHeight, max: maxHeight, maxGrade, feasibleRange: elevation.feasibleRange } };
}

export function biomeMix(x, z, squareSize) {
  // Odd boundary displacement has zero mean over the symmetric map extent.
  const boundary = Math.sin(z / squareSize * TAU) * squareSize * 0.026;
  return smoothstep(-squareSize * 0.09, squareSize * 0.09, x - boundary);
}

// Adaptive segment lengths keep the original GLB rails aligned even through
// the tightest procedural bends. Each transform uses the same driving path.
export function trackSegments(route, tolerance = 0.007) {
  const result = [], count = Math.ceil(route.length / 2), step = route.length / count;
  function append(start, end, depth = 0) {
    const a = route.sample(start), b = route.sample(end), mid = route.sample((start + end) / 2);
    const deviation = Math.hypot(mid.x - (a.x + b.x) / 2, mid.y - (a.y + b.y) / 2, mid.z - (a.z + b.z) / 2);
    if (deviation > tolerance && depth < 5) { append(start, (start + end) / 2, depth + 1); append((start + end) / 2, end, depth + 1); return; }
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    result.push({ start, end, x: a.x, y: a.y, z: a.z, yaw: Math.atan2(dx, dz), pitch: -Math.atan2(dy, Math.hypot(dx, dz)), length: Math.hypot(dx, dy, dz), deviation });
  }
  for (let i = 0; i < count; i++) append(i * step, (i + 1) * step);
  return result;
}

export function createPhysics() {
  return { speed: 0, acceleration: 0, driveAcceleration: 0, distance: 0, odometer: 0, elapsed: 0, countdown: 3, throttle: 0.42, grade: 0, governor: false };
}

export const flatResistanceForce = speed => CART_MASS * ROLLING_COEFFICIENT * GRAVITY + AIR_DRAG * speed * speed;
export const flatPower = speed => flatResistanceForce(Math.abs(speed)) * Math.abs(speed);
export const RATED_POWER = flatPower(MAX_FORWARD);
export function leverReference(throttle) {
  const u = clamp(throttle, -1, 1), magnitude = 1 - (1 - Math.abs(u)) ** LEVER_CURVE;
  const speed = Math.sign(u) * (u < 0 ? MAX_REVERSE : MAX_FORWARD) * magnitude;
  const power = flatPower(speed);
  return { speed, kmh: speed * 3.6, power, powerPercent: power / RATED_POWER * 100 };
}
export function leverForSpeed(kmh) {
  const max = kmh < 0 ? 30 : 120;
  return Math.sign(kmh) * (1 - (1 - clamp(Math.abs(kmh) / max, 0, 1)) ** (1 / LEVER_CURVE));
}

export function stepPhysics(state, dt, throttle = state.throttle, grade = 0) {
  if (!(dt > 0 && dt <= 0.1)) throw new Error('Simulation requires a small positive timestep.');
  const u = Math.abs(throttle) < 0.002 ? 0 : clamp(throttle, -1, 1);
  state.throttle = u;
  state.grade = grade;
  state.elapsed += dt;
  if (state.countdown > 0) {
    const before = state.countdown;
    state.countdown = Math.max(0, before - dt);
    if (before >= dt) return state;
    dt -= before;
  }
  const v = state.speed;
  const sinTheta = grade / Math.sqrt(1 + grade * grade), cosTheta = 1 / Math.sqrt(1 + grade * grade);
  const reference = leverReference(u), tractionLimit = 0.22 * GRAVITY * cosTheta;
  const reverseBraking = u * v < 0 && Math.abs(v) > 0.025;
  let drive = u ? Math.sign(u) * Math.min(tractionLimit, reference.power / (CART_MASS * Math.max(0.05, Math.abs(v)))) : 0;
  if (reverseBraking) drive = -Math.sign(v) * 0.25 * GRAVITY * cosTheta * Math.sqrt(Math.abs(u));
  state.driveAcceleration = u ? state.driveAcceleration + clamp(drive - state.driveAcceleration, -8 * dt, 8 * dt) : 0;
  const freeAcceleration = state.driveAcceleration - GRAVITY * sinTheta;
  const rolling = ROLLING_COEFFICIENT * GRAVITY * cosTheta;
  const direction = Math.abs(v) > 0.0001 ? Math.sign(v) : Math.sign(freeAcceleration);
  const resistance = direction * (rolling + AIR_DRAG / CART_MASS * v * v);
  let acceleration = freeAcceleration - resistance;
  let next = v + acceleration * dt;
  // Static rolling resistance can hold a stopped cart on a very gentle slope;
  // gravity on a steeper slope can restart it, including neutral rollback.
  if ((Math.abs(v) < 0.0001 || Math.sign(next) !== Math.sign(v)) && Math.abs(freeAcceleration) <= rolling) next = 0;
  const limited = clamp(next, -MAX_REVERSE, MAX_FORWARD);
  state.governor = next !== limited; next = limited;
  // The governor is a dissipative speed-limiting brake, not a hidden energy source.
  state.acceleration = (next - v) / dt;
  const delta = (v + next) * 0.5 * dt;
  state.distance += delta;
  state.odometer += Math.abs(delta);
  state.speed = next;
  return state;
}

export function stationsFor(route, count) {
  return Array.from({ length: count }, (_, i) => ({
    index: i, distance: i * route.length / count,
    name: ['始發站', '林野站', '遠山站'][i],
    ...route.sample(i * route.length / count)
  }));
}

export function nextStation(route, stations, signedDistance, direction = 1) {
  const d = wrap(signedDistance, route.length);
  return stations.map(s => ({ ...s, remaining: direction >= 0 ? wrap(s.distance - d, route.length) : wrap(d - s.distance, route.length) }))
    .sort((a, b) => a.remaining - b.remaining)[0];
}
