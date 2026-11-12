import * as THREE from 'three';
import { lerp, smoothstep, randomGenerator, TAU } from './core.js?v=8.0.0';
import { riverLocation, bridgeCoordinates } from './route-features.js?v=8.0.0';
import { renderedGroundHeight } from './grounding.js?v=8.0.0';
import { GRASS_HABITAT, grassPatch, inFarm } from './landscape-profile.js?v=8.0.0';

export function grassHabitatAt(world, x, z, near) {
  const habitat = world.blendValue(GRASS_HABITAT,x,z);
  if (habitat < 0.02) return 0;
  let weight = habitat * smoothstep(4.8, 8.5, near.distance);
  if (world.lake && world.lakeRadiusAt(x, z) < world.lake.radius + 8) return 0;
  const bridge = world.features.bridge;
  if (bridge) {
    const p = bridgeCoordinates(bridge, x, z), r = bridge.river;
    if (p.along > r.start - 40 && p.along < r.end + 40 && Math.abs(p.across) < 160) {
      const river = riverLocation(bridge, x, z); weight *= smoothstep(river.halfWidth + 3.5, river.halfWidth + 8, river.distance);
    }
  }
  const t = world.features.tunnel;
  if (t && near.distanceAlong > t.start - t.approachLength && near.distanceAlong < t.end + t.approachLength && near.distance < t.halfWidth + 2) return 0;
  if (world.sceneryPlan?.farms.some(f => inFarm(f, x, z, 3))) return 0;
  for (const pad of world.groundPadIndex?.get(`${Math.floor(x / 64)},${Math.floor(z / 64)}`) || []) {
    weight *= smoothstep(pad.inner, pad.inner + 4, Math.hypot(x - pad.x, z - pad.z));
  }
  if (world.stations.some(s => Math.hypot(x - s.x, z - s.z) < 26)) return 0;
  return weight;
}

// World-space colour variation has no repeating photograph or external image
// download. It stays subtle enough to suit the existing rounded low-poly art.
export function createGroundMaterial(world) {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  material.onBeforeCompile = shader => {
    shader.uniforms.landGreen = { value: new THREE.Color('#637e45') };
    shader.uniforms.landLight = { value: new THREE.Color('#9caf6b') };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float landGrass; varying float vLandGrass; varying vec2 vLandXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLandGrass = landGrass; vLandXZ = (modelMatrix * vec4(position, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying float vLandGrass; varying vec2 vLandXZ; uniform vec3 landGreen; uniform vec3 landLight;
      float landHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float landNoise(vec2 p) {
        vec2 a = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(landHash(a), landHash(a + vec2(1, 0)), f.x), mix(landHash(a + vec2(0, 1)), landHash(a + vec2(1, 1)), f.x), f.y);
      }`).replace('#include <color_fragment>', `#include <color_fragment>
      float broadPatch = landNoise(vLandXZ / 22.0) * 0.70 + landNoise(vLandXZ / 7.0) * 0.30;
      float grassBlend = smoothstep(0.36, 0.68, broadPatch);
      vec3 grassColor = mix(landGreen, landLight, landNoise(vLandXZ / 3.4));
      diffuseColor.rgb = mix(diffuseColor.rgb, grassColor, grassBlend * vLandGrass * 0.68);
      float grainFade = 1.0 - smoothstep(0.3, 1.5, length(fwidth(vLandXZ)));
      diffuseColor.rgb *= 1.0 + (landNoise(vLandXZ * 1.5) - 0.5) * 0.065 * vLandGrass * grainFade;`);
  };
  material.customProgramCacheKey = () => 'loop-ground-cover-v7';
  return material;
}

export function planGrassCover(world) {
  const random = randomGenerator(`${world.config.seed}:grass-v7`), result = [];
  // Vegetation density is an art layer independent of the stress-load setting.
  // A 50,000-model test uses exactly the same seeded ground cover as 1,000.
  for (let s = 0; s < world.route.length; s += 4.2) {
    const p = world.route.sample(s + random() * 3.5);
    for (const side of [-1, 1]) for (const band of [9, 16, 27, 43, 67]) {
      const offset = (band + (random() - 0.5) * 6) * side;
      const cx = p.x + p.nx * offset, cz = p.z + p.nz * offset;
      const patch = grassPatch(cx, cz);
      if (patch < 0.36) continue;
      const count = 2 + Math.floor(patch * 4);
      for (let i = 0; i < count; i++) {
        const x = cx + (random() - 0.5) * 4.8, z = cz + (random() - 0.5) * 4.8;
        if (Math.abs(x) > world.route.squareSize - 8 || Math.abs(z) > world.route.squareSize / 2 - 8) continue;
        const near = world.route.nearestTo(x, z, 115), habitat = grassHabitatAt(world, x, z, near);
        if (habitat < 0.3 || random() > habitat) continue;
        const y = renderedGroundHeight(world.terrainGrid, x, z);
        if (!Number.isFinite(y)) continue;
        result.push({ x, y: y - 0.012, z, yaw: random() * TAU, width: 0.78 + random() * 1.05,
          height: 0.58 + random() * 0.75, tone: random(), along: s });
      }
    }
  }
  return result;
}

export function buildGrassCover(world) {
  const placements = planGrassCover(world), positions = [], colors = [];
  const root = new THREE.Color('#708f53'), tip = new THREE.Color('#b1bd7c');
  // Seven opaque triangles per tuft. No alpha cutouts, transparent sorting,
  // individual grass draw calls or shadow maps are required.
  for (let leaf = 0; leaf < 7; leaf++) {
    const a = leaf * 2.39996, c = Math.cos(a), s = Math.sin(a), height = 0.40 + (leaf % 3) * 0.14;
    const vertices = [[-0.065, 0, 0], [0.065, 0, 0], [0.13 + leaf % 2 * 0.10, height, 0.04]];
    for (let k = 0; k < vertices.length; k++) {
      const [x, y, z] = vertices[k]; positions.push(c * x + s * z, y, -s * x + c * z);
      const color = k === 2 ? tip : root; colors.push(color.r, color.g, color.b);
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
  world.grassWind = { value: 0 };
  material.onBeforeCompile = shader => {
    shader.uniforms.grassTime = world.grassWind;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float grassTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.x += position.y * position.y * 0.13 * sin(grassTime * 1.1 + instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.13);`);
  };
  material.customProgramCacheKey = () => 'loop-grass-v7';
  world.ownedGeometry.push(geometry); world.ownedMaterials.push(material);
  const bins = new Map(), cell = 112;
  for (const p of placements) {
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
    if (!bins.has(key)) bins.set(key, []); bins.get(key).push(p);
  }
  const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), axis = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), scale = new THREE.Vector3();
  for (const [key, values] of bins) {
    const mesh = new THREE.InstancedMesh(geometry, material, values.length); mesh.name = 'grass-tufts';
    for (let i = 0; i < values.length; i++) {
      const p = values[i]; pos.set(p.x, p.y, p.z); q.setFromAxisAngle(axis, p.yaw); scale.set(p.width, p.height, p.width);
      mesh.setMatrixAt(i, matrix.compose(pos, q, scale)); mesh.setColorAt(i, new THREE.Color().setRGB(0.92 + p.tone * 0.08, 0.96 + p.tone * 0.04, 0.90 + p.tone * 0.08));
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); mesh.receiveShadow = true;
    world.group.add(mesh);
    const [ix, iz] = key.split(',').map(Number);
    world.cullGroups.push({ group: mesh, x: (ix + 0.5) * cell, z: (iz + 0.5) * cell, radius: cell * 0.75, kind: 'grass' });
  }
  world.groundCoverCount = placements.length;
  world.groundCoverPreview = placements.find(p => p.along > 140 && p.along < 950 && world.route.distanceTo(p.x, p.z, 35) < 23) || placements[0];
  world.landscapeStats = { ...world.landscapeStats, grassTufts: placements.length, grassTrianglesPerTuft: 7, grassVisibleRange: 190 };
}

