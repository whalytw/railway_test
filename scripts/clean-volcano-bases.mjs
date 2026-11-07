/**
 * Remove display foundations from the web-project volcano copies only.
 * Original library assets and original metadata/provenance are never changed.
 *
 * node scripts/clean-volcano-bases.mjs --inspect
 * node scripts/clean-volcano-bases.mjs --apply
 *
 * Cone: remove the circular -0.65m display plinth, not the crater.
 * Pool: remove the square foundation and display apron; reshape only its outer
 *       shoulder to an oval, zero-datum foot; retain the inner rim and lava top.
 * Channel: remove the basal box walls and end caps, keeping the banks/bed/top.
 * Cliff: retain genuine individual column feet; add correct placement metadata.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VOLCANO_IDS = [
  'Environment_Volcano_Cone16m_001',
  'Environment_Volcano_LavaChannel8m_001',
  'Environment_Volcano_LavaPool8m_001',
  'Environment_Volcano_BasaltCliff8m_001',
];
const eps = 0.00002;
const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const lanes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const readers = { 5120: 'readInt8', 5121: 'readUInt8', 5122: 'readInt16LE', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' };
const pad4 = value => (value + 3) & ~3;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const near = (a, b) => Math.abs(a - b) <= eps;
const pointKey = point => point.map(v => Math.round(v * 10000)).join(',');

export function parseGlb(bytes) {
  assert(bytes.toString('ascii', 0, 4) === 'glTF' && bytes.readUInt32LE(4) === 2, 'Expected GLB 2.0');
  assert(bytes.readUInt32LE(8) === bytes.length, 'GLB length mismatch');
  let document, binary;
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    assert(offset + 8 + length <= bytes.length, 'GLB chunk is outside the file');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) document = JSON.parse(chunk.toString('utf8'));
    if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  assert(document && binary, 'GLB JSON/BIN is missing');
  return { document, binary };
}

export function readAccessor(glb, index) {
  const accessor = glb.document.accessors[index];
  assert(accessor && !accessor.sparse, 'Missing or sparse accessor is unsupported');
  const view = glb.document.bufferViews[accessor.bufferView];
  const size = sizes[accessor.componentType], width = lanes[accessor.type];
  assert(size && width && view.buffer === 0, 'Unsupported accessor storage');
  const elementSize = size * width, stride = view.byteStride ?? elementSize;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  assert(offset + (accessor.count - 1) * stride + elementSize <= glb.binary.length, 'Accessor exceeds BIN');
  const values = Array.from({ length: accessor.count }, (_, vertex) => Array.from({ length: width }, (_, axis) => glb.binary[readers[accessor.componentType]](offset + vertex * stride + axis * size)));
  return { accessor, size, width, elementSize, stride, offset, values };
}

export function primitiveData(glb, primitive) {
  assert((primitive.mode ?? 4) === 4, 'Expected triangle primitive');
  const positions = readAccessor(glb, primitive.attributes.POSITION);
  const indices = primitive.indices === undefined ? positions.values.map((_, i) => i) : readAccessor(glb, primitive.indices).values.map(value => value[0]);
  assert(indices.length % 3 === 0, 'Invalid triangle index count');
  for (const index of indices) assert(index >= 0 && index < positions.values.length, 'Triangle index out of bounds');
  const materialName = glb.document.materials?.[primitive.material]?.name ?? '';
  return { positions, indices, materialName, lava: /lava/i.test(materialName) };
}

export function inspectGeometry(glb) {
  let triangles = 0, lavaTriangles = 0;
  const values = [];
  for (const mesh of glb.document.meshes) for (const primitive of mesh.primitives) {
    const data = primitiveData(glb, primitive);
    triangles += data.indices.length / 3;
    if (data.lava) lavaTriangles += data.indices.length / 3;
    for (const index of data.indices) {
      const point = data.positions.values[index];
      assert(point.every(Number.isFinite), 'Nonfinite vertex');
      values.push(point);
    }
  }
  assert(values.length, 'Empty volcano geometry');
  const bounds = {
    min: [0, 1, 2].map(axis => Math.min(...values.map(p => p[axis]))),
    max: [0, 1, 2].map(axis => Math.max(...values.map(p => p[axis]))),
  };
  return { triangles, lavaTriangles, bounds, dimensions: bounds.max.map((value, axis) => value - bounds.min[axis]) };
}

// A semantic signature of the real molten surface. Bottom/side walls of a lava
// prism are deliberately excluded for the pool/channel, but cone lava veins,
// crater lava and their complete geometry are protected.
export function lavaSurfaceSignature(glb, id) {
  const faces = [];
  for (const mesh of glb.document.meshes) for (const primitive of mesh.primitives) {
    const data = primitiveData(glb, primitive);
    if (!data.lava) continue;
    for (let t = 0; t < data.indices.length; t += 3) {
      const points = data.indices.slice(t, t + 3).map(i => data.positions.values[i]);
      if (!id.includes('Cone') && !points.every(p => p[1] > -0.14 && p[1] < -0.10 + eps)) continue;
      faces.push(points.map(p => p.map(value => value.toPrecision(9)).join(',')).sort().join('|'));
    }
  }
  return { triangles: faces.length, sha256: sha256(Buffer.from(faces.sort().join('\n'))) };
}

const poolRingLookup = new Map();
const poolProfiles = [[0, -0.20], [0.16, 0.28], [0.46, 0.22], [1, 0], [1, -0.3], [0, -0.3]];
for (let ring = 0; ring < poolProfiles.length; ring++) for (let j = 0; j < 40; j++) {
  const [blend, height] = poolProfiles[ring];
  const angle = 2 * Math.PI * j / 40, cos = Math.cos(angle), sin = Math.sin(angle), divisor = Math.max(Math.abs(cos), Math.abs(sin));
  const x = 3.08 * cos * (1 - blend) + 4 * cos / divisor * blend;
  const z = 2.58 * sin * (1 - blend) + 4 * sin / divisor * blend;
  const y = height + (blend === 0 || blend === 1 ? 0 : 0.035 * Math.sin(angle * 7));
  poolRingLookup.set(pointKey([x, y, z]), { ring, angle });
}

export function poolRing(point) { return poolRingLookup.get(pointKey(point)); }

function filterReason(id, data, points) {
  if (id.includes('Cone')) {
    if (!data.lava && points.some(p => p[1] < -0.64)) return 'circular-plinth-wall-or-bottom';
    return null;
  }
  if (id.includes('LavaChannel')) {
    if (data.lava) return points.every(p => p[1] > -0.14 && p[1] < -0.10 + eps) ? null : 'lava-prism-bottom-or-side';
    if (points.some(p => p[1] < -0.69)) return 'rectangular-channel-foundation';
    if (points.every(p => near(p[2], 0)) || points.every(p => near(p[2], 8))) return 'channel-display-end-cap';
    return null;
  }
  if (id.includes('LavaPool')) {
    if (data.lava) return points.every(p => near(p[1], -0.12)) ? null : 'lava-prism-bottom-or-side';
    if (points.every(p => near(Math.abs(p[0]), 4) && near(Math.abs(p[2]), 4) && (near(p[1], -0.65) || near(p[1], -0.20)))) return 'square-display-foundation';
    const rings = points.map(poolRing);
    if (rings.every(Boolean)) {
      if (rings.every(value => value.ring <= 2)) return null;
      return 'square-apron-or-lower-rim-closure';
    }
  }
  return null;
}

function placementFor(id, bounds) {
  const centreXZ = [0, 2].map(axis => (bounds.min[axis] + bounds.max[axis]) / 2);
  const halfExtentsXZ = [0, 2].map(axis => (bounds.max[axis] - bounds.min[axis]) / 2);
  const base = {
    localGroundDatumY: 0, groundAnchor: [0, 0, 0], useOriginalBoundingBoxBottomAsGround: false,
    alignToGroundNormal: false, keepUpright: true, uniformScaleRecommended: true,
    footprintAdaptive: true, embedMeters: id.includes('BasaltCliff') ? 0.035 : 0.015,
    footBounds: { min: [bounds.min[0], 0, bounds.min[2]], max: [bounds.max[0], 0, bounds.max[2]] },
    normalizedFootBounds: { min: [-1, 0, -1], max: [1, 0, 1] },
    footNormalization: { centreXZ, halfExtentsXZ, formula: 'normalizedXZ=(localXZ-centreXZ)/halfExtentsXZ' },
  };
  if (id.includes('Cone')) return {
    ...base, footprint: { shape: 'irregular-oval', halfExtentsXZ: [8.4, 8.5] },
    rootPlacement: { strategy: 'sampled-ground-datum', rootLocalDatumY: 0 },
    terrainConform: { mode: 'contact-band-only', localYBand: [0, 1.65], preserveAboveLocalY: 1.65, contactBoundaryY: 0, keepCraterAndLavaHorizontal: true, protectMaterialNamePattern: 'lava', weight: { formula: '1-smoothstep(0,1.65,localY)', fullBelowLocalY: 0, zeroAboveLocalY: 1.65 } },
    note: 'Local Y=0 is the mountain foot datum, not the remaining small rock minimum (-0.05m). Fit the foot to sampled host terrain; keep the upper cone/crater/lava upright. Do not raise by -bounds.minY.',
  };
  if (id.includes('LavaPool')) return {
    ...base, footprint: { shape: 'ellipse', halfExtentsXZ: [3.7, 3.4] },
    rootPlacement: { strategy: 'highest-rendered-footprint-sample-plus-lava-clearance', lavaLocalY: -0.12, clearanceWorldMeters: 0.04, formula: 'rootWorldY=maxRenderedFootprintY+0.12*scaleY+0.04', hostTerrainModificationRequired: false },
    terrainConform: { mode: 'outer-contact-only', contactBoundaryY: 0, preserveLavaLevel: true, lavaLocalY: -0.12, outerContactRadiiXZ: [3.7, 3.4], weight: { formula: 'smoothstep(.94,1,rho)*(1-smoothstep(.02,.22,localY))', rhoDefinition: 'sqrt((localX/3.7)^2+(localZ/3.4)^2)', radialBegin: 0.94, radialFull: 1, fullBelowLocalY: 0.02, zeroAboveLocalY: 0.22 }, protectedMoltenHalfExtentsXZ: [3.13, 2.63] },
    note: 'Keep molten surface horizontal at local Y=-0.12. Place the root above the highest actually rendered host-ground sample plus lava depth/clearance, then pull only the outer oval foot back to sampled terrain. The original inner rim, crest, molten surface and host terrain remain unchanged.',
  };
  if (id.includes('LavaChannel')) return {
    ...base, footprint: { shape: 'channel', xRange: [-2.6, 2.6], zRange: [0, 8], entryOrigin: true },
    rootPlacement: { strategy: 'highest-rendered-footprint-sample-plus-lava-clearance', lavaLocalY: -0.12, clearanceWorldMeters: 0.04, formula: 'rootWorldY=maxRenderedFootprintY+0.12*scaleY+0.04', hostTerrainModificationRequired: false },
    terrainConform: { mode: 'bank-contact-only', contactX: [-2.6, 2.6], contactBoundaryY: 0, preserveLavaLevel: true, lavaLocalY: -0.12, weight: { formula: 'smoothstep(2.2,2.6,abs(localX))*(1-smoothstep(.02,.24,localY))', xBeginMeters: 2.2, xFullMeters: 2.6, normalizedXBegin: 2.2 / 2.6, normalizedXFull: 1, fullBelowLocalY: 0.02, zeroAboveLocalY: 0.24 }, endContactBand: { zEdges: [0, 8], zBlendDepthMeters: 0.65, affectOnlyAbsXAbove: 1.4, fullAtAbsX: 2.2, combineWithSideWeight: 'max', applyHeightFade: true, keepMoltenEndPortsLevel: true }, protectedMoltenXRange: [-1.4, 1.4] },
    note: 'Place root above the highest rendered footprint ground plus lava depth/clearance, not by bed minimum. Pull only the outer bank feet into host terrain. End-edge blending may affect outer rocks only; preserve the central molten ribbon and its z=0/z=8 end ports. Host terrain need not be cut.',
  };
  return {
    ...base, footprint: { shape: 'column-cluster', halfExtentsXZ: [4.12, 1.32] },
    rootPlacement: { strategy: 'sampled-ground-datum', rootLocalDatumY: 0 },
    terrainConform: { mode: 'contact-band-only', localYBand: [0, 0.6], preserveAboveLocalY: 0.85, contactBoundaryY: 0, weight: { formula: '1-smoothstep(.08,.85,localY)', fullBelowLocalY: 0.08, zeroAboveLocalY: 0.85 } },
    contactCentresXZ: [[-3.35, 0], [-2, 0], [-0.65, 0], [0.7, 0], [2.05, 0], [3.35, 0], [-2.8, 0.85], [-1.2, 0.85], [1, 0.85], [2.9, 0.85]],
    note: 'Six independent natural basalt columns and their fallen rocks have no shared display base. Keep their geology upright and fit only their individual lower feet to host terrain; never flatten the whole cliff by its bounding box.',
  };
}

function rewrite(glb, id) {
  const document = structuredClone(glb.document);
  assert(!document.images?.length && !document.textures?.length && !document.animations?.length && !document.skins?.length, 'Only static vertex-colour landscapes are supported');
  assert(!document.extensionsRequired?.length, 'Required extension needs explicit handling');
  const containsMesh = node => node.mesh !== undefined || (node.children ?? []).some(i => containsMesh(document.nodes[i]));
  for (const node of document.nodes) if (containsMesh(node)) assert(!node.matrix && !node.translation && !node.rotation && !node.scale, 'Mesh is not in canonical local coordinates');
  document.accessors = []; document.bufferViews = [];
  const parts = []; let offset = 0;
  const removed = {}; let reprofiledVertices = 0;
  function append(bytes, original, count, target, min, max) {
    const padded = pad4(offset); if (padded > offset) parts.push(Buffer.alloc(padded - offset)); offset = padded;
    const view = document.bufferViews.length;
    document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    parts.push(bytes); offset += bytes.length;
    const accessor = { ...original, bufferView: view, byteOffset: 0, count };
    delete accessor.sparse;
    if (min) accessor.min = min; else delete accessor.min;
    if (max) accessor.max = max; else delete accessor.max;
    document.accessors.push(accessor); return document.accessors.length - 1;
  }
  document.meshes.forEach((mesh, meshIndex) => {
    const primitives = [];
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const old = glb.document.meshes[meshIndex].primitives[primitiveIndex], data = primitiveData(glb, old), retained = [];
      const modifiedPositions = data.positions.values.map(point => [...point]);
      const moved = new Set();
      for (let t = 0; t < data.indices.length; t += 3) {
        const triangle = data.indices.slice(t, t + 3), reason = filterReason(id, data, triangle.map(i => data.positions.values[i]));
        if (reason) { removed[reason] = (removed[reason] ?? 0) + 1; continue; }
        retained.push(...triangle);
      }
      if (!retained.length) return;
      const used = [...new Set(retained)], remap = new Map(used.map((old, index) => [old, index]));
      if (id.includes('LavaPool') && !data.lava) for (const index of used) {
        const tag = poolRing(data.positions.values[index]);
        if (tag?.ring === 2) {
          modifiedPositions[index] = [Math.fround(3.7 * Math.cos(tag.angle)), 0, Math.fround(3.4 * Math.sin(tag.angle))];
          moved.add(index); reprofiledVertices++;
        }
      }
      const normalChanges = new Map();
      for (let t = 0; t < retained.length; t += 3) {
        const indices = retained.slice(t, t + 3);
        if (!indices.some(i => moved.has(i))) continue;
        const [a, b, c] = indices.map(i => modifiedPositions[i]);
        const u = b.map((n, i) => n - a[i]), v = c.map((n, i) => n - a[i]);
        const faceNormal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        for (const index of indices) {
          const sum = normalChanges.get(index) ?? [0, 0, 0];
          normalChanges.set(index, sum.map((n, axis) => n + faceNormal[axis]));
        }
      }
      for (const [index, normal] of normalChanges) {
        const length = Math.hypot(...normal); assert(length > 0.0000001, 'Degenerate reprofiling normal');
        normalChanges.set(index, normal.map(n => Math.fround(n / length)));
      }
      const attributes = {};
      for (const [semantic, oldAccessor] of Object.entries(old.attributes)) {
        const attr = readAccessor(glb, oldAccessor), bytes = Buffer.alloc(used.length * attr.elementSize);
        const values = used.map(index => semantic === 'POSITION' ? modifiedPositions[index] : semantic === 'NORMAL' && normalChanges.has(index) ? normalChanges.get(index) : attr.values[index]);
        used.forEach((index, newIndex) => {
          glb.binary.copy(bytes, newIndex * attr.elementSize, attr.offset + index * attr.stride, attr.offset + index * attr.stride + attr.elementSize);
          if (semantic === 'POSITION' && moved.has(index) || semantic === 'NORMAL' && normalChanges.has(index)) {
            assert(attr.accessor.componentType === 5126, 'Changed positions/normals must be float32');
            values[newIndex].forEach((value, axis) => bytes.writeFloatLE(value, newIndex * attr.elementSize + axis * 4));
          }
        });
        const min = semantic === 'POSITION' || attr.accessor.min ? Array.from({ length: attr.width }, (_, axis) => Math.min(...values.map(p => p[axis]))) : undefined;
        const max = semantic === 'POSITION' || attr.accessor.max ? Array.from({ length: attr.width }, (_, axis) => Math.max(...values.map(p => p[axis]))) : undefined;
        attributes[semantic] = append(bytes, attr.accessor, used.length, 34962, min, max);
      }
      const large = used.length > 65535, indexBytes = Buffer.alloc(retained.length * (large ? 4 : 2));
      retained.forEach((index, i) => indexBytes[large ? 'writeUInt32LE' : 'writeUInt16LE'](remap.get(index), i * (large ? 4 : 2)));
      const indices = append(indexBytes, { componentType: large ? 5125 : 5123, type: 'SCALAR' }, retained.length, 34963, [0], [used.length - 1]);
      primitives.push({ ...primitive, attributes, indices });
    });
    assert(primitives.length, 'Cleanup removed an entire volcano mesh'); mesh.primitives = primitives;
  });
  document.buffers = [{ byteLength: offset }];
  document.asset.extras = { ...document.asset.extras, railLoopLabVolcanoCleanup: { version: 1, originalLibraryUnchanged: true, groundDatumY: 0 } };
  const binary = Buffer.concat(parts), bin = Buffer.alloc(pad4(binary.length)); binary.copy(bin);
  const jsonBytes = Buffer.from(JSON.stringify(document)), json = Buffer.alloc(pad4(jsonBytes.length), 0x20); jsonBytes.copy(json);
  const bytes = Buffer.alloc(28 + json.length + bin.length);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  const binStart = 20 + json.length; bytes.writeUInt32LE(bin.length, binStart); bytes.writeUInt32LE(0x004e4942, binStart + 4); bin.copy(bytes, binStart + 8);
  return { bytes, removed, reprofiledVertices };
}

export function makeDerivative(bytes, id) {
  const glb = parseGlb(bytes), before = inspectGeometry(glb), protectedBefore = lavaSurfaceSignature(glb, id);
  if (id.includes('BasaltCliff')) return { bytes, before, after: before, removed: {}, reprofiledVertices: 0, protectedBefore, protectedAfter: protectedBefore, geometryModified: false };
  const output = rewrite(glb, id), result = parseGlb(output.bytes), after = inspectGeometry(result), protectedAfter = lavaSurfaceSignature(result, id);
  assert(protectedBefore.triangles > 0, `No protected molten surface found: ${id}`);
  assert(JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter), `The true molten surface changed: ${id}`);
  assert(after.triangles > 0 && after.triangles < before.triangles, `No display foundation was removed: ${id}`);
  return { ...output, before, after, protectedBefore, protectedAfter, geometryModified: true };
}

export function run(apply = false) {
  const manifestPath = path.join(projectRoot, 'asset-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const reports = [];
  for (const id of VOLCANO_IDS) {
    const model = manifest.models[id], modelPath = path.join(projectRoot, model.url), original = fs.readFileSync(modelPath), parsed = parseGlb(original);
    const derivationPath = path.join(projectRoot, 'assets/provenance', id, 'derivations/volcano-base-cleanup.json');
    if (parsed.document.asset.extras?.railLoopLabVolcanoCleanup || id.includes('BasaltCliff') && fs.existsSync(derivationPath)) {
      const previous = JSON.parse(fs.readFileSync(derivationPath, 'utf8'));
      if (apply) {
        previous.placement = placementFor(id, inspectGeometry(parsed).bounds);
        model.placement = previous.placement;
        fs.writeFileSync(derivationPath, JSON.stringify(previous, null, 2) + '\n');
      }
      reports.push({ ...previous, alreadyProcessed: true }); continue;
    }
    const result = makeDerivative(original, id), placement = placementFor(id, result.after.bounds);
    const report = {
      id, operation: result.geometryModified ? 'remove-display-foundation-and-retain-natural-volcano' : 'placement-metadata-only-natural-individual-column-feet',
      sourceReadOnly: '07_Environment/Volcano/_Shared/Volcano_Kit_001/source/build_volcano.py',
      originalSha256: sha256(original), outputSha256: sha256(result.bytes),
      before: { ...result.before, bytes: original.length }, after: { ...result.after, bytes: result.bytes.length },
      removedTriangles: result.removed, reprofiledOuterRimVertices: result.reprofiledVertices,
      protectedMoltenSurface: { before: result.protectedBefore, after: result.protectedAfter, unchanged: true },
      placement, geometryModified: result.geometryModified, sourceLibraryModified: false,
    };
    if (apply) {
      if (result.geometryModified) fs.writeFileSync(modelPath, result.bytes);
      fs.mkdirSync(path.dirname(derivationPath), { recursive: true }); fs.writeFileSync(derivationPath, JSON.stringify(report, null, 2) + '\n');
      model.bytes = result.bytes.length; model.triangles = result.after.triangles; model.bounds = result.after.bounds; model.dimensions = result.after.dimensions;
      model.derivation = path.relative(projectRoot, derivationPath).replaceAll(path.sep, '/'); model.placement = placement;
    }
    reports.push(report);
  }
  if (apply) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    // Repeated application retains original geometry hashes/removal records and
    // only refreshes the placement recommendations; it never cleans a GLB twice.
    fs.writeFileSync(path.join(projectRoot, 'assets/provenance/volcano-base-cleanup.json'), JSON.stringify({ version: 1, originalLibraryModified: false, models: reports }, null, 2) + '\n');
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'inspect', models: reports }, null, 2));
  return reports;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run(process.argv.includes('--apply'));
