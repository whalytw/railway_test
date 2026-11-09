/** Validate the four volcano assets using the exact Three.js/GLTFLoader shipped by the app. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { projectRoot, VOLCANO_IDS, parseGlb, inspectGeometry, sha256, lavaSurfaceSignature } from './clean-volcano-bases.mjs';

const threeURL = new URL('../vendor/three.module.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) { return specifier === 'three' ? { url: threeURL, shortCircuit: true } : next(specifier, context); } });
const THREE = await import('../vendor/three.module.js');
const { GLTFLoader } = await import('../vendor/GLTFLoader.js');

export async function verifyVolcanoAssets() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'asset-manifest.json'), 'utf8'));
  const loader = new GLTFLoader();
  const models = [];
  for (const id of VOLCANO_IDS) {
    const model = manifest.models[id], bytes = fs.readFileSync(path.join(projectRoot, model.url)), raw = parseGlb(bytes);
    const derivation = JSON.parse(fs.readFileSync(path.join(projectRoot, model.derivation), 'utf8'));
    assert.equal(sha256(bytes), derivation.outputSha256, `${id}: derivative SHA`);
    assert.equal(bytes.length, model.bytes, `${id}: manifest byte count`);
    const signature = lavaSurfaceSignature(raw, id);
    assert.deepEqual(signature, derivation.protectedMoltenSurface.before, `${id}: original molten surface is preserved`);
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    gltf.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(gltf.scene), identity = new THREE.Matrix4();
    const parts = [];
    let triangles = 0;
    gltf.scene.traverse(node => {
      if (!node.isMesh) return;
      const geometry = node.geometry, position = geometry.attributes.position;
      assert.ok(position?.count > 0, `${id}: nonempty mesh`);
      for (const attribute of Object.values(geometry.attributes)) assert.equal(attribute.count, position.count, `${id}: attribute lengths`);
      for (const value of position.array) assert.ok(Number.isFinite(value), `${id}: finite vertices`);
      for (const index of geometry.index.array) assert.ok(index < position.count, `${id}: indices`);
      for (let i = 0; i < geometry.attributes.normal.count; i++) {
        const normal = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, i);
        assert.ok(Math.abs(normal.length() - 1) < 0.0002, `${id}: unit normals`);
      }
      const determinant = node.matrixWorld.determinant();
      assert.ok(Math.abs(determinant) > 0.0000001, `${id}: part transform must be invertible`);
      assert.ok(node.matrixWorld.elements.every((n, i) => Math.abs(n - identity.elements[i]) < 0.000001), `${id}: canonical mesh/root coordinates`);
      const sample = new THREE.Vector3(0.37, 0.91, -0.22), returned = sample.clone().applyMatrix4(node.matrixWorld).applyMatrix4(node.matrixWorld.clone().invert());
      assert.ok(returned.distanceTo(sample) < 0.000001, `${id}: local-Y inverse transform round trip`);
      const meshTriangles = geometry.index.count / 3; triangles += meshTriangles;
      parts.push({ name: node.name, triangles: meshTriangles, matrixDeterminant: determinant, matrixIdentity: true, localYInverseRoundTrip: 'passed' });
    });
    assert.equal(triangles, model.triangles, `${id}: visible triangles`);
    const rawStats = inspectGeometry(raw);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(rawStats.bounds.min[axis] - model.bounds.min[axis]) < 0.000001, `${id}: compacted raw lower bound`);
      assert.ok(Math.abs(rawStats.bounds.max[axis] - model.bounds.max[axis]) < 0.000001, `${id}: compacted raw upper bound`);
      assert.ok(Math.abs(bounds.min.getComponent(axis) - model.bounds.min[axis]) < 0.000001, `${id}: loader lower bound`);
      assert.ok(Math.abs(bounds.max.getComponent(axis) - model.bounds.max[axis]) < 0.000001, `${id}: loader upper bound`);
    }
    models.push({ id, load: 'passed', triangles, bytes: bytes.length, bounds: rawStats.bounds, parts, moltenSurfaceUnchanged: true, placementDatumY: model.placement.localGroundDatumY });
  }
  return { threeRevision: THREE.REVISION, models };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyVolcanoAssets();
  fs.writeFileSync(path.join(projectRoot, 'assets/provenance/volcano-loader-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
