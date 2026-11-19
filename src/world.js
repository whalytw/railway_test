import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { TAU, lerp, clamp, wrap, smoothstep, randomGenerator, stationsFor, biomeMix, trackSegments } from './core.js?v=13.0.0';
import { createCircuitRoute } from './circuit-route.js?v=13.0.0';
import { createStraightRoute, straightStations } from './straight-route.js?v=13.0.0';
import { sleeperLayout, sleeperFilter, planRouteFeatures, routeStructures, bridgeCoordinates, bridgeGroundHeight } from './route-features.js?v=13.0.0';
import { buildMountainBackdrop, buildVariedClouds, updateClouds, buildBridgeAndRiver, buildTunnel, buildGirderBridge } from './scenery.js?v=13.0.0';
import { fitGroundContact, prepareGroundedParts, groundBatchGeometry, renderedGroundHeight } from './grounding.js?v=13.0.0';
import { planScenery, indexGroundPads, paddedHeight } from './scenery-plan.js?v=13.0.0';
import { createBiomeLayout } from './biome-blend.js?v=13.0.0';
import { shadowProfile, keepSceneryShadow } from './shadow-profile.js?v=13.0.0';
import { createStandingDriver } from './drivers.js?v=13.0.0';
import { TURBO_ASSET_ID, TurboPair, createTurboResources } from './turbo-visual.js?v=13.0.0';
import { createGroundMaterial, grassHabitatAt, buildGrassCover, buildFarmland, GRASS_NEAR_DISTANCE, GRASS_DRAW_DISTANCE } from './ground-cover.js?v=13.0.0';
import { chooseFarGeometry, distanceToXZBounds } from './render-lod.js?v=13.0.0';
import { planSharedShadow, SHADOW_DEPTH } from './shared-shadow.js?v=13.0.0';

export const PALETTES = {
  Forest: { ground: '#829565', detail: '#62794d', sky: '#bed0ba', amplitude: 12 },
  Hills: { ground: '#a0ad78', detail: '#829260', sky: '#c8d4bb', amplitude: 43 },
  Pastoral: { ground: '#a5ae74', detail: '#879a60', sky: '#d6d9ba', amplitude: 9 },
  Desert: { ground: '#d6b584', detail: '#c39865', sky: '#e3d0af', amplitude: 21 },
  Rural: { ground: '#a9aa7c', detail: '#8b986e', sky: '#d1d5bb', amplitude: 10 },
  Lakeside: { ground: '#9baa83', detail: '#8e9c74', sky: '#bfd7d0', amplitude: 6 },
  Snow: { ground: '#e3e8db', detail: '#beced0', sky: '#cfdde0', amplitude: 17 },
  Volcano: { ground: '#777065', detail: '#5a5b55', sky: '#c3bcae', amplitude: 36 }
};

const q = new THREE.Quaternion(), axisY = new THREE.Vector3(0, 1, 0);
const position = new THREE.Vector3(), scaling = new THREE.Vector3();
const placementMatrix = new THREE.Matrix4(), combined = new THREE.Matrix4();
const rotationEuler = new THREE.Euler(0, 0, 0, 'YXZ'), upAxis = new THREE.Vector3(0, 1, 0);
const slopeNormal = new THREE.Vector3(), slopeQuaternion = new THREE.Quaternion();
const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));

export class AssetStore {
  constructor(manifest) {
    this.manifest = manifest; this.loader = new GLTFLoader(); this.cache = new Map(); this.pending = new Map();
    this.sharedTextures = new Map(); this.sharedMaterials = new Map();
    // ImageBitmapLoader can share decoded images, and the maps below also share
    // the GPU textures/materials across the 63 independently parsed glTF files.
    THREE.Cache.enabled = true;
  }
  shareMaterial(material, parser, assetURL) {
    for (const value of Object.values(material)) if (value?.isTexture) {
      const association = parser.associations.get(value), texture = parser.json.textures?.[association?.textures];
      const uri = parser.json.images?.[texture?.source]?.uri;
      if (!uri || !uri.includes('nature-v8/')) continue;
      const url = new URL(uri, new URL(assetURL, document.baseURI)).href;
      const key = JSON.stringify([url,value.colorSpace,value.flipY,value.wrapS,value.wrapT,value.magFilter,value.minFilter,value.channel,value.offset.toArray(),value.repeat.toArray(),value.rotation]);
      const existing = this.sharedTextures.get(key);
      if (existing) { if(existing!==value){for(const property of Object.keys(material)) if(material[property]===value)material[property]=existing;value.dispose();} }
      else this.sharedTextures.set(key,value);
    }
    const index=parser.associations.get(material)?.materials, definition=parser.json.materials?.[index];
    if(!definition || !assetURL.includes('Quaternius_'))return material;
    const maps=Object.entries(material).filter(([,v])=>v?.isTexture).map(([name,v])=>[name,v.uuid]);
    const key=JSON.stringify([definition,maps,material.vertexColors,material.flatShading,material.side,material.alphaTest,material.transparent]);
    const existing=this.sharedMaterials.get(key);
    if(existing){if(material!==existing)material.dispose();return existing;}
    this.sharedMaterials.set(key,material);return material;
  }
  async load(ids, onProgress = () => {}) {
    const unique = [...new Set(ids)].flatMap(id => this.manifest.models[id].lod ? [{ id, level: 0 }, { id, level: 1 }] : [{ id, level: 0 }]);
    let done = 0;
    // Bound concurrent image decoding on small integrated GPUs.
    const queue = [...unique];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const { id, level } = queue.shift(), key = level ? `${id}#lod1` : id;
        if (!this.cache.has(key)) {
          const info = this.manifest.models[id];
          const assetURL = level ? info.lod.url : info.derivation ? `${info.url}?revision=grounded-v4` : info.url;
          if (!this.pending.has(key)) this.pending.set(key, this.loader.loadAsync(assetURL).then(gltf => {
            const root = gltf.scene;
            root.updateMatrixWorld(true);
            const parts = [];
            root.traverse(node => {
              if (node.isMesh) {
                node.castShadow = false; node.receiveShadow = true;
                node.material = Array.isArray(node.material) ? node.material.map(m=>this.shareMaterial(m,gltf.parser,assetURL)) : this.shareMaterial(node.material,gltf.parser,assetURL);
                parts.push({ geometry: node.geometry, material: node.material, matrix: node.matrixWorld.clone() });
              }
            });
            const asset = { root, parts, bounds: new THREE.Box3().setFromObject(root), animations: gltf.animations };
            this.cache.set(key, asset); this.pending.delete(key);
            return asset;
          }).catch(error => { this.pending.delete(key); throw new Error(`模型讀取失敗：${id}。${error.message}`); }));
          await this.pending.get(key);
        }
        onProgress(++done / unique.length, id);
      }
    }));
  }
  get(id, level = 0) { const value = this.cache.get(level ? `${id}#lod1` : id); if (!value) throw new Error(`模型尚未載入：${id}`); return value; }
  dispose() {
    const geometries = new Set(), materials = new Set(), textures = new Set();
    for (const asset of this.cache.values()) for (const part of asset.parts) {
      geometries.add(part.geometry);
      for (const material of Array.isArray(part.material) ? part.material : [part.material]) {
        materials.add(material);
        for (const v of Object.values(material)) if (v?.isTexture) textures.add(v);
      }
    }
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); this.cache.clear();
    this.sharedTextures.clear(); this.sharedMaterials.clear(); THREE.Cache.clear();
  }
}

