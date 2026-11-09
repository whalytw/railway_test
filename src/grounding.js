import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './core.js?v=7.0.0';

export function groundContactWeight(placement, x, y, z) {
  const conform = placement.terrainConform, w = conform.weight;
  let weight = 1 - smoothstep(w.fullBelowLocalY, w.zeroAboveLocalY, y);
  if (conform.mode === 'outer-contact-only') {
    const [rx, rz] = conform.outerContactRadiiXZ;
    weight *= smoothstep(w.radialBegin, w.radialFull, Math.hypot(x / rx, z / rz));
  } else if (conform.mode === 'bank-contact-only') {
    let edge = smoothstep(w.xBeginMeters, w.xFullMeters, Math.abs(x));
    const end = conform.endContactBand;
    if (end) {
      const distance = Math.min(...end.zEdges.map(v => Math.abs(z - v)));
      edge = Math.max(edge, (1 - smoothstep(0, end.zBlendDepthMeters, distance)) * smoothstep(end.affectOnlyAbsXAbove, end.fullAtAbsX, Math.abs(x)));
    }
    weight *= edge;
  }
  return weight;
}

export function renderedGroundHeight(grid, x, z) {
  const ix = clamp(Math.floor((x + grid.d) / grid.width), 0, grid.nx - 1);
  const iz = clamp(Math.floor((z + grid.d / 2) / grid.depth), 0, grid.nz - 1);
  const tile = grid.tiles[iz * grid.nx + ix], n = tile.segments, a = tile.geometry.attributes.position;
  const fx = clamp((x - tile.x0) / grid.width * n, 0, n), fz = clamp((z - tile.z0) / grid.depth * n, 0, n);
  const i = Math.min(n - 1, Math.floor(fx)), j = Math.min(n - 1, Math.floor(fz)), tx = fx - i, tz = fz - j, k = j * (n + 1) + i;
  const h0 = a.getY(k), h1 = a.getY(k + 1), h2 = a.getY(k + n + 1), h3 = a.getY(k + n + 2);
  return tx + tz <= 1 ? h0 + tx * (h1 - h0) + tz * (h2 - h0) : h3 + (1 - tx) * (h2 - h3) + (1 - tz) * (h1 - h3);
}

function clipPolygon(points, axis, limit, greater) {
  const output = [], inside = v => greater ? v[axis] >= limit : v[axis] <= limit;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], ai = inside(a), bi = inside(b);
    if (ai) output.push(a);
    if (ai !== bi) { const t = (limit - a[axis]) / (b[axis] - a[axis]); output.push(a.map((v, k) => lerp(v, b[k], t))); }
  }
  return output;
}
export function footprintMaximum(grid, p, bounds) {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw), scale = p.scale || 1, min = bounds.min, max = bounds.max;
  const corners = [[min[0], min[2]], [min[0], max[2]], [max[0], min[2]], [max[0], max[2]]].map(([x, z]) => [p.x + scale * (c * x + s * z), p.z + scale * (-s * x + c * z)]);
  const x0 = Math.min(...corners.map(v => v[0])), x1 = Math.max(...corners.map(v => v[0]));
  const z0 = Math.min(...corners.map(v => v[1])), z1 = Math.max(...corners.map(v => v[1]));
  let highest = renderedGroundHeight(grid, p.x, p.z);
  for (let iz = Math.max(0, Math.floor((z0 + grid.d / 2) / grid.depth)); iz <= Math.min(grid.nz - 1, Math.floor((z1 + grid.d / 2) / grid.depth)); iz++) {
    for (let ix = Math.max(0, Math.floor((x0 + grid.d) / grid.width)); ix <= Math.min(grid.nx - 1, Math.floor((x1 + grid.d) / grid.width)); ix++) {
      const tile = grid.tiles[iz * grid.nx + ix], n = tile.segments, a = tile.geometry.attributes.position;
      const firstX = clamp(Math.floor((x0 - tile.x0) / grid.width * n), 0, n - 1), lastX = clamp(Math.floor((x1 - tile.x0) / grid.width * n), 0, n - 1);
      const firstZ = clamp(Math.floor((z0 - tile.z0) / grid.depth * n), 0, n - 1), lastZ = clamp(Math.floor((z1 - tile.z0) / grid.depth * n), 0, n - 1);
      for (let j = firstZ; j <= lastZ; j++) for (let i = firstX; i <= lastX; i++) {
        const k = j * (n + 1) + i;
        for (const triangle of [[k, k + n + 1, k + 1], [k + 1, k + n + 1, k + n + 2]]) {
          let points = triangle.map(v => { const dx = a.getX(v) - p.x, dz = a.getZ(v) - p.z; return [(c * dx - s * dz) / scale, a.getY(v), (s * dx + c * dz) / scale]; });
          for (const [axis, limit, greater] of [[0, min[0], true], [0, max[0], false], [2, min[2], true], [2, max[2], false]]) points = clipPolygon(points, axis, limit, greater);
          for (const v of points) highest = Math.max(highest, v[1]);
        }
      }
    }
  }
  return highest;
}

