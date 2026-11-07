// Seeded scene composition. This module uses metres and catalog metadata only;
// no renderer or Blender source files are needed to reproduce a population.
import { TAU, clamp, lerp, randomGenerator, wrap } from './core.js?v=5.0.0';
import { bridgeCoordinates, riverBend } from './route-features.js?v=5.0.0';

export const SCENERY_VERSION = '5.0.0';
export const DENSITY_OPTIONS = [1000, 2000, 3500, 5000, 8000, 10000, 12000, 16000, 20000, 30000, 50000];
const BUILDING_ROLES = ['home', 'shop', 'workshop', 'civic'];
const NATURAL_ROLES = ['tree', 'shrub', 'rock', 'deadwood', 'feature'];
const FREQUENCY_WEIGHT = { common: 2, uncommon: 1, rare: 0.35, landmark: 1 };
const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));
const gaussian = r => (r() + r() + r() + r() - 2) * 0.92;
const alongGap = (a, b, length) => Math.min(wrap(a - b, length), wrap(b - a, length));

function pick(items, random) {
  if (!items.length) return null;
  const total = items.reduce((sum, a) => sum + (FREQUENCY_WEIGHT[a.frequency] || 1), 0);
  let value = random() * total;
  for (const a of items) { value -= FREQUENCY_WEIGHT[a.frequency] || 1; if (value <= 0) return a; }
  return items.at(-1);
}

// Full footprints protect structures. Adjacent plant crowns may overlap,
// while their trunks and root patches retain separation at high densities.
class Occupancy {
  constructor() { this.cells = new Map(); this.maxRadius = 0; this.cellSize = 24; }
  free(p) {
    const n = Math.ceil((p.radius + this.maxRadius) / this.cellSize), x = Math.floor(p.x / this.cellSize), z = Math.floor(p.z / this.cellSize);
    for (let iz = z - n; iz <= z + n; iz++) for (let ix = x - n; ix <= x + n; ix++) {
      for (const other of this.cells.get(`${ix},${iz}`) || []) {
        const separation = p.strict || other.strict ? p.radius + other.radius + 0.7 : p.spacing + other.spacing;
        if ((p.x - other.x) ** 2 + (p.z - other.z) ** 2 < separation ** 2) return false;
      }
    }
    return true;
  }
  add(p) {
    const key = `${Math.floor(p.x / this.cellSize)},${Math.floor(p.z / this.cellSize)}`;
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(p); this.maxRadius = Math.max(this.maxRadius, p.radius);
  }
}

export function compatibleScenery(info, biome, context = 'wild', nearWater = false) {
  if (!info.compatibleBiomes?.includes(biome)) return false;
  if (/LeaningRiverTree|StiltRootTree|Cattail|RiverPebbles/.test(info.id) && !nearWater) return false;
  if (biome === 'Desert' && /DryReedTuft|ForkedDriftwood|DatePalm/.test(info.id) && !nearWater) return false;
  if (biome === 'Volcano' && /Common_/.test(info.id) && context === 'hot-rock') return false;
  return true;
}