export class RailWorld {
  constructor(scene, store, config) {
    this.scene = scene; this.store = store; this.config = config;
    this.shadowProfile = shadowProfile(config);
    const createLayout = config.routeMode === 'straight' ? createStraightRoute : createCircuitRoute;
    this.route = createLayout(config.length * 1000, config.seed, { elevationLimit: config.elevationLimit, stations: config.stations, turns: config.turns });
    this.stations = this.route.lanes ? straightStations(this.route, config.stations) : stationsFor(this.route, config.stations);
    this.stationPasses = this.stations.flatMap(s => s.passes ?? [s]).sort((a, b) => a.distance - b.distance);
    this.features = config.features ? planRouteFeatures(this.route, this.stations, config.seed) : { bridge: null, tunnel: null };
    const { overpass, crossings } = this.route;
    if (overpass) {
      this.features.overpass = overpass;
      this.features.underpasses = crossings.map(crossing => {
        const centre = crossing.lowerDistance, lower = this.route.sample(centre), upper = this.route.sample(crossing.upperDistance);
        const sine = Math.abs(lower.tx * upper.tz - lower.tz * upper.tx);
        const margin = clamp(3.2 / Math.max(sine, 0.08) + 3, 9, 37);
        return { kind: 'underpass', name: '高架橋下方', start: centre - margin, end: centre + margin, centre, ...lower };
      });
      const steps = Math.ceil(overpass.length / 12);
      this.flyoverSamples = Array.from({ length: steps + 1 }, (_, i) => this.route.sample(lerp(overpass.start, overpass.end, i / steps)));
    }
    this.groundProximities = Array.from({ length: this.route.lanes?.length ?? this.route.turns }, () => ({}));
    this.structures = routeStructures(this.features);
    this.group = new THREE.Group(); scene.add(this.group);
    this.cullGroups = []; this.ownedGeometry = []; this.ownedMaterials = []; this.ownedTextures = [];
    this.instanceCount = 0; this.sceneryCount = 0; this.terrainChunks = 0;
    this.wheels = []; this.carts = []; this.waterMaterials = [];
    this.driver = null; this.driverRequest = 0; this.disposed = false;
    this.partsOverrides = new Map(); this.environmentElapsed = 0; this.lastSpeed = 0;
    this.groundParts = new Map(); this.terrainGrid = null;
    this.sceneryPlan = null; this.groundPadIndex = null;
    this.sleeperUniforms = { exposure: { value: 0 }, contrast: { value: 0 }, enabled: { value: config.sleeperFilter === false ? 0 : 1 } };
    this.biomeLayout = config.biomeMix ? createBiomeLayout(this.route, config.biomeMix, config.seed) : null;
    this.activeBiomes = this.biomeLayout ? this.biomeLayout.mix.map(row => row.biome) : [...new Set([config.biomeA, config.biomeB])];
    config.biomeA ||= this.activeBiomes[0]; config.biomeB ||= this.activeBiomes[1] || this.activeBiomes[0];
    this.paletteA = PALETTES[config.biomeA]; this.paletteB = PALETTES[config.biomeB];
    this.paletteMix = this.activeBiomes.map(id => ({ id, palette: PALETTES[id], ground: new THREE.Color(PALETTES[id].ground), detail: new THREE.Color(PALETTES[id].detail), sky: new THREE.Color(PALETTES[id].sky) }));
    this.amplitudes = Object.fromEntries(this.paletteMix.map(row=>[row.id,row.palette.amplitude]));
    this.biomeReport = this.biomeLayout?.report() || null;
    this.colorA = new THREE.Color(this.paletteA.ground); this.colorB = new THREE.Color(this.paletteB.ground);
    this.detailA = new THREE.Color(this.paletteA.detail); this.detailB = new THREE.Color(this.paletteB.detail);
    this.tmpSample = {}; this.cartSample = {}; this.cartFrontSample = {}; this.cartRearSample = {};
    this.elevationField = this.route.lanes ? null : this.createElevationField();
    this.lake = this.planLake();
    if (this.features.bridge) {
      const b = this.features.bridge, biome = this.dominantBiomeAt(b.x, b.z);
      b.style = b.spans ? 'girder' : ['Forest', 'Pastoral', 'Rural'].includes(biome) ? 'wood' : 'steel';
      if (!b.spans) b.name = b.style === 'wood' ? '河谷木橋' : '河谷鋼橋';
    }
  }
  createElevationField() {
    const nx = 32, nz = 16, d = this.route.squareSize, values = new Float64Array((nx + 1) * (nz + 1));
    const anchors = Array.from({ length: 64 }, (_, i) => this.route.sample(i / 64 * this.route.length))
      .filter((_, i) => !this.route.overpass || i / 64 * this.route.length < this.route.overpass.start || i / 64 * this.route.length > this.route.overpass.end);
    const soft = (d * 0.065) ** 2;
    for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++) {
      const wx = -d + 2 * d * x / nx, wz = -d / 2 + d * z / nz;
      let weighted = 0, total = 0;
      for (const p of anchors) {
        const weight = 1 / (((wx - p.x) ** 2 + (wz - p.z) ** 2 + soft) ** 2);
        weighted += p.y * weight; total += weight;
      }
      values[z * (nx + 1) + x] = weighted / total;
    }
    return { nx, nz, values };
  }
  baseElevation(x, z) {
    if (this.route.lanes) return this.route.nearestOnTurn(1, x, 0, Infinity, this.raceGroundSample ||= {}).y;
    const { nx, nz, values } = this.elevationField, d = this.route.squareSize;
    const fx = clamp((x + d) / (2 * d) * nx, 0, nx), fz = clamp((z + d / 2) / d * nz, 0, nz);
    const ix = Math.min(nx - 1, Math.floor(fx)), iz = Math.min(nz - 1, Math.floor(fz)), a = iz * (nx + 1) + ix;
    return lerp(lerp(values[a], values[a + 1], fx - ix), lerp(values[a + nx + 1], values[a + nx + 2], fx - ix), fz - iz);
  }
  planLake() {
    if (this.biomeLayout) return this.planBlendedLake();
    if (![this.config.biomeA, this.config.biomeB].includes('Lakeside')) return null;
    const side = this.config.biomeA === 'Lakeside' ? -1 : 1, d = this.route.squareSize;
    const depth = this.route.halfDepth ? this.route.halfDepth * 2 : d;
    let chosen = null, best = 0;
    for (let i = 0; i < 70; i++) {
      const x = side * d * (0.16 + (i % 10) * 0.065), z = depth * (-0.25 + Math.floor(i / 10) * 0.08);
      if (this.stations.some(s => Math.hypot(x - s.x - s.nx * 47, z - s.z - s.nz * 47) < 215)) continue;
      const distance = this.route.distanceTo(x, z, 230);
      if (distance > best) { best = distance; chosen = { x, z }; }
    }
    if (!chosen || best < 45) return null;
    return { ...chosen, radius: Math.min(150, best * 0.76), depthScale: 0.68, level: this.baseElevation(chosen.x, chosen.z) - 0.16 };
  }
  lakeRadiusAt(x, z) {
    if (!this.lake) return Infinity;
    return Math.hypot(x - this.lake.x, (z - this.lake.z) / this.lake.depthScale);
  }
  mixAt(x, z) { return this.biomeLayout ? this.biomeWeight(this.config.biomeB, x, z) : biomeMix(x, z, this.route.squareSize); }
  weightsAt(x, z) { if (this.biomeLayout) return this.biomeLayout.weightsAt(x, z); const t = biomeMix(x, z, this.route.squareSize); return { [this.config.biomeA]: 1-t, [this.config.biomeB]: t }; }
  biomeWeight(id, x, z) { return this.weightsAt(x, z)[id] || 0; }
  chooseBiomeAt(x, z, random = Math.random) { return this.biomeLayout ? this.biomeLayout.choose(this.weightsAt(x,z), random) : random() < this.mixAt(x,z) ? this.config.biomeB : this.config.biomeA; }
  dominantBiomeAt(x, z) { return this.biomeLayout ? this.biomeLayout.dominant(this.weightsAt(x,z)) : this.mixAt(x,z) < .5 ? this.config.biomeA : this.config.biomeB; }
  blendValue(values, x, z) { const weights = this.weightsAt(x,z); let total=0; for(const id of this.activeBiomes) total += (values[id] || 0) * (weights[id] || 0); return total; }
  colorAt(x, z, out = new THREE.Color(), detail = false) { const weights=this.weightsAt(x,z); out.setRGB(0,0,0); for(const row of this.paletteMix){ const c=detail?row.detail:row.ground,w=weights[row.id]||0; out.r+=c.r*w;out.g+=c.g*w;out.b+=c.b*w; } return out; }
  skyColor(out = new THREE.Color()) { out.setRGB(0,0,0); for(const row of this.paletteMix){const w=this.biomeLayout ? this.biomeLayout.mix.find(v=>v.biome===row.id).percent/100 : .5;out.r+=row.sky.r*w;out.g+=row.sky.g*w;out.b+=row.sky.b*w;} return out; }
  planBlendedLake() {
    const biome = this.activeBiomes.includes('Lakeside') ? 'Lakeside' : this.activeBiomes.includes('Desert') ? 'Desert' : null;
    if (!biome) return null;
    const region = this.biomeReport.regions.find(row => row.biome === biome), d = this.route.squareSize;
    const halfDepth = this.route.halfDepth ?? d / 2;
    const maximumRadius = Math.min(biome === 'Desert' ? 60 : 135, Math.sqrt(region.weightedSquareMetres) * 0.22);
    const bridge = this.features.bridge;
    let chosen = null, best = -Infinity;
    const consider = (x, z) => {
      const edge = Math.min(d - Math.abs(x), (halfDepth - Math.abs(z)) / 0.68);
      if (edge < 34 || this.biomeWeight(biome, x, z) < 0.72) return;
      const distance = this.route.distanceTo(x, z, 225);
      const radius = Math.min(maximumRadius, distance * 0.62, edge - 17);
      if (radius < 7 || this.stationPasses.some(station => Math.hypot(x - station.x, z - station.z) < radius + 35)) return;
      if (bridge) {
        const b = bridgeCoordinates(bridge, x, z);
        if (Math.abs(b.across) < radius + 170 && b.along > bridge.river.start - radius && b.along < bridge.river.end + radius) return;
      }
      if (this.biomeWeight(biome, x - radius * 0.68, z) < 0.52 || this.biomeWeight(biome, x + radius * 0.68, z) < 0.52) return;
      const score = radius - Math.abs(distance - 135) * 0.26;
      if (score > best) {
        best = score;
        chosen = { x, z, radius, depthScale: 0.68, level: this.baseElevation(x, z) - 0.16, kind: biome === 'Desert' ? 'oasis' : 'lake', biome };
      }
    };
    for (let i = 0; i < 112; i++) {
      const p = this.route.sample((i + 0.5) / 112 * this.route.length);
      for (const offset of [-176, -128, -84, -50, 50, 84, 128, 176]) consider(p.x + p.nx * offset, p.z + p.nz * offset);
    }
    if (!chosen) for (let j = 0; j < 13; j++) for (let i = 0; i < 26; i++) {
      consider(-d + (i + 0.5) / 26 * 2 * d, (j + 0.5) / 13 * (2 * halfDepth) - halfDepth);
    }
    return chosen;
  }
  rawHeight(x, z) {
    const a = this.blendValue(this.amplitudes, x, z);
    const broad = Math.sin(x * 0.0051 + 2) * Math.cos(z * 0.0043 - 0.8);
    const medium = Math.sin(x * 0.014 + z * 0.006) * Math.cos(z * 0.012);
    let h = this.baseElevation(x, z) + (0.55 + broad * 0.6 + medium * 0.19) * a - 1.3;
    if (this.lake) {
      const r = this.lakeRadiusAt(x, z), edge = this.lake.radius;
      const basin = lerp(this.lake.level - 2.5, this.lake.level + 1.2, smoothstep(edge - 12, edge + 23, r));
      h = lerp(basin, h, smoothstep(edge + 23, edge + 65, r));
    }
    const hill = this.route.tracksideHill;
    if (hill) {
      const dx = x - hill.x, dz = z - hill.z;
      const radius = Math.hypot((dx * hill.tx + dz * hill.tz) / hill.halfLength, (dx * hill.tz - dz * hill.tx) / hill.halfWidth);
      h += hill.height * (1 - smoothstep(0.05, 1, radius));
    }
    return h;
  }
  groundHeight(x, z) {
    return this.terrainGrid ? renderedGroundHeight(this.terrainGrid, x, z) : this.heightAt(x, z);
  }
  heightAt(x, z, knownProximity) {
    const near = typeof knownProximity === 'object' ? knownProximity : this.route.nearestTo(x, z, 110);
    const terrain = this.rawHeight(x, z);
    if (this.route.turns > 1 || this.route.lanes) return this.parallelGroundHeight(x, z, near, terrain);
    if (near.y === undefined) return paddedHeight(this.groundPadIndex, x, z, bridgeGroundHeight(this.features.bridge, x, z, terrain));
    // A graded earthwork supports the rails; distant land follows the same
    // elevation field, rather than leaving an elevated railway floating in air.
    return paddedHeight(this.groundPadIndex, x, z, bridgeGroundHeight(this.features.bridge, x, z, lerp(near.y - 0.09, terrain, smoothstep(20, 105, near.distance))));
  }
  parallelGroundHeight(x, z, near, terrain) {
    const route = this.route, overpass = route.overpass;
    if (near.distance < 61) {
      // Each supported track contributes its embankment or cut. The flyover
      // itself is excluded, so the roadbed below always follows the lower rail.
      let weightSum = 0, heightSum = 0, influence = 0, closest = null;
      for (let lane = 0; lane < this.groundProximities.length; lane++) {
        const p = route.nearestOnTurn(lane, x, z, 55, this.groundProximities[lane], true);
        if (p.y === undefined) continue;
        const w = 1 - smoothstep(7, 44, p.distance);
        const priority = w / (2 + (Math.max(0, p.distance - 3) / 2) ** 4);
        weightSum += priority;
        heightSum += (p.y - 0.10) * priority;
        influence = Math.max(influence, w);
        if (!closest || p.distance < closest.distance) closest = p;
      }
      if (weightSum > 0) {
        terrain = lerp(terrain, heightSum / weightSum, influence);
        terrain = lerp(terrain, closest.y - 0.10, 1 - smoothstep(5.3, 8, closest.distance));
      }
      if (overpass && this.flyoverSamples.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < 20 ** 2)) {
        const deck = route.nearestTo(x, z, 16, this.deckProximity ||= {}, i => !route.groundSegment(i));
        if (deck.y !== undefined) {
          const end = Math.min(deck.distanceAlong - overpass.start, overpass.end - deck.distanceAlong);
          const cut = (1 - smoothstep(4.4, 13.5, deck.distance)) * smoothstep(0, 11, end);
          terrain -= Math.max(0, terrain - (deck.y - 1.18)) * cut;
        }
      }
    }
    return paddedHeight(this.groundPadIndex, x, z, bridgeGroundHeight(this.features.bridge, x, z, terrain));
  }
  async prepareScenery(onProgress = () => {}) {
    if (this.sceneryPlan || !this.store.manifest || !this.config.density) return;
    this.sceneryPlan = await planScenery(this, onProgress);
    this.groundPadIndex = indexGroundPads(this.sceneryPlan.pads);
    this.sceneryStats = this.sceneryPlan.stats;
  }
  async build(onProgress = () => {}) {
    onProgress(0.01, '規劃聚落、田區與自然景物…'); await yieldFrame();
    await this.prepareScenery(p => onProgress(0.01 + p * 0.07, '規劃疏密交錯的沿線風景…'));
    const infrastructure = [
      ...(this.features.bridge && !this.features.bridge.spans ? ['Building_Bridge_SteelTruss8m_001', 'Building_Bridge_TimberDeck4m_001', 'Building_Bridge_StonePier4m_001', 'Building_Bridge_Abutment_001'] : []),
      ...(this.features.tunnel ? ['Building_Tunnel_StonePortal_001', 'Building_Tunnel_RockStraight4m_001'] : [])
    ];
    const lakeModels = this.lake && this.lake.kind !== 'oasis' && this.lake.radius >= 36 ? this.store.manifest.biomes.Lakeside.models.filter(id => !this.store.manifest.models[id].scenePack?.startsWith('Quaternius')) : [];
    const selections = this.config.fleet ?? [this.config];
    const vehicles = selections.flatMap(({ vehicle, driver }) => driver ? [vehicle, driver] : [vehicle]);
    const ids = [...this.sceneryPlan.placements.map(p => p.id), ...lakeModels,
      ...this.store.manifest.stationModels, 'Environment_Rail_RailSection_1m_001', 'Environment_Rail_Sleeper_001', 'Environment_Rail_Fastener_001', ...infrastructure,
      ...vehicles, ...(this.config.playable ? [TURBO_ASSET_ID] : [])];
    await this.store.load(ids, (p, id) => onProgress(0.08 + p * 0.32, `讀取 ${this.store.manifest.models[id].name}`));
    onProgress(0.42, this.route.lanes ? '鋪設三條直線賽道…' : '鋪設閉合軌道…'); await yieldFrame(); this.buildTrack();
    onProgress(0.55, `混合 ${this.activeBiomes.length} 種環境地表…`); await yieldFrame(); await this.buildTerrain();
    onProgress(0.70, '佈置沿線地景…'); await yieldFrame(); await this.buildScenery();
    onProgress(0.87, '建立橋梁、立體交會與隧道…'); await yieldFrame();
    if (this.features.overpass) buildGirderBridge(this, this.features.overpass, this.route.turns - 1);
    buildBridgeAndRiver(this); buildTunnel(this);
    onProgress(0.94, '建立車站、礦車與遠景…'); await yieldFrame(); this.buildStations(); this.buildCart();
    this.createClouds();
    onProgress(1, '旅程準備就緒');
    return this;
  }
  addBatches(id, placements, { size = 160, kind = 'scenery', castShadow } = {}) {
    const info = this.store.manifest?.models?.[id];
    const casts = castShadow ?? (this.config.sceneryShadows && ['scenery', 'landmark'].includes(kind));
    const bins = new Map();
    let source = this.partsOverrides.get(id) || this.store.get(id);
    if (placements[0]?.groundPatch) {
      if (!this.groundParts.has(id)) this.groundParts.set(id, { parts: prepareGroundedParts(source, this.store.manifest.models[id].placement, this.ownedMaterials) });
      source = this.groundParts.get(id);
    }
    for (const p of placements) {
      const key = `${Math.floor(p.x / size)},${Math.floor(p.z / size)}`;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(p);
    }
    for (const [key, values] of bins) {
      const [cx, cz] = key.split(',').map(Number);
      const group = new THREE.Group(); group.name = `${kind}:${id}:${key}`;
      const lod = info?.lod;
      const farSource = lod && !values[0].groundPatch ? this.partsOverrides.get(`${id}#lod1`) || this.store.get(id, 1) : null;
      const bounds = lod?.nearestBounds ? new THREE.Box3() : null;
      const castsHere = casts && (kind !== 'scenery' || keepSceneryShadow(info, values, this.shadowProfile));
      for (const [partIndex, part] of source.parts.entries()) {
        const geometry = values[0].groundPatch ? groundBatchGeometry(part, values) : part.geometry;
        if (geometry !== part.geometry) this.ownedGeometry.push(geometry);
        const mesh = new THREE.InstancedMesh(geometry, part.material, values.length);
        if (part.depth) mesh.customDepthMaterial = part.depth;
        for (let i = 0; i < values.length; i++) {
          const p = values[i];
          position.set(p.x, p.y || 0, p.z); q.setFromEuler(rotationEuler.set(p.pitch || 0, p.yaw || 0, p.roll || 0, 'YXZ'));
          if (p.groundX !== undefined) {
            slopeNormal.set(-p.groundX, 1, -p.groundZ).normalize();
            slopeQuaternion.setFromUnitVectors(upAxis, slopeNormal); q.premultiply(slopeQuaternion);
          }
          scaling.set(p.sx ?? p.scale ?? 1, p.sy ?? p.scale ?? 1, p.sz ?? p.scale ?? 1);
          placementMatrix.compose(position, q, scaling); combined.multiplyMatrices(placementMatrix, part.matrix);
          mesh.setMatrixAt(i, combined);
          if (p.tone !== undefined) mesh.setColorAt(i, new THREE.Color(p.tone, p.tone, p.tone));
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere(); mesh.computeBoundingBox();
        if (bounds) bounds.union(mesh.boundingBox);
        mesh.castShadow = Boolean(castsHere); mesh.receiveShadow = true;
        if (farSource?.parts[partIndex]) {
          const far = farSource.parts[partIndex];
          mesh.userData.sceneryLOD = { nearGeometry: geometry, nearMaterial: part.material,
            farGeometry: far.geometry, farMaterial: lod.reuseMaterials ? part.material : far.material, switchDistance: lod.switchDistance, far: false };
        }
        group.add(mesh);
      }
      this.group.add(group);
      this.cullGroups.push({ group, x: (cx + 0.5) * size, z: (cz + 0.5) * size, radius: size * 0.82, kind, bounds });
    }
    this.instanceCount += placements.length;
  }
  buildTrack() {
    const tracks = this.route.lanes ?? [this.route], rails = [];
    const layout = sleeperLayout(this.route.length, this.config.sleeperSpacing || 0.75, this.config.seed), ties = [], bolts = [];
    this.sleeperPitch = layout.pitch;
    for (const track of tracks) {
      for (const s of trackSegments(track)) {
        const p = track.sample(s.start);
        for (const side of [-1, 1]) rails.push({ x: s.x + p.nx * side * 0.8885 + p.upX * 0.205,
          y: s.y + p.upY * 0.205, z: s.z + p.nz * side * 0.8885 + p.upZ * 0.205, yaw: s.yaw, pitch: s.pitch, sz: s.length });
      }
      for (const item of layout.placements) {
        const p = track.sample(item.distance);
        ties.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, tone: item.tone });
        for (const side of [-1, 1]) bolts.push({ x: p.x + p.nx * side * 0.8885 + p.upX * 0.18,
          y: p.y + p.upY * 0.18, z: p.z + p.nz * side * 0.8885 + p.upZ * 0.18, yaw: p.yaw, pitch: p.pitch });
      }
    }
    this.prepareRailMaterial();
    this.addBatches('Environment_Rail_RailSection_1m_001', rails, { size: 56, kind: 'track' });
    this.prepareSleeperMaterial();
    this.addBatches('Environment_Rail_Sleeper_001', ties, { size: 56, kind: 'sleepers' });
    this.addBatches('Environment_Rail_Fastener_001', bolts, { size: 96, kind: 'fasteners' });
    this.sleeperInstances = ties.length;
    this.trackInstances = rails.length / 2;
    const bedMaterial = new THREE.MeshStandardMaterial({ color: '#a79a7d', roughness: 1, side: THREE.DoubleSide });
    const overviewMaterial = new THREE.LineBasicMaterial({ color: '#926848' });
    this.ownedMaterials.push(bedMaterial, overviewMaterial);
    this.overviewTrack = new THREE.Group(); this.overviewTrack.visible = false; this.group.add(this.overviewTrack);
    for (const track of tracks) this.buildTrackBase(track, bedMaterial, overviewMaterial);
  }
  buildTrackBase(track, bedMaterial, overviewMaterial) {
    const bed = [], bedIndices = [], bedCount = Math.ceil(track.length / 2);
    for (let i = 0; i <= bedCount; i++) {
      const p = track.sample(i / bedCount * track.length);
      for (const side of [-1, 1]) bed.push(p.x + p.nx * side * 1.49, p.y - 0.035, p.z + p.nz * side * 1.49);
      if (i) { const a = (i - 1) * 2; bedIndices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const bedGeometry = new THREE.BufferGeometry(); bedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bed, 3)); bedGeometry.setIndex(bedIndices); bedGeometry.computeVertexNormals();
    const bedMesh = new THREE.Mesh(bedGeometry, bedMaterial); bedMesh.receiveShadow = true; this.group.add(bedMesh); this.ownedGeometry.push(bedGeometry);
    const overviewPoints = track.points.filter((_, i) => i % 8 === 0).map(p => new THREE.Vector3(p.x, p.y + 0.46, p.z));
    const geometry = new THREE.BufferGeometry().setFromPoints(overviewPoints);
    const overview = this.route.lanes ? new THREE.Line(geometry, overviewMaterial) : new THREE.LineLoop(geometry, overviewMaterial);
    this.overviewTrack.add(overview); this.ownedGeometry.push(geometry);
  }
  prepareRailMaterial() {
    const id = 'Environment_Rail_RailSection_1m_001';
    const original = this.store.get(id);
    const tone = new THREE.Color('#8b5d37').toArray().map(v => v.toFixed(5)).join(', ');
    const prepare = source => {
      const material = source.clone();
      material.onBeforeCompile = shader => {
        shader.vertexShader = 'varying float vRailDistance;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>',
          '#include <project_vertex>\nvRailDistance = length(mvPosition.xyz);');
        shader.fragmentShader = 'varying float vRailDistance;\n' + shader.fragmentShader;
        // Match the sub-pixel colour of the detail meshes before the batch LOD
        // changes. Mip filtering alone gives their differently laid-out UVs
        // different hues when a full rail is smaller than a pixel.
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <map_fragment>', `#include <map_fragment>
            float railTone = smoothstep(52.0, 76.0, vRailDistance);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${tone}), railTone);`)
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.82, railTone);')
          .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.18, railTone);');
      };
      material.customProgramCacheKey = () => 'loop-rail-v12';
      this.ownedMaterials.push(material);
      return material;
    };
    const parts = original.parts.map(part => ({ ...part,
      material: Array.isArray(part.material) ? part.material.map(prepare) : prepare(part.material) }));
    this.partsOverrides.set(id, { parts });
  }
  prepareSleeperMaterial() {
    const id = 'Environment_Rail_Sleeper_001';
    const original = this.store.get(id);
    const withExposureBounds = part => {
      const geometry = part.geometry.clone(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      geometry.boundingBox.min.z -= 0.8; geometry.boundingBox.max.z += 0.8; geometry.boundingSphere.radius += 0.8;
      this.ownedGeometry.push(geometry);
      return { ...part, geometry };
    };
    const parts = original.parts.map(part => {
      const makeMaterial = source => {
        const material = source.clone(); material.transparent = true; material.depthWrite = false; material.alphaTest = 0.008;
        material.onBeforeCompile = shader => {
          shader.uniforms.uSleeperExposure = this.sleeperUniforms.exposure; shader.uniforms.uSleeperContrast = this.sleeperUniforms.contrast; shader.uniforms.uSleeperFilter = this.sleeperUniforms.enabled;
          shader.vertexShader = 'uniform float uSleeperExposure; varying float vSleeperZ; varying float vSleeperDepth;\n' + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z *= (0.30 + uSleeperExposure) / 0.30; vSleeperZ = transformed.z;');
          shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvSleeperDepth = -mvPosition.z;');
          shader.fragmentShader = 'uniform float uSleeperExposure; uniform float uSleeperContrast; uniform float uSleeperFilter; varying float vSleeperZ; varying float vSleeperDepth;\n' + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
            float tieCoverage = 1.0;
            if (uSleeperExposure > 0.00001) tieCoverage = clamp((min(0.15, vSleeperZ + uSleeperExposure * 0.5) - max(-0.15, vSleeperZ - uSleeperExposure * 0.5)) / uSleeperExposure, 0.0, 1.0);
            float tieDistance = mix(1.0, 1.0 - smoothstep(85.0, 280.0, vSleeperDepth) * 0.88, uSleeperFilter);
            diffuseColor.a *= tieCoverage * tieDistance;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.45, 0.32, 0.18), uSleeperContrast);`);
        };
        material.customProgramCacheKey = () => 'sleeper-exposure-v3'; this.ownedMaterials.push(material); return material;
      };
      const material = Array.isArray(part.material) ? part.material.map(makeMaterial) : makeMaterial(part.material);
      return { ...withExposureBounds(part), material };
    });
    this.partsOverrides.set(id, { parts });
    if (this.store.manifest?.models[id]?.lod) {
      this.partsOverrides.set(`${id}#lod1`, { parts: this.store.get(id, 1).parts.map(withExposureBounds) });
    }
  }
  async buildTerrain() {
    await this.prepareScenery();
    const d = this.route.squareSize, halfDepth = this.route.halfDepth ?? d / 2;
    const multi = this.route.turns > 1 || Boolean(this.route.lanes), tile = multi ? 128 : 192;
    const material = createGroundMaterial(this);
    this.ownedMaterials.push(material);
    const color = new THREE.Color(), detail = new THREE.Color();
    const nx = Math.ceil(2 * d / tile), nz = Math.ceil(2 * halfDepth / tile);
    const width = 2 * d / nx, depth = 2 * halfDepth / nz;
    this.terrainGrid = { d, halfDepth, nx, nz, width, depth, tiles: [] };
    const detailedAt = (x, z) => {
      if (this.sceneryPlan?.pads.some(p => Math.abs(x - p.x) < tile * 0.55 + p.outer && Math.abs(z - p.z) < tile * 0.55 + p.outer)) return true;
      if (multi && this.route.distanceTo(x, z, tile + 55) < tile * 0.75 + 43) return true;
      if (!this.features.bridge) return false;
      const p = bridgeCoordinates(this.features.bridge, x, z);
      const r = this.features.bridge.river;
      return Math.abs(p.across) < 140 + tile * 0.72 && p.along > r.start - tile * 0.72 && p.along < r.end + tile * 0.72;
    };
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x0 = -d + ix * width, z0 = -halfDepth + iz * depth;
        const cx = x0 + width / 2, cz = z0 + depth / 2, detailed = detailedAt(cx, cz);
        const coarseLeft = !detailedAt(cx - width, cz), coarseRight = !detailedAt(cx + width, cz);
        const coarseTop = !detailedAt(cx, cz - depth), coarseBottom = !detailedAt(cx, cz + depth);
        const segments = detailed ? 48 : 12;
        const verts = [], colors = [], indices = [], normals = [], grass = [];
        for (let z = 0; z <= segments; z++) for (let x = 0; x <= segments; x++) {
          const wx = x0 + x / segments * width, wz = z0 + z / segments * depth;
          const near = this.route.nearestTo(wx, wz, 110);
          let h = this.heightAt(wx, wz, near);
          // Resolve rail beds and the river channel without refining the whole map.
          // Fine-tile edges follow the coarse neighbor's linear edge exactly.
          const vertical = (x === 0 && coarseLeft) || (x === segments && coarseRight);
          const horizontal = (z === 0 && coarseTop) || (z === segments && coarseBottom);
          if (detailed && (vertical || horizontal)) {
            const t = (vertical ? z : x) / segments * 12, k = Math.min(11, Math.floor(t));
            const a = vertical ? this.heightAt(wx, z0 + k / 12 * depth) : this.heightAt(x0 + k / 12 * width, wz);
            const b = vertical ? this.heightAt(wx, z0 + (k + 1) / 12 * depth) : this.heightAt(x0 + (k + 1) / 12 * width, wz);
            h = lerp(a, b, t - k);
          }
          verts.push(wx, h, wz);
          if (!multi || x === 0 || z === 0 || x === segments || z === segments) {
            const normal = new THREE.Vector3(this.heightAt(wx - 1, wz) - this.heightAt(wx + 1, wz), 2,
              this.heightAt(wx, wz - 1) - this.heightAt(wx, wz + 1)).normalize();
            normals.push(normal.x, normal.y, normal.z);
          } else normals.push(0, 1, 0);
          grass.push(grassHabitatAt(this, wx, wz, near));
          const speckle = 0.11 + 0.11 * Math.sin(wx * 0.073) * Math.cos(wz * 0.067);
          this.colorAt(wx,wz,color); this.colorAt(wx,wz,detail,true);
          color.lerp(detail, speckle);
          for (const farm of this.sceneryPlan?.farms || []) {
            const dx = wx - farm.x, dz = wz - farm.z, c = Math.cos(farm.yaw), s = Math.sin(farm.yaw);
            const edge = Math.max(Math.abs(c * dx - s * dz) / farm.halfWidth, Math.abs(s * dx + c * dz) / farm.halfLength);
            color.lerp(new THREE.Color('#a48f63'), (1 - smoothstep(0.72, 1.08, edge)) * 0.38);
          }
          // A continuous dusty verge under the entire railway hides biome seams.
          color.lerp(new THREE.Color('#aca48b'), (1 - smoothstep(3, 9, near.distance)) * 0.40);
          colors.push(color.r, color.g, color.b);
        }
        for (let z = 0; z < segments; z++) for (let x = 0; x < segments; x++) {
          const a = z * (segments + 1) + x, b = a + 1, c = a + segments + 1, e = c + 1;
          indices.push(a, c, b, b, c, e);
        }
        if (multi) for (let z = 1; z < segments; z++) for (let x = 1; x < segments; x++) {
          const index = (z * (segments + 1) + x) * 3;
          const dx = (verts[index - 2] - verts[index + 4]) * segments / (2 * width);
          const dz = (verts[index - (segments + 1) * 3 + 1] - verts[index + (segments + 1) * 3 + 1]) * segments / (2 * depth);
          const length = Math.hypot(dx, 1, dz);
          normals[index] = dx / length; normals[index + 1] = 1 / length; normals[index + 2] = dz / length;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        for (let i = 0; i < grass.length; i++) grass[i] *= smoothstep(0.60, 0.94, normals[i * 3 + 1]);
        geometry.setAttribute('landGrass', new THREE.Float32BufferAttribute(grass, 1));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.setIndex(indices); geometry.computeBoundingSphere();
        this.terrainGrid.tiles[iz * nx + ix] = { x0, z0, segments, geometry };
        const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true;
        this.group.add(mesh); this.ownedGeometry.push(geometry); this.terrainChunks++;
        this.cullGroups.push({ group: mesh, x: x0 + width / 2, z: z0 + depth / 2, radius: tile, kind: 'terrain' });
      }
      if (iz % 4 === 0) await yieldFrame();
    }
  }
  async buildScenery() {
    await this.prepareScenery();
    const batches = new Map();
    for (const p of this.sceneryPlan.placements) {
      const info = this.store.manifest.models[p.id];
      const height = (x, z) => renderedGroundHeight(this.terrainGrid, x, z);
      if (p.role !== 'aquatic') p.y = height(p.x, p.z) - Math.max(0, this.store.get(p.id).bounds.min.y) * p.scale - 0.025;
      if (info.placement?.footprintAdaptive) {
        fitGroundContact(this, p, info.placement);
      } else if (info.derivation && info.placement) {
        const radius = clamp(Math.max(info.dimensions[0], info.dimensions[2]) * p.scale * 0.32, 3, 22);
        const east = height(p.x + radius, p.z), west = height(p.x - radius, p.z);
        const south = height(p.x, p.z + radius), north = height(p.x, p.z - radius);
        p.groundX = (east - west) / (2 * radius); p.groundZ = (south - north) / (2 * radius);
        const centre = height(p.x, p.z);
        p.y += Math.min(0, east - centre - p.groundX * radius, west - centre + p.groundX * radius,
          south - centre - p.groundZ * radius, north - centre + p.groundZ * radius) - 0.035 * p.scale;
      }
      if (!batches.has(p.id)) batches.set(p.id, []);
      batches.get(p.id).push(p);
    }
    for (const [id, placements] of batches) {
      const lod = this.store.manifest.models[id].lod;
      this.addBatches(id, placements, { size: lod?.batchSize ?? (lod ? 224 : 160), kind: 'scenery' });
    }
    this.sceneryCount = this.sceneryPlan.placements.length;
    this.buildDistrictPaths();
    buildFarmland(this); buildGrassCover(this);
    if (this.lake) this.buildLake();
  }
  buildDistrictPaths() {
    const material = new THREE.MeshStandardMaterial({ color: '#aaa18a', roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.ownedMaterials.push(material);
    const buildPath = (waypoints, halfWidth, name, district) => {
      const verts = [], indices = [];
      for (let piece = 1; piece < waypoints.length; piece++) {
        const a = waypoints[piece - 1], b = waypoints[piece], dx = b.x - a.x, dz = b.z - a.z;
        const length = Math.hypot(dx, dz), segments = Math.ceil(length / 0.9);
        for (let i = 0; i <= segments; i++) {
          const x = lerp(a.x, b.x, i / segments), z = lerp(a.z, b.z, i / segments);
          for (const side of [-halfWidth, halfWidth]) {
            const wx = x + dz / length * side, wz = z - dx / length * side;
            verts.push(wx, this.groundHeight(wx, wz) + 0.08, wz);
          }
          if (i) { const k = verts.length / 3 - 4; indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      const path = new THREE.Mesh(geometry, material); path.receiveShadow = true; path.name = name;
      this.group.add(path); this.ownedGeometry.push(geometry);
      this.cullGroups.push({ group: path, x: district.x, z: district.z, radius: district.laneHalfLength + 65, kind: 'scenery' });
    };
    for (const district of this.sceneryPlan.districts) {
      if (district.buildings.length < 2) continue;
      const tx = Math.sin(district.yaw), tz = Math.cos(district.yaw);
      const ends = [-district.laneHalfLength, district.laneHalfLength].map(v => ({ x: district.x + tx * v, z: district.z + tz * v }));
      buildPath(ends, 2.1, 'village-lane', district);
      if (district.accessPath) buildPath(district.accessPath, 1.35, 'station-access-path', district);
    }
  }
  buildLake() {
    if (!this.lake) return;
    const { x, z, radius, depthScale, level } = this.lake;
    const geometry = new THREE.CircleGeometry(radius + (this.biomeLayout ? Math.min(4,radius*.08) : 8), 80); geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({ color: '#699eaa', roughness: 0.24, metalness: 0.12 });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, level, z); mesh.scale.z = depthScale;
    this.group.add(mesh); this.ownedGeometry.push(geometry); this.ownedMaterials.push(material); this.waterMaterials.push(material);
    if(this.lake.kind === 'oasis' || radius < 36) return;
    // Original Blender water tile, pier, boat and willow form a coherent shore.
    const placements = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) placements.push({ x: x + dx * 8, z: z + dz * 8, y: level + 0.2, yaw: 0 });
    this.addBatches('Environment_Lakeside_WaterTile8m_001', placements, { kind: 'water' });
    const shoreZ = z + radius * depthScale - 4;
    const pierY = this.heightAt(x, shoreZ);
    this.addBatches('Prop_Lakeside_WoodenPier6m_001', [{ x, z: shoreZ, y: pierY, yaw: Math.PI }], { kind: 'landmark' });
    this.addBatches('Prop_Lakeside_Rowboat4m_001', [{ x: x + 8, z: shoreZ - 7, y: level, yaw: -0.6 }], { kind: 'landmark' });
    const willows = [];
    for (let i = 0; i < 15; i++) {
      const angle = i / 15 * TAU;
      const px = x + Math.cos(angle) * (radius + 12), pz = z + Math.sin(angle) * (radius * depthScale + 13);
      if (this.route.distanceTo(px, pz, 50) > 18) willows.push({ x: px, z: pz, y: this.heightAt(px, pz), yaw: angle });
    }
    this.addBatches('Plant_Lakeside_WeepingWillow_001', willows, { kind: 'landmark' });
  }
  buildStations() {
    const platform = [], canopy = [], hut = [], signs = [], lamps = [];
    const straight = Boolean(this.route.lanes);
    for (const s of this.stationPasses) {
      const main = straight ? s.turnIndex === this.route.lanes.length - 1 : !s.turnIndex;
      const side = straight ? (s.turnIndex === 0 ? -1 : 1) : (s.turnIndex ? 1 : this.stations[s.index].platformSide ?? 1);
      const platformShift = straight && s.distance === this.route.length ? 8 : 0;
      const at = (offset, along = 0, y = 0) => ({
        x: s.x + s.nx * offset * side + s.tx * (along + platformShift),
        z: s.z + s.nz * offset * side + s.tz * (along + platformShift), y: s.y + y, yaw: s.yaw,
      });
      const platformOffset = straight ? 4.2 : 3.2;
      for (let i = -2; i < 3; i++) {
        platform.push(at(platformOffset, i * 4));
        if (i >= -1 && i <= 1) canopy.push(at(platformOffset, i * 4));
      }
      if (main) hut.push(at(10.5, -4));
      signs.push(at(6.1, 8)); lamps.push(at(6.3, -10), at(6.3, 11));
      const subtitle = straight ? `第 ${s.turnIndex + 1} 道 · ${s.distance / 1000} km`
        : this.route.turns > 1 ? `第 ${s.turnIndex + 1} 圈月台` : s.index === 0 ? 'A / DEPARTURE' : `STATION 0${s.index + 1}`;
      const board = this.makeLabel(s.name, subtitle);
      const p = straight ? at(5.8, 6, 4.2) : at(4.7, 0, 5.6);
      board.position.set(p.x, p.y, p.z);
      if (straight) board.scale.set(6.4, 2, 1); else board.scale.set(9.6, 3.0, 1);
      this.group.add(board);
      const padGeo = new THREE.BoxGeometry(main ? 23 : 8.5, 0.18, main ? 35 : 29);
      const padMat = new THREE.MeshStandardMaterial({ color: '#c3bda5', roughness: 0.95 });
      const pad = new THREE.Mesh(padGeo, padMat); const padP = at(main ? 9 : 4.5, 0, -0.08);
      pad.position.set(padP.x, padP.y, padP.z); pad.rotation.y = s.yaw; pad.receiveShadow = true; this.group.add(pad);
      this.ownedGeometry.push(padGeo); this.ownedMaterials.push(padMat);
    }
    const shadow = this.config.shadows;
    this.addBatches('Building_Station_Platform4m_001', platform, { kind: 'station', castShadow: shadow });
    this.addBatches('Building_Station_Canopy4m_001', canopy, { kind: 'station', castShadow: shadow });
    this.addBatches('Building_Station_TicketHut_001', hut, { kind: 'station', castShadow: shadow });
    this.addBatches('Prop_Station_StationSign_001', signs, { kind: 'station', castShadow: shadow });
    this.addBatches('Prop_Lineside_TracksideLamp_001', lamps, { kind: 'station', castShadow: shadow });
    if (this.route.lanes) this.buildRaceLines();
  }
  buildRaceLines() {
    const geometry = new THREE.BoxGeometry(0.31, 0.024, 0.55);
    const material = new THREE.MeshBasicMaterial();
    const lanes = this.route.lanes, squaresPerLine = 16;
    const lines = new THREE.InstancedMesh(geometry, material, lanes.length * 2 * squaresPerLine);
    const transform = new THREE.Matrix4(), colour = new THREE.Color();
    let index = 0;
    for (const lane of lanes) for (const distance of [0, lane.length]) {
      const position = lane.sample(distance);
      for (let row = 0; row < 2; row++) for (let col = 0; col < 8; col++) {
        transform.makeTranslation(position.x + (row - 0.5) * 0.31, position.y + 0.045, position.z + (col - 3.5) * 0.55);
        lines.setMatrixAt(index, transform);
        colour.set((row + col) % 2 ? '#f5f1d5' : distance ? '#342f2d' : '#2d735f');
        lines.setColorAt(index++, colour);
      }
    }
    lines.name = 'straight-start-and-finish'; lines.computeBoundingSphere();
    this.group.add(lines); this.ownedGeometry.push(geometry); this.ownedMaterials.push(material);
  }
  makeLabel(title, subtitle) {
    const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#173d36'; ctx.beginPath(); ctx.roundRect(4, 4, 760, 228, 14); ctx.fill();
    ctx.strokeStyle = '#cdd5a9'; ctx.lineWidth = 2; ctx.strokeRect(16, 16, 736, 204);
    ctx.textAlign = 'center'; ctx.fillStyle = '#f3efd5'; ctx.font = '500 70px "Microsoft JhengHei",sans-serif'; ctx.fillText(title, 384, 116);
    ctx.fillStyle = '#bdc99b'; ctx.font = '24px "Microsoft JhengHei","Segoe UI",sans-serif'; ctx.fillText(subtitle, 384, 177);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: true, sizeAttenuation: true });
    this.ownedTextures.push(texture); this.ownedMaterials.push(material);
    return new THREE.Sprite(material);
  }
  buildCart() {
    const fleet = this.config.fleet ?? [this.config];
    const resources = this.config.playable ? createTurboResources(this) : null;
    this.carts = fleet.map((selection, index) => {
      const laneIndex = fleet.length === 1 ? 1 : index;
      const track = this.route.lanes?.[laneIndex] ?? this.route;
      const departure = this.route.lanes ? 0 : this.route.turnStarts[fleet.length - index - 1];
      return { ...this.buildCartRig(selection, departure, resources), track, laneIndex };
    });
    this.primaryCart = this.carts[Math.floor(this.carts.length / 2)];
    this.cart = this.primaryCart.root;
    this.wheels = this.primaryCart.wheels;
    this.cartSample = this.primaryCart.sample;
    for (const [index, rig] of this.carts.entries()) {
      if (fleet[index].driver) this.attachDriver(fleet[index].driver, rig);
      this.updateCart(rig.departure, 0, 0, 0, rig);
    }
  }
  buildCartRig({ vehicle }, departure, resources) {
    const source = this.store.get(vehicle), root = source.root.clone(true), wheels = [];
    root.name = vehicle;
    root.traverse(node => { if (node.isMesh) { node.castShadow = this.config.shadows; node.receiveShadow = true; } });
    const prefix = vehicle.includes('GoldenOak') ? 'GoldenOak' : vehicle.includes('AzureLake') ? 'AzureLake' : 'RedCopper';
    for (const suffix of ['FL', 'FR', 'RL', 'RR']) {
      const node = root.getObjectByName(`${prefix}_Wheel_${suffix}`);
      if (node) {
        const parents=[];for(let parent=node.parent;parent&&parent!==root;parent=parent.parent)parents.unshift(parent);
        const matrix=new THREE.Matrix4();for(const parent of parents){parent.updateMatrix();matrix.multiply(parent.matrix);}
        const suspensionAxis=new THREE.Vector3(0,1,0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix).invert());
        wheels.push({ node, original: node.quaternion.clone(), originalPosition: node.position.clone(), suspensionAxis });
      }
    }
    const lever = root.getObjectByName(`${prefix}_Lever`);
    this.group.add(root);
    const halfWidth = resources ? Math.max(-source.bounds.min.x, source.bounds.max.x) : 0;
    const turbo = resources ? new TurboPair(this, root, halfWidth, resources) : null;
    return { root, vehicle, departure, wheels, lever, leverBase: lever?.quaternion.clone(), sample: {}, frontSample: {}, rearSample: {}, driver: null, turbo };
  }
  attachDriver(id, rig = this.primaryCart) {
    if (!this.store.manifest.drivers?.includes(id)) throw new Error('找不到動物駕駛。');
    const next = createStandingDriver(this.store.get(id).root, rig.vehicle, {
      id, name: this.store.manifest.models[id].name, shadows: this.config.shadows,
      staticClip: this.store.get(id).animations?.find(clip => clip.name === 'static')
    });
    if (rig.driver) rig.root.remove(rig.driver);
    rig.root.add(next); rig.driver = next;
    if (rig === this.primaryCart) { this.driver = next; this.config.driver = id; }
    return next;
  }
  async setDriver(id) {
    const request = ++this.driverRequest;
    await this.store.load([id]);
    if (this.disposed || request !== this.driverRequest) return false;
    this.attachDriver(id);
    return true;
  }
  createClouds() {
    if (this.config.skyline === false) { this.clouds = null; return; }
    buildMountainBackdrop(this); buildVariedClouds(this);
  }
  structureAt(distance, padding = 0, rig = this.primaryCart) {
    const s = this.route.lanes ? clamp(distance, 0, this.route.length) : wrap(distance, this.route.length);
    return this.structures.find(f => (!this.route.lanes || f.turnIndex === rig?.laneIndex) && s >= f.start - padding && s <= f.end + padding) || null;
  }
  tunnelFactor(distance, rig = this.primaryCart) {
    const tunnel = this.features.tunnel;
    if (!tunnel || (this.route.lanes && tunnel.turnIndex !== rig?.laneIndex)) return 0;
    const s = this.route.lanes ? clamp(distance, 0, this.route.length) : wrap(distance, this.route.length);
    return smoothstep(tunnel.start, tunnel.start + 6, s) * (1 - smoothstep(tunnel.end - 6, tunnel.end, s));
  }
  updateEnvironment(dt, speed, frameSeconds) {
    this.environmentElapsed += dt;
    this.updateTrackFilter(speed, frameSeconds);
    updateClouds(this, this.environmentElapsed);
    if (this.grassWind) this.grassWind.value = this.environmentElapsed;
    if (this.riverFlow) this.riverFlow.value = this.environmentElapsed;
  }
  updateTrackFilter(speed, frameSeconds) {
    this.lastSpeed = speed;
    const filter = sleeperFilter(speed, frameSeconds, this.sleeperPitch || 0.75, this.config.sleeperFilter !== false);
    this.sleeperUniforms.exposure.value = filter.exposure; this.sleeperUniforms.contrast.value = filter.contrastReduction; this.sleeperUniforms.enabled.value = filter.enabled;
  }
  updateCart(distance, odometer, throttle, suspensionY = 0, rig = this.primaryCart) {
    const cart = rig?.root ?? this.cart;
    const track = rig?.track ?? this.route;
    const p = track.sample(distance, rig?.sample ?? this.cartSample);
    // Use a two-metre track chord for body attitude. The arc-table position is
    // exact; this removes tiny tangent jumps at successive polyline samples.
    const front = track.sample(distance + 1, rig?.frontSample ?? this.cartFrontSample), rear = track.sample(distance - 1, rig?.rearSample ?? this.cartRearSample);
    const dx = front.x - rear.x, dy = front.y - rear.y, dz = front.z - rear.z;
    const horizontal = Math.hypot(dx, dz), length = Math.hypot(horizontal, dy);
    p.tx = dx / horizontal; p.tz = dz / horizontal; p.tx3 = dx / length; p.ty = dy / length; p.tz3 = dz / length;
    p.pitch = -Math.atan2(dy, horizontal); p.yaw = Math.atan2(dx, dz); p.nx = p.tz; p.nz = -p.tx;
    p.upX = -p.tx * p.ty; p.upY = horizontal / length; p.upZ = -p.tz * p.ty;
    const height=0.381+suspensionY;
    cart.position.set(p.x + height * p.upX, p.y + height * p.upY, p.z + height * p.upZ);
    cart.quaternion.setFromEuler(rotationEuler.set(p.pitch, p.yaw, 0, 'YXZ'));
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), distance / 0.346);
    for (const wheel of rig?.wheels ?? this.wheels) {
      wheel.node.quaternion.copy(wheel.original).multiply(q);
      // Account for nested Blender parent axes/scales. Wheels stay on the rails
      // while the cart body, lever and animal share the sprung displacement.
      wheel.node.position.copy(wheel.originalPosition).addScaledVector(wheel.suspensionAxis,-suspensionY);
    }
    if (rig?.lever) {
      q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -throttle * 0.35);
      rig.lever.quaternion.copy(rig.leverBase).multiply(q);
    }
    return p;
  }
  showTestBumper(distance) {
    if (distance === null) { if(this.testBumper)this.testBumper.visible=false; return; }
    if(!this.testBumper){
      const geometry=new THREE.BoxGeometry(2.5,.24,.36),material=new THREE.MeshStandardMaterial({color:'#cf7a43',roughness:.7});
      this.ownedGeometry.push(geometry);this.ownedMaterials.push(material);
      this.testBumper=new THREE.Mesh(geometry,material);this.testBumper.castShadow=this.config.shadows;this.group.add(this.testBumper);
    }
    const p=this.route.sample(distance);this.testBumper.position.set(p.x+p.upX*.405,p.y+p.upY*.405,p.z+p.upZ*.405);
    this.testBumper.quaternion.setFromEuler(rotationEuler.set(p.pitch,p.yaw,0,'YXZ'));this.testBumper.visible=true;
  }
  setVisibility(camera, farDistance, overview = false) {
    const cx = camera.position.x, cz = camera.position.z;
    const radius = overview ? this.route.squareSize * 4 : farDistance;
    for (const item of this.cullGroups) {
      const distance = Math.hypot(cx - item.x, cz - item.z);
      const nearest = item.bounds ? distanceToXZBounds(item.bounds, cx, cz) : distance;
      if (item.kind === 'grass') {
        item.group.visible = !overview && nearest < Math.min(radius, GRASS_DRAW_DISTANCE);
        if (item.group.visible) {
          const far = chooseFarGeometry(nearest, GRASS_NEAR_DISTANCE, item.group.geometry === item.farGeometry, 3);
          item.group.geometry = far ? item.farGeometry : item.nearGeometry;
        }
        continue;
      }
      item.group.visible = !(overview && ['track', 'sleepers', 'fasteners'].includes(item.kind)) && distance < radius + item.radius;
      if (item.kind === 'fasteners') item.group.visible = item.group.visible && Math.abs(this.lastSpeed) < 12 && distance < 95;
      if (item.group.visible) for (const mesh of item.group.children) {
        const lod = mesh.userData.sceneryLOD;
        if (!lod) continue;
        const threshold = lod.switchDistance + (item.bounds ? 0 : item.radius * 0.5);
        const far = overview || chooseFarGeometry(nearest, threshold, lod.far, item.bounds ? 5 : 12);
        if (far !== lod.far) {
          mesh.geometry = far ? lod.farGeometry : lod.nearGeometry;
          mesh.material = far ? lod.farMaterial : lod.nearMaterial; lod.far = far;
        }
      }
    }
    this.overviewTrack.visible = overview;
    if (this.clouds) this.clouds.visible = !overview;
  }
  withSharedShadowCasters(cameras, draw) {
    const newlyVisible = [], detailed = [];
    const range = this.config.viewDistance;
    for (const item of this.cullGroups) {
      const { group } = item;
      if (!group.castShadow && !group.children.some(mesh => mesh.castShadow)) continue;
      let distance = Infinity, nearest = Infinity;
      for (const { position } of cameras) {
        distance = Math.min(distance, Math.hypot(position.x - item.x, position.z - item.z));
        if (item.bounds) nearest = Math.min(nearest, distanceToXZBounds(item.bounds, position.x, position.z));
      }
      if (distance >= range + item.radius) continue;
      if (!group.visible) { group.visible = true; newlyVisible.push(group); }
      for (const mesh of group.children) {
        const lod = mesh.userData.sceneryLOD;
        if (!mesh.castShadow || !lod?.far) continue;
        const useDetail = item.bounds ? nearest <= lod.switchDistance + 5 : distance <= lod.switchDistance + item.radius * 0.5 + 12;
        if (!useDetail) continue;
        mesh.geometry = lod.nearGeometry; mesh.material = lod.nearMaterial; detailed.push(mesh);
      }
    }
    try { return draw(); }
    finally {
      for (const group of newlyVisible) group.visible = false;
      for (const mesh of detailed) {
        const lod = mesh.userData.sceneryLOD;
        mesh.geometry = lod.farGeometry; mesh.material = lod.farMaterial;
      }
    }
  }
  dispose() {
    this.disposed = true; ++this.driverRequest; this.driver = null;
    this.scene.remove(this.group);
    for (const rig of this.carts) rig.turbo?.dispose();
    this.carts = []; this.primaryCart = null;
    this.group.traverse(node => { if (node.isInstancedMesh) node.dispose(); });
    this.ownedGeometry.forEach(g => g.dispose()); this.ownedMaterials.forEach(m => m.dispose()); this.ownedTextures.forEach(t => t.dispose());
    this.group.clear(); this.cullGroups = []; this.wheels = [];
    this.groundParts.clear(); this.terrainGrid = null;
    this.sceneryPlan = null; this.groundPadIndex = null;
  }
}

