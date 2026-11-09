import * as THREE from 'three';
import { clamp, lerp, smoothstep, randomGenerator, TAU } from './core.js?v=6.0.0';
import { bridgeCoordinates, riverBend } from './route-features.js?v=6.0.0';

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

export function buildMountainBackdrop(world) {
  const d = world.route.squareSize, random = randomGenerator(`${world.config.seed}:skyline`);
  const sky = new THREE.Color(world.paletteA.sky).lerp(new THREE.Color(world.paletteB.sky), 0.5);
  const snow = [world.config.biomeA, world.config.biomeB].includes('Snow');
  const volcanic = [world.config.biomeA, world.config.biomeB].includes('Volcano');
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
  const banks = [], positions = [], uvs = [], indices = [], halfWater = 1.74 * 3;
  function riverPoint(b) {
    const a = riverBend(b); return { x: bridge.x + bridge.nx * b + bridge.tx * a, z: bridge.z + bridge.nz * b + bridge.tz * a, y: bridge.y - 6 + b * 0.004 };
  }
  for (let b = -144; b < 144; b += 8) {
    const a = riverPoint(b), end = riverPoint(b + 8);
    banks.push({ x: a.x, y: a.y, z: a.z, yaw: Math.atan2(end.x - a.x, end.z - a.z), pitch: -Math.atan2(end.y - a.y, Math.hypot(end.x - a.x, end.z - a.z)), sx: 3, sz: Math.hypot(end.x - a.x, end.z - a.z) / 8 });
  }
  world.addBatches('Environment_Terrain_RiverStraight8m_001', banks, { kind: 'river' });
  for (let i = 0; i <= 80; i++) {
    const b = -160 + i * 4, p = riverPoint(b), fade = 1 - smoothstep(140, 160, Math.abs(b));
    const width = halfWater * fade;
    for (const side of [-1, 1]) {
      positions.push(p.x + bridge.tx * width * side, p.y - 0.54, p.z + bridge.tz * width * side); uvs.push((side + 1) / 2, b / 12);
    }
    if (i) { const a = (i - 1) * 2; indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: '#609eaa', metalness: 0.22, roughness: 0.22, side: THREE.DoubleSide, transparent: true, opacity: 0.90 });
  world.ownedMaterials.push(material); ownMesh(world, geometry, material); world.riverWater = material;
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
  const rows = 40, columns = 28, vertices = [], indices = [], colors = [];
  const ground = world.colorA.clone().lerp(world.colorB, world.mixAt(tunnel.x, tunnel.z));
  for (let i = 0; i <= rows; i++) {
    const s = lerp(tunnel.start, tunnel.end, i / rows), p = route.sample(s), hump = 10 + Math.sin(i / rows * Math.PI) * tunnel.hillHeight;
    for (let j = 0; j <= columns; j++) {
      const x = (j / columns * 2 - 1) * tunnel.halfWidth, profile = Math.max(0, 1 - (x / tunnel.halfWidth) ** 2) ** 1.25;
      const v = atFrame(p, x, hump * profile);
      v.y = Math.max(v.y, world.heightAt(v.x, v.z) - 0.03);
      vertices.push(v.x, v.y, v.z);
      const color = ground.clone().multiplyScalar(0.9 + 0.10 * Math.cos(j * 0.7 + i * 0.23)); colors.push(color.r, color.g, color.b);
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) {
    const a = i * (columns + 1) + j, b = a + columns + 1; indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
  world.ownedMaterials.push(material);
  const hill = ownMesh(world, geometry, material); hill.receiveShadow = true; hill.castShadow = Boolean(world.config.sceneryShadows);
  // Concave front face has an open arch notch. No terrain triangle crosses the
  // mouth; the imported stone portal masks the seam around the opening.
  for (const [s, reverse] of [[tunnel.start, false], [tunnel.end, true]]) {
    const p = route.sample(s), shape = new THREE.Shape();
    shape.moveTo(-tunnel.halfWidth, -0.09);
    for (let j = 0; j <= 28; j++) { const x = (j / 28 * 2 - 1) * tunnel.halfWidth; shape.lineTo(x, 10 * Math.max(0, 1 - (x / tunnel.halfWidth) ** 2) ** 1.25); }
    shape.lineTo(tunnel.halfWidth, -0.09); shape.lineTo(1.72, -0.09); shape.lineTo(1.72, 1.65);
    for (let k = 0; k <= 20; k++) { const angle = k / 20 * Math.PI; shape.lineTo(1.72 * Math.cos(angle), 1.65 + 1.72 * Math.sin(angle)); }
    shape.lineTo(-1.72, -0.09); shape.closePath();
    const cap = new THREE.ShapeGeometry(shape), a = cap.attributes.position;
    for (let i = 0; i < a.count; i++) { const v = atFrame(p, a.getX(i), a.getY(i)); a.setXYZ(i, v.x, v.y, v.z); }
    cap.computeVertexNormals();
    const rock = new THREE.MeshStandardMaterial({ color: ground.clone().lerp(new THREE.Color('#7e8275'), 0.62), roughness: 1, side: THREE.DoubleSide });
    world.ownedMaterials.push(rock); const face = ownMesh(world, cap, rock); face.receiveShadow = true; face.castShadow = Boolean(world.config.sceneryShadows);
  }
  for (const offset of [22, 58]) {
    const p = route.sample(tunnel.start + offset), light = new THREE.PointLight('#ffd69b', 18, 12, 2);
    light.position.copy(atFrame(p, 0, 2.5)); world.group.add(light);
  }
}
