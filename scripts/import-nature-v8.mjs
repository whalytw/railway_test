/**
 * Read-only source import of the 63 Quaternius May 2022 game-ready models.
 * Usage: node scripts/import-nature-v8.mjs --source-root <GameAssets> --target-root <game> [--verify-only]
 * No Blender files or source archives are copied. Existing, differing files are never overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const PACK = 'Quaternius_UltimateStylizedNature_202205';
const SOURCE_PACK = `04_Plants/${PACK}/_Shared`;
const PROVENANCE = `assets/provenance/${PACK}`;
const LICENSES = `assets/licenses/${PACK}`;
const TEXTURES = 'assets/textures/nature-v8';
const FRAGMENT = 'asset-manifest.nature-v8.json';
const REPORT = 'validation/nature-v8-assets.json';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = data => Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
const slash = name => name.split(path.sep).join('/');
const clone = value => structuredClone(value);
const args = process.argv.slice(2);
const arg = flag => args[args.indexOf(flag) + 1];
assert(args.includes('--source-root'), '--source-root is required');
const sourceRoot = fs.realpathSync(arg('--source-root'));
const targetRoot = fs.realpathSync(args.includes('--target-root') ? arg('--target-root') : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const verifyOnly = args.includes('--verify-only');
const refreshMetadata = args.includes('--refresh-metadata');
assert(!(verifyOnly && refreshMetadata), 'Verification does not rewrite metadata');
assert(!targetRoot.toLowerCase().startsWith(sourceRoot.toLowerCase() + path.sep), 'Do not import into the source asset library');
assert.notEqual(sourceRoot.toLowerCase(), targetRoot.toLowerCase());
const src = relative => path.resolve(sourceRoot, relative);
const dst = relative => {
  const resolved = path.resolve(targetRoot, relative);
  assert(resolved.toLowerCase().startsWith(targetRoot.toLowerCase() + path.sep), 'Output must remain in the game working copy');
  return resolved;
};
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const catalog = readJson(src(`${SOURCE_PACK}/catalog.json`));
const textureSources = readJson(src(`${SOURCE_PACK}/licenses/texture-manifest.json`));
const originalTextureMap = new Map(textureSources.map(t => [t.name.replace(/\.png$/i, ''), t]));
assert.equal(catalog.id, PACK);
assert.equal(catalog.license, 'CC0-1.0');
assert.equal(catalog.assets.length, 63);
assert.equal(new Set(catalog.assets.map(a => a.id)).size, 63);
assert(catalog.assets.every(a => a.status === 'game_ready'));
const existingManifest = readJson(dst('asset-manifest.json'));

// This allows a deterministic rerun while protecting unrelated files.
function writeNewOrSame(relative, bytes) {
  const filename = dst(relative);
  if (fs.existsSync(filename)) {
    if (!fs.readFileSync(filename).equals(bytes)) {
      const ownedMetadata = relative === FRAGMENT || relative === REPORT || relative.startsWith(PROVENANCE + '/');
      assert(refreshMetadata && ownedMetadata, `Refusing to replace a differing file: ${relative}`);
      fs.writeFileSync(filename, bytes);
    }
    return;
  }
  assert(!verifyOnly, `Missing output file: ${relative}`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes, { flag: 'wx' });
}

function readGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length');
  const chunks = [];
  let offset = 12;
  while (offset < bytes.length) {
    assert.equal(offset % 4, 0);
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    assert(offset + 8 + length <= bytes.length);
    chunks.push({ type, bytes: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  assert.equal(offset, bytes.length);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].type, 0x4e4f534a);
  assert.equal(chunks[1].type, 0x004e4942);
  const json = JSON.parse(chunks[0].bytes.toString('utf8'));
  assert.equal(json.buffers.length, 1);
  assert(!json.buffers[0].uri, 'Source uses a single GLB BIN chunk');
  assert(json.buffers[0].byteLength <= chunks[1].bytes.length);
  assert(chunks[1].bytes.length - json.buffers[0].byteLength < 4);
  return { json, bin: chunks[1].bytes.subarray(0, json.buffers[0].byteLength) };
}

function writeGlb(json, bin) {
  const jsonSource = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.alloc(Math.ceil(jsonSource.length / 4) * 4, 0x20);
  jsonSource.copy(jsonChunk);
  const binChunk = Buffer.alloc(Math.ceil(bin.length / 4) * 4);
  bin.copy(binChunk);
  const header = Buffer.alloc(12), jHeader = Buffer.alloc(8), bHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + jsonChunk.length + binChunk.length, 8);
  jHeader.writeUInt32LE(jsonChunk.length, 0); jHeader.writeUInt32LE(0x4e4f534a, 4);
  bHeader.writeUInt32LE(binChunk.length, 0); bHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jHeader, jsonChunk, bHeader, binChunk]);
}

const crcTable = Array.from({ length: 256 }, (_, i) => {
  for (let k = 0; k < 8; k++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
  return i >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Complete PNG scanline decoding (including all five filters), rather than a header-only check.
function decodePng(bytes) {
  assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  let offset = 8, width, height, depth, type, palette, ended = false;
  const compressed = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    assert(end <= bytes.length, 'PNG chunk boundary');
    const name = bytes.toString('ascii', offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length), `PNG ${name} CRC`);
    if (name === 'IHDR') {
      assert.equal(offset, 8); assert.equal(length, 13);
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4); depth = payload[8]; type = payload[9];
      assert(width > 0 && height > 0 && width <= 4096 && height <= 4096);
      assert.equal(payload[10], 0); assert.equal(payload[11], 0); assert.equal(payload[12], 0, 'Non-interlaced runtime PNG');
      const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      assert(validDepths[type]?.includes(depth), 'Supported PNG pixel format');
    } else if (name === 'IDAT') compressed.push(payload);
    else if (name === 'PLTE') { assert(length % 3 === 0); palette = length / 3; }
    else if (name === 'IEND') { assert.equal(length, 0); ended = true; assert.equal(end, bytes.length); }
    offset = end;
  }
  assert(ended && compressed.length);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const stride = Math.ceil(width * channels * depth / 8), bpp = Math.max(1, Math.ceil(channels * depth / 8));
  const inflated = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  assert.equal(inflated.length, (stride + 1) * height);
  const decoded = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const input = y * (stride + 1), row = y * stride, filter = inflated[input];
    assert(filter <= 4, 'PNG filter');
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? decoded[row + x - bpp] : 0, b = y ? decoded[row - stride + x] : 0, c = y && x >= bpp ? decoded[row - stride + x - bpp] : 0;
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      decoded[row + x] = (inflated[input + 1 + x] + prediction) & 255;
    }
    if (type === 3) {
      assert(palette > 0);
      for (let x = 0; x < width; x++) {
        const index = (decoded[row + Math.floor(x * depth / 8)] >> (8 - depth - x * depth % 8)) & ((1 << depth) - 1);
        assert(index < palette, 'PNG palette index');
      }
    }
  }
  return { dimensions: [width, height], bitDepth: depth, colorType: type, decodedBytes: decoded.length, decodedSHA256: sha(decoded) };
}

function viewBytes(glb, index) {
  const view = glb.json.bufferViews[index];
  assert(view && view.buffer === 0);
  const offset = view.byteOffset || 0;
  assert(offset >= 0 && view.byteLength > 0 && offset + view.byteLength <= glb.bin.length);
  return glb.bin.subarray(offset, offset + view.byteLength);
}
function mapViewReferences(value, mapper) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'bufferView') value[key] = mapper(item);
    else mapViewReferences(item, mapper);
  }
}
function accessorBytes(glb, index) {
  const a = glb.json.accessors[index];
  assert(!a.sparse, 'This pack has dense accessors');
  const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  assert(sizes[a.componentType] && components[a.type], 'Scalar/vector accessor');
  const elementSize = sizes[a.componentType] * components[a.type];
  const view = glb.json.bufferViews[a.bufferView], stride = view.byteStride || elementSize, data = viewBytes(glb, a.bufferView);
  assert(stride >= elementSize);
  const result = Buffer.alloc(a.count * elementSize), start = a.byteOffset || 0;
  assert(start + (a.count - 1) * stride + elementSize <= data.length);
  for (let i = 0; i < a.count; i++) data.copy(result, i * elementSize, start + i * stride, start + i * stride + elementSize);
  return result;
}

const sharedTextures = new Map(), modelSources = [], models = {}, results = [];
let sourceBytesTotal = 0, outputBytesTotal = 0, accessorCount = 0, imageReferences = 0, materialCount = 0, maskedMaterialCount = 0, multiPrimitiveModels = 0;
for (const entry of catalog.assets) {
  assert(!existingManifest.models[entry.id] || existingManifest.models[entry.id].scenePack === PACK, `Existing v7 ID collision: ${entry.id}`);
  const metadata = readJson(src(entry.metadata)), sourceBytes = fs.readFileSync(src(entry.file)), original = readGlb(sourceBytes);
  assert.equal(sha(sourceBytes), metadata.sha256, `${entry.id}: source GLB hash`);
  assert.equal(sourceBytes.length, entry.fileBytes);
  assert.equal(metadata.originalSHA256, entry.originalSHA256);
  assert.deepEqual(metadata.compatibleBiomes, entry.compatibleBiomes);
  assert(entry.compatibleBiomes.length > 0);
  const output = clone(original.json), imageViews = new Set(), modelImages = [];
  for (const image of output.images || []) {
    assert(image.bufferView !== undefined && image.mimeType === 'image/png' && !image.uri);
    const data = viewBytes(original, image.bufferView), digest = sha(data), filename = `${digest}.png`;
    imageViews.add(image.bufferView);
    const sourceTexture = originalTextureMap.get(image.name);
    assert(sourceTexture, `Untracked source texture: ${image.name}`);
    assert.equal(digest, sourceTexture.runtime_sha256, 'Embedded image exactly matches its documented library runtime texture');
    if (!sharedTextures.has(digest)) {
      const decoded = decodePng(data);
      sharedTextures.set(digest, {
        url: `${TEXTURES}/${filename}`, sha256: digest, bytes: data.length, ...decoded,
        embeddedSourceNames: [], sourceTextures: [], usedBy: [],
        originalTextureName: sourceTexture.name, originalTextureSHA256: sourceTexture.sha256,
        sourceLibraryRuntimeSHA256: sourceTexture.runtime_sha256,
        matchesLibraryRuntimeBytes: digest === sourceTexture.runtime_sha256,
        originalAuthorFileUrl: sourceTexture.original_author_file_url,
        recoveryMirrorUrl: sourceTexture.download_url,
        sourceLibraryTextureManifest: `${SOURCE_PACK}/licenses/texture-manifest.json`
      });
    }
    const record = sharedTextures.get(digest);
    if (!record.embeddedSourceNames.includes(image.name)) {
      record.embeddedSourceNames.push(image.name);
      record.sourceTextures.push({ name: sourceTexture.name, originalSHA256: sourceTexture.sha256, runtimeSHA256: sourceTexture.runtime_sha256, originalAuthorFileUrl: sourceTexture.original_author_file_url, recoveryMirrorUrl: sourceTexture.download_url });
    }
    if (!record.usedBy.includes(entry.id)) record.usedBy.push(entry.id);
    writeNewOrSame(record.url, data);
    modelImages.push({ name: image.name, sha256: digest, url: record.url, bytes: data.length });
    delete image.bufferView;
    image.uri = `../textures/nature-v8/${filename}`;
    imageReferences++;
  }
  const retained = [], mapping = new Map(), chunks = [];
  let newOffset = 0;
  for (let i = 0; i < original.json.bufferViews.length; i++) {
    if (imageViews.has(i)) continue;
    const view = clone(original.json.bufferViews[i]);
    const padding = (4 - newOffset % 4) % 4;
    if (padding) { chunks.push(Buffer.alloc(padding)); newOffset += padding; }
    mapping.set(i, retained.length); view.byteOffset = newOffset;
    const data = viewBytes(original, i);
    chunks.push(data); newOffset += data.length; retained.push(view);
  }
  output.bufferViews = retained;
  mapViewReferences(output, old => {
    assert(mapping.has(old), `A retained structure references removed image bufferView ${old}`);
    return mapping.get(old);
  });
  output.buffers[0].byteLength = newOffset;
  const bin = Buffer.concat(chunks), encoded = writeGlb(output, bin);
  const modelFilename = `Quaternius_${entry.id.split('_Quaternius_')[1]}.glb`, url = `assets/models/${modelFilename}`;
  writeNewOrSame(url, encoded);
  const written = fs.readFileSync(dst(url)), actual = readGlb(written);
  assert(written.equals(encoded));

  // Compare all renderer-visible JSON after reversing bufferView index relocation.
  const semanticBefore = clone(original.json), semanticAfter = clone(actual.json);
  for (const key of ['buffers', 'bufferViews', 'images']) { delete semanticBefore[key]; delete semanticAfter[key]; }
  const reverse = new Map([...mapping].map(([before, after]) => [after, before]));
  mapViewReferences(semanticAfter, value => reverse.get(value));
  assert.deepEqual(semanticAfter, semanticBefore, `${entry.id}: geometry/material/node semantics`);
  for (const [before, after] of mapping) {
    assert(viewBytes(actual, after).equals(viewBytes(original, before)), `${entry.id}: bufferView bytes ${before}`);
    const a = clone(original.json.bufferViews[before]), b = clone(actual.json.bufferViews[after]);
    delete a.byteOffset; delete b.byteOffset; assert.deepEqual(a, b);
  }
  const accessorChecks = original.json.accessors.map((a, i) => {
    const before = accessorBytes(original, i), after = accessorBytes(actual, i);
    assert(before.equals(after), `${entry.id}: accessor ${i} bytes changed`);
    accessorCount++;
    return { accessor: i, type: a.type, componentType: a.componentType, count: a.count, bytes: before.length, sha256: sha(before) };
  });
  for (let i = 0; i < actual.json.images.length; i++) {
    const image = actual.json.images[i];
    assert(!('bufferView' in image)); assert(!/^(?:[a-z]+:|\/)/i.test(image.uri));
    const imagePath = path.resolve(path.dirname(dst(url)), image.uri);
    assert(imagePath.startsWith(dst(TEXTURES) + path.sep));
    const before = original.json.images[i];
    assert(fs.readFileSync(imagePath).equals(viewBytes(original, before.bufferView)), 'External PNG is byte-identical to embedded source');
    const a = clone(before), b = clone(image); delete a.bufferView; delete b.uri; assert.deepEqual(a, b);
  }
  const primitives = original.json.meshes.flatMap(m => m.primitives);
  const triangles = primitives.reduce((sum, p) => {
    assert(p.mode === undefined || p.mode === 4, 'Triangle primitive');
    return sum + original.json.accessors[p.indices ?? p.attributes.POSITION].count / 3;
  }, 0);
  assert.equal(triangles, entry.triangles);
  const tree = /Tree_/.test(entry.id), dead = /DeadTree_/.test(entry.id), rock = entry.group === '岩石';
  const natureType = rock ? 'rock' : dead ? 'dead-tree' : tree ? 'tree' : /Petals_/.test(entry.id) ? 'petal' : /Grass/.test(entry.id) ? 'grass' : /Flower/.test(entry.id) && !/Bush/.test(entry.id) ? 'flower' : /Bush/.test(entry.id) ? 'bush' : 'leafy-plant';
  const placement = clone(metadata.placement);
  const palm = /PalmTree_/.test(entry.id);
  const gameUsage = palm ? '沙漠生態區僅配置於水邊綠洲；避免將棕櫚零散放在乾燥沙丘，寬葉冠仍須遵守軌道淨空。'
    : natureType === 'petal' ? '原始檔名 Petals 指這組靜態花頭／花冠部件，應作小型地面花叢或花朵組裝使用；不是單片飄落花瓣，也沒有粒子或飄落動畫。' : metadata.placement.usageNote;
  models[entry.id] = {
    id: entry.id, name: entry.name, url, category: entry.category,
    biome: entry.compatibleBiomes.length === 1 ? entry.compatibleBiomes[0] : null,
    compatibleBiomes: clone(entry.compatibleBiomes), sceneRole: rock ? 'rock' : tree ? 'tree' : 'shrub',
    scenePack: PACK, natureType, frequency: natureType === 'petal' ? 'uncommon' : 'common',
    ...(palm ? { nearWaterOnly: true, habitat: 'oasis' } : {}),
    usageNotes: gameUsage,
    dimensions: clone(entry.dimensions), bounds: clone(metadata.boundsMeters), triangles,
    meshNodeCount: primitives.length, materialCount: original.json.materials.length,
    bytes: written.length, sourceBytes: sourceBytes.length, footprintRadius: placement.footprintRadiusMeters,
    minRailOffset: placement.suggestedMinRailCenterOffsetMeters, minimumRailOffset: placement.suggestedMinRailCenterOffsetMeters,
    placement, license: 'CC0-1.0', author: catalog.author, source: catalog.sourceUrl,
    originalSHA256: entry.originalSHA256,
    sourceDerivation: { operation: 'externalize-deduplicated-png-images-only', sourceLibraryFile: entry.file, sourceGLBSHA256: metadata.sha256, outputSHA256: sha(written), accessorsByteIdentical: true },
    provenance: `${PROVENANCE}/models/${entry.id}.json`,
    sharedTextureUrls: modelImages.map(i => i.url)
  };
  const provenance = {
    id: entry.id, name: entry.name, author: catalog.author, pack: PACK,
    sourceUrl: catalog.sourceUrl, vendorRelease: '2022-05', license: 'CC0-1.0',
    licenseEvidence: `${LICENSES}/LicensingReview.zh-TW.md`,
    originalSourceFile: entry.originalFile, originalSourceSHA256: entry.originalSHA256,
    sourceArchiveName: catalog.sourceArchiveName, sourceArchiveSHA256: catalog.sourceArchiveSHA256,
    sourceLibraryMetadata: entry.metadata, sourceLibraryGLB: entry.file,
    sourceGLBSHA256: metadata.sha256, sourceGLBBytes: sourceBytes.length,
    gameFile: url, gameSHA256: sha(written), gameBytes: written.length,
    transformation: 'Only embedded PNG images were externalized and deduplicated by exact SHA-256. Non-image BIN bufferViews were copied byte-for-byte and relocated with 4-byte alignment. Geometry, indices, UVs, normals, tangents, material properties, samplers, nodes and transforms were preserved.',
    compatibleBiomes: clone(entry.compatibleBiomes), placement, gameUsage,
    ...(palm ? { nearWaterOnly: true, habitat: 'oasis' } : {}),
    originalNormalization: clone(metadata.sourceNormalization), coordinates: clone(metadata.coordinates),
    images: modelImages, accessorChecks, animationsProvided: false, lodsProvided: false,
    gamePerformanceCertification: false
  };
  writeNewOrSame(`${PROVENANCE}/models/${entry.id}.json`, jsonBytes(provenance));
  modelSources.push({ id: entry.id, gameFile: url, gameSHA256: sha(written), originalSourceFile: entry.originalFile, originalSourceSHA256: entry.originalSHA256, sourceLibraryGLB: entry.file, sourceGLBSHA256: metadata.sha256 });
  results.push({ id: entry.id, sourceSHA256: metadata.sha256, outputSHA256: sha(written), sourceBytes: sourceBytes.length, outputBytes: written.length, accessors: accessorChecks.length, images: modelImages.length, primitives: primitives.length, triangles, checks: 'passed' });
  sourceBytesTotal += sourceBytes.length; outputBytesTotal += written.length;
  materialCount += original.json.materials.length;
  maskedMaterialCount += original.json.materials.filter(m => m.alphaMode === 'MASK').length;
  multiPrimitiveModels += primitives.length > 1 ? 1 : 0;
}

const evidence = fs.readdirSync(src(`${SOURCE_PACK}/licenses`), { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort();
assert(evidence.includes('License.txt') && evidence.includes('LicensingReview.zh-TW.md'));
const copiedEvidence = [];
for (const filename of evidence) {
  const bytes = fs.readFileSync(src(`${SOURCE_PACK}/licenses/${filename}`));
  assert(!/\.(?:zip|blend|fbx|obj)$/i.test(filename));
  writeNewOrSame(`${LICENSES}/${filename}`, bytes);
  copiedEvidence.push({ file: `${LICENSES}/${filename}`, bytes: bytes.length, sha256: sha(bytes) });
}
const textures = [...sharedTextures.values()].sort((a, b) => a.url.localeCompare(b.url));
const textureBytes = textures.reduce((sum, t) => sum + t.bytes, 0);
writeNewOrSame(`${PROVENANCE}/textures.json`, jsonBytes(textures));
const packSource = {
  id: PACK, author: catalog.author, sourceUrl: catalog.sourceUrl, sourceArchiveName: catalog.sourceArchiveName,
  sourceArchiveSHA256: catalog.sourceArchiveSHA256, license: 'CC0-1.0', sourceCatalogSHA256: sha(fs.readFileSync(src(`${SOURCE_PACK}/catalog.json`))),
  modelCount: 63, plants: 58, rocks: 5, models: modelSources, licenseEvidence: copiedEvidence,
  derivation: 'Game-ready library GLBs, externalized PNGs, no geometry simplification, no Blender originals or source archive included.',
  licensingCaveat: 'This specific May 2022 pack is labeled CC0 on its dedicated official pack page. The official License.txt header says Ultimate Platformer Pack; the later generic QAL page differs. The preserved review and source pages explain this evidence and discrepancy. Do not generalize this pack-specific assessment to other Quaternius releases.',
  textureProvenance: `${PROVENANCE}/textures.json`
};
writeNewOrSame(`${PROVENANCE}/pack.json`, jsonBytes(packSource));
writeNewOrSame(`${PROVENANCE}/README.md`, Buffer.from(`# Quaternius nature assets in RailLoopLab v8\n\nThese 63 third-party models are from Quaternius Ultimate Stylized Nature Pack (May 2022), identified in the source library as CC0-1.0. The dedicated pack page, official license, later generic QAL page and documented title discrepancy are preserved under \`${LICENSES}/\`. Source Blender files and the full archive remain in the local asset library and are not delivered with the game.\n\nEach \`models/<asset ID>.json\` records the original Blender SHA-256, imported GLB SHA-256, output GLB SHA-256, individual accessor byte hashes, placement guidance and exact model-specific compatible biomes. \`textures.json\` links each content-addressed PNG to its original author file and the verified recovery mirror, including all original filenames that share identical bytes.\n\nThe import only extracts embedded PNG image bytes into shared files and repacks non-image BIN views without changing their contents. All 457 accessors are checked byte-for-byte, including indices, positions, normals, UVs and tangents. MASK alpha, cutoffs, double-sided state, material assignments and sampler values are preserved. No baked animation, wind shader or LOD was added.\n\nPalmTree models retain Desert as their exact catalog biome and carry \`nearWaterOnly: true\` and \`habitat: oasis\`; place them around water rather than throughout dry dunes. The original placement notes remain intact. Source files named Petals are static flower-head / flower-crown pieces for small flower patches or flower assembly, not individual falling-petal effects. They contain no particle behavior or falling animation.\n\nUse \`node scripts/import-nature-v8.mjs --source-root <GameAssets> --target-root <game> --verify-only\` to repeat the source comparison. The source root is read-only. The game is fully local through its included HTTP server; no external texture or model requests are required.\n`));
const byBiome = {};
for (const model of Object.values(models)) for (const biome of model.compatibleBiomes) (byBiome[biome] ||= []).push(model.id);
const fragment = {
  version: 8, models,
  naturePack: {
    id: PACK, name: catalog.name, author: catalog.author, source: catalog.sourceUrl, license: 'CC0-1.0',
    modelCount: 63, plantCount: 58, rockCount: 5, ids: Object.keys(models), byBiome,
    provenance: `${PROVENANCE}/pack.json`, licenseReview: `${LICENSES}/LicensingReview.zh-TW.md`,
    sharedTextureCount: textures.length, sharedTextureBytes: textureBytes,
    originalGLBBytes: sourceBytesTotal, optimizedGLBBytes: outputBytesTotal,
    optimizedModelAndTextureBytes: outputBytesTotal + textureBytes,
    materials: { total: materialCount, alphaMask: maskedMaterialCount, multiPrimitiveModels },
    rendererNotes: ['GLTFLoader preserves the 28 multi-primitive models as separate mesh parts.', 'Preserve original MASK alpha cutoff 0.45 and doubleSided material properties.', 'Share Texture objects across GLB parsers by resolved external image URL, sampler and colorSpace/flipY to avoid duplicated GPU texture storage.', 'sourceDerivation is intentionally distinct from the legacy derivation field so new assets do not accidentally enter the v4 adaptive terrain deformation path.', 'Honor nearWaterOnly for the five Desert PalmTree models; they belong in an oasis.', 'The four Petals meshes are static flower-head/crown pieces, not individual falling petals.']
  }
};
// The independent LOD builder may add verified index-only derivatives later.
// Preserve those additions; build-nature-lod-v8.mjs verifies their detailed proofs.
if (fs.existsSync(dst(FRAGMENT))) {
  const prior = readJson(dst(FRAGMENT));
  for (const [id, model] of Object.entries(models)) if (prior.models?.[id]?.lod) {
    const lod = prior.models[id].lod;
    assert.equal(lod.sourceSHA256, model.sourceDerivation.outputSHA256);
    assert.equal(lod.url, model.url.replace(/\.glb$/, '.lod1.glb'));
    assert(fs.existsSync(dst(lod.url)) && lod.triangles < model.triangles);
    model.lod = clone(lod);
  }
  if (prior.naturePack?.lod) fragment.naturePack.lod = clone(prior.naturePack.lod);
}
writeNewOrSame(FRAGMENT, jsonBytes(fragment));
const report = {
  status: 'passed', pack: PACK, uniqueIDs: 63, sourceBytes: sourceBytesTotal,
  outputGLBBytes: outputBytesTotal, sharedTextureBytes: textureBytes,
  outputModelAndTextureBytes: outputBytesTotal + textureBytes,
  savedBytes: sourceBytesTotal - outputBytesTotal - textureBytes,
  accessorByteComparisons: accessorCount, externalImageReferences: imageReferences,
  uniqueTexturesDecoded: textures.length, materials: materialCount, alphaMaskMaterials: maskedMaterialCount,
  multiPrimitiveModels, allNonImageBufferViewsByteIdentical: true, allAccessorBytesUnchanged: true,
  allGeometryMaterialsTransformsSemanticallyEqual: true, everyExternalImageByteIdenticalToEmbeddedSource: true,
  allPNGChunksCRCValidated: true, allPNGsFullyDecoded: true, allRelativeReferencesExist: true,
  allCompatibleBiomesPreserved: true, allOriginalSourceSHA256Preserved: true,
  nearWaterOnlyModels: Object.values(models).filter(m => m.nearWaterOnly).length,
  staticFlowerCrownPieces: Object.values(models).filter(m => m.natureType === 'petal').length,
  sourceLibraryWritten: false, sourceArchivesIncluded: false, sourceBlenderFilesIncluded: false,
  licenseEvidenceFiles: copiedEvidence.length, byBiome: Object.fromEntries(Object.entries(byBiome).map(([k, v]) => [k, v.length])),
  models: results, textures: textures.map(t => ({ url: t.url, bytes: t.bytes, sha256: t.sha256, dimensions: t.dimensions, bitDepth: t.bitDepth, colorType: t.colorType, usedByModels: t.usedBy.length }))
};
writeNewOrSame(REPORT, jsonBytes(report));
console.log(JSON.stringify({ mode: verifyOnly ? 'verify-only' : 'import', status: report.status, uniqueIDs: report.uniqueIDs, accessorByteComparisons: accessorCount, externalImageReferences: imageReferences, uniqueTexturesDecoded: textures.length, sourceBytes: sourceBytesTotal, outputGLBBytes: outputBytesTotal, sharedTextureBytes: textureBytes, outputModelAndTextureBytes: outputBytesTotal + textureBytes, savedBytes: report.savedBytes, multiPrimitiveModels, byBiome: report.byBiome, fragment: FRAGMENT, report: REPORT }, null, 2));