export async function planScenery(world, onProgress = () => {}) {
  const { route, config, stations, features, lake } = world;
  const manifest = world.store.manifest, d = route.squareSize, goal = config.density;
  if (!Number.isSafeInteger(goal) || goal < 1) throw new Error('場景物件數必須是正整數。');
  const random = randomGenerator(`${config.seed}:composition-v5`);
  const natureRandom = randomGenerator(`${config.seed}:nature-v5`);
  const placements = [], pads = [], districts = [], farms = [], landmarks = [], clusters = [];
  const occupied = new Occupancy(), counts = new Map(), modelList = Object.values(manifest.models).filter(a => a.sceneRole && a.sceneRole !== 'fixed');
  const poolCache = new Map();
  const biomeAt = (x, z, r = random) => r() < world.mixAt(x, z) ? config.biomeB : config.biomeA;
  const waterAt = (x, z) => {
    if (lake && Math.abs(world.lakeRadiusAt(x, z) - lake.radius) < 42) return true;
    if (!features.bridge) return false;
    const b = bridgeCoordinates(features.bridge, x, z);
    return Math.abs(b.along) < 168 && Math.abs(b.across - riverBend(b.along)) < 42;
  };
  const pool = (biome, role, context = 'wild', wet = false) => {
    const key = `${biome}/${role}/${context}/${wet}`;
    if (!poolCache.has(key)) poolCache.set(key, modelList.filter(a => a.sceneRole === role && compatibleScenery(a, biome, context, wet)));
    return poolCache.get(key);
  };
  const scaleFor = (info, r = random) => {
    const range = info.placement?.recommendedUniformScaleRange || (BUILDING_ROLES.includes(info.sceneRole) ? [0.94, 1.06] : [0.85, 1.15]);
    return lerp(range[0], range[1], r());
  };
  const ground = (x, z) => world.heightAt(x, z);
  const footprintRelief = (x, z, radius) => {
    const heights = [ground(x, z), ground(x - radius, z), ground(x + radius, z), ground(x, z - radius), ground(x, z + radius)];
    return { y: heights[0], range: Math.max(...heights) - Math.min(...heights) };
  };
  function candidate(info, x, z, options = {}) {
    if (!info) return null;
    const scale = options.scale ?? scaleFor(info, options.random || random), radius = info.footprintRadius * scale;
    if (Math.abs(x) + radius > d - 10 || Math.abs(z) + radius > d / 2 - 10) return null;
    const clearance = Math.max(7 + radius, (info.minimumRailOffset || 0) * scale + 2);
    const nearest = route.nearestTo(x, z, Math.max(115, clearance + 1));
    if (nearest.distance < clearance) return null;
    if (stations.some(s => Math.hypot(x - s.x, z - s.z) < 23 + radius)) return null;
    if (!options.water && world.lakeRadiusAt(x, z) < (lake?.radius || 0) + radius + 3) return null;
    if (features.bridge) {
      const b = bridgeCoordinates(features.bridge, x, z);
      if (Math.abs(b.along) < 188 + radius && Math.abs(b.across - riverBend(b.along)) < 37 + radius) return null;
    }
    if (features.tunnel) {
      const t = features.tunnel, n = route.nearestTo(x, z, t.halfWidth + radius + 12);
      if (n.distanceAlong !== undefined && n.distanceAlong > t.start - radius - 12 && n.distanceAlong < t.end + radius + 12) return null;
    }
    const role = info.sceneRole, strict = BUILDING_ROLES.includes(role) || ['landmark', 'feature'].includes(role) || role.startsWith('prop-');
    const p = { id: info.id, role, x, z, scale, yaw: options.yaw ?? (options.random || random)() * TAU,
      biome: options.biome || biomeAt(x, z), district: options.district || 'wild', radius, strict,
      spacing: Math.max(0.24, radius * (role === 'shrub' || role === 'crop' ? 0.45 : 0.50)), along: options.along };
    if (!occupied.free(p)) return null;
    const sample = footprintRelief(x, z, Math.min(radius, 18));
    // A natural slope may support a tree, but it must not leave rigid footings,
    // long logs, level lava or ice structures hanging above the ground.
    const flat = strict || role === 'deadwood';
    const limit = role === 'feature' || role === 'landmark' ? Math.max(2.5, radius * 0.45)
      : BUILDING_ROLES.includes(role) ? Math.max(1.6, radius * 0.30)
      : flat ? Math.max(0.22, radius * 0.10) : Math.max(1.2, radius * 0.7);
    if (sample.range > limit) return null;
    p.y = sample.y - (info.bounds?.min[1] > 0 ? info.bounds.min[1] * scale : 0) - 0.025;
    if (options.water) p.y = lake.level - (info.placement.surfaceDatumLocalY || 0) * scale;
    if (!options.water && (BUILDING_ROLES.includes(role) || role === 'landmark' || role === 'feature')) {
      // These are earthworks in the terrain itself, never a model display slab.
      const inner = radius + 6, outer = inner + Math.max(7, radius * 0.35);
      // The entire blending ring must also stay out of the railway earthwork.
      if (nearest.distance < outer + 21) return null;
      const level = options.groundLevel ?? sample.y - 0.025;
      if (Math.abs(level - sample.y) > 2.6) return null;
      // Different earthwork levels must not have overlapping flat interiors.
      // Plots along the same village lane deliberately share one level.
      if (pads.some(p => Math.abs(level - p.y) > 0.001 && Math.hypot(x - p.x, z - p.z) < inner + p.inner + 1)) return null;
      pads.push({ x, z, y: level, inner, outer });
      p.pad = pads.length - 1;
    }
    return p;
  }
  function commit(p) {
    if (!p || placements.length >= goal) return false;
    placements.push(p); occupied.add(p); counts.set(p.id, (counts.get(p.id) || 0) + 1); return true;
  }
  function chooseUnique(items, used, max = Infinity) {
    return pick(items.filter(a => !used.has(a.id) && (counts.get(a.id) || 0) < Math.min(max, a.sceneRole === 'civic' ? 1 : Infinity)), random);
  }

  // Landmarks are a global pool: two to four distinct silhouettes, independent
  // of stress density. Both along-track and straight-line spacing are enforced.
  const landmarkTarget = clamp(Math.round(route.length / 3500), 2, 4), phase = random() * 0.12;
  const landmarkIds = new Set();
  for (let slot = 0; slot < landmarkTarget; slot++) {
    for (let attempt = 0; attempt < 90; attempt++) {
      const s = wrap((slot / landmarkTarget + 0.12 + phase) * route.length + gaussian(random) * 120, route.length), a = route.sample(s);
      const offset = (random() < 0.5 ? -1 : 1) * (62 + random() * 95), x = a.x + a.nx * offset, z = a.z + a.nz * offset;
      const biome = biomeAt(x, z), info = chooseUnique(pool(biome, 'landmark'), landmarkIds);
      if (!info) continue;
      const nearest = route.nearestTo(x, z, 220);
      if (nearest.distance < 50 || nearest.distance > 180 || nearest.distanceAlong === undefined) continue;
      if (landmarks.some(l => Math.hypot(l.x - x, l.z - z) < 350 || alongGap(l.along, nearest.distanceAlong, route.length) < 800)) continue;
      const p = candidate(info, x, z, { biome, along: nearest.distanceAlong, district: 'landmark', scale: scaleFor(info), yaw: a.yaw + Math.PI / 2 });
      if (commit(p)) { landmarks.push(p); landmarkIds.add(info.id); break; }
    }
  }

  // Preserve each region's characteristic silhouettes without filling every
  // kilometre with the same mountain, crater or ice arch.
  const showcase = {
    Forest: ['Plant_Feature_Forest_ButtressTree_001', 'Plant_Feature_Forest_BambooGrove_001'],
    Hills: ['Environment_Feature_Hills_HoodooCluster_001', 'Environment_Feature_Hills_KarstPinnacles_001'],
    Snow: ['Environment_Feature_Snow_IceArch_001', 'Plant_Feature_Snow_BentSnowPine_001'],
    Volcano: ['Environment_Volcano_Cone16m_001', 'Environment_Feature_Volcano_RopedLava_001', 'Environment_Feature_Volcano_BrokenLavaShell_001'],
    Desert: ['Environment_Feature_Desert_YardangFins_001', 'Plant_Feature_Desert_OcotilloFan_001'],
    Rural: ['Plant_Feature_Rural_FloweringCherry_001', 'Environment_Feature_Rural_WisteriaPergola_001'],
    Pastoral: ['Plant_Feature_Rural_FloweringCherry_001'], Lakeside: []
  };
  for (const biome of [config.biomeA, config.biomeB]) for (const id of showcase[biome] || []) {
    const info = manifest.models[id]; if (!info) continue;
    for (let attempt = 0; attempt < 200; attempt++) {
      const along = random() * route.length, a = route.sample(along), offset = (random() < 0.5 ? -1 : 1) * (65 + random() * 100);
      const x = a.x + a.nx * offset, z = a.z + a.nz * offset;
      if (biomeAt(x, z) !== biome) continue;
      const p = candidate(info, x, z, { biome, along, district: 'regional-feature' });
      if (commit(p)) break;
    }
  }

  // Station hamlets plus a few smaller settlements create destinations between
  // open stretches. Buildings face a local lane, with varied roofs and uses.
  const anchors = stations.map(s => ({ along: s.distance, station: true }));
  for (let i = 0; i < Math.round(route.length / 2600); i++) {
    const along = wrap((i + 0.56) / Math.round(route.length / 2600) * route.length, route.length);
    if (stations.every(s => alongGap(s.distance, along, route.length) > 450)) anchors.push({ along, station: false });
  }
  for (const anchor of anchors) {
    const a = route.sample(anchor.along), side = anchor.station ? 1 : (random() < 0.5 ? -1 : 1);
    const offset = anchor.station ? 70 : 70 + random() * 30;
    const cx = a.x + a.nx * offset * side, cz = a.z + a.nz * offset * side, biome = biomeAt(cx, cz);
    const remote = ['Snow', 'Volcano', 'Desert'].includes(biome), used = new Set();
    const district = { id: `settlement-${districts.length}`, x: cx, z: cz, yaw: a.yaw, biome, along: anchor.along, groundY: ground(cx, cz) - 0.025, station: anchor.station, buildings: [], laneHalfLength: 42 };
    const target = remote ? 2 + Math.floor(random() * 2) : (anchor.station ? 7 : 4) + Math.floor(random() * 3);
    for (let slot = 0; slot < target; slot++) {
      const role = slot === 0 && anchor.station ? 'shop' : slot === 1 ? 'workshop' : slot === 2 && anchor.station ? 'civic' : 'home';
      let choices = pool(biome, role, 'settlement');
      if (!choices.length) choices = BUILDING_ROLES.flatMap(r => pool(biome, r, 'settlement'));
      const info = chooseUnique(choices, used, role === 'civic' ? 1 : 3);
      if (!info) continue;
      for (let trial = 0; trial < 16; trial++) {
        const laneSide = slot % 2 ? 1 : -1, along = -28 + Math.floor(slot / 2) * 19 + gaussian(random) * 4;
        const width = 10 + info.footprintRadius + random() * 3;
        const x = cx + a.tx * along + a.nx * laneSide * width, z = cz + a.tz * along + a.nz * laneSide * width;
        const p = candidate(info, x, z, { biome, district: district.id, along: anchor.along, groundLevel: district.groundY, yaw: a.yaw + (laneSide === 1 ? -Math.PI / 2 : Math.PI / 2) + gaussian(random) * 0.025 });
        if (commit(p)) { used.add(info.id); district.buildings.push(p); break; }
      }
    }
    if (district.buildings.length) districts.push(district);
  }
  for (const district of districts) for (const house of district.buildings) {
    const used = new Set(), houseInfo = manifest.models[house.id], role = houseInfo.sceneRole;
    const propRole = role === 'workshop' ? 'prop-lineside' : 'prop-domestic';
    for (let i = 0; i < 2 + Math.floor(random() * 3); i++) {
      const info = chooseUnique(pool(house.biome, propRole, 'settlement'), used);
      if (!info) continue;
      for (let trial = 0; trial < 10; trial++) {
        const angle = house.yaw + (random() - 0.5) * Math.PI * 1.5, radius = house.radius + info.footprintRadius + 1.5 + random() * 3;
        const p = candidate(info, house.x + Math.sin(angle) * radius, house.z + Math.cos(angle) * radius, { biome: house.biome, district: district.id, yaw: house.yaw });
        if (commit(p)) { used.add(info.id); break; }
      }
    }
  }

  // Crops form readable rows in a small number of actual farm pockets. They
  // don't appear as random wheat clumps across every part of the map.
  for (let i = 0; i < Math.round(route.length / 1100); i++) {
    const s = wrap((i + 0.33) / Math.round(route.length / 1100) * route.length, route.length), a = route.sample(s);
    const offset = (random() < 0.5 ? -1 : 1) * (75 + random() * 50), x = a.x + a.nx * offset, z = a.z + a.nz * offset;
    const biome = biomeAt(x, z), crops = pool(biome, 'crop', 'farm'), info = pick(crops, random);
    if (!info || !['Rural', 'Pastoral', 'Hills'].includes(biome)) continue;
    const farm = { id: `farm-${farms.length}`, x, z, yaw: a.yaw, biome, halfWidth: 20, halfLength: 25, crop: info.id, plants: 0 };
    const sx = Math.max(3.6, info.dimensions[0] * 1.13), sz = Math.max(3.4, info.dimensions[2] * 1.16);
    for (let row = -3; row <= 3; row++) for (let col = -3; col <= 3; col++) {
      const u = col * sx, v = row * sz;
      if (Math.abs(u) > farm.halfWidth - 2 || Math.abs(v) > farm.halfLength - 2) continue;
      const p = candidate(info, x + a.nx * u + a.tx * v, z + a.nz * u + a.tz * v, { biome, district: farm.id, yaw: a.yaw, scale: 0.94 + random() * 0.1 });
      if (commit(p)) farm.plants++;
    }
    if (farm.plants < 8) continue;
    farms.push(farm);
    const used = new Set();
    for (let prop = 0; prop < 5; prop++) {
      const info = chooseUnique(pool(biome, 'prop-farm', 'farm'), used);
      if (!info) continue;
      const u = farm.halfWidth + 4, v = (prop - 2) * 6;
      const p = candidate(info, x + a.nx * u + a.tx * v, z + a.nz * u + a.tz * v, { biome, district: farm.id, yaw: a.yaw });
      if (commit(p)) used.add(info.id);
    }
  }
  if (lake) {
    const lotus = modelList.find(a => a.sceneRole === 'aquatic');
    if (lotus) for (let i = 0; i < 12; i++) {
      const angle = random() * TAU, r = lake.radius * (0.66 + random() * 0.14);
      commit(candidate(lotus, lake.x + Math.cos(angle) * r, lake.z + Math.sin(angle) * r * lake.depthScale,
        { biome: 'Lakeside', district: 'shore', water: true }));
    }
  }
  const compositionCount = placements.length;

  // Different stretches carry different dominant silhouettes. Spaces between
  // the pockets remain open, and distant scenery uses the same biome mixing.
  const clusterCount = Math.ceil(route.length / 145);
  for (let i = 0; i < clusterCount; i++) {
    const along = (i + natureRandom() * 0.55) / clusterCount * route.length, a = route.sample(along);
    const side = natureRandom() < 0.5 ? -1 : 1, offset = side * (30 + natureRandom() ** 1.3 * 160);
    const x = a.x + a.nx * offset, z = a.z + a.nz * offset, biome = biomeAt(x, z, natureRandom);
    const wet = waterAt(x, z), themes = biome === 'Forest' ? ['woodland', 'woodland', 'meadow', 'rocky'] : ['woodland', 'meadow', 'rocky', 'meadow'];
    const theme = ['Desert', 'Snow', 'Volcano'].includes(biome) ? 'rocky' : themes[Math.floor(natureRandom() * themes.length)];
    const palette = {};
    for (const role of NATURAL_ROLES) {
      const choices = [...pool(biome, role, 'wild', wet)], selected = [];
      for (let n = 0; n < (role === 'tree' || role === 'shrub' ? 3 : 2); n++) {
        const info = pick(choices, natureRandom); if (!info) break;
        selected.push(info); choices.splice(choices.indexOf(info), 1);
      }
      palette[role] = selected;
    }
    clusters.push({ x, z, along, biome, theme, palette, width: 14 + natureRandom() * 28, recent: [] });
  }
  const weights = { woodland: [['tree', 0.60], ['shrub', 0.25], ['rock', 0.09], ['deadwood', 0.04], ['feature', 0.02]],
    meadow: [['shrub', 0.62], ['rock', 0.20], ['tree', 0.13], ['deadwood', 0.03], ['feature', 0.02]],
    rocky: [['rock', 0.66], ['shrub', 0.17], ['tree', 0.10], ['deadwood', 0.035], ['feature', 0.035]] };
  let attempts = 0;
  while (placements.length < goal && attempts++ < goal * 45) {
    const cluster = clusters[Math.floor(natureRandom() * clusters.length)];
    let x, z;
    const location = natureRandom();
    if (location < 0.68) {
      x = cluster.x + gaussian(natureRandom) * cluster.width; z = cluster.z + gaussian(natureRandom) * cluster.width;
    } else if (location < 0.84) {
      const a = route.sample(natureRandom() * route.length), offset = (natureRandom() < 0.5 ? -1 : 1) * (12 + natureRandom() * 36);
      x = a.x + a.nx * offset; z = a.z + a.nz * offset;
    } else { x = (natureRandom() * 2 - 1) * (d - 22); z = (natureRandom() - 0.5) * (d - 44); }
    const biome = biomeAt(x, z, natureRandom), wet = waterAt(x, z), roll = natureRandom();
    let role = 'rock', sum = 0;
    for (const [r, w] of weights[cluster.theme]) { sum += w; if (roll < sum) { role = r; break; } }
    let choices = location < 0.68 && biome === cluster.biome ? cluster.palette[role] : pool(biome, role, 'wild', wet);
    choices = choices.filter(a => compatibleScenery(a, biome, 'wild', wet) && !cluster.recent.includes(a.id));
    if (!choices.length) choices = pool(biome, role, 'wild', wet);
    if (!choices.length) choices = pool(biome, 'rock', 'wild', wet);
    const info = pick(choices, natureRandom); if (!info) continue;
    // Terrain masses and striking arches are punctuation, not stress-test fill.
    const cap = info.sceneRole === 'feature' ? (info.frequency === 'rare' ? 3 : 6) : info.frequency === 'rare' ? 12 : Infinity;
    if ((counts.get(info.id) || 0) >= cap) continue;
    const p = candidate(info, x, z, { biome, district: `nature-${clusters.indexOf(cluster)}`, random: natureRandom });
    if (commit(p)) {
      cluster.recent.push(info.id); if (cluster.recent.length > 2) cluster.recent.shift();
      if (placements.length % 1500 === 0) { onProgress(placements.length / goal); await yieldFrame(); }
    }
  }
  if (placements.length !== goal) throw new Error(`無法在保持軌道淨空的情況下放入 ${goal.toLocaleString()} 個物件；請嘗試其他種子或更長路線。`);
  const roleCounts = {}, biomeCounts = {};
  for (const p of placements) { roleCounts[p.role] = (roleCounts[p.role] || 0) + 1; biomeCounts[p.biome] = (biomeCounts[p.biome] || 0) + 1; }
  return { placements, pads, districts, farms, landmarks, clusters, version: SCENERY_VERSION,
    stats: { requested: goal, placed: placements.length, uniqueModels: counts.size, models: Object.fromEntries(counts), roles: roleCounts, biomes: biomeCounts,
      settlementCount: districts.length, buildingCount: placements.filter(p => BUILDING_ROLES.includes(p.role)).length,
      farmCount: farms.length, landmarkCount: landmarks.length, composedInstances: compositionCount, naturalInstances: goal - compositionCount } };
}

