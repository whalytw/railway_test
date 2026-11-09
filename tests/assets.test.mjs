import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'asset-manifest.json'), 'utf8'));

test('the selected library has eight biomes, three cars and all station / infrastructure models', async () => {
  assert.equal(Object.keys(manifest.biomes).length, 8); assert.equal(manifest.vehicles.length, 3);
  for (const biome of Object.values(manifest.biomes)) {
    assert.ok(biome.models.length >= 4); await stat(path.join(root, biome.preview));
    for (const id of biome.models) assert.ok(manifest.models[id]);
  }
  for (const id of [...manifest.vehicles, ...manifest.stationModels, ...manifest.trackModels]) assert.ok(manifest.models[id]);
  assert.equal(manifest.bridgeModels.length, 4); assert.equal(manifest.tunnelModels.length, 3); assert.equal(manifest.riverModels.length, 2);
  for (const id of [...manifest.bridgeModels, ...manifest.tunnelModels, ...manifest.riverModels]) assert.ok(manifest.models[id]);
});

test('all 192 existing models, 24 animal drivers and 118 LODs are valid self-contained glTF 2.0 files', async () => {
  assert.equal(Object.keys(manifest.models).length, 216);
  assert.equal(manifest.drivers.length, 24);
  assert.equal(manifest.scenery.selectedAdditionalCount, 118);
  const files = Object.entries(manifest.models).flatMap(([id, info]) => info.lod ? [[id, info], [`${id}:LOD1`, info.lod]] : [[id, info]]);
  assert.equal(files.length, 334);
  for (const [id, info] of files) {
    assert.ok(!info.url.startsWith('/'), 'asset URLs must also work under a GitHub project subdirectory');
    const bytes = await readFile(path.join(root, info.url));
    assert.equal(bytes.readUInt32LE(0), 0x46546c67, id); assert.equal(bytes.readUInt32LE(4), 2, id);
    assert.equal(bytes.readUInt32LE(8), bytes.length, id); assert.equal(bytes.length, info.bytes, id);
    assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, id);
    const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8').trim());
    assert.equal(gltf.asset.version, '2.0'); assert.ok(gltf.meshes?.length > 0);
    for (const buffer of gltf.buffers || []) assert.ok(!buffer.uri || buffer.uri.startsWith('data:'), `${id}: external buffer`);
    for (const image of gltf.images || []) assert.ok(image.bufferView !== undefined || image.uri?.startsWith('data:'), `${id}: external image`);
    for (const extension of gltf.extensionsRequired || []) assert.ok(!['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension), `${id}: unsupported decoder`);
    if (info.runtimeParts) for (const name of [info.runtimeParts.body, info.runtimeParts.lever, ...info.runtimeParts.wheels]) assert.ok(gltf.nodes.some(node => node.name === name), `${id}: missing ${name}`);
  }
});

test('all application element IDs exist and shipped imports are local', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const app = await readFile(path.join(root, 'src/app.js'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const match of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(match[1]), `Missing #${match[1]}`);
  for (const file of ['vendor/three.module.js', 'vendor/three.core.js', 'vendor/GLTFLoader.js', 'vendor/BufferGeometryUtils.js', 'vendor/THREE-LICENSE.txt', '.nojekyll']) await stat(path.join(root, file));
  assert.ok(!html.includes('https://'), 'runtime HTML must not require a CDN');
});
