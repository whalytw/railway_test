// Seeded scene composition. This module uses metres and catalog metadata only;
// no renderer or Blender source files are needed to reproduce a population.
import { TAU, clamp, lerp, randomGenerator, wrap } from './core.js?v=8.0.0';
import { bridgeCoordinates, riverLocation } from './route-features.js?v=8.0.0';
import { inFarm } from './landscape-profile.js?v=8.0.0';

export const SCENERY_VERSION = '8.0.0';
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
  if(info.nearWaterOnly && !nearWater) return false;
  if (/LeaningRiverTree|StiltRootTree|Cattail|RiverPebbles/.test(info.id) && !nearWater) return false;
  if (biome === 'Desert' && /DryReedTuft|ForkedDriftwood|DatePalm/.test(info.id) && !nearWater) return false;
  if (biome === 'Volcano' && /Common_/.test(info.id) && context === 'hot-rock') return false;
  return true;
}

export async function planScenery(world, onProgress = () => {}) {
  const { route, config, stations, features, lake } = world;
  const manifest = world.store.manifest, d = route.squareSize, goal = config.density;
  if (!Number.isSafeInteger(goal) || goal < 1) throw new Error('場景物件數必須是正整數。');
  const random = randomGenerator(`${config.seed}:composition-v7`);
  const natureRandom = randomGenerator(`${config.seed}:nature-v5`);
  const placements = [], pads = [], districts = [], farms = [], landmarks = [], clusters = [];
  const occupied = new Occupancy(), counts = new Map(), modelList = Object.values(manifest.models).filter(a => a.sceneRole && a.sceneRole !== 'fixed');
  const poolCache = new Map();
  const activeBiomes = world.activeBiomes || [...new Set([config.biomeA,config.biomeB])];
  const biomeAt = (x, z, r = random) => world.chooseBiomeAt ? world.chooseBiomeAt(x,z,r) : r() < world.mixAt(x,z) ? config.biomeB : config.biomeA;
  const waterAt = (x, z) => {
    if (lake && Math.abs(world.lakeRadiusAt(x, z) - lake.radius) < 42) return true;
    if (!features.bridge) return false;
    const b = bridgeCoordinates(features.bridge, x, z), river = features.bridge.river;
    if (b.along < river.start - 20 || b.along > river.end + 20 || Math.abs(b.across) > 160) return false;
    const p = riverLocation(features.bridge, x, z);
    return p.along > river.start && p.along < river.end && p.distance < p.halfWidth + 28;
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
      const b = bridgeCoordinates(features.bridge, x, z), river = features.bridge.river;
      if (b.along > river.start - radius - 40 && b.along < river.end + radius + 40 && Math.abs(b.across) < 160 + radius) {
        const p = riverLocation(features.bridge, x, z);
        if (p.distance < p.halfWidth + 25 + radius) return null;
      }
    }
    if (features.tunnel) {
      const t = features.tunnel, n = route.nearestTo(x, z, t.halfWidth + radius + 12);
      if (n.distanceAlong !== undefined && n.distanceAlong > t.start - t.approachLength - radius && n.distanceAlong < t.end + t.approachLength + radius) return null;
    }
    // A field is an actual reserved plot, not a few crop models sharing a
    // patch with subsequently scattered trees and rocks.
    if (farms.some(f => options.district !== f.id && inFarm(f, x, z, radius + 2))) return null;
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
  for (const biome of activeBiomes) for (const id of showcase[biome] || []) {
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

  // Prioritise two visible Pastoral plots, then alternate the remaining farm
  // regions. Every accepted plot has tilled soil, aligned crops and a margin
  // facing the railway, 18–40 m away instead of 75–125 m away.
  const farmBiomes = activeBiomes.filter(b => ['Pastoral', 'Rural', 'Hills'].includes(b));
  const farmTarget = farmBiomes.length ? clamp(Math.round(route.length / 1500), 3, 7) : 0;
  const cropIds = ['Plant_Pastoral_WheatCluster_001', 'Plant_Pastoral_CornCluster_001', 'Plant_Feature_Pastoral_Sunflowers_001', 'Plant_Feature_Pastoral_PumpkinVines_001', 'Plant_Feature_Pastoral_VineyardRow_001'];
  for (let slot = 0; slot < farmTarget; slot++) {
    const priority = farmBiomes.includes('Pastoral');
    const index = priority ? (slot - 2 + farmBiomes.indexOf('Pastoral') + 1 + farmBiomes.length) % farmBiomes.length : slot % farmBiomes.length;
    const biome = slot < 2 && priority ? 'Pastoral' : farmBiomes[index];
    const available = cropIds.filter(id => manifest.models[id]?.compatibleBiomes?.includes(biome));
    if (!available.length) continue;
    const info = manifest.models[available[slot % available.length]];
    for (let attempt = 0; attempt < 150; attempt++) {
      const along = wrap(145 + slot / farmTarget * route.length + attempt * route.length / 151, route.length), a = route.sample(along);
      const offset = (attempt % 2 ? -1 : 1) * (37 + attempt % 3 * 8), x = a.x + a.nx * offset, z = a.z + a.nz * offset;
      const weight = world.biomeWeight ? world.biomeWeight(biome,x,z) : config.biomeA === biome ? 1-world.mixAt(x,z) : world.mixAt(x,z);
      if (weight < 0.56 || farms.some(f => Math.hypot(f.x - x, f.z - z) < 110)) continue;
      const farm = { id: `farm-${farms.length}`, x, z, yaw: a.yaw, biome, along, halfWidth: 15.5 + slot % 2 * 2,
        halfLength: 22 + slot % 3 * 3, crop: info.id, plants: 0, rowCount: 8, soil: slot % 2 ? '#9f8764' : '#aa9066' };
      if (placements.some(p => inFarm(farm, p.x, p.z, p.radius + 3))) continue;
      const heights = [], corners = [];
      for (const u of [-farm.halfWidth - 2, 0, farm.halfWidth + 2]) for (const v of [-farm.halfLength - 2, 0, farm.halfLength + 2]) {
        const px = x + a.nx * u + a.tx * v, pz = z + a.nz * u + a.tz * v;
        corners.push({ x: px, z: pz }); heights.push(ground(px, pz));
      }
      if (Math.max(...heights) - Math.min(...heights) > 4.8 || corners.some(p => Math.abs(p.x) > d - 12 || Math.abs(p.z) > d / 2 - 12 || route.distanceTo(p.x, p.z, 30) < 11 || waterAt(p.x, p.z))) continue;
      const cropPlacements = [];
      farm.rowSpacing = (farm.halfWidth * 2 - 4.6) / (farm.rowCount - 1);
      farm.plantsPerRow = info.id.includes('Wheat') ? 17 : 9;
      for (let col = 0; col < farm.rowCount; col++) for (let row = 0; row < farm.plantsPerRow; row++) {
        const u = -farm.halfWidth + 2.3 + col * farm.rowSpacing, v = -farm.halfLength + 2.5 + row * (farm.halfLength * 2 - 5) / (farm.plantsPerRow - 1);
        const p = candidate(info, x + a.nx * u + a.tx * v, z + a.nz * u + a.tz * v,
          { biome, district: farm.id, along, yaw: a.yaw, scale: (info.id.includes('Wheat') ? 1.18 : 1.02) + random() * 0.08 });
        if (p) cropPlacements.push(p);
      }
      if (cropPlacements.length < 45) continue;
      farms.push(farm);
      for (const p of cropPlacements) if (commit(p)) farm.plants++;
      const used = new Set();
      for (let prop = 0; prop < 4; prop++) {
        const propInfo = prop === 0 ? manifest.models.Prop_Daily_Scarecrow_001 : chooseUnique(pool(biome, 'prop-farm', 'farm'), used);
        if (!propInfo?.compatibleBiomes?.includes(biome)) continue;
        const u = farm.halfWidth + 4, v = (prop - 1.5) * 8;
        const p = candidate(propInfo, x + a.nx * u + a.tx * v, z + a.nz * u + a.tz * v, { biome, district: farm.id, along, yaw: a.yaw });
        if (commit(p)) used.add(propInfo.id);
      }
      break;
    }
  }
  if (lake && lake.kind !== 'oasis') {
    const lotus = modelList.find(a => a.sceneRole === 'aquatic');
    if (lotus) for (let i = 0; i < 12; i++) {
      const angle = random() * TAU, r = lake.radius * (0.66 + random() * 0.14);
      commit(candidate(lotus, lake.x + Math.cos(angle) * r, lake.z + Math.sin(angle) * r * lake.depthScale,
        { biome: 'Lakeside', district: 'shore', water: true }));
    }
  }
  // Give each suitable newly imported silhouette an actual placement before
  // density fill. This fixed seeded pass is independent of the stress count.
  const imported = modelList.filter(info=>info.scenePack === 'Quaternius_UltimateStylizedNature_202205');
  const natureCoverage = { available:imported.length, eligible:0, placed:0, missing:[], incompatible:[] };
  for(const info of imported){
    const eligible=activeBiomes.filter(b=>info.compatibleBiomes.includes(b));
    if(!eligible.length){natureCoverage.incompatible.push(info.id);continue;}
    natureCoverage.eligible++; let done=false;
    for(let attempt=0;attempt<180&&!done;attempt++){
      const target=eligible[attempt%eligible.length];
      let x,z,along;
      if(info.nearWaterOnly && lake){const angle=(attempt*.61803398875%1)*TAU,r=lake.radius+10+Math.floor(attempt/18)*2;x=lake.x+Math.cos(angle)*r;z=lake.z+Math.sin(angle)*r*lake.depthScale;along=route.nearestTo(x,z,250).distanceAlong;}
      else{along=random()*route.length;const p=route.sample(along),offset=(attempt%2?-1:1)*(18+random()*115);x=p.x+p.nx*offset;z=p.z+p.nz*offset;}
      const wet=waterAt(x,z),biome=biomeAt(x,z);
      if(!eligible.includes(biome)||!compatibleScenery(info,biome,'wild',wet))continue;
      const p=candidate(info,x,z,{biome,along,district:'nature-v8-showcase'});
      if(commit(p)){natureCoverage.placed++;done=true;}
    }
    if(!done)natureCoverage.missing.push(info.id);
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
      naturePack: { ...natureCoverage, modelCounts: Object.fromEntries(imported.filter(info=>counts.has(info.id)).map(info=>[info.id,counts.get(info.id)])) },
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