export function createAtmosphere(scene, renderer) {
  const hemi = new THREE.HemisphereLight('#e8f0e2', '#6c7652', 2.2); scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff0cf', 3.1); sun.position.set(-160, 240, 90); scene.add(sun); scene.add(sun.target);
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 1; sun.shadow.camera.far = SHADOW_DEPTH;
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70; sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
  sun.shadow.bias = -0.00012; sun.shadow.normalBias = 0.04;
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color('#719bb0') }, bottom: { value: new THREE.Color('#e8e6cc') } },
    vertexShader: 'varying vec3 vDirection; void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'varying vec3 vDirection;uniform vec3 top;uniform vec3 bottom;void main(){float h=normalize(vDirection).y;gl_FragColor=vec4(mix(bottom,top,smoothstep(-.06,.7,h)),1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}'
  });
  const skyGeometry = new THREE.SphereGeometry(18000, 24, 16), sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);
  const envScene = new THREE.Scene(); const envSky = new THREE.Mesh(new THREE.SphereGeometry(100, 16, 12), skyMaterial); envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer); const environment = pmrem.fromScene(envScene, 0.04, 0.1, 200);
  scene.environment = environment.texture; scene.environmentIntensity = 0.55; envSky.geometry.dispose(); pmrem.dispose();
  let outsideFog = new THREE.Color('#c7d5c2');
  const lightOffset = new THREE.Vector3(-100, 170, 70), lightZ = lightOffset.clone().normalize();
  const lightX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), lightZ).normalize();
  const lightY = new THREE.Vector3().crossVectors(lightZ, lightX), focus = new THREE.Vector3();
  const shadowTargets = [null, null];
  let shadowSlot = 0, shadowSettings = { mapSize: 2048, radius: 70 }, sharedFrame = null;
  function setShadowFrame(frame) {
    const shadow = sun.shadow, shadowCamera = shadow.camera;
    const { mapSize, radius } = shadowSettings;
    const slot = frame ? 1 : 0;
    const width = frame?.width ?? mapSize, height = frame?.height ?? mapSize;
    if (slot !== shadowSlot) {
      shadowTargets[shadowSlot] = shadow.map;
      shadow.map = shadowTargets[slot]; shadowSlot = slot;
    }
    if (shadow.mapSize.x !== width || shadow.mapSize.y !== height) {
      shadow.map?.setSize(width, height);
      shadow.mapSize.set(width, height);
      shadow.needsUpdate = true;
    }
    const halfX = frame?.halfX ?? radius, halfY = frame?.halfY ?? radius, far = frame?.far ?? SHADOW_DEPTH;
    if (shadowCamera.right !== halfX || shadowCamera.top !== halfY || shadowCamera.far !== far) {
      shadowCamera.left = -halfX; shadowCamera.right = halfX;
      shadowCamera.bottom = -halfY; shadowCamera.top = halfY;
      shadowCamera.far = far; shadowCamera.updateProjectionMatrix();
      shadow.bias = -0.00012 * (SHADOW_DEPTH - 1) / (far - 1);
    }
    sharedFrame = frame;
  }
  return { sun, hemi, sky, environment, setBiomes(a, b, mixture) {
    const fog = new THREE.Color(0);
    for(const row of mixture || [{biome:a,percent:50},{biome:b,percent:50}]){ const c=new THREE.Color(PALETTES[row.biome].sky),w=row.percent/100;fog.r+=c.r*w;fog.g+=c.g*w;fog.b+=c.b*w; }
    skyMaterial.uniforms.bottom.value.copy(fog); scene.fog = new THREE.Fog(fog, 170, 600);
    outsideFog.copy(fog);
  }, setShadowProfile(profile) {
    shadowSettings = profile; setShadowFrame(null);
  }, setShadowFrame,
  sharedShadowFor(positions, maxTextureSize) {
    const projected = positions.map(position => ({ x: position.dot(lightX), y: position.dot(lightY), z: position.dot(lightZ) }));
    return planSharedShadow(shadowSettings, projected, maxTextureSize, sharedFrame);
  }, update(camera, position, shadows, tunnel = 0) {
    sky.position.copy(camera.position); sun.castShadow = shadows;
    // Keep the shadow projection on whole texels as the cart moves.
    const texel = shadowSettings.radius * 2 / shadowSettings.mapSize;
    const x = sharedFrame?.x ?? Math.round(position.dot(lightX) / texel) * texel;
    const y = sharedFrame?.y ?? Math.round(position.dot(lightY) / texel) * texel;
    const z = sharedFrame?.z ?? position.dot(lightZ);
    focus.copy(lightX).multiplyScalar(x).addScaledVector(lightY, y).addScaledVector(lightZ, z);
    sun.position.copy(focus).add(lightOffset); sun.target.position.copy(focus);
    sun.target.updateMatrixWorld();
    hemi.intensity = lerp(2.2, 0.70, tunnel); sun.intensity = lerp(3.1, 0.30, tunnel);
    scene.environmentIntensity = lerp(0.55, 0.18, tunnel);
    if (scene.fog) scene.fog.color.copy(outsideFog).lerp(new THREE.Color('#273b35'), tunnel);
  } };
}
