export function shadowProfile(config) {
  const near = config.shadowQuality === 'near';
  return {
    quality: near ? 'near' : 'wide',
    mapSize: near ? 1024 : 2048,
    radius: config.sceneryShadows ? (near ? 80 : 180) : (near ? 46 : 70),
    minimumSceneryHeight: near ? 0.85 : 0
  };
}

export function keepSceneryShadow(info, placements, profile) {
  const height = info?.dimensions?.[1];
  if (!Number.isFinite(height) || profile.minimumSceneryHeight === 0) return true;
  if (['tree', 'home', 'shop', 'workshop', 'civic', 'feature', 'landmark'].includes(info.sceneRole)) return true;
  return placements.some(p => height * (p.sy ?? p.scale ?? 1) >= profile.minimumSceneryHeight);
}
