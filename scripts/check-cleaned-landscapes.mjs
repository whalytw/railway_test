/** Load the four derived landscapes with the exact Three.js loader shipped by this app. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const threeURL = new URL('../vendor/three.module.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') return { url: threeURL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { Box3, REVISION } = await import('../vendor/three.module.js');
const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'asset-manifest.json'), 'utf8'));
const cleanup = JSON.parse(fs.readFileSync(path.join(root, 'assets/provenance/landscape-display-base-cleanup.json'), 'utf8'));
const loader = new GLTFLoader();
const results = [];
for (const report of cleanup.modifiedModels) {
  const info = manifest.models[report.id];
  const bytes = fs.readFileSync(path.join(root, info.url));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(gltf.scene);
  let triangles = 0;
  let meshCount = 0;
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    meshCount++;
    const geometry = node.geometry;
    assert.ok(geometry.attributes.position);
    for (const attribute of Object.values(geometry.attributes)) assert.equal(attribute.count, geometry.attributes.position.count, `${report.id}: attribute vertex count`);
    for (const index of geometry.index.array) assert.ok(index < geometry.attributes.position.count, `${report.id}: index out of range`);
    triangles += geometry.index.count / 3;
  });
  assert.equal(triangles, info.triangles, `${report.id}: visible triangles disagree with manifest`);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(bounds.min.getComponent(axis) - info.bounds.min[axis]) < 0.000001, `${report.id}: lower bound`);
    assert.ok(Math.abs(bounds.max.getComponent(axis) - info.bounds.max[axis]) < 0.000001, `${report.id}: upper bound`);
  }
  results.push({ id: report.id, load: 'passed', meshes: meshCount, triangles, minY: bounds.min.y, maxY: bounds.max.y });
}
console.log(JSON.stringify({ threeRevision: REVISION, results }, null, 2));
