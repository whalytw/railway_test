import * as THREE from 'three';
import { clamp, lerp, smoothstep, randomGenerator, TAU } from './core.js?v=8.0.0';
import { riverProfile, riverPoint } from './route-features.js?v=8.0.0';
import { renderedGroundHeight } from './grounding.js?v=8.0.0';
import { tunnelFrontShift, tunnelMoundHeight, tunnelCutFactor, GRASS_HABITAT, landNoise } from './landscape-profile.js?v=8.0.0';
import { createGroundMaterial } from './ground-cover.js?v=8.0.0';

const up = new THREE.Vector3(0, 1, 0), frameEuler = new THREE.Euler(0, 0, 0, 'YXZ');
function ownMesh(world, geometry, material) { const mesh = new THREE.Mesh(geometry, material); world.group.add(mesh); world.ownedGeometry.push(geometry); return mesh; }
function atFrame(p, x, y, z = 0) {
  const local = new THREE.Vector3(x, y, z).applyEuler(frameEuler.set(p.pitch, p.yaw, 0, 'YXZ'));
  return local.add(new THREE.Vector3(p.x, p.y, p.z));
}
function alongPlacement(route, start, end, authoredLength) {
  const a = route.sample(start), b = route.sample(end), dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return { x: a.x, y: a.y, z: a.z, yaw: Math.atan2(dx, dz), pitch: -Math.atan2(dy, Math.hypot(dx, dz)), sz: Math.hypot(dx, dy, dz) / authoredLength };
}
function refineCutFace(source) {
  // Earcut only triangulates a 2D outline. Subdivide its long interior edges
  // before bending the face, so a curved cliff never becomes one diagonal
  // planar triangle stretching behind the entrance.
  const a = source.attributes.position, index = source.index.array, stack = [], vertices = [];
  const p = i => [a.getX(i), a.getY(i)];
  for (let i = 0; i < index.length; i += 3) stack.push([p(index[i]), p(index[i + 1]), p(index[i + 2])]);
  while (stack.length) {
    const tri = stack.pop(), edges = tri.map((v, i) => (v[0] - tri[(i + 1) % 3][0]) ** 2 + (v[1] - tri[(i + 1) % 3][1]) ** 2);
    const edge = edges.indexOf(Math.max(...edges));
    if (edges[edge] > 1.2 ** 2) {
      const u = tri[edge], v = tri[(edge + 1) % 3], w = tri[(edge + 2) % 3], m = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
      stack.push([u, m, w], [m, v, w]);
    } else for (const v of tri) vertices.push(v[0], v[1], 0);
  }
  source.dispose(); const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); return geometry;
}

export function buildMountainBackdrop(world) {
  const d = world.route.squareSize, random = randomGenerator(`${world.config.seed}:skyline`);
  const sky = world.skyColor();
  const snow = world.activeBiomes.includes('Snow');
  const volcanic = world.activeBiomes.includes('Volcano');
  for (let layer = 0; layer < 3; layer++) {
    const n = 192, positions = [], colors = [], indices = [], phase = random() * TAU;
    const rx = d * (2.20 + layer * 0.65), rz = d * (1.75 + layer * 0.50);
    const base = world.route.elevation.range * 0.45 - 60;
    const ridge = new THREE.Color(volcanic ? '#748185' : '#7b9592').lerp(sky, 0.50 + layer * 0.13);
    for (let ring = 0; ring < 5; ring++) for (let i = 0; i <= n; i++) {
      const angle = i / n * TAU;
      const jagged = 0.55 + 0.24 * Math.sin(angle * 11 + phase) + 0.15 * Math.sin(angle * 23 + phase * 0.7) + 0.08 * Math.sin(angle * 41 + 1);
      const height = (160 + layer * 55 + jagged * (170 + layer * 55));
      const r = [0.68, 0.84, 1, 1.11, 1.30][ring], profile = [0, 0.28, 1, 0.22, 0][ring];
      positions.push(Math.cos(angle) * rx * r, base + height * profile, Math.sin(angle) * rz * r);
      const color = ridge.clone();
      if (ring === 0 || ring === 4) color.lerp(sky, 0.6);
      else if (ring === 2 && snow && jagged > 0.65) color.lerp(new THREE.Color('#e4ece6'), 0.20 - layer * 0.04);
      else color.multiplyScalar(0.98 + 0.025 * Math.sin(angle * 7 + phase));
      colors.push(color.r, color.g, color.b);
    }
    for (let ring = 0; ring < 4; ring++) for (let i = 0; i < n; i++) {
      const a = ring * (n + 1) + i, b = a + n + 1; indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: false });
    world.ownedMaterials.push(material);
    const mesh = ownMesh(world, geometry, material);
    // Far layer draws first, near silhouette draws on top, all before foreground.
    mesh.renderOrder = -3 - layer;
  }
}

