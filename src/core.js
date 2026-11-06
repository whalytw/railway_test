// Pure, deterministic simulation. One world unit is one metre; time is seconds.
export const TAU = Math.PI * 2;
export const MAX_FORWARD = 120 / 3.6;
export const MAX_REVERSE = 30 / 3.6;
export const FIXED_STEP = 1 / 120;
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

// Build an arc-length table once. Track transforms, cart motion, minimap and
// scenery all read this SAME polyline. No separate smoothed driving spline.
export function createRoute(lengthMetres, seed = 1, samples = 8192) {
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
    points.push({ x, z });
    if (i) distances[i] = distances[i - 1] + Math.hypot(x - points[i - 1].x, z - points[i - 1].z);
  }
  points[samples] = { ...points[0] };
  distances[samples] = distances[samples - 1] + Math.hypot(points[samples].x - points[samples - 1].x, points[samples].z - points[samples - 1].z);
  const scale = lengthMetres / distances[samples];
  let maxX = 0, maxZ = 0;
  for (let i = 0; i <= samples; i++) {
    points[i].x *= scale; points[i].z *= scale; distances[i] *= scale;
    maxX = Math.max(maxX, Math.abs(points[i].x)); maxZ = Math.max(maxZ, Math.abs(points[i].z));
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
    const dx = b.x - a.x, dz = b.z - a.z, magnitude = Math.hypot(dx, dz);
    out.x = lerp(a.x, b.x, f); out.z = lerp(a.z, b.z, f);
    out.tx = dx / magnitude; out.tz = dz / magnitude;
    out.nx = out.tz; out.nz = -out.tx;
    out.yaw = Math.atan2(out.tx, out.tz);
    return out;
  }
  function distanceTo(x, z, limit = 100) {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell), radius = Math.ceil(limit / cell);
    let best = limit * limit;
    for (let a = -radius; a <= radius; a++) for (let b = -radius; b <= radius; b++) {
      const entries = spatial.get(`${cx + a},${cz + b}`);
      if (!entries) continue;
      for (const i of entries) {
        const p = points[i], q = points[Math.min(i + 4, samples)];
        const dx = q.x - p.x, dz = q.z - p.z;
        const t = clamp(((x - p.x) * dx + (z - p.z) * dz) / (dx * dx + dz * dz), 0, 1);
        best = Math.min(best, (x - p.x - t * dx) ** 2 + (z - p.z - t * dz) ** 2);
      }
    }
    return Math.sqrt(best);
  }
  return { length: lengthMetres, points, distances, samples, squareSize, sample, distanceTo };
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
    const deviation = Math.hypot(mid.x - (a.x + b.x) / 2, mid.z - (a.z + b.z) / 2);
    if (deviation > tolerance && depth < 5) { append(start, (start + end) / 2, depth + 1); append((start + end) / 2, end, depth + 1); return; }
    result.push({ start, end, x: a.x, z: a.z, yaw: Math.atan2(b.x - a.x, b.z - a.z), length: Math.hypot(b.x - a.x, b.z - a.z), deviation });
  }
  for (let i = 0; i < count; i++) append(i * step, (i + 1) * step);
  return result;
}

export function createPhysics() {
  return { speed: 0, acceleration: 0, distance: 0, odometer: 0, elapsed: 0, countdown: 3, throttle: 0.42 };
}

export function stepPhysics(state, dt, throttle = state.throttle) {
  if (!(dt > 0 && dt <= 0.1)) throw new Error('Simulation requires a small positive timestep.');
  const u = Math.abs(throttle) < 0.045 ? 0 : clamp(throttle, -1, 1);
  state.throttle = u;
  state.elapsed += dt;
  if (state.countdown > 0) {
    const before = state.countdown;
    state.countdown = Math.max(0, before - dt);
    if (before >= dt) return state;
    dt -= before;
  }
  const v = state.speed;
  const resistance = Math.abs(v) < 0.001 ? 0 : Math.sign(v) * (0.11 + 0.009 * Math.abs(v) + 0.00045 * v * v);
  let force = u > 0 ? (v < -0.05 ? 4.6 : 2.6) * u : u < 0 ? (v > 0.05 ? 4.6 : 1.8) * u : 0;
  const targetAcceleration = force - resistance;
  state.acceleration += clamp(targetAcceleration - state.acceleration, -6 * dt, 6 * dt);
  let next = v + state.acceleration * dt;
  if (!u && (v === 0 || Math.sign(next) !== Math.sign(v))) { next = 0; state.acceleration = 0; }
  next = clamp(next, -MAX_REVERSE, MAX_FORWARD);
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
