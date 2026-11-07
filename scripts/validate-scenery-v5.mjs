// Integration check using the shipped GLTFLoader and real mesh geometry.
// It verifies scene construction, not a WebGL FPS benchmark.
import { registerHooks } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
registerHooks({ resolve(s, context, next) { return s === 'three' ? { url: new URL('../vendor/three.module.js', import.meta.url).href, shortCircuit: true } : next(s, context); } });
const THREE = await import('../vendor/three.module.js');
const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
const { AssetStore, RailWorld } = await import('../src/world.js');
const { renderedGroundHeight } = await import('../src/grounding.js');
const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));
const loader = new GLTFLoader(), store = new AssetStore(manifest);
let loadedFiles = 0, mainTriangles = 0, lodTriangles = 0;
for (const id of manifest.scenery.additionalModels) {
  const info = manifest.models[id], provenance = JSON.parse(await readFile(new URL('../' + info.provenance, import.meta.url), 'utf8'));
  for (const [level, spec] of [[0, info], [1, info.lod]]) {
    const bytes = await readFile(new URL('../' + spec.url, import.meta.url));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== provenance[level ? 'lod1Sha256' : 'mainSha256']) throw Error(`Copy checksum mismatch: ${id}`);
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const root = gltf.scene; root.updateMatrixWorld(true); const parts = [];
    let triangles = 0;
    root.traverse(node => {
      if (!node.isMesh) return;
      if (!Number.isFinite(node.matrixWorld.determinant()) || Math.abs(node.matrixWorld.determinant()) < 0.001) throw Error(`Singular transform: ${id}`);
      for (const attribute of Object.values(node.geometry.attributes)) for (const value of attribute.array) if (!Number.isFinite(value)) throw Error(`Non-finite attribute: ${id}`);
      triangles += (node.geometry.index?.count || node.geometry.attributes.position.count) / 3;
      parts.push({ geometry: node.geometry, material: node.material, matrix: node.matrixWorld.clone() });
    });
    const bounds = new THREE.Box3().setFromObject(root);
    if (Math.abs(bounds.min.y) > 0.005 || parts.length !== 1 || triangles !== spec.triangles) throw Error(`Geometry contract mismatch: ${id} / ${level}`);
    store.cache.set(level ? `${id}#lod1` : id, { root, parts, bounds });
    loadedFiles++; if (level) lodTriangles += triangles; else mainTriangles += triangles;
  }
}
const results = [];
const scenarios = [
  { biomeA: 'Rural', biomeB: 'Pastoral', density: 5000, seed: 'V5-COMPOSITION' },
  { biomeA: 'Rural', biomeB: 'Pastoral', density: 12000, seed: 'V5-COMPOSITION' },
  { biomeA: 'Snow', biomeB: 'Volcano', density: 12000, seed: 'V5-SNOW-VOLCANO' },
  { biomeA: 'Desert', biomeB: 'Lakeside', density: 12000, seed: 'V5-DESERT-LAKE' }
];
for (const scenario of scenarios) {
  const world = new RailWorld(new THREE.Scene(), store, { ...scenario, length: 5, stations: 3, elevationLimit: 500, features: true, sceneryShadows: true });
  await world.prepareScenery();
  // Load original models used in the same scenario from local files too.
  const required = [...new Set(world.sceneryPlan.placements.map(p => p.id).concat(world.lake ? manifest.biomes.Lakeside.models : []))];
  for (const id of required) if (!store.cache.has(id)) {
    const bytes = await readFile(new URL('../' + manifest.models[id].url, import.meta.url));
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const root = gltf.scene; root.updateMatrixWorld(true); const parts = [];
    root.traverse(n => { if (n.isMesh) parts.push({ geometry: n.geometry, material: n.material, matrix: n.matrixWorld.clone() }); });
    store.cache.set(id, { root, parts, bounds: new THREE.Box3().setFromObject(root) });
  }
  await world.buildTerrain(); await world.buildScenery();
  if (world.sceneryCount !== scenario.density) throw Error('Population mismatch');
  const all = []; world.group.traverse(n => { if (n.isInstancedMesh) all.push(n); });
  if (all.some(mesh => mesh.castShadow !== true && mesh.parent.name.startsWith('scenery:'))) throw Error('Missing scenery shadow caster');
  if (all.some(mesh => [...mesh.instanceMatrix.array].some(v => !Number.isFinite(v)))) throw Error('Invalid instance matrix');
  let maxFootError = 0, levelFootings = 0;
  for (const p of world.sceneryPlan.placements.filter(p => ['home', 'shop', 'workshop', 'civic', 'landmark', 'feature'].includes(p.role) && !manifest.models[p.id].derivation)) {
    const asset = store.get(p.id); const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    for (const part of asset.parts) {
      const a = part.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(part.matrix);
        if (Math.abs(v.y) > 0.002) continue;
        const x = p.x + p.scale * (c * v.x + s * v.z), z = p.z + p.scale * (-s * v.x + c * v.z);
        const error = p.y + v.y * p.scale - renderedGroundHeight(world.terrainGrid, x, z);
        maxFootError = Math.max(maxFootError, Math.abs(error)); levelFootings++;
      }
    }
  }
  if (maxFootError > 0.16) throw Error(`Floating footing: ${scenario.seed}, ${maxFootError}m`);
  const result = { ...scenario, ...world.sceneryStats, terrainChunks: world.terrainChunks, meshBatches: all.length, lodBatches: all.filter(n => n.userData.sceneryLOD).length, checkedFootVertices: levelFootings, maximumFootErrorMetres: maxFootError };
  results.push(result); console.log(JSON.stringify({ seed: scenario.seed, density: scenario.density, uniqueModels: result.uniqueModels, buildings: result.buildingCount, farms: result.farmCount, landmarks: result.landmarkCount, batches: result.meshBatches, maxFootError }));
  world.dispose();
}
store.dispose();
await mkdir(new URL('../validation/', import.meta.url), { recursive: true });
await writeFile(new URL('../validation/scenery-v5.json', import.meta.url), JSON.stringify({ version: '5.0.0', checkedFiles: loadedFiles, mainTriangles, lodTriangles, results, browserQA: { observedBeforeFinalLayoutTuning: true, fiveThousandSceneLoaded: true, shownModelTypes: 71, scriptErrorsObserved: 0, fpsBenchmark: 'not verified: browser was minimized; further UI control stopped because current URL could not be reliably identified' } }, null, 2) + '\n');
console.log(JSON.stringify({ checkedFiles: loadedFiles, mainTriangles, lodTriangles }));
