import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { TAU, lerp, clamp, wrap, smoothstep, randomGenerator, createRoute, stationsFor, biomeMix, trackSegments } from './core.js?v=6.0.0';
import { sleeperLayout, sleeperFilter, planRouteFeatures, featureAt, bridgeCoordinates, bridgeGroundHeight, riverBend } from './route-features.js?v=6.0.0';
import { buildMountainBackdrop, buildVariedClouds, updateClouds, buildBridgeAndRiver, buildTunnel } from './scenery.js?v=6.0.0';
import { fitGroundContact, prepareGroundedParts, groundBatchGeometry, renderedGroundHeight } from './grounding.js?v=6.0.0';
import { planScenery, indexGroundPads, paddedHeight } from './scenery-plan.js?v=6.0.0';
import { createStandingDriver } from './drivers.js?v=6.0.0';

export const PALETTES = {
  Forest: { ground: '#829565', detail: '#62794d', sky: '#bed0ba', amplitude: 12 },
  Hills: { ground: '#a0aa75', detail: '#829260', sky: '#c8d4bb', amplitude: 43 },
  Pastoral: { ground: '#b4ae77', detail: '#879a60', sky: '#d6d9ba', amplitude: 9 },
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
  constructor(manifest) { this.manifest = manifest; this.loader = new GLTFLoader(); this.cache = new Map(); this.pending = new Map(); }
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
  }
}

