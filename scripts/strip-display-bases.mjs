/**
 * Remove rectangular display slabs from the web project's landscape copies.
 * The original GameAssets library and its provenance are never changed.
 *
 * node scripts/strip-display-bases.mjs --inspect
 * node scripts/strip-display-bases.mjs --apply
 * node scripts/strip-display-bases.mjs --verify
 *
 * Deliberately targets only four known heightfields. Water/farm tiles and
 * naturally shaped cone/rock feet are intentionally excluded.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.find(arg => ['--inspect', '--apply', '--verify'].includes(arg)) ?? '--inspect';
const epsilon = 0.00001;
const flatTopLimit = 0.002; // two millimetres: trims coplanar display land, not slopes
const targets = new Map([
  ['Environment_Hills_RoundHill16m_001', -0.9],
  ['Environment_Hills_RollingRidge24m_001', -0.9],
  ['Environment_Hills_DistantRidge48m_001', -0.9],
  ['Environment_Desert_DuneTile16m_001', -0.65],
]);
const reviewedNatural = [
  'Environment_Hills_StrataRockface8m_001',
  'Environment_Desert_SandstoneArch9m_001',
  'Environment_Snow_DriftCluster_001',
  'Environment_Snow_IceWall8m_001',
  'Environment_Volcano_Cone16m_001',
  'Environment_Volcano_BasaltCliff8m_001',
];
const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const lanes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const readers = { 5120: 'readInt8', 5121: 'readUInt8', 5122: 'readInt16LE', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pad4 = n => (n + 3) & ~3;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function parse(bytes) {
  assert(bytes.toString('ascii', 0, 4) === 'glTF', 'Not a GLB');
  assert(bytes.readUInt32LE(4) === 2, 'Only GLB 2.0 is supported');
  assert(bytes.readUInt32LE(8) === bytes.length, 'GLB length mismatch');
  let document;
  let binary;
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    assert(offset + 8 + length <= bytes.length, 'Invalid chunk range');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) document = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  assert(document && binary, 'JSON or BIN chunk is missing');
  return { document, binary };
}

function accessorData(glb, index) {
  const accessor = glb.document.accessors[index];
  assert(accessor && !accessor.sparse, 'Unsupported missing/sparse accessor');
  const view = glb.document.bufferViews[accessor.bufferView];
  const size = sizes[accessor.componentType];
  const width = lanes[accessor.type];
  assert(size && width && view.buffer === 0, 'Unsupported attribute format');
  const elementSize = size * width;
  const stride = view.byteStride ?? elementSize;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  assert(offset + (accessor.count - 1) * stride + elementSize <= glb.binary.length, 'Accessor out of bounds');
  const values = Array.from({ length: accessor.count }, (_, vertex) =>
    Array.from({ length: width }, (_, axis) => glb.binary[readers[accessor.componentType]](offset + vertex * stride + axis * size)));
  return { accessor, view, size, width, elementSize, stride, offset, values };
}

function primitiveData(glb, primitive) {
  assert((primitive.mode ?? 4) === 4, 'Only triangles are supported');
  const position = accessorData(glb, primitive.attributes.POSITION);
  const indices = primitive.indices === undefined
    ? Array.from({ length: position.values.length }, (_, i) => i)
    : accessorData(glb, primitive.indices).values.map(value => value[0]);
  assert(indices.length % 3 === 0, 'Index count is not divisible by three');
  return { position, indices };
}

function boundsFromPoints(points) {
  assert(points.length > 0, 'No visible positions remain');
  return {
    min: [0, 1, 2].map(axis => Math.min(...points.map(p => p[axis]))),
    max: [0, 1, 2].map(axis => Math.max(...points.map(p => p[axis]))),
  };
}

function classify(points) {
  if (Math.min(...points.map(p => p[1])) < -epsilon) return 'slab-side-or-bottom';
  if (Math.max(...points.map(p => p[1])) <= flatTopLimit) return 'flat-display-top';
  return 'natural-surface';
}

function scan(glb) {
  let triangles = 0;
  let sideBottom = 0;
  let flatTop = 0;
  const points = [];
  for (const mesh of glb.document.meshes) {
    for (const primitive of mesh.primitives) {
      const { position, indices } = primitiveData(glb, primitive);
      for (let t = 0; t < indices.length; t += 3) {
        const vertices = indices.slice(t, t + 3).map(i => {
          assert(i < position.values.length, 'Index outside position attribute');
          const value = position.values[i];
          assert(value.every(Number.isFinite), 'Nonfinite position');
          return value;
        });
        points.push(...vertices);
        triangles++;
        const kind = classify(vertices);
        if (kind === 'slab-side-or-bottom') sideBottom++;
        else if (kind === 'flat-display-top') flatTop++;
      }
    }
  }
  return { triangles, slabSideBottomTriangles: sideBottom, flatDisplayTopTriangles: flatTop, bounds: boundsFromPoints(points) };
}

function clean(glb, id) {
  const document = structuredClone(glb.document);
  assert(!document.animations?.length && !document.skins?.length, 'Animated or skinned meshes are out of scope');
  assert(!document.extensionsRequired?.length, 'Required glTF extensions need explicit handling');
  assert(!document.textures?.length && !document.images?.length, 'This cleaner targets vertex-colour landscapes only');
  const containsMesh = node => node.mesh !== undefined || (node.children ?? []).some(index => containsMesh(document.nodes[index]));
  for (const node of document.nodes) {
    if (containsMesh(node)) assert(!node.matrix && !node.rotation && !node.scale && !node.translation, 'Expected landscape geometry already in datum coordinates');
  }
  document.accessors = [];
  document.bufferViews = [];
  const binaryParts = [];
  let binaryLength = 0;

  function addAccessor(buffer, original, count, target, min, max) {
    const offset = pad4(binaryLength);
    if (offset > binaryLength) binaryParts.push(Buffer.alloc(offset - binaryLength));
    const viewIndex = document.bufferViews.length;
    document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length, target });
    binaryParts.push(buffer);
    binaryLength = offset + buffer.length;
    const value = { ...original, bufferView: viewIndex, byteOffset: 0, count };
    delete value.sparse;
    if (min) value.min = min; else delete value.min;
    if (max) value.max = max; else delete value.max;
    const accessorIndex = document.accessors.length;
    document.accessors.push(value);
    return accessorIndex;
  }

  document.meshes.forEach((mesh, meshIndex) => {
    const keptPrimitives = [];
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const oldPrimitive = glb.document.meshes[meshIndex].primitives[primitiveIndex];
      const { position, indices } = primitiveData(glb, oldPrimitive);
      const retained = [];
      for (let t = 0; t < indices.length; t += 3) {
        const triangle = indices.slice(t, t + 3);
        if (classify(triangle.map(i => position.values[i])) === 'natural-surface') retained.push(...triangle);
      }
      if (!retained.length) return;
      const oldVertices = [...new Set(retained)];
      const newIndex = new Map(oldVertices.map((old, i) => [old, i]));
      const attributes = {};
      for (const [semantic, accessorIndex] of Object.entries(oldPrimitive.attributes)) {
        const data = accessorData(glb, accessorIndex);
        const bytes = Buffer.alloc(oldVertices.length * data.elementSize);
        oldVertices.forEach((old, i) => glb.binary.copy(bytes, i * data.elementSize, data.offset + old * data.stride, data.offset + old * data.stride + data.elementSize));
        let min;
        let max;
        if (semantic === 'POSITION' || data.accessor.min || data.accessor.max) {
          min = Array.from({ length: data.width }, (_, axis) => Math.min(...oldVertices.map(i => data.values[i][axis])));
          max = Array.from({ length: data.width }, (_, axis) => Math.max(...oldVertices.map(i => data.values[i][axis])));
        }
        attributes[semantic] = addAccessor(bytes, data.accessor, oldVertices.length, 34962, min, max);
      }
      const large = oldVertices.length > 65535;
      const bytes = Buffer.alloc(retained.length * (large ? 4 : 2));
      retained.forEach((old, i) => bytes[large ? 'writeUInt32LE' : 'writeUInt16LE'](newIndex.get(old), i * (large ? 4 : 2)));
      const indexAccessor = addAccessor(bytes, { componentType: large ? 5125 : 5123, type: 'SCALAR' }, retained.length, 34963, [0], [oldVertices.length - 1]);
      keptPrimitives.push({ ...primitive, attributes, indices: indexAccessor });
    });
    assert(keptPrimitives.length, `All primitives were removed from ${id}`);
    mesh.primitives = keptPrimitives;
  });
  document.buffers = [{ byteLength: binaryLength }];
  document.asset.extras = {
    ...document.asset.extras,
    railLoopLabDerivation: { kind: 'remove-rectangular-display-slab', datumY: 0, flatTopThresholdMeters: flatTopLimit, originalLibraryUnchanged: true },
  };
  const binary = Buffer.concat(binaryParts);
  const binPadded = Buffer.alloc(pad4(binary.length));
  binary.copy(binPadded);
  const json = Buffer.from(JSON.stringify(document));
  const jsonPadded = Buffer.alloc(pad4(json.length), 0x20);
  json.copy(jsonPadded);
  const output = Buffer.alloc(12 + 8 + jsonPadded.length + 8 + binPadded.length);
  output.write('glTF', 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonPadded.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonPadded.copy(output, 20);
  const binStart = 20 + jsonPadded.length;
  output.writeUInt32LE(binPadded.length, binStart);
  output.writeUInt32LE(0x004e4942, binStart + 4);
  binPadded.copy(output, binStart + 8);
  return output;
}

const manifestPath = path.join(root, 'asset-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
const reports = [];
for (const [id, originalSlabBottomY] of targets) {
  const model = manifest.models[id];
  const modelPath = path.join(root, model.url);
  const original = fs.readFileSync(modelPath);
  const glb = parse(original);
  const before = scan(glb);
  const alreadyCleaned = Boolean(glb.document.asset.extras?.railLoopLabDerivation);
  if (mode === '--verify') {
    assert(alreadyCleaned, `${id} has not been cleaned`);
    assert(before.slabSideBottomTriangles === 0 && before.flatDisplayTopTriangles === 0, `${id} still contains its display slab`);
    assert(model.bytes === original.length && model.triangles === before.triangles, `${id} manifest is stale`);
    assert(JSON.stringify(model.bounds) === JSON.stringify(before.bounds), `${id} manifest bounds are stale`);
    reports.push({ id, verified: true, ...before, bytes: original.length });
    continue;
  }
  if (alreadyCleaned) {
    reports.push({ id, alreadyCleaned: true, ...before, bytes: original.length });
    continue;
  }
  const cleaned = clean(glb, id);
  const after = scan(parse(cleaned));
  assert(after.triangles > 0 && after.triangles < before.triangles, `${id} cleanup did not remove any slab faces`);
  assert(after.slabSideBottomTriangles === 0 && after.flatDisplayTopTriangles === 0, `${id} still has slab triangles`);
  const report = {
    id,
    applied: mode === '--apply',
    originalSha256: digest(original),
    cleanedSha256: digest(cleaned),
    before: { ...before, bytes: original.length },
    after: { ...after, bytes: cleaned.length },
    originalSlabBottomY,
    placement: { localGroundDatumY: 0, useOriginalBoundingBoxBottomAsGround: false, embedMeters: 0.015, note: 'Place local Y=0 at the host terrain datum. The open natural foot is intended to blend into host terrain.' },
    removed: { slabSideBottomTriangles: before.slabSideBottomTriangles, flatDisplayTopTriangles: before.flatDisplayTopTriangles },
    preserved: ['natural sloping terrain', 'artist vertex positions, normals and colors', 'embedded natural rock geometry', 'glTF node hierarchy and materials'],
    sourceLibraryModified: false,
  };
  if (mode === '--apply') {
    fs.writeFileSync(modelPath, cleaned);
    const derivationPath = path.join(root, 'assets', 'provenance', id, 'derivations', 'display-base-removal.json');
    fs.mkdirSync(path.dirname(derivationPath), { recursive: true });
    fs.writeFileSync(derivationPath, JSON.stringify(report, null, 2) + '\n');
    model.bytes = cleaned.length;
    model.triangles = after.triangles;
    model.bounds = after.bounds;
    model.dimensions = after.bounds.max.map((value, axis) => value - after.bounds.min[axis]);
    model.placement = report.placement;
    model.derivation = path.relative(root, derivationPath).replaceAll(path.sep, '/');
  }
  reports.push(report);
}
if (mode === '--apply') fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const naturalReview = reviewedNatural.map(id => {
  const bytes = fs.readFileSync(path.join(root, manifest.models[id].url));
  const glb = parse(bytes);
  return { id, modified: false, sha256: digest(bytes), reason: 'Natural cone, rock, arch or drift outline; no rectangular landscape display slab.', triangles: scan(glb).triangles };
});
const output = { mode, modifiedModels: reports, reviewedUnmodifiedNaturalModels: naturalReview };
if (mode === '--apply') {
  fs.writeFileSync(path.join(root, 'assets', 'provenance', 'landscape-display-base-cleanup.json'), JSON.stringify(output, null, 2) + '\n');
}
console.log(JSON.stringify(output, null, 2));
