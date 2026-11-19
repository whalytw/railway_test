const SHADOW_LAYOUTS = [[1, 1], [1.75, 1.25], [1.25, 1.75], [1.5, 1.5]];
export const SHADOW_DEPTH = 650;

// Work in the original map's texel grid. Enlarging the area also enlarges the
// texture, so the shared footprint keeps the texel size of each individual view.
export function planSharedShadow(profile, positions, maxTextureSize, previous) {
  if (profile.quality !== 'near' || positions.length < 2) return null;
  const step = profile.radius * 2 / profile.mapSize;
  const xs = positions.map(p => Math.round(p.x / step));
  const ys = positions.map(p => Math.round(p.y / step));
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const centreX = Math.round((minX + maxX) / 2), centreY = Math.round((minY + maxY) / 2);
  const z = Math.max(...positions.map(p => p.z));
  const depthExtra = z - Math.min(...positions.map(p => p.z));
  if (depthExtra > 160) return null;
  const base = profile.mapSize;
  const sizes = SHADOW_LAYOUTS.map(([x, y]) => ({ width: x * base, height: y * base }));
  if (previous) sizes.unshift(previous);
  for (const { width, height } of sizes) {
    const extendsCurrent = width === previous?.width && height === previous.height;
    const margin = extendsCurrent || width === base && height === base ? 0 : 16;
    if (width > maxTextureSize || height > maxTextureSize || width * height >= positions.length * base ** 2) continue;
    const neededX = base + 2 * Math.max(centreX - minX, maxX - centreX);
    const neededY = base + 2 * Math.max(centreY - minY, maxY - centreY);
    if (neededX > width - (width > base ? margin : 0) || neededY > height - (height > base ? margin : 0)) continue;
    return { width, height, halfX: width * step / 2, halfY: height * step / 2,
      x: centreX * step, y: centreY * step, z, far: SHADOW_DEPTH + Math.ceil(depthExtra / 8) * 8 };
  }
  return null;
}