export class RailWorld {
  constructor(scene, store, config) {
    this.scene = scene; this.store = store; this.config = config;
    this.route = createRoute(config.length * 1000, config.seed, 8192, { elevationLimit: config.elevationLimit || 0, stations: config.stations });
    this.stations = stationsFor(this.route, config.stations);
    this.features = config.features ? planRouteFeatures(this.route, this.stations, config.seed) : { bridge: null, tunnel: null };
    this.group = new THREE.Group(); scene.add(this.group);
    this.cullGroups = []; this.ownedGeometry = []; this.ownedMaterials = []; this.ownedTextures = [];
    this.instanceCount = 0; this.sceneryCount = 0; this.terrainChunks = 0;
    this.wheels = []; this.waterMaterials = [];
    this.driver = null; this.driverRequest = 0; this.disposed = false;
    this.partsOverrides = new Map(); this.environmentElapsed = 0; this.lastSpeed = 0;
    this.groundParts = new Map(); this.terrainGrid = null;
    this.sceneryPlan = null; this.groundPadIndex = null;
    this.sleeperUniforms = { exposure: { value: 0 }, contrast: { value: 0 }, enabled: { value: config.sleeperFilter === false ? 0 : 1 } };
    this.paletteA = PALETTES[config.biomeA]; this.paletteB = PALETTES[config.biomeB];
    this.colorA = new THREE.Color(this.paletteA.ground); this.colorB = new THREE.Color(this.paletteB.ground);
    this.detailA = new THREE.Color(this.paletteA.detail); this.detailB = new THREE.Color(this.paletteB.detail);
    this.tmpSample = {}; this.cartSample = {}; this.cartFrontSample = {}; this.cartRearSample = {};
    this.elevationField = this.createElevationField();
    this.lake = this.planLake();
    if (this.features.bridge) {
      const b = this.features.bridge, biome = this.mixAt(b.x, b.z) < 0.5 ? config.biomeA : config.biomeB;
      b.style = ['Forest', 'Pastoral', 'Rural'].includes(biome) ? 'wood' : 'steel';
      b.name = b.style === 'wood' ? '河谷木橋' : '河谷鋼橋';
    }
  }
  createElevationField() {
    const nx = 32, nz = 16, d = this.route.squareSize, values = new Float64Array((nx + 1) * (nz + 1));
    const anchors = Array.from({ length: 64 }, (_, i) => this.route.sample(i / 64 * this.route.length));
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
    const { nx, nz, values } = this.elevationField, d = this.route.squareSize;
    const fx = clamp((x + d) / (2 * d) * nx, 0, nx), fz = clamp((z + d / 2) / d * nz, 0, nz);
    const ix = Math.min(nx - 1, Math.floor(fx)), iz = Math.min(nz - 1, Math.floor(fz)), a = iz * (nx + 1) + ix;
    return lerp(lerp(values[a], values[a + 1], fx - ix), lerp(values[a + nx + 1], values[a + nx + 2], fx - ix), fz - iz);
  }
  planLake() {
    if (![this.config.biomeA, this.config.biomeB].includes('Lakeside')) return null;
    const side = this.config.biomeA === 'Lakeside' ? -1 : 1, d = this.route.squareSize;
    let chosen = null, best = 0;
    for (let i = 0; i < 70; i++) {
      const x = side * d * (0.16 + (i % 10) * 0.065), z = d * (-0.25 + Math.floor(i / 10) * 0.08);
      const distance = this.route.distanceTo(x, z, 230);
      if (distance > best) { best = distance; chosen = { x, z }; }
    }
    return { ...chosen, radius: Math.min(150, best * 0.76), depthScale: 0.68, level: this.baseElevation(chosen.x, chosen.z) - 0.16 };
  }
  lakeRadiusAt(x, z) {
    if (!this.lake) return Infinity;
    return Math.hypot(x - this.lake.x, (z - this.lake.z) / this.lake.depthScale);
  }
  mixAt(x, z) { return biomeMix(x, z, this.route.squareSize); }
  rawHeight(x, z) {
    const mix = this.mixAt(x, z), a = lerp(this.paletteA.amplitude, this.paletteB.amplitude, mix);
    const broad = Math.sin(x * 0.0051 + 2) * Math.cos(z * 0.0043 - 0.8);
    const medium = Math.sin(x * 0.014 + z * 0.006) * Math.cos(z * 0.012);
    let h = this.baseElevation(x, z) + (0.55 + broad * 0.6 + medium * 0.19) * a - 1.3;
    if (this.lake) {
      const r = this.lakeRadiusAt(x, z), edge = this.lake.radius;
      const basin = lerp(this.lake.level - 2.5, this.lake.level + 1.2, smoothstep(edge - 12, edge + 23, r));
      h = lerp(basin, h, smoothstep(edge + 23, edge + 65, r));
    }
    return h;
  }
  heightAt(x, z, knownProximity) {
    const near = typeof knownProximity === 'object' ? knownProximity : this.route.nearestTo(x, z, 110);
    const terrain = this.rawHeight(x, z);
    if (near.y === undefined) return paddedHeight(this.groundPadIndex, x, z, bridgeGroundHeight(this.features.bridge, x, z, terrain));
    // A graded earthwork supports the rails; distant land follows the same
    // elevation field, rather than leaving an elevated railway floating in air.
    return paddedHeight(this.groundPadIndex, x, z, bridgeGroundHeight(this.features.bridge, x, z, lerp(near.y - 0.09, terrain, smoothstep(20, 105, near.distance))));
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
    const infrastructure = this.config.features ? ['Building_Bridge_SteelTruss8m_001', 'Building_Bridge_TimberDeck4m_001', 'Building_Bridge_StonePier4m_001', 'Building_Bridge_Abutment_001',
      'Building_Tunnel_StonePortal_001', 'Building_Tunnel_RockStraight4m_001', 'Environment_Terrain_RiverStraight8m_001'] : [];
    const lakeModels = this.lake ? this.store.manifest.biomes.Lakeside.models : [];
    const ids = [...this.sceneryPlan.placements.map(p => p.id), ...lakeModels,
      ...this.store.manifest.stationModels, 'Environment_Rail_RailSection_1m_001', 'Environment_Rail_Sleeper_001', 'Environment_Rail_Fastener_001', ...infrastructure, this.config.vehicle, ...(this.config.driver ? [this.config.driver] : [])];
    await this.store.load(ids, (p, id) => onProgress(0.08 + p * 0.32, `讀取 ${this.store.manifest.models[id].name}`));
    onProgress(0.42, '鋪設閉合軌道…'); await yieldFrame(); this.buildTrack();
    onProgress(0.55, '混合 A、B 區地表…'); await yieldFrame(); await this.buildTerrain();
    onProgress(0.70, '佈置沿線地景…'); await yieldFrame(); await this.buildScenery();
    onProgress(0.87, '建立跨河橋與穿山隧道…'); await yieldFrame();
    if (this.config.features) { buildBridgeAndRiver(this); buildTunnel(this); }
    onProgress(0.94, '建立車站、礦車與遠景…'); await yieldFrame(); this.buildStations(); this.buildCart();
    this.createClouds();
    onProgress(1, '旅程準備就緒');
    return this;
  }
  addBatches(id, placements, { size = 160, kind = 'scenery', castShadow } = {}) {
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
      const lod = this.store.manifest?.models[id]?.lod;
      const farSource = lod && !values[0].groundPatch ? this.store.get(id, 1) : null;
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
        mesh.castShadow = Boolean(casts); mesh.receiveShadow = true;
        if (farSource?.parts[partIndex]) {
          const far = farSource.parts[partIndex];
          mesh.userData.sceneryLOD = { nearGeometry: geometry, nearMaterial: part.material, farGeometry: far.geometry, farMaterial: far.material, switchDistance: lod.switchDistance, far: false };
        }
        group.add(mesh);
      }
      this.group.add(group);
      this.cullGroups.push({ group, x: (cx + 0.5) * size, z: (cz + 0.5) * size, radius: size * 0.82, kind });
    }
    this.instanceCount += placements.length;
  }
  buildTrack() {
    const segments = trackSegments(this.route);
    const rails = [];
    for (const s of segments) {
      const p = this.route.sample(s.start);
      for (const side of [-1, 1]) rails.push({ x: s.x + p.nx * side * 0.8885 + p.upX * 0.205,
        y: s.y + p.upY * 0.205, z: s.z + p.nz * side * 0.8885 + p.upZ * 0.205, yaw: s.yaw, pitch: s.pitch, sz: s.length });
    }
    this.addBatches('Environment_Rail_RailSection_1m_001', rails, { size: 96, kind: 'track' });
    this.prepareSleeperMaterial();
    const layout = sleeperLayout(this.route.length, this.config.sleeperSpacing || 0.75, this.config.seed), ties = [], bolts = [];
    this.sleeperPitch = layout.pitch;
    for (const item of layout.placements) {
      const p = this.route.sample(item.distance);
      ties.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, tone: item.tone });
      for (const side of [-1, 1]) bolts.push({ x: p.x + p.nx * side * 0.8885 + p.upX * 0.18,
        y: p.y + p.upY * 0.18, z: p.z + p.nz * side * 0.8885 + p.upZ * 0.18, yaw: p.yaw, pitch: p.pitch });
    }
    this.addBatches('Environment_Rail_Sleeper_001', ties, { size: 96, kind: 'sleepers' });
    this.addBatches('Environment_Rail_Fastener_001', bolts, { size: 96, kind: 'fasteners' });
    this.sleeperInstances = ties.length;
    const bed = [], bedIndices = [], bedCount = Math.ceil(this.route.length / 2);
    for (let i = 0; i <= bedCount; i++) {
      const p = this.route.sample(i / bedCount * this.route.length);
      for (const side of [-1, 1]) bed.push(p.x + p.nx * side * 1.49, p.y - 0.035, p.z + p.nz * side * 1.49);
      if (i) { const a = (i - 1) * 2; bedIndices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const bedGeometry = new THREE.BufferGeometry(); bedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bed, 3)); bedGeometry.setIndex(bedIndices); bedGeometry.computeVertexNormals();
    const bedMaterial = new THREE.MeshStandardMaterial({ color: '#a79a7d', roughness: 1, side: THREE.DoubleSide });
    const bedMesh = new THREE.Mesh(bedGeometry, bedMaterial); bedMesh.receiveShadow = true; this.group.add(bedMesh); this.ownedGeometry.push(bedGeometry); this.ownedMaterials.push(bedMaterial);
    this.trackInstances = segments.length;
    const overviewPoints = this.route.points.filter((_, i) => i % 8 === 0).map(p => new THREE.Vector3(p.x, p.y + 0.46, p.z));
    const geometry = new THREE.BufferGeometry().setFromPoints(overviewPoints);
    const material = new THREE.LineBasicMaterial({ color: '#926848' });
    this.overviewTrack = new THREE.LineLoop(geometry, material); this.overviewTrack.visible = false;
    this.group.add(this.overviewTrack); this.ownedGeometry.push(geometry); this.ownedMaterials.push(material);
  }
  prepareSleeperMaterial() {
    const original = this.store.get('Environment_Rail_Sleeper_001');
    const parts = original.parts.map(part => {
      const geometry = part.geometry.clone(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      geometry.boundingBox.min.z -= 0.8; geometry.boundingBox.max.z += 0.8; geometry.boundingSphere.radius += 0.8;
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
      this.ownedGeometry.push(geometry); return { ...part, geometry, material };
    });
    this.partsOverrides.set('Environment_Rail_Sleeper_001', { parts });
  }
  async buildTerrain() {
    await this.prepareScenery();
    const d = this.route.squareSize, tile = 192;
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    this.ownedMaterials.push(material);
    const color = new THREE.Color(), detail = new THREE.Color();
    const nx = Math.ceil(2 * d / tile), nz = Math.ceil(d / tile);
    const width = 2 * d / nx, depth = d / nz;
    this.terrainGrid = { d, nx, nz, width, depth, tiles: [] };
    const riverDetailAt = (x, z) => {
      if (this.sceneryPlan?.pads.some(p => Math.abs(x - p.x) < tile * 0.55 + p.outer && Math.abs(z - p.z) < tile * 0.55 + p.outer)) return true;
      if (!this.features.bridge) return false;
      const p = bridgeCoordinates(this.features.bridge, x, z);
      return Math.abs(p.across) < 36 + tile * 0.72 && Math.abs(p.along) < 204 + tile * 0.72;
    };
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x0 = -d + ix * width, z0 = -d * 0.5 + iz * depth;
        const cx = x0 + width / 2, cz = z0 + depth / 2, detailedRiver = riverDetailAt(cx, cz);
        const coarseLeft = !riverDetailAt(cx - width, cz), coarseRight = !riverDetailAt(cx + width, cz);
        const coarseTop = !riverDetailAt(cx, cz - depth), coarseBottom = !riverDetailAt(cx, cz + depth);
        const segments = detailedRiver ? 48 : 12;
        const verts = [], colors = [], indices = [], normals = [];
        for (let z = 0; z <= segments; z++) for (let x = 0; x <= segments; x++) {
          const wx = x0 + x / segments * width, wz = z0 + z / segments * depth;
          const near = this.route.nearestTo(wx, wz, 110);
          let h = this.heightAt(wx, wz, near);
          // Resolve the narrow river channel without refining the whole map.
          // Fine-tile edges follow the coarse neighbor's linear edge exactly.
          const vertical = (x === 0 && coarseLeft) || (x === segments && coarseRight);
          const horizontal = (z === 0 && coarseTop) || (z === segments && coarseBottom);
          if (detailedRiver && (vertical || horizontal)) {
            const t = (vertical ? z : x) / segments * 12, k = Math.min(11, Math.floor(t));
            const a = vertical ? this.heightAt(wx, z0 + k / 12 * depth) : this.heightAt(x0 + k / 12 * width, wz);
            const b = vertical ? this.heightAt(wx, z0 + (k + 1) / 12 * depth) : this.heightAt(x0 + (k + 1) / 12 * width, wz);
            h = lerp(a, b, t - k);
          }
          verts.push(wx, h, wz);
          const normal = new THREE.Vector3(this.heightAt(wx - 1, wz) - this.heightAt(wx + 1, wz), 2,
            this.heightAt(wx, wz - 1) - this.heightAt(wx, wz + 1)).normalize();
          normals.push(normal.x, normal.y, normal.z);
          const mix = this.mixAt(wx, wz), speckle = 0.11 + 0.11 * Math.sin(wx * 0.073) * Math.cos(wz * 0.067);
          color.copy(this.colorA).lerp(this.colorB, mix); detail.copy(this.detailA).lerp(this.detailB, mix);
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
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
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
    for (const [id, placements] of batches) this.addBatches(id, placements, { size: this.store.manifest.models[id].lod ? 224 : 160, kind: 'scenery' });
    this.sceneryCount = this.sceneryPlan.placements.length;
    this.buildDistrictPaths();
    if (this.lake) this.buildLake();
  }
  buildDistrictPaths() {
    const material = new THREE.MeshStandardMaterial({ color: '#aaa18a', roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.ownedMaterials.push(material);
    for (const district of this.sceneryPlan.districts) {
      if (district.buildings.length < 2) continue;
      const verts = [], indices = [], segments = 28, c = Math.cos(district.yaw), s = Math.sin(district.yaw);
      for (let i = 0; i <= segments; i++) {
        const v = (i / segments * 2 - 1) * district.laneHalfLength;
        for (const u of [-2.1, 2.1]) {
          const x = district.x + c * u + s * v, z = district.z - s * u + c * v;
          verts.push(x, renderedGroundHeight(this.terrainGrid, x, z) + 0.045, z);
        }
        if (i) { const k = (i - 1) * 2; indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
      const path = new THREE.Mesh(geometry, material); path.receiveShadow = true; path.name = 'village-lane';
      this.group.add(path); this.ownedGeometry.push(geometry);
      this.cullGroups.push({ group: path, x: district.x, z: district.z, radius: district.laneHalfLength + 4, kind: 'scenery' });
    }
  }
  buildLake() {
    if (!this.lake) return;
    const { x, z, radius, depthScale, level } = this.lake;
    const geometry = new THREE.CircleGeometry(radius + 8, 80); geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({ color: '#699eaa', roughness: 0.24, metalness: 0.12 });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, level, z); mesh.scale.z = depthScale;
    this.group.add(mesh); this.ownedGeometry.push(geometry); this.ownedMaterials.push(material); this.waterMaterials.push(material);
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
    for (const s of this.stations) {
      const side = 1;
      const at = (offset, along = 0, y = 0) => ({ x: s.x + s.nx * offset * side + s.tx * along, z: s.z + s.nz * offset * side + s.tz * along, y: s.y + y, yaw: s.yaw });
      for (let i = -2; i < 3; i++) { platform.push(at(3.2, i * 4)); if (i >= -1 && i <= 1) canopy.push(at(3.2, i * 4)); }
      hut.push(at(10.5, -4)); signs.push(at(6.1, 8)); lamps.push(at(6.3, -10), at(6.3, 11));
      const board = this.makeLabel(s.name, s.index === 0 ? 'A / DEPARTURE' : `STATION 0${s.index + 1}`);
      const p = at(4.7, 0, 5.6); board.position.set(p.x, p.y, p.z); board.scale.set(9.6, 3.0, 1); this.group.add(board);
      const padGeo = new THREE.BoxGeometry(23, 0.18, 35);
      const padMat = new THREE.MeshStandardMaterial({ color: '#c3bda5', roughness: 0.95 });
      const pad = new THREE.Mesh(padGeo, padMat); const padP = at(9.0, 0, -0.08);
      pad.position.set(padP.x, padP.y, padP.z); pad.rotation.y = s.yaw; pad.receiveShadow = true; this.group.add(pad);
      this.ownedGeometry.push(padGeo); this.ownedMaterials.push(padMat);
    }
    const shadow = this.config.shadows;
    this.addBatches('Building_Station_Platform4m_001', platform, { kind: 'station', castShadow: shadow });
    this.addBatches('Building_Station_Canopy4m_001', canopy, { kind: 'station', castShadow: shadow });
    this.addBatches('Building_Station_TicketHut_001', hut, { kind: 'station', castShadow: shadow });
    this.addBatches('Prop_Station_StationSign_001', signs, { kind: 'station', castShadow: shadow });
    this.addBatches('Prop_Lineside_TracksideLamp_001', lamps, { kind: 'station', castShadow: shadow });
  }
  makeLabel(title, subtitle) {
    const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#173d36'; ctx.beginPath(); ctx.roundRect(4, 4, 760, 228, 14); ctx.fill();
    ctx.strokeStyle = '#cdd5a9'; ctx.lineWidth = 2; ctx.strokeRect(16, 16, 736, 204);
    ctx.textAlign = 'center'; ctx.fillStyle = '#f3efd5'; ctx.font = '500 70px "Microsoft JhengHei",sans-serif'; ctx.fillText(title, 384, 116);
    ctx.fillStyle = '#bdc99b'; ctx.font = '22px "Segoe UI",sans-serif'; ctx.fillText(subtitle, 384, 177);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: true, sizeAttenuation: true });
    this.ownedTextures.push(texture); this.ownedMaterials.push(material);
    return new THREE.Sprite(material);
  }
  buildCart() {
    const source = this.store.get(this.config.vehicle);
    this.cart = source.root.clone(true);
    this.cart.traverse(node => { if (node.isMesh) { node.castShadow = this.config.shadows; node.receiveShadow = true; } });
    const prefix = this.config.vehicle.includes('GoldenOak') ? 'GoldenOak' : this.config.vehicle.includes('AzureLake') ? 'AzureLake' : 'RedCopper';
    for (const suffix of ['FL', 'FR', 'RL', 'RR']) {
      const node = this.cart.getObjectByName(`${prefix}_Wheel_${suffix}`);
      if (node) this.wheels.push({ node, original: node.quaternion.clone() });
    }
    this.cartLever = this.cart.getObjectByName(`${prefix}_Lever`);
    this.cartLeverBase = this.cartLever?.quaternion.clone();
    this.cart.position.y = 0.405 - 0.024;
    this.group.add(this.cart);
    if (this.config.driver) this.attachDriver(this.config.driver);
    this.updateCart(0, 0, 0);
  }
  attachDriver(id) {
    if (!this.store.manifest.drivers?.includes(id)) throw new Error('找不到動物駕駛。');
    const next = createStandingDriver(this.store.get(id).root, this.config.vehicle, {
      id, name: this.store.manifest.models[id].name, shadows: this.config.shadows,
      staticClip: this.store.get(id).animations?.find(clip => clip.name === 'static')
    });
    if (this.driver) this.cart.remove(this.driver);
    this.cart.add(next); this.driver = next; this.config.driver = id;
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
  structureAt(distance, padding = 0) { return featureAt(this.features, distance, this.route.length, padding); }
  tunnelFactor(distance) {
    const tunnel = this.features.tunnel;
    if (!tunnel) return 0;
    const s = wrap(distance, this.route.length);
    return smoothstep(tunnel.start, tunnel.start + 6, s) * (1 - smoothstep(tunnel.end - 6, tunnel.end, s));
  }
  updateEnvironment(dt, speed, frameSeconds) {
    this.environmentElapsed += dt; this.lastSpeed = speed;
    const filter = sleeperFilter(speed, frameSeconds, this.sleeperPitch || 0.75, this.config.sleeperFilter !== false);
    this.sleeperUniforms.exposure.value = filter.exposure; this.sleeperUniforms.contrast.value = filter.contrastReduction; this.sleeperUniforms.enabled.value = filter.enabled;
    updateClouds(this, this.environmentElapsed);
  }
  updateCart(distance, odometer, throttle) {
    const p = this.route.sample(distance, this.cartSample);
    // Use a two-metre track chord for body attitude. The arc-table position is
    // exact; this removes tiny tangent jumps at successive polyline samples.
    const front = this.route.sample(distance + 1, this.cartFrontSample), rear = this.route.sample(distance - 1, this.cartRearSample);
    const dx = front.x - rear.x, dy = front.y - rear.y, dz = front.z - rear.z;
    const horizontal = Math.hypot(dx, dz), length = Math.hypot(horizontal, dy);
    p.tx = dx / horizontal; p.tz = dz / horizontal; p.tx3 = dx / length; p.ty = dy / length; p.tz3 = dz / length;
    p.pitch = -Math.atan2(dy, horizontal); p.yaw = Math.atan2(dx, dz); p.nx = p.tz; p.nz = -p.tx;
    p.upX = -p.tx * p.ty; p.upY = horizontal / length; p.upZ = -p.tz * p.ty;
    this.cart.position.set(p.x + 0.381 * p.upX, p.y + 0.381 * p.upY, p.z + 0.381 * p.upZ);
    this.cart.quaternion.setFromEuler(rotationEuler.set(p.pitch, p.yaw, 0, 'YXZ'));
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), distance / 0.346);
    for (const wheel of this.wheels) wheel.node.quaternion.copy(wheel.original).multiply(q);
    if (this.cartLever) {
      q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -throttle * 0.35);
      this.cartLever.quaternion.copy(this.cartLeverBase).multiply(q);
    }
    return p;
  }
  setVisibility(camera, farDistance, overview = false) {
    const cx = camera.position.x, cz = camera.position.z;
    const radius = overview ? this.route.squareSize * 4 : farDistance;
    for (const item of this.cullGroups) {
      const distance = Math.hypot(cx - item.x, cz - item.z);
      item.group.visible = !(overview && ['track', 'sleepers', 'fasteners'].includes(item.kind)) && distance < radius + item.radius;
      if (item.kind === 'fasteners') item.group.visible = item.group.visible && Math.abs(this.lastSpeed) < 12 && distance < 95;
      if (item.group.visible) for (const mesh of item.group.children) {
        const lod = mesh.userData.sceneryLOD;
        if (!lod) continue;
        const threshold = lod.switchDistance + item.radius * 0.5;
        const far = overview || distance > threshold + (lod.far ? -12 : 12);
        if (far !== lod.far) {
          mesh.geometry = far ? lod.farGeometry : lod.nearGeometry;
          mesh.material = far ? lod.farMaterial : lod.nearMaterial; lod.far = far;
        }
      }
    }
    this.overviewTrack.visible = overview;
    if (this.clouds) this.clouds.visible = !overview;
  }
  dispose() {
    this.disposed = true; ++this.driverRequest; this.driver = null;
    this.scene.remove(this.group);
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
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 1; sun.shadow.camera.far = 650;
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
  return { sun, hemi, sky, environment, setBiomes(a, b) {
    const fog = new THREE.Color(PALETTES[a].sky).lerp(new THREE.Color(PALETTES[b].sky), 0.5);
    skyMaterial.uniforms.bottom.value.copy(fog); scene.fog = new THREE.Fog(fog, 170, 600);
    outsideFog.copy(fog);
  }, update(camera, position, shadows, tunnel = 0, sceneryShadows = false) {
    sky.position.copy(camera.position); sun.castShadow = shadows;
    const radius = sceneryShadows ? 180 : 70, shadowCamera = sun.shadow.camera;
    if (shadowCamera.right !== radius) {
      shadowCamera.left = shadowCamera.bottom = -radius; shadowCamera.right = shadowCamera.top = radius;
      shadowCamera.updateProjectionMatrix();
    }
    // Keep the shadow projection on whole texels as the cart moves.
    const texel = radius * 2 / sun.shadow.mapSize.x;
    const x = Math.round(position.dot(lightX) / texel) * texel, y = Math.round(position.dot(lightY) / texel) * texel;
    focus.copy(lightX).multiplyScalar(x).addScaledVector(lightY, y).addScaledVector(lightZ, position.dot(lightZ));
    sun.position.copy(focus).add(lightOffset); sun.target.position.copy(focus);
    sun.target.updateMatrixWorld();
    hemi.intensity = lerp(2.2, 0.70, tunnel); sun.intensity = lerp(3.1, 0.30, tunnel);
    scene.environmentIntensity = lerp(0.55, 0.18, tunnel);
    if (scene.fog) scene.fog.color.copy(outsideFog).lerp(new THREE.Color('#273b35'), tunnel);
  } };
}
