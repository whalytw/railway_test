import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { TAU, lerp, clamp, smoothstep, randomGenerator, createRoute, stationsFor, biomeMix, trackSegments } from './core.js';

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
const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));

export class AssetStore {
  constructor(manifest) { this.manifest = manifest; this.loader = new GLTFLoader(); this.cache = new Map(); this.pending = new Map(); }
  async load(ids, onProgress = () => {}) {
    const unique = [...new Set(ids)];
    let done = 0;
    // Bound concurrent image decoding on small integrated GPUs.
    const queue = [...unique];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift();
        if (!this.cache.has(id)) {
          if (!this.pending.has(id)) this.pending.set(id, this.loader.loadAsync(this.manifest.models[id].url).then(gltf => {
            const root = gltf.scene;
            root.updateMatrixWorld(true);
            const parts = [];
            root.traverse(node => {
              if (node.isMesh) {
                node.castShadow = false; node.receiveShadow = true;
                parts.push({ geometry: node.geometry, material: node.material, matrix: node.matrixWorld.clone() });
              }
            });
            const asset = { root, parts, bounds: new THREE.Box3().setFromObject(root) };
            this.cache.set(id, asset); this.pending.delete(id);
            return asset;
          }).catch(error => { this.pending.delete(id); throw new Error(`模型讀取失敗：${id}。${error.message}`); }));
          await this.pending.get(id);
        }
        onProgress(++done / unique.length, id);
      }
    }));
  }
  get(id) { const value = this.cache.get(id); if (!value) throw new Error(`模型尚未載入：${id}`); return value; }
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
    this.route = createRoute(config.length * 1000, config.seed);
    this.stations = stationsFor(this.route, config.stations);
    this.group = new THREE.Group(); scene.add(this.group);
    this.cullGroups = []; this.ownedGeometry = []; this.ownedMaterials = []; this.ownedTextures = [];
    this.instanceCount = 0; this.sceneryCount = 0; this.terrainChunks = 0;
    this.wheels = []; this.waterMaterials = [];
    this.paletteA = PALETTES[config.biomeA]; this.paletteB = PALETTES[config.biomeB];
    this.colorA = new THREE.Color(this.paletteA.ground); this.colorB = new THREE.Color(this.paletteB.ground);
    this.detailA = new THREE.Color(this.paletteA.detail); this.detailB = new THREE.Color(this.paletteB.detail);
    this.tmpSample = {}; this.cartSample = {};
    this.lake = this.planLake();
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
    return { ...chosen, radius: Math.min(150, best * 0.76), depthScale: 0.68, level: -0.16 };
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
    let h = (0.55 + broad * 0.6 + medium * 0.19) * a - 1.3;
    if (this.lake) {
      const r = this.lakeRadiusAt(x, z), edge = this.lake.radius;
      const basin = lerp(this.lake.level - 2.5, this.lake.level + 1.2, smoothstep(edge - 12, edge + 23, r));
      h = lerp(basin, h, smoothstep(edge + 23, edge + 65, r));
    }
    return h;
  }
  heightAt(x, z, knownDistance) {
    const d = knownDistance ?? this.route.distanceTo(x, z, 70);
    // The flat verge is wider than a terrain cell diagonal, preventing the
    // interpolated ground triangles from cutting through rails between vertices.
    return lerp(-0.07, this.rawHeight(x, z), smoothstep(20, 75, d));
  }
  async build(onProgress = () => {}) {
    const ids = [...this.store.manifest.biomes[this.config.biomeA].models, ...this.store.manifest.biomes[this.config.biomeB].models,
      ...this.store.manifest.stationModels, 'Environment_Rail_Straight_2m_001', this.config.vehicle];
    await this.store.load(ids, (p, id) => onProgress(p * 0.4, `讀取 ${this.store.manifest.models[id].name}`));
    onProgress(0.42, '鋪設閉合軌道…'); await yieldFrame(); this.buildTrack();
    onProgress(0.55, '混合 A、B 區地表…'); await yieldFrame(); await this.buildTerrain();
    onProgress(0.70, '佈置沿線地景…'); await yieldFrame(); await this.buildScenery();
    onProgress(0.90, '建立車站與礦車…'); await yieldFrame(); this.buildStations(); this.buildCart();
    this.createClouds();
    onProgress(1, '旅程準備就緒');
    return this;
  }
  addBatches(id, placements, { size = 160, kind = 'scenery', castShadow = false } = {}) {
    const bins = new Map(), source = this.store.get(id);
    for (const p of placements) {
      const key = `${Math.floor(p.x / size)},${Math.floor(p.z / size)}`;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(p);
    }
    for (const [key, values] of bins) {
      const [cx, cz] = key.split(',').map(Number);
      const group = new THREE.Group(); group.name = `${kind}:${id}:${key}`;
      for (const part of source.parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, values.length);
        for (let i = 0; i < values.length; i++) {
          const p = values[i];
          position.set(p.x, p.y || 0, p.z); q.setFromAxisAngle(axisY, p.yaw || 0);
          scaling.set(p.sx ?? p.scale ?? 1, p.sy ?? p.scale ?? 1, p.sz ?? p.scale ?? 1);
          placementMatrix.compose(position, q, scaling); combined.multiplyMatrices(placementMatrix, part.matrix);
          mesh.setMatrixAt(i, combined);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere(); mesh.computeBoundingBox();
        mesh.castShadow = castShadow; mesh.receiveShadow = true;
        group.add(mesh);
      }
      this.group.add(group);
      this.cullGroups.push({ group, x: (cx + 0.5) * size, z: (cz + 0.5) * size, radius: size * 0.82, kind });
    }
    this.instanceCount += placements.length;
  }
  buildTrack() {
    const segments = trackSegments(this.route);
    const placements = segments.map(s => ({ x: s.x, z: s.z, y: 0, yaw: s.yaw, sz: s.length / 2 }));
    // Source GLB: +Z forward, two-metre segment; rail top = 0.405 m.
    this.addBatches('Environment_Rail_Straight_2m_001', placements, { size: 96, kind: 'track' });
    this.trackInstances = segments.length;
    const overviewPoints = this.route.points.filter((_, i) => i % 8 === 0).map(p => new THREE.Vector3(p.x, 0.46, p.z));
    const geometry = new THREE.BufferGeometry().setFromPoints(overviewPoints);
    const material = new THREE.LineBasicMaterial({ color: '#926848' });
    this.overviewTrack = new THREE.LineLoop(geometry, material); this.overviewTrack.visible = false;
    this.group.add(this.overviewTrack); this.ownedGeometry.push(geometry); this.ownedMaterials.push(material);
  }
  async buildTerrain() {
    const d = this.route.squareSize, tile = 192, segments = 12;
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    this.ownedMaterials.push(material);
    const color = new THREE.Color(), detail = new THREE.Color();
    const nx = Math.ceil(2 * d / tile), nz = Math.ceil(d / tile);
    const width = 2 * d / nx, depth = d / nz;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x0 = -d + ix * width, z0 = -d * 0.5 + iz * depth;
        const verts = [], colors = [], indices = [], normals = [];
        for (let z = 0; z <= segments; z++) for (let x = 0; x <= segments; x++) {
          const wx = x0 + x / segments * width, wz = z0 + z / segments * depth;
          const near = this.route.distanceTo(wx, wz, 80);
          const h = this.heightAt(wx, wz, near);
          verts.push(wx, h, wz);
          const normal = new THREE.Vector3(this.heightAt(wx - 1, wz) - this.heightAt(wx + 1, wz), 2,
            this.heightAt(wx, wz - 1) - this.heightAt(wx, wz + 1)).normalize();
          normals.push(normal.x, normal.y, normal.z);
          const mix = this.mixAt(wx, wz), speckle = 0.11 + 0.11 * Math.sin(wx * 0.073) * Math.cos(wz * 0.067);
          color.copy(this.colorA).lerp(this.colorB, mix); detail.copy(this.detailA).lerp(this.detailB, mix);
          color.lerp(detail, speckle);
          // A continuous dusty verge under the entire railway hides biome seams.
          color.lerp(new THREE.Color('#aca48b'), (1 - smoothstep(3, 9, near)) * 0.40);
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
        const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true;
        this.group.add(mesh); this.ownedGeometry.push(geometry); this.terrainChunks++;
        this.cullGroups.push({ group: mesh, x: x0 + width / 2, z: z0 + depth / 2, radius: tile, kind: 'terrain' });
      }
      if (iz % 4 === 0) await yieldFrame();
    }
  }
  async buildScenery() {
    const random = randomGenerator(`${this.config.seed}:scenery`), d = this.route.squareSize;
    const batches = new Map(), goal = this.config.density;
    const choose = (list, r) => list[Math.floor(r * list.length)];
    let added = 0, attempts = 0;
    while (added < goal && attempts < goal * 12) {
      attempts++;
      let x, z, near;
      // Most detail lives along the track, with far scenery filling both squares.
      if (random() < 0.76) {
        const p = this.route.sample(random() * this.route.length, this.tmpSample);
        const offset = (random() < 0.5 ? -1 : 1) * (17 + random() ** 1.65 * 185);
        x = p.x + p.nx * offset; z = p.z + p.nz * offset;
      } else { x = (random() * 2 - 1) * (d - 25); z = (random() - 0.5) * (d - 50); }
      if (Math.abs(x) > d - 18 || Math.abs(z) > d * 0.5 - 18) continue;
      near = this.route.distanceTo(x, z, 85);
      if (near < 12) continue;
      if (this.stations.some(s => Math.hypot(x - s.x, z - s.z) < 36)) continue;
      const biome = random() < this.mixAt(x, z) ? this.config.biomeB : this.config.biomeA;
      const list = this.store.manifest.biomes[biome].models.filter(id => !/WaterTile|StraightShore|Rowboat|WoodenPier/.test(id));
      const id = choose(list, random());
      let scale = 0.78 + random() * 0.65;
      if (/DistantRidge|RoundHill|RollingRidge|DuneTile|Cone16/.test(id)) {
        if (near < 42) continue;
        scale *= near > 110 ? 2.0 : 1.2;
      }
      const info = this.store.manifest.models[id], maxDim = Math.max(info.dimensions[0], info.dimensions[2]) * scale;
      if (near < maxDim * 0.6 + 7) continue;
      if (this.lakeRadiusAt(x, z) < (this.lake?.radius || 0) + maxDim * 0.5 + 4) continue;
      const bounds = this.store.get(id).bounds;
      // Terrain assets deliberately extend below y=0. Preserve their authored
      // surface origin so their underground foundation stays underground.
      const isLandform = /^(Environment_)/.test(id);
      const baseY = isLandform ? 0 : Math.max(0, bounds.min.y);
      const y = this.heightAt(x, z, near) - baseY * scale - 0.04;
      const p = { x, z, y, scale, yaw: random() * TAU };
      if (!batches.has(id)) batches.set(id, []);
      batches.get(id).push(p); added++;
      if (added % 4000 === 0) await yieldFrame();
    }
    for (const [id, placements] of batches) this.addBatches(id, placements, { size: 160, kind: 'scenery' });
    this.sceneryCount = added;
    // Broad, level lakes sit away from the rail corridor; repeated source water
    // tiles remain in the scenery population and this supplies a readable lake.
    if ([this.config.biomeA, this.config.biomeB].includes('Lakeside')) this.buildLake();
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
      const at = (offset, along = 0, y = 0) => ({ x: s.x + s.nx * offset * side + s.tx * along, z: s.z + s.nz * offset * side + s.tz * along, y, yaw: s.yaw });
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
    this.group.add(this.cart); this.updateCart(0, 0, 0);
  }
  createClouds() {
    const random = randomGenerator(`${this.config.seed}:clouds`), d = this.route.squareSize;
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({ color: '#f5f1df', transparent: true, opacity: 0.38, depthWrite: false, fog: false });
    const mesh = new THREE.InstancedMesh(geometry, material, 48);
    for (let i = 0; i < 48; i++) {
      position.set((random() * 2 - 1) * d * 1.2, 260 + random() * 240, (random() - 0.5) * d * 1.5);
      scaling.set(45 + random() * 80, 6 + random() * 13, 18 + random() * 34);
      q.identity(); placementMatrix.compose(position, q, scaling); mesh.setMatrixAt(i, placementMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); this.group.add(mesh);
    this.ownedGeometry.push(geometry); this.ownedMaterials.push(material); this.clouds = mesh;
  }
  updateCart(distance, odometer, throttle) {
    const p = this.route.sample(distance, this.cartSample);
    this.cart.position.set(p.x, 0.381, p.z); this.cart.rotation.y = p.yaw;
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
    for (const item of this.cullGroups) item.group.visible = !(overview && item.kind === 'track') && Math.hypot(cx - item.x, cz - item.z) < radius + item.radius;
    this.overviewTrack.visible = overview;
    this.clouds.visible = !overview;
  }
  dispose() {
    this.scene.remove(this.group);
    this.group.traverse(node => { if (node.isInstancedMesh) node.dispose(); });
    this.ownedGeometry.forEach(g => g.dispose()); this.ownedMaterials.forEach(m => m.dispose()); this.ownedTextures.forEach(t => t.dispose());
    this.group.clear(); this.cullGroups = []; this.wheels = [];
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
  return { sun, hemi, sky, environment, setBiomes(a, b) {
    const fog = new THREE.Color(PALETTES[a].sky).lerp(new THREE.Color(PALETTES[b].sky), 0.5);
    skyMaterial.uniforms.bottom.value.copy(fog); scene.fog = new THREE.Fog(fog, 170, 600);
  }, update(camera, position, shadows) {
    sky.position.copy(camera.position); sun.castShadow = shadows;
    sun.position.set(position.x - 100, 170, position.z + 70); sun.target.position.set(position.x, 0, position.z);
    sun.target.updateMatrixWorld();
  } };
}