export function buildFarmland(world) {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  world.ownedMaterials.push(material);
  for (const farm of world.sceneryPlan.farms) {
    const positions = [], colors = [], indices = [], c = Math.cos(farm.yaw), s = Math.sin(farm.yaw);
    const width = farm.halfWidth + 1.5, length = farm.halfLength + 1.5;
    const nx = Math.ceil(width * 2 / 1.25), nz = Math.ceil(length * 2 / 1.8), soil = new THREE.Color(farm.soil);
    const cropColor = new THREE.Color(farm.crop.includes('Wheat') ? '#c3ad6b' : farm.crop.includes('Corn') ? '#9aa568' : '#b0a276');
    const path = new THREE.Color('#bdb18c');
    for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix <= nx; ix++) {
      const u = lerp(-width, width, ix / nx), v = lerp(-length, length, iz / nz);
      const x = farm.x + c * u + s * v, z = farm.z - s * u + c * v;
      const edge = Math.min(farm.halfWidth - Math.abs(u), farm.halfLength - Math.abs(v));
      const row = (u + farm.halfWidth - 2.3) / farm.rowSpacing, distance = Math.abs(row - Math.round(row));
      const ridge = (1 - smoothstep(0.10, 0.43, distance)) * smoothstep(0.4, 2, edge);
      const y = renderedGroundHeight(world.terrainGrid, x, z) + 0.035 + 0.11 * ridge;
      positions.push(x, y, z);
      const color = soil.clone().multiplyScalar(0.85 + ridge * 0.20).lerp(cropColor, ridge * 0.34).lerp(path, 1 - smoothstep(-0.1, 1.15, edge));
      if (edge < -0.7) color.lerp(world.colorAt(x,z), smoothstep(0.7, 1.5, -edge));
      colors.push(color.r, color.g, color.b);
    }
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const a = iz * (nx + 1) + ix, b = a + nx + 1; indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material); mesh.name = 'tilled-field'; mesh.receiveShadow = true; mesh.userData.farm = farm.id;
    world.group.add(mesh); world.ownedGeometry.push(geometry);
    world.cullGroups.push({ group: mesh, x: farm.x, z: farm.z, radius: Math.hypot(width, length), kind: 'scenery' });
  }
  world.landscapeStats = { ...world.landscapeStats, farmlandPlots: world.sceneryPlan.farms.length,
    fieldCropModels: world.sceneryPlan.farms.reduce((sum, f) => sum + f.plants, 0) };
}
