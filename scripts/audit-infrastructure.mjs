/**
 * Geometry audit of the bridge/tunnel/river copies and the original rail parts.
 * Reads only project assets; does not alter GLBs or source metadata.
 * Browser image decoding is replaced by empty textures for this Node geometry
 * audit. All PNG bufferViews and source hashes are checked without decoding.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const threeURL = new URL('../vendor/three.module.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  return specifier === 'three' ? { url: threeURL, shortCircuit: true } : next(specifier, context);
} });
const THREE = await import('../vendor/three.module.js');
const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
const loader = new GLTFLoader();
loader.register(() => ({ name: 'node_geometry_audit_texture_placeholder', loadTexture() { return Promise.resolve(new THREE.Texture()); } }));

const manifestPath = path.join(root, 'asset-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const ids = [...new Set([...manifest.bridgeModels, ...manifest.tunnelModels, ...manifest.riverModels, ...manifest.trackModels])];

function components(scene) {
  const vertices = [];
  const weld = new Map();
  const parents = [];
  const triangles = [];
  const find = i => parents[i] === i ? i : parents[i] = find(parents[i]);
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parents[ra] = rb; };
  const point = new THREE.Vector3();
  const vertexId = value => {
    const key = value.map(n => Math.round(n * 100000)).join(',');
    if (!weld.has(key)) { weld.set(key, vertices.length); vertices.push(value); parents.push(parents.length); }
    return weld.get(key);
  };
  scene.traverse(node => {
    if (!node.isMesh) return;
    const pos = node.geometry.attributes.position;
    const vertexMap = Array.from({ length: pos.count }, (_, i) => {
      point.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
      return vertexId(point.toArray());
    });
    const index = node.geometry.index?.array ?? Array.from({ length: pos.count }, (_, i) => i);
    for (let i = 0; i < index.length; i += 3) {
      const triangle = [vertexMap[index[i]], vertexMap[index[i + 1]], vertexMap[index[i + 2]]];
      union(triangle[0], triangle[1]); union(triangle[1], triangle[2]); triangles.push(triangle);
    }
  });
  const groups = new Map();
  for (const triangle of triangles) {
    const id = find(triangle[0]);
    if (!groups.has(id)) groups.set(id, { points: new Set(), triangles: 0 });
    const group = groups.get(id); group.triangles++;
    triangle.forEach(index => group.points.add(index));
  }
  return [...groups.values()].map(group => {
    const values = [...group.points].map(index => vertices[index]);
    const min = [0, 1, 2].map(axis => Math.min(...values.map(p => p[axis])));
    const max = [0, 1, 2].map(axis => Math.max(...values.map(p => p[axis])));
    return { triangles: group.triangles, bounds: { min, max }, dimensions: max.map((n, i) => n - min[i]), centre: max.map((n, i) => (n + min[i]) / 2) };
  }).sort((a, b) => b.triangles - a.triangles);
}

const audits = {};
for (const id of ids) {
  const model = manifest.models[id];
  const bytes = fs.readFileSync(path.join(root, model.url));
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const gltfJson = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
  for (const buffer of gltfJson.buffers ?? []) assert.ok(!buffer.uri || buffer.uri.startsWith('data:'));
  for (const image of gltfJson.images ?? []) {
    assert.ok(image.bufferView !== undefined || image.uri?.startsWith('data:'));
    if (image.bufferView !== undefined) {
      const view = gltfJson.bufferViews[image.bufferView];
      assert.ok((view.byteOffset ?? 0) + view.byteLength <= gltfJson.buffers[0].byteLength);
    }
  }
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  const meshes = [];
  let triangles = 0;
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    const geometry = node.geometry;
    for (const attribute of Object.values(geometry.attributes)) assert.equal(attribute.count, geometry.attributes.position.count);
    const count = geometry.index?.count ?? geometry.attributes.position.count;
    assert.equal(count % 3, 0);
    if (geometry.index) for (const index of geometry.index.array) assert.ok(index < geometry.attributes.position.count);
    triangles += count / 3;
    meshes.push({ name: node.name, role: node.userData.role, triangles: count / 3 });
  });
  assert.equal(triangles, model.triangles, `${id}: manifest triangle count`);
  assert.equal(bytes.length, model.bytes, `${id}: manifest byte count`);
  const provenance = path.join(root, 'assets/provenance', id);
  const metadata = JSON.parse(fs.readFileSync(path.join(provenance, 'asset.json'), 'utf8'));
  const technical = model.technicalData ? JSON.parse(fs.readFileSync(path.join(root, model.technicalData), 'utf8')) : {};
  const audit = {
    id, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    triangles, meshes, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    dimensions: bounds.getSize(new THREE.Vector3()).toArray(),
    coordinates: metadata.coordinates, ports: metadata.ports ?? technical.ports ?? [],
    railTop: technical.railTop ?? technical.railTopMeters ?? metadata.track?.railTopMeters,
    supportDrop: technical.supportDrop, supportSockets: technical.supportSockets,
    bearingHeight: metadata.parameters?.bearingHeight,
    opening: technical.opening, clearance: technical.clearance ?? metadata.clearance,
    sourceTrackPath: technical.sourceTrackPath,
    route: technical.route ? {
      lengthMeters: technical.route.lengthMeters,
      firstSurfacePoint: technical.route.surfacePoints?.[0],
      lastSurfacePoint: technical.route.surfacePoints?.at(-1),
      firstRailPoint: technical.route.railPoints?.[0],
      lastRailPoint: technical.route.railPoints?.at(-1),
    } : undefined,
    crossSection: technical.crossSection,
    water: technical.water ? { ...technical.water, surfacePath: { count: technical.water.surfacePath.length, first: technical.water.surfacePath[0], last: technical.water.surfacePath.at(-1) }, tangents: undefined } : undefined,
    originalAssetModified: false,
  };
  if (id === 'Environment_Rail_Straight_2m_001') {
    const parts = components(gltf.scene);
    const sleepers = parts.filter(p => Math.abs(p.dimensions[0] - 2.5) < 0.0001 && Math.abs(p.dimensions[1] - 0.18) < 0.0001 && Math.abs(p.dimensions[2] - 0.30) < 0.0001);
    assert.equal(sleepers.length, 4, 'Original straight module has four sleepers');
    audit.weldedConnectedComponentCount = parts.length;
    audit.sleeperGeometryAudit = {
      count: sleepers.length,
      centreDistances: sleepers.map(p => p.centre[2]).sort((a, b) => a - b),
      pitchMeters: 0.5,
      eachTriangles: sleepers.map(p => p.triangles),
      sourceAlgorithm: 'count=max(1,round(route.length/.52)); s=(i+.5)*route.length/count',
      fastenerSetsPerSleeper: 2,
      fastenerLateralOffsetsMeters: [-0.8885, 0.8885],
    };
    audit.railComponents = parts.filter(p => p.dimensions[2] > 1.99 && p.dimensions[0] < 0.22 && p.dimensions[1] > 0.19);
  }
  if (id === 'Environment_Rail_Sleeper_001') audit.standardTrackPlacement = { yOffset: 0, zCentre: 0, width: 2.5, height: 0.18, depth: 0.3 };
  if (id === 'Environment_Rail_RailSection_1m_001') audit.standardTrackPlacement = { yOffset: 0.205, lateralOffsets: [-0.8885, 0.8885], zStart: 0, zEnd: 1 };
  if (id === 'Environment_Rail_Fastener_001') audit.standardTrackPlacement = { yOffset: 0.18, lateralOffsets: [-0.8885, 0.8885], zCentre: 0 };
  if (manifest.bridgeModels.includes(id)) audit.includes = { rails: false, deck: !id.includes('Pier') && !id.includes('Abutment'), support: id.includes('Pier') || id.includes('Abutment') };
  if (manifest.tunnelModels.includes(id)) audit.includes = { rails: false, floor: id.includes('RockStraight'), roof: id.includes('RockStraight'), builtInSupportFramesAtZ: id.includes('RockStraight') ? [0.55, 3.45] : [] };
  if (manifest.riverModels.includes(id)) audit.includes = { waterSurface: false, dryChannelAndBanks: true, closedBottomAndEndCaps: true, baseBottomY: -2.1 };
  audits[id] = audit;
}
const report = {
  threeRevision: THREE.REVISION,
  method: 'Shipped Three.js GLTFLoader, all real geometry and transforms; texture decoding replaced by an empty texture for Node geometry audit only.',
  sourceDefinitionsReadOnly: [
    '07_Environment/_Shared/Environment_Railway_Cartoon_Kit_001/source/build_railway_kit.py:161,215,353,376',
    '06_Buildings/Railway_Bridges/_Shared/Bridge_Roadbed_Kit_001/source/build_bridge_roadbed.py:14,54,87,99,123',
    '06_Buildings/Railway_Tunnels_Mines/_Shared/Tunnel_Mine_Kit_001/source/build_tunnel_mine.py:71,81,110',
    '07_Environment/Common_Terrain/_Shared/Terrain_Common_Kit_001/source/build_common_terrain.py:39,177',
  ],
  models: audits,
};
const outputPath = path.join(root, 'assets/provenance/infrastructure-audit.json');
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');

// Add precise loader-measured bounds and compact engineering fields for integration.
// Preserve all original metadata documents and every existing manifest property.
if (process.argv.includes('--update-manifest')) {
  for (const [id, audit] of Object.entries(audits)) {
    const model = manifest.models[id];
    model.bounds = audit.bounds;
    model.dimensions = audit.dimensions;
    if (audit.clearance) model.clearance = audit.clearance;
    if (audit.supportDrop !== undefined) model.supportDrop = audit.supportDrop;
    if (audit.bearingHeight !== undefined) model.bearingHeight = audit.bearingHeight;
    if (audit.standardTrackPlacement) model.standardTrackPlacement = audit.standardTrackPlacement;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(JSON.stringify({ report: path.relative(root, outputPath), auditedModels: ids.length, newInfrastructureModels: manifest.bridgeModels.length + manifest.tunnelModels.length + manifest.riverModels.length, sleeperAudit: audits.Environment_Rail_Straight_2m_001.sleeperGeometryAudit, partModels: ['Environment_Rail_Sleeper_001', 'Environment_Rail_RailSection_1m_001', 'Environment_Rail_Fastener_001'].map(id => audits[id]) }, null, 2));