export function buildVariedClouds(world) {
  const random = randomGenerator(`${world.config.seed}:varied-clouds`), d = world.route.squareSize;
  const geometry = new THREE.IcosahedronGeometry(1, 2), parts = [], span = Math.max(d * 3.6, 6000);
  for (let i = 0; i < 27; i++) {
    const kind = i % 3, size = 35 + random() * 55, cluster = { x: (random() - 0.5) * span, z: (random() - 0.5) * span,
      y: world.route.elevation.max + 270 + random() * 270 + kind * 35, wind: 0.65 + random() * 0.6 };
    const count = kind === 0 ? 8 : kind === 1 ? 5 : 3;
    for (let j = 0; j < count; j++) {
      const t = j / Math.max(1, count - 1) - 0.5;
      parts.push({ cluster, x: t * size * (kind === 0 ? 1.8 : 3.5), y: kind === 0 ? Math.sin((t + 0.5) * Math.PI) * size * 0.35 : random() * size * 0.05,
        z: (random() - 0.5) * size * 0.7,
        sx: size * (kind === 2 ? 1.0 : 0.6) * (0.8 + random() * 0.3),
        sy: size * (kind === 0 ? 0.35 + random() * 0.22 : kind === 1 ? 0.14 : 0.06), sz: size * (kind === 2 ? 0.28 : 0.48) });
    }
  }
  const cloudColors = [], cloudPositions = geometry.attributes.position;
  const shade = new THREE.Color('#d5e0e1'), highlight = new THREE.Color('#fffdf3');
  for (let i = 0; i < cloudPositions.count; i++) {
    const color = shade.clone().lerp(highlight, clamp((cloudPositions.getY(i) + 0.55) / 1.4, 0, 1));
    cloudColors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(cloudColors, 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.70, depthWrite: false, fog: false });
  const mesh = new THREE.InstancedMesh(geometry, material, parts.length); mesh.frustumCulled = false; mesh.renderOrder = 2;
  world.group.add(mesh); world.ownedGeometry.push(geometry); world.ownedMaterials.push(material);
  world.clouds = mesh; world.cloudParts = parts; world.cloudSpan = span;
  updateClouds(world, 0);
}
export function updateClouds(world, time) {
  if (!world.cloudParts) return;
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), pos = new THREE.Vector3(), scale = new THREE.Vector3();
  world.cloudParts.forEach((p, i) => {
    const c = p.cluster, x = ((c.x + time * c.wind + world.cloudSpan / 2) % world.cloudSpan + world.cloudSpan) % world.cloudSpan - world.cloudSpan / 2;
    pos.set(x + p.x, c.y + p.y, c.z + p.z); scale.set(p.sx, p.sy, p.sz); matrix.compose(pos, quaternion, scale); world.clouds.setMatrixAt(i, matrix);
  });
  world.clouds.instanceMatrix.needsUpdate = true;
}

