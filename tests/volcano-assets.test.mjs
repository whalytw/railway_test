import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot, parseGlb, primitiveData, sha256 } from '../scripts/clean-volcano-bases.mjs';
import { verifyVolcanoAssets } from '../scripts/check-volcano-assets.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'asset-manifest.json'), 'utf8'));
function read(id) { return parseGlb(fs.readFileSync(path.join(projectRoot, manifest.models[id].url))); }
function triangles(glb) {
  const result = [];
  for (const mesh of glb.document.meshes) for (const primitive of mesh.primitives) {
    const data = primitiveData(glb, primitive);
    for (let t = 0; t < data.indices.length; t += 3) result.push({ lava: data.lava, points: data.indices.slice(t, t + 3).map(i => data.positions.values[i]) });
  }
  return result;
}

test('volcano cone has no circular display plinth while preserving the real crater height', () => {
  const id = 'Environment_Volcano_Cone16m_001', model = manifest.models[id];
  assert.ok(model.bounds.min[1] > -0.051, 'only the natural small-rock burial remains below datum');
  assert.ok(model.bounds.max[1] > 6.74 && model.bounds.max[1] < 6.75, 'original natural crater rim is retained');
  for (const triangle of triangles(read(id))) assert.ok(!triangle.points.some(p => p[1] < -0.64), 'no deep circular foundation vertex');
  assert.equal(model.placement.localGroundDatumY, 0);
  assert.equal(model.placement.alignToGroundNormal, false, 'upper crater and molten surface stay upright');
});

test('lava pool has an oval zero-datum foot instead of a square display tile', () => {
  const id = 'Environment_Volcano_LavaPool8m_001', model = manifest.models[id];
  assert.ok(Math.abs(model.dimensions[0] - 7.4) < 0.0001 && Math.abs(model.dimensions[2] - 6.8) < 0.0001);
  const footPoints = new Map();
  for (const triangle of triangles(read(id))) for (const p of triangle.points) {
    assert.ok(Math.abs(p[0]) < 3.701 && Math.abs(p[2]) < 3.401, 'old square apron is absent');
    if (Math.abs(p[1]) < 0.00001) footPoints.set(p.join(','), p);
    if (triangle.lava) assert.ok(Math.abs(p[1] + 0.12) < 0.00001, 'retain the molten top, not its display prism');
  }
  assert.equal(footPoints.size, 40);
  for (const p of footPoints.values()) assert.ok(Math.abs(Math.hypot(p[0] / 3.7, p[2] / 3.4) - 1) < 0.00001);
  assert.equal(model.placement.rootPlacement.hostTerrainModificationRequired, false);
  assert.equal(model.placement.terrainConform.weight.radialBegin, 0.94);
});

test('lava channel retains its molten ribbon and banks without deep foundation walls/end plates', () => {
  const id = 'Environment_Volcano_LavaChannel8m_001', model = manifest.models[id];
  assert.ok(model.bounds.min[1] > -0.351, 'natural shallow channel bed remains, deep box bottom is absent');
  for (const triangle of triangles(read(id))) {
    if (triangle.lava) assert.ok(triangle.points.every(p => p[1] > -0.14 && p[1] < -0.10), 'molten ribbon stays a horizontal top surface');
    else assert.ok(!triangle.points.every(p => Math.abs(p[2]) < 0.00001) && !triangle.points.every(p => Math.abs(p[2] - 8) < 0.00001), 'no rectangular end cap');
  }
  assert.deepEqual(model.placement.terrainConform.protectedMoltenXRange, [-1.4, 1.4]);
});

test('basalt cliff keeps its genuine individual column feet and receives placement metadata only', () => {
  const id = 'Environment_Volcano_BasaltCliff8m_001', model = manifest.models[id];
  const report = JSON.parse(fs.readFileSync(path.join(projectRoot, model.derivation), 'utf8'));
  const bytes = fs.readFileSync(path.join(projectRoot, model.url));
  assert.equal(report.geometryModified, false);
  assert.equal(sha256(bytes), report.originalSha256);
  assert.equal(model.triangles, 720);
  assert.equal(model.placement.contactCentresXZ.length, 10);
});

test('all delivered volcano GLBs load through shipped Three.js with invertible canonical part matrices and unchanged real molten surfaces', async () => {
  const report = await verifyVolcanoAssets();
  assert.equal(report.models.length, 4);
  for (const model of report.models) {
    assert.equal(model.load, 'passed');
    assert.equal(model.moltenSurfaceUnchanged, true);
    assert.ok(model.parts.every(part => part.matrixIdentity && part.matrixDeterminant === 1 && part.localYInverseRoundTrip === 'passed'));
  }
});
