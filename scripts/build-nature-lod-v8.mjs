/**
 * Deterministic, index-only far LODs. Whole independent foliage islands are retained;
 * opaque bark and flower primitives, all vertex attributes, UVs and transforms stay intact.
 * node scripts/build-nature-lod-v8.mjs --analyze | --build | --verify-only
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fragmentPath = path.join(root, 'asset-manifest.nature-v8.json');
const fragment = JSON.parse(fs.readFileSync(fragmentPath, 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const verifyOnly = process.argv.includes('--verify-only');
const build = process.argv.includes('--build') || verifyOnly;
const PROVENANCE = 'assets/provenance/Quaternius_UltimateStylizedNature_202205';
function artifact(relative, bytes) {
  const filename = path.resolve(root, relative);
  assert(filename.startsWith(root + path.sep));
  if (fs.existsSync(filename)) {
    if (verifyOnly || relative.endsWith('.glb')) assert(fs.readFileSync(filename).equals(bytes), `Deterministic output mismatch: ${relative}`);
    else fs.writeFileSync(filename, bytes);
  } else {
    assert(!verifyOnly, `Missing artifact: ${relative}`);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes, { flag: 'wx' });
  }
}
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function readGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binOffset = 20 + jsonLength; assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942);
  return { json, bin: bytes.subarray(binOffset + 8, binOffset + 8 + json.buffers[0].byteLength) };
}
function accessor(glb, index) {
  const a = glb.json.accessors[index], v = glb.json.bufferViews[a.bufferView];
  assert(!a.sparse); assert.equal(v.buffer, 0);
  const sizes = { 5123: 2, 5125: 4, 5126: 4 }, components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const size = sizes[a.componentType], count = components[a.type]; assert(size && count);
  const start = (v.byteOffset || 0) + (a.byteOffset || 0), stride = v.byteStride || size * count;
  const rows = [];
  for (let i = 0; i < a.count; i++) {
    const row = [];
    for (let k = 0; k < count; k++) {
      const offset = start + i * stride + k * size;
      row.push(a.componentType === 5126 ? glb.bin.readFloatLE(offset) : size === 2 ? glb.bin.readUInt16LE(offset) : glb.bin.readUInt32LE(offset));
    }
    rows.push(row);
  }
  const bytes = Buffer.alloc(a.count * size * count);
  for (let i = 0; i < a.count; i++) glb.bin.copy(bytes, i * size * count, start + i * stride, start + i * stride + size * count);
  return { descriptor: a, rows, bytes };
}
function viewBytes(glb, index) {
  const view = glb.json.bufferViews[index];
  return glb.bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
}
function writeGlb(json, bin) {
  const source = Buffer.from(JSON.stringify(json)), j = Buffer.alloc(Math.ceil(source.length / 4) * 4, 32), b = Buffer.alloc(Math.ceil(bin.length / 4) * 4);
  source.copy(j); bin.copy(b);
  const h = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + j.length + b.length, 8);
  jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, jh, j, bh, b]);
}
function islands(indices, positions, weldPositions) {
  const count = indices.length / 3, parent = Array.from({ length: count }, (_, i) => i), vertexTriangle = new Map();
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let triangle = 0; triangle < count; triangle++) for (let corner = 0; corner < 3; corner++) {
    const index = indices[triangle * 3 + corner];
    const key = weldPositions ? positions[index].map(v => Object.is(v, -0) ? 0 : v).join(',') : index;
    if (vertexTriangle.has(key)) union(triangle, vertexTriangle.get(key)); else vertexTriangle.set(key, triangle);
  }
  const groups = new Map();
  for (let triangle = 0; triangle < count; triangle++) {
    const key = find(triangle);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(triangle);
  }
  return [...groups.values()].map(triangles => {
    const vertexIDs = [...new Set(triangles.flatMap(t => indices.slice(t * 3, t * 3 + 3)))];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], centroid = [0, 0, 0];
    for (const index of vertexIDs) for (let k = 0; k < 3; k++) { const v = positions[index][k]; min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v); centroid[k] += v / vertexIDs.length; }
    return { triangles, vertexIDs, min, max, centroid };
  }).sort((a, b) => a.triangles[0] - b.triangles[0]);
}
function summarize(groups) {
  const histogram = {};
  for (const g of groups) histogram[g.triangles.length] = (histogram[g.triangles.length] || 0) + 1;
  return { islands: groups.length, triangleHistogram: histogram, largestIslandTriangles: Math.max(...groups.map(g => g.triangles.length)) };
}
const analyses = [], candidates = [];
for (const model of Object.values(fragment.models)) {
  if (!/Tree_|Bush/.test(model.id)) continue;
  const filename = path.join(root, model.url), bytes = fs.readFileSync(filename), glb = readGlb(bytes);
  const foliage = []; let opaqueTriangles = 0;
  for (const [meshIndex, mesh] of glb.json.meshes.entries()) for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
    assert(primitive.mode === undefined || primitive.mode === 4);
    const indices = accessor(glb, primitive.indices).rows.map(v => v[0]), positionAccessor = accessor(glb, primitive.attributes.POSITION);
    const material = glb.json.materials[primitive.material];
    if (material.alphaMode !== 'MASK') { opaqueTriangles += indices.length / 3; continue; }
    const indexed = islands(indices, positionAccessor.rows, false), welded = islands(indices, positionAccessor.rows, true);
    foliage.push({ mesh: meshIndex, primitive: primitiveIndex, material: material.name, leafTriangles: indices.length / 3, indexed: summarize(indexed), positionWelded: summarize(welded) });
    candidates.push({ model, filename, bytes, glb, meshIndex, primitiveIndex, primitive, material, indices, positions: positionAccessor.rows, groups: welded });
  }
  analyses.push({ id: model.id, totalTriangles: model.triangles, opaqueTriangles, foliage });
}
const report = {
  status: 'analyzed', modelsInspected: analyses.length, foliageModels: analyses.filter(a => a.foliage.length).length,
  alphaPrimitives: candidates.length, totalSourceTriangles: analyses.reduce((s, a) => s + a.totalTriangles, 0),
  foliageTriangles: candidates.reduce((s, a) => s + a.indices.length / 3, 0),
  independentPositionWeldedIslands: candidates.reduce((s, a) => s + a.groups.length, 0),
  models: analyses
};
const reportPath = path.join(root, 'validation/nature-v8-foliage-analysis.json');
artifact('validation/nature-v8-foliage-analysis.json', jsonBytes(report));
if (!build) {
  console.log(JSON.stringify({ ...report, models: undefined, report: reportPath }, null, 2));
  process.exit(0);
}

function selectIslands(candidate) {
  const { groups } = candidate;
  const selected = new Set(), extents = [0, 1, 2].map(k => [Math.min(...groups.map(g => g.min[k])), Math.max(...groups.map(g => g.max[k]))]);
  // Retain a whole island at every coordinate extreme. This preserves exact bounds.
  for (let k = 0; k < 3; k++) for (const side of [0, 1]) {
    const field = side ? 'max' : 'min', limit = extents[k][side];
    selected.add(groups.findIndex(g => g[field][k] === limit));
  }
  const positions = groups.map(g => g.centroid.map((v, k) => (v - extents[k][0]) / Math.max(1e-9, extents[k][1] - extents[k][0])));
  const nearest = groups.map(() => Infinity);
  const updateDistances = index => {
    for (let i = 0; i < groups.length; i++) {
      let distance = 0;
      for (let k = 0; k < 3; k++) distance += (positions[index][k] - positions[i][k]) ** 2;
      nearest[i] = Math.min(nearest[i], distance);
    }
  };
  for (const index of selected) updateDistances(index);
  const tie = groups.map(g => sha(Buffer.from(`${candidate.model.id}/${candidate.meshIndex}/${candidate.primitiveIndex}/${g.triangles[0]}`)).slice(0, 12));
  const sourceTriangles = candidate.indices.length / 3, target = sourceTriangles * 0.45, ceiling = sourceTriangles * 0.50;
  let retainedTriangles = [...selected].reduce((sum, i) => sum + groups[i].triangles.length, 0);
  if (retainedTriangles > ceiling) return null;
  while (retainedTriangles < target) {
    let next = -1;
    for (let i = 0; i < groups.length; i++) {
      if (selected.has(i) || retainedTriangles + groups[i].triangles.length > ceiling) continue;
      if (next === -1 || nearest[i] > nearest[next] + 1e-14 || Math.abs(nearest[i] - nearest[next]) <= 1e-14 && tie[i] < tie[next]) next = i;
    }
    if (next < 0) break;
    selected.add(next); retainedTriangles += groups[next].triangles.length; updateDistances(next);
  }
  if (retainedTriangles < sourceTriangles * 0.40 || retainedTriangles > ceiling) return null;
  const retainedTriangleIDs = [...selected].flatMap(i => groups[i].triangles).sort((a, b) => a - b);
  const values = retainedTriangleIDs.flatMap(t => candidate.indices.slice(t * 3, t * 3 + 3));
  return { selected, retainedTriangles, retainedTriangleIDs, values, sourceTriangles, retainedRatio: retainedTriangles / sourceTriangles };
}

function indexedBounds(glb) {
  const bounds = [];
  for (const mesh of glb.json.meshes) for (const primitive of mesh.primitives) {
    const positions = accessor(glb, primitive.attributes.POSITION).rows, indices = accessor(glb, primitive.indices).rows;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const [index] of indices) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[index][k]); max[k] = Math.max(max[k], positions[index][k]); }
    bounds.push({ min, max });
  }
  return bounds;
}

const perModel = new Map(), skipped = [];
for (const candidate of candidates) {
  const sourceName = candidate.material.extras?.sourceMaterial || candidate.material.name;
  if (!/Leaves/i.test(sourceName)) continue; // Preserve flowers, even on flowering bushes.
  let reason;
  if (/PalmTree_/.test(candidate.model.id)) reason = 'Only 8–12 large fronds; retain full authored palm silhouette.';
  else if (candidate.groups.length < 20) reason = 'Too few independently connected foliage islands.';
  const selection = reason ? null : selectIslands(candidate);
  const saved = selection ? selection.sourceTriangles - selection.retainedTriangles : 0;
  if (!reason && (!selection || saved < 100 || saved / candidate.model.triangles < 0.08)) reason = 'Insufficient whole-island triangle savings after preserving spatial extremes.';
  if (reason) { skipped.push({ id: candidate.model.id, material: sourceName, reason }); continue; }
  if (!perModel.has(candidate.model.id)) perModel.set(candidate.model.id, []);
  perModel.get(candidate.model.id).push({ ...candidate, selection });
}
const lodResults = [];
for (const [id, changes] of perModel) {
  const model = fragment.models[id], original = changes[0].glb, json = structuredClone(original.json), replacements = new Map(), changedAccessors = new Set();
  let savedTriangles = 0;
  const selections = [];
  for (const candidate of changes) {
    const indexID = candidate.primitive.indices, a = json.accessors[indexID], v = json.bufferViews[a.bufferView], selection = candidate.selection;
    assert(!v.byteStride && !(a.byteOffset || 0));
    assert.equal(json.accessors.filter(other => other.bufferView === a.bufferView).length, 1, 'The index accessor owns its bufferView');
    const size = { 5123: 2, 5125: 4 }[a.componentType]; assert(size);
    assert.equal(v.byteLength, original.json.accessors[indexID].count * size);
    const bytes = Buffer.alloc(selection.values.length * size);
    selection.values.forEach((value, i) => size === 2 ? bytes.writeUInt16LE(value, i * size) : bytes.writeUInt32LE(value, i * size));
    replacements.set(a.bufferView, bytes); changedAccessors.add(indexID);
    a.count = selection.values.length; a.min = [Math.min(...selection.values)]; a.max = [Math.max(...selection.values)];
    savedTriangles += selection.sourceTriangles - selection.retainedTriangles;
    selections.push({ mesh: candidate.meshIndex, primitive: candidate.primitiveIndex, material: candidate.material.name,
      sourceIslands: candidate.groups.length, retainedIslands: selection.selected.size,
      sourceTriangles: selection.sourceTriangles, retainedTriangles: selection.retainedTriangles,
      retainedFoliageRatio: selection.retainedRatio,
      retainedIslandFirstTriangleIndices: [...selection.selected].map(i => candidate.groups[i].triangles[0]).sort((a, b) => a - b) });
  }
  const chunks = []; let offset = 0;
  for (let i = 0; i < json.bufferViews.length; i++) {
    const padding = (4 - offset % 4) % 4;
    if (padding) { chunks.push(Buffer.alloc(padding)); offset += padding; }
    const bytes = replacements.get(i) || viewBytes(original, i), v = json.bufferViews[i];
    v.byteOffset = offset; v.byteLength = bytes.length; chunks.push(bytes); offset += bytes.length;
  }
  json.buffers[0].byteLength = offset;
  const output = writeGlb(json, Buffer.concat(chunks)), actual = readGlb(output), url = model.url.replace(/\.glb$/, '.lod1.glb');
  assert(savedTriangles >= 100 && model.triangles - savedTriangles < model.triangles);
  const accessorProofs = [];
  for (let i = 0; i < original.json.accessors.length; i++) {
    const before = accessor(original, i), after = accessor(actual, i);
    if (changedAccessors.has(i)) {
      const a = structuredClone(before.descriptor), b = structuredClone(after.descriptor);
      for (const key of ['count', 'min', 'max']) { delete a[key]; delete b[key]; }
      assert.deepEqual(a, b);
      const candidate = changes.find(c => c.primitive.indices === i), retained = new Set(candidate.selection.retainedTriangleIDs);
      for (const group of candidate.groups) { const count = group.triangles.filter(t => retained.has(t)).length; assert(count === 0 || count === group.triangles.length, 'A whole card/island must be kept or removed'); }
      assert.deepEqual(after.rows.map(r => r[0]), candidate.selection.values);
    } else {
      assert.deepEqual(before.descriptor, after.descriptor, 'Non-index accessor descriptor unchanged');
      assert(before.bytes.equals(after.bytes), 'All vertex attributes and opaque/flower index bytes unchanged');
    }
    accessorProofs.push({ accessor: i, changedIndexOnly: changedAccessors.has(i), sourceSHA256: sha(before.bytes), outputSHA256: sha(after.bytes), sourceCount: before.descriptor.count, outputCount: after.descriptor.count });
  }
  const beforeSemantic = structuredClone(original.json), afterSemantic = structuredClone(actual.json);
  for (const key of ['buffers', 'bufferViews', 'accessors']) { delete beforeSemantic[key]; delete afterSemantic[key]; }
  assert.deepEqual(beforeSemantic, afterSemantic, 'Nodes, materials, image URIs, mesh/material assignments and transforms unchanged');
  for (let i = 0; i < json.bufferViews.length; i++) if (!replacements.has(i)) assert(viewBytes(original, i).equals(viewBytes(actual, i)), 'Non-index bufferViews unchanged');
  assert.deepEqual(indexedBounds(original), indexedBounds(actual), 'Every primitive retains its exact indexed spatial bounds');
  for (const image of actual.json.images) {
    assert(!image.bufferView && image.uri.startsWith('../textures/nature-v8/'));
    assert(fs.existsSync(path.resolve(path.dirname(path.join(root, url)), image.uri)));
  }
  const provenance = `${PROVENANCE}/lods/${id}.lod1.json`, sourceSHA256 = sha(changes[0].bytes), outputSHA256 = sha(output);
  assert.equal(sourceSHA256, model.sourceDerivation.outputSHA256);
  artifact(url, output);
  model.lod = {
    url, bytes: output.length, triangles: model.triangles - savedTriangles,
    switchDistance: model.sceneRole === 'tree' ? 90 : 65,
    method: 'spatially-distributed-whole-foliage-island-subset',
    sourceTriangles: model.triangles, sourceSHA256, outputSHA256,
    retainedFoliageRatio: changes.reduce((s, c) => s + c.selection.retainedTriangles, 0) / changes.reduce((s, c) => s + c.selection.sourceTriangles, 0),
    provenance
  };
  artifact(provenance, jsonBytes({
    id, level: 1, author: model.author, license: model.license, source: model.source,
    sourceGameFile: model.url, sourceSHA256, outputGameFile: url, outputSHA256,
    method: 'Select whole, exact-position-connected leaf islands by deterministic farthest-point sampling in normalized 3D canopy space. Preserve one whole island at each primitive coordinate extreme. Keep 40–50% foliage triangle budget; do not collapse or rescale individual leaf cards.',
    opaqueBarkAndFlowersUnchanged: true, allVertexAttributesUnchanged: true,
    allUVsNormalsTangentsUnchanged: true, exactPerPrimitiveIndexedBoundsPreserved: true,
    allMaterialAndNodeSemanticsUnchanged: true, allSelectedIslandsComplete: true,
    sourceTriangles: model.triangles, outputTriangles: model.lod.triangles, savedTriangles,
    sourceBytes: changes[0].bytes.length, outputBytes: output.length, selections, accessorProofs
  }));
  lodResults.push({ id, ...model.lod, savedTriangles, triangleReduction: savedTriangles / model.triangles, allChecks: 'passed' });
}
const sourceTriangles = lodResults.reduce((s, r) => s + r.sourceTriangles, 0), outputTriangles = lodResults.reduce((s, r) => s + r.triangles, 0), lodBytes = lodResults.reduce((s, r) => s + r.bytes, 0);
const lodReport = {
  status: 'passed', lodModels: lodResults.length, sourceTriangles, outputTriangles,
  savedTriangles: sourceTriangles - outputTriangles, triangleReduction: (sourceTriangles - outputTriangles) / sourceTriangles,
  lodGLBBytes: lodBytes, allMainModelHashesUnchanged: true,
  allVertexAttributeAndOpaqueIndexBytesUnchanged: true, allLeafUVsAndNormalsPreserved: true,
  allRetainedIslandsComplete: true, allPrimitiveBoundsExact: true,
  allMaterialsAndNodeTransformsUnchanged: true, allExternalTexturesExist: true,
  models: lodResults, skipped
};
fragment.naturePack.lod = { modelCount: lodResults.length, sourceTriangles, outputTriangles,
  savedTriangles: sourceTriangles - outputTriangles, bytes: lodBytes,
  modelAndTextureBytesIncludingLODs: fragment.naturePack.optimizedModelAndTextureBytes + lodBytes,
  report: 'validation/nature-v8-lod.json', method: 'whole-independent-foliage-islands-only' };
artifact('asset-manifest.nature-v8.json', jsonBytes(fragment));
artifact('validation/nature-v8-lod.json', jsonBytes(lodReport));
artifact(`${PROVENANCE}/LOD.md`, Buffer.from(`# Nature LOD1 derivation\n\n${lodResults.length} green tree/bush models have a true lower-triangle far model. Each retains a deterministic, spatially distributed subset of whole connected leaf-card islands. Islands are connected using exact vertex positions so UV seams cannot split a card into individual triangles. No card is collapsed, rescaled or given different UVs.\n\nSix coordinate extremes remain represented, preserving every primitive's exact indexed bounds. All position, normal, UV and tangent accessor bytes are unchanged. Opaque bark and flower index buffers are unchanged; only independent foliage index arrays are shortened. Original main GLBs remain untouched and are used near the camera. The five palms are skipped because they have only 8–12 large fronds; opaque/dead trees, rocks, flowers, grass and flower-crown pieces are also unchanged.\n\nAcross the ${lodResults.length} affected models, one instance each is reduced from ${sourceTriangles} to ${outputTriangles} triangles (${((sourceTriangles - outputTriangles) / sourceTriangles * 100).toFixed(1)}%). This is a geometry reduction, not a measured frame-rate guarantee. Full per-model selection and accessor proofs are under \`lods/\`; aggregate checks are in \`validation/nature-v8-lod.json\`.\n\nRepeat deterministic verification with \`node scripts/build-nature-lod-v8.mjs --verify-only\`. It uses only delivered local game files.\n`));
console.log(JSON.stringify({ status: lodReport.status, lodModels: lodResults.length, sourceTriangles, outputTriangles, savedTriangles: sourceTriangles - outputTriangles, triangleReduction: lodReport.triangleReduction, lodGLBBytes: lodBytes, includingLODsBytes: fragment.naturePack.lod.modelAndTextureBytesIncludingLODs, report: 'validation/nature-v8-lod.json' }, null, 2));