// Indexed flat earthwork pads. The feathered perimeter blends into the original
// land and every pad was checked against the protected rail/river corridors.
export function indexGroundPads(pads) {
  const index = new Map(), cell = 64;
  for (const p of pads) for (let z = Math.floor((p.z - p.outer) / cell); z <= Math.floor((p.z + p.outer) / cell); z++) {
    for (let x = Math.floor((p.x - p.outer) / cell); x <= Math.floor((p.x + p.outer) / cell); x++) {
      const key = `${x},${z}`; if (!index.has(key)) index.set(key, []); index.get(key).push(p);
    }
  }
  return index;
}

export function paddedHeight(index, x, z, original) {
  let sum = 0, weighted = 0, strength = 0;
  for (const p of index?.get(`${Math.floor(x / 64)},${Math.floor(z / 64)}`) || []) {
    const distance = Math.hypot(x - p.x, z - p.z);
    if (distance >= p.outer) continue;
    const t = clamp((distance - p.inner) / (p.outer - p.inner), 0, 1), w = 1 - t * t * (3 - 2 * t);
    // Strong interior dominance keeps footings flat; continuous weights avoid
    // a hard step where two feathered earthwork perimeters meet.
    const dominance = w ** 32;
    weighted += p.y * dominance; sum += dominance; strength = Math.max(strength, w);
  }
  return sum ? lerp(original, weighted / sum, strength) : original;
}