export function buildBridgeAndRiver(world) {
  const bridge = world.features.bridge, route = world.route;
  if (!bridge) return;
  const spans = [], piers = [], abutments = [];
  const spanLength = bridge.style === 'wood' ? 4 : 8;
  for (let s = bridge.start; s < bridge.end - 0.1; s += spanLength) spans.push(alongPlacement(route, s, s + spanLength, spanLength));
  for (let s = bridge.start + 8; s < bridge.end - 2; s += 16) {
    const p = route.sample(s), bottom = world.heightAt(p.x, p.z), top = p.y - 0.60;
    piers.push({ x: p.x, y: bottom - 0.12, z: p.z, yaw: p.yaw, sy: Math.max(0.2, (top - bottom + 0.12) / 4) });
  }
  for (const [s, sign] of [[bridge.start, 1], [bridge.end, -1]]) {
    const p = route.sample(s); abutments.push({ x: p.x, y: p.y - 2.2, z: p.z, yaw: p.yaw + (sign < 0 ? Math.PI : 0) });
  }
  world.addBatches(bridge.style === 'wood' ? 'Building_Bridge_TimberDeck4m_001' : 'Building_Bridge_SteelTruss8m_001', spans, { kind: 'bridge', size: 96, castShadow: world.config.shadows });
  world.addBatches('Building_Bridge_StonePier4m_001', piers, { kind: 'bridge', castShadow: world.config.shadows });
  world.addBatches('Building_Bridge_Abutment_001', abutments, { kind: 'bridge', castShadow: world.config.shadows });
  const positions = [], uvs = [], indices = [], colors = [], bankVertices = [], bankColors = [], bankIndices = [];
  const river = bridge.river, rows = Math.ceil((river.end - river.start) / 2.8);
  const deep = new THREE.Color('#559da5'), shallows = new THREE.Color('#92bdb0');
  const wetSand = new THREE.Color('#969c7d'), drySand = new THREE.Color('#b0aa87');
  for (let i = 0; i <= rows; i++) {
    const b = lerp(river.start, river.end, i / rows), profile = riverProfile(bridge, b);
    for (const t of [-1, -0.6, 0, 0.6, 1]) {
      const p = riverPoint(bridge, b, profile.halfWidth * t);
      positions.push(p.x, p.y, p.z); uvs.push((t + 1) / 2, b / 12);
      const color = deep.clone().lerp(shallows, Math.abs(t) ** 2 * 0.72); colors.push(color.r, color.g, color.b);
    }
    for (const side of [-1, 1]) for (const band of [0, 1.8, 4.8, 7]) {
      const p = riverPoint(bridge, b, side * (profile.halfWidth + band));
      // Bank colour hugs the actual rendered ground triangles, rather than
      // exposing the rectangular footings of repeated straight modules.
      const h = world.terrainGrid ? renderedGroundHeight(world.terrainGrid, p.x, p.z) : world.heightAt(p.x, p.z);
      bankVertices.push(p.x, h + 0.025, p.z);
      const ground = world.colorAt(p.x,p.z);
      const color = wetSand.clone().lerp(drySand, Math.min(1, band / 4)).lerp(ground, smoothstep(3, 7, band));
      bankColors.push(color.r, color.g, color.b);
    }
    if (i) {
      const a = (i - 1) * 5;
      for (let j = 0; j < 4; j++) indices.push(a + j, a + j + 5, a + j + 1, a + j + 1, a + j + 5, a + j + 6);
      for (let side = 0; side < 2; side++) for (let j = 0; j < 3; j++) {
        const a = (i - 1) * 8 + side * 4 + j; bankIndices.push(a, a + 8, a + 1, a + 1, a + 8, a + 9);
      }
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.10, roughness: 0.34, side: THREE.DoubleSide });
  world.riverFlow = { value: 0 };
  material.onBeforeCompile = shader => {
    shader.uniforms.riverTime = world.riverFlow;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vRiverUV;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRiverUV = uv;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float riverTime; varying vec2 vRiverUV;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float ripples = sin(vRiverUV.y * 7.0 - riverTime * 1.2 + sin(vRiverUV.x * 19.0)) * 0.5 + 0.5;
        float streak = smoothstep(0.92, 0.995, sin(vRiverUV.x * 73.0 + sin(vRiverUV.y * 0.7 - riverTime * 0.25)));
        diffuseColor.rgb *= 0.975 + 0.045 * ripples;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.66, 0.82, 0.76), streak * 0.10 * smoothstep(0.04, 0.22, vRiverUV.x) * (1.0 - smoothstep(0.78, 0.96, vRiverUV.x)));`);
  };
  material.customProgramCacheKey = () => 'loop-river-v7';
  world.ownedMaterials.push(material); const water = ownMesh(world, geometry, material); water.name = 'river-water'; water.receiveShadow = true; world.riverWater = material;
  const bankGeometry = new THREE.BufferGeometry(); bankGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bankVertices, 3));
  bankGeometry.setAttribute('color', new THREE.Float32BufferAttribute(bankColors, 3)); bankGeometry.setIndex(bankIndices); bankGeometry.computeVertexNormals();
  const bankMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  world.ownedMaterials.push(bankMaterial); const banks = ownMesh(world, bankGeometry, bankMaterial); banks.name = 'river-banks'; banks.receiveShadow = true;
  world.landscapeStats = { ...world.landscapeStats, riverLength: river.end - river.start,
    riverMaxWidth: Math.max(...Array.from({ length: 101 }, (_, i) => riverProfile(bridge, lerp(river.start, river.end, i / 100)).halfWidth * 2)) };
}

export function buildTunnel(world) {
  const tunnel = world.features.tunnel, route = world.route;
  if (!tunnel) return;
  const modules = [], portals = [];
  for (let s = tunnel.start; s < tunnel.end - 0.1; s += 4) modules.push(alongPlacement(route, s, s + 4, 4));
  for (const [s, sign] of [[tunnel.start, 1], [tunnel.end, -1]]) {
    const p = route.sample(s); portals.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw + (sign < 0 ? Math.PI : 0), pitch: p.pitch * sign });
  }
  world.addBatches('Building_Tunnel_RockStraight4m_001', modules, { kind: 'tunnel', size: 96 });
  world.addBatches('Building_Tunnel_StonePortal_001', portals, { kind: 'tunnel', size: 96 });
  const ground = world.colorAt(tunnel.x,tunnel.z);
  const material = createGroundMaterial(world); material.side = THREE.DoubleSide;
  world.ownedMaterials.push(material);
  const rockColor = new THREE.Color('#919481').lerp(ground, 0.24);
  const columns = [-58, -49, -40, -32, -25, -20, -16, -13, -11, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 16, 20, 25, 32, 40, 49, 58];
  function frameAt(localS, x) {
    const front = 1 - smoothstep(0, 28, Math.abs(localS)), back = 1 - smoothstep(0, 28, Math.abs(localS - tunnel.length));
    return route.sample(tunnel.start + localS + tunnelFrontShift(tunnel, x) * (front - back));
  }
  function vertex(localS, x, height) {
    const p = frameAt(localS, x), v = atFrame(p, x, height - 0.12);
    const groundY = (world.terrainGrid ? renderedGroundHeight(world.terrainGrid, v.x, v.z) : world.heightAt(v.x, v.z)) - 0.04;
    v.y = lerp(groundY, Math.max(v.y, groundY), smoothstep(0, 1.4, height)); return v;
  }
  // Three open surfaces meet at the small excavated rock cut. There is no
  // cross-map end cap: the grassy shoulders extend 72 m into both approaches.
  for (const [start, end, excavated, label] of [[-tunnel.approachLength, 0, true, 'approach-a'], [0, tunnel.length, false, 'roof'], [tunnel.length, tunnel.length + tunnel.approachLength, true, 'approach-b']]) {
    const rows = Math.ceil((end - start) / 2.5), vertices = [], colors = [], indices = [], grasses = [];
    for (let i = 0; i <= rows; i++) for (const x of columns) {
      const localS = lerp(start, end, i / rows), mountain = tunnelMoundHeight(tunnel, localS, x);
      const cut = excavated ? tunnelCutFactor(localS, x, tunnel.length) : 1;
      const v = vertex(localS, x, mountain * cut); vertices.push(v.x, v.y, v.z);
      const rocky = excavated ? (1 - cut) * smoothstep(0.15, 0.45, cut) * (1 - smoothstep(10, 45, Math.max(0, -localS, localS - tunnel.length))) : 0;
      const habitat = world.blendValue(GRASS_HABITAT,v.x,v.z);
      const surface = world.colorAt(v.x,v.z), detail = world.colorAt(v.x,v.z,new THREE.Color(),true);
      surface.lerp(detail, 0.11 + 0.11 * Math.sin(v.x * 0.073) * Math.cos(v.z * 0.067));
      const color = surface.lerp(rockColor, rocky * 0.65).multiplyScalar(1 - smoothstep(0, 2, mountain * cut) * 0.06);
      colors.push(color.r, color.g, color.b);
      grasses.push(habitat * (1 - rocky) * smoothstep(0, 1.5, mountain * cut));
    }
    for (let i = 0; i < rows; i++) for (let j = 0; j < columns.length - 1; j++) {
      const a = i * columns.length + j, b = a + columns.length; indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    geometry.setAttribute('landGrass', new THREE.Float32BufferAttribute(grasses.map((v, i) => v * smoothstep(0.6, 0.94, Math.abs(geometry.attributes.normal.getY(i)))), 1));
    const hill = ownMesh(world, geometry, material); hill.name = `tunnel-mountain-${label}`; hill.receiveShadow = true; hill.castShadow = Boolean(world.config.sceneryShadows);
  }
  for (const localS of [0, tunnel.length]) {
    const shape = new THREE.Shape(), xs = columns.filter(x => Math.abs(x) <= 9);
    const top = x => tunnelMoundHeight(tunnel, localS, x);
    shape.moveTo(-9, top(-9));
    for (const x of xs.slice(1)) shape.lineTo(x, top(x));
    for (const x of xs.filter(x => x > 1.72).reverse()) shape.lineTo(x, top(x) * tunnelCutFactor(localS, x, tunnel.length));
    shape.lineTo(1.72, -0.12); shape.lineTo(1.72, 1.65);
    for (let k = 0; k <= 20; k++) { const angle = k / 20 * Math.PI; shape.lineTo(1.72 * Math.cos(angle), 1.65 + 1.72 * Math.sin(angle)); }
    shape.lineTo(-1.72, -0.12);
    for (const x of xs.filter(x => x < -1.72).reverse()) shape.lineTo(x, top(x) * tunnelCutFactor(localS, x, tunnel.length));
    shape.closePath();
    const cap = refineCutFace(new THREE.ShapeGeometry(shape)), a = cap.attributes.position, colors = [];
    for (let i = 0; i < a.count; i++) {
      const x = a.getX(i), y = a.getY(i), p = frameAt(localS, x), v = atFrame(p, x, y - 0.12);
      a.setXYZ(i, v.x, v.y, v.z);
      const grass = smoothstep(top(x) - 1.0, top(x), y);
      const color = rockColor.clone().lerp(ground, grass).multiplyScalar(0.86 + 0.17 * landNoise(x * 0.65, y * 0.6)); colors.push(color.r, color.g, color.b);
    }
    cap.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    cap.computeVertexNormals();
    const rock = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide });
    world.ownedMaterials.push(rock); const face = ownMesh(world, cap, rock); face.name = 'tunnel-cut-face'; face.receiveShadow = true; face.castShadow = Boolean(world.config.sceneryShadows);
  }
  for (const offset of [22, 58]) {
    const p = route.sample(tunnel.start + offset), light = new THREE.PointLight('#ffd69b', 18, 12, 2);
    light.position.copy(atFrame(p, 0, 2.5)); world.group.add(light);
  }
}