export function fitGroundContact(world, p, placement) {
  const bounds = placement.footBounds, scale = p.scale || 1, c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  const highest = footprintMaximum(world.terrainGrid, p, bounds), root = placement.rootPlacement;
  p.y = renderedGroundHeight(world.terrainGrid, p.x, p.z);
  if (root.lavaLocalY !== undefined) p.y = highest - root.lavaLocalY * scale + root.clearanceWorldMeters;
  else p.y = Math.max(p.y, highest - placement.terrainConform.weight.zeroAboveLocalY * scale * 0.45);
  const patch = new Float32Array(16);
  let lowest = highest;
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const x = lerp(bounds.min[0], bounds.max[0], col / 3), z = lerp(bounds.min[2], bounds.max[2], row / 3);
    const height = renderedGroundHeight(world.terrainGrid, p.x + scale * (c * x + s * z), p.z + scale * (-s * x + c * z));
    lowest = Math.min(lowest, height);
    patch[row * 4 + col] = (height - p.y - placement.embedMeters) / scale;
  }
  p.groundPatch = patch;
  p.groundRelief = highest - lowest;
  return p;
}

export function sampleGroundPatch(patch, u, v) {
  const x = clamp(u, 0, 1) * 3, y = clamp(v, 0, 1) * 3, ix = Math.min(2, Math.floor(x)), iy = Math.min(2, Math.floor(y));
  return lerp(lerp(patch[iy * 4 + ix], patch[iy * 4 + ix + 1], x - ix), lerp(patch[(iy + 1) * 4 + ix], patch[(iy + 1) * 4 + ix + 1], x - ix), y - iy);
}

const declarations = `attribute vec2 aGroundUV; attribute float aGroundWeight;
attribute vec4 iGround0; attribute vec4 iGround1; attribute vec4 iGround2; attribute vec4 iGround3;
uniform vec3 uGroundUp;
float groundRow(vec4 r, float x) { if(x<1.0)return mix(r.x,r.y,x); if(x<2.0)return mix(r.y,r.z,x-1.0); return mix(r.z,r.w,x-2.0); }
float groundPatch(vec2 uv) { vec2 p=clamp(uv,0.0,1.0)*3.0;
float a=groundRow(iGround0,p.x),b=groundRow(iGround1,p.x),c=groundRow(iGround2,p.x),d=groundRow(iGround3,p.x);
if(p.y<1.0)return mix(a,b,p.y); if(p.y<2.0)return mix(b,c,p.y-1.0); return mix(c,d,p.y-2.0); }
`;
export function prepareGroundedParts(source, placement, ownedMaterials) {
  return source.parts.map(part => {
    const a = part.geometry.attributes.position, uv = new Float32Array(a.count * 2), weights = new Float32Array(a.count), point = new THREE.Vector3();
    const { min, max } = placement.footBounds;
    for (let i = 0; i < a.count; i++) {
      point.fromBufferAttribute(a, i).applyMatrix4(part.matrix);
      uv[i * 2] = (point.x - min[0]) / (max[0] - min[0]); uv[i * 2 + 1] = (point.z - min[2]) / (max[2] - min[2]);
      weights[i] = groundContactWeight(placement, point.x, point.y, point.z);
    }
    const up = new THREE.Vector3(0, 1, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(part.matrix).invert());
    const deform = material => {
      material.onBeforeCompile = shader => {
        shader.uniforms.uGroundUp = { value: up };
        shader.vertexShader = declarations + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += uGroundUp * aGroundWeight * groundPatch(aGroundUV);');
      };
      material.customProgramCacheKey = () => 'footprint-contact-v4'; ownedMaterials.push(material); return material;
    };
    const material = Array.isArray(part.material) ? part.material.map(m => deform(m.clone())) : deform(part.material.clone());
    const depth = deform(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide }));
    return { ...part, material, depth, groundUp: up, groundUV: new THREE.BufferAttribute(uv, 2), groundWeights: new THREE.BufferAttribute(weights, 1) };
  });
}
export function groundBatchGeometry(part, placements) {
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(part.geometry.attributes)) geometry.setAttribute(name, attribute);
  geometry.setIndex(part.geometry.index); geometry.groups = part.geometry.groups.map(g => ({ ...g }));
  geometry.setAttribute('aGroundUV', part.groundUV); geometry.setAttribute('aGroundWeight', part.groundWeights);
  let largestOffset = 0;
  for (let row = 0; row < 4; row++) {
    const values = new Float32Array(placements.length * 4);
    placements.forEach((p, i) => { values.set(p.groundPatch.subarray(row * 4, row * 4 + 4), i * 4); });
    for (const value of values) largestOffset = Math.max(largestOffset, Math.abs(value));
    geometry.setAttribute(`iGround${row}`, new THREE.InstancedBufferAttribute(values, 4));
  }
  part.geometry.computeBoundingBox(); geometry.boundingBox = part.geometry.boundingBox.clone();
  geometry.boundingBox.expandByVector(part.groundUp.clone().set(Math.abs(part.groundUp.x), Math.abs(part.groundUp.y), Math.abs(part.groundUp.z)).multiplyScalar(largestOffset));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geometry;
}
