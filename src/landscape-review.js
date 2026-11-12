// Optional visual review page. It builds the same RailWorld, assets, materials
// and terrain as the game; buttons only move its camera to the real locations.
import * as THREE from 'three';
import { RailWorld, AssetStore, createAtmosphere } from './world.js?v=8.0.0';
import { riverPoint } from './route-features.js?v=8.0.0';
const canvas = document.getElementById('review-scene'), status = document.getElementById('status');
let renderer, scene, camera, world, atmosphere, previous = 0, selected = 'tunnel';
const target = new THREE.Vector3(), focus = new THREE.Vector3();
function fail(error) { console.error(error); const el = document.getElementById('error'); el.hidden = false; el.textContent = error.message || error; }
window.addEventListener('error', e => { if (e.error) fail(e.error); });
window.addEventListener('unhandledrejection', e => fail(e.reason));
function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
function view(name) {
  selected = name; const route = world.route, bridge = world.features.bridge, tunnel = world.features.tunnel;
  let along = 0;
  if (name === 'tunnel') {
    const p = route.sample(tunnel.start), end = route.sample(tunnel.start + 17);
    camera.position.set(p.x - p.tx * 67 + p.nx * 18, p.y + 18, p.z - p.tz * 67 + p.nz * 18);
    target.set(end.x, end.y + 7, end.z); along = tunnel.start - 28;
    status.textContent = '隧道入口 · 山坡延伸到進山路段，只有洞口附近保留彎曲岩切面。';
  } else if (name === 'river') {
    const p = riverPoint(bridge, 35), wide = bridge.river.wideSide;
    camera.position.set(bridge.x - bridge.tx * 175 + bridge.nx * 90 * wide, bridge.y + 168, bridge.z - bridge.tz * 175 + bridge.nz * 90 * wide);
    target.set(p.x, p.y, p.z); along = bridge.centre - 10;
    status.textContent = `彎曲河道 · S 彎與寬河段共用連續河床，最大水寬 ${world.landscapeStats.riverMaxWidth.toFixed(1)} m。`;
  } else if (name === 'farm') {
    const f = world.sceneryPlan.farms.find(f => f.crop.includes('Wheat')) || world.sceneryPlan.farms[0], p = route.sample(f.along);
    camera.position.set(f.x - p.tx * 48 + p.nx * 29, world.heightAt(f.x, f.z) + 22, f.z - p.tz * 48 + p.nz * 29);
    target.set(f.x, world.heightAt(f.x, f.z) + 0.8, f.z); along = f.along;
    status.textContent = `田園農地 · ${world.sceneryPlan.farms.length} 塊田區，包含麥田、玉米等作物、畦溝與田邊小徑。`;
  } else {
    const g = world.groundCoverPreview, p = route.sample(g.along);
    camera.position.set(g.x - p.tx * 13 + p.nx * 5, g.y + 4.3, g.z - p.tz * 13 + p.nz * 5);
    target.set(g.x + p.tx * 8, g.y + 0.7, g.z + p.tz * 8); along = g.along;
    status.textContent = '草地近景 · 草叢、柔和綠色斑塊與裸地交錯，近處草叢有輕微風吹。';
  }
  camera.fov = name === 'river' ? 57 : 52; camera.updateProjectionMatrix(); camera.lookAt(target);
  world.updateCart(along, along, 0); focus.copy(world.cart.position);
  world.setVisibility(camera, name === 'river' ? 1500 : 1100, false);
  scene.fog.near = name === 'river' ? 500 : 320; scene.fog.far = name === 'river' ? 1900 : 1400;
  atmosphere.update(camera, focus, false, 0, false);
  document.body.dataset.view = name;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
}
async function init() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.08, 18000);
  atmosphere = createAtmosphere(scene, renderer); atmosphere.setBiomes('Pastoral', 'Hills'); resize();
  const manifest = await (await fetch('./asset-manifest.json?v=8.0.0')).json(), store = new AssetStore(manifest);
  world = new RailWorld(scene, store, { length: 5, stations: 3, seed: 'V7-COUNTRY', biomeA: 'Pastoral', biomeB: 'Hills', density: 5000,
    elevationLimit: 75, vehicle: manifest.vehicles[1], driver: 'Animal_CubePet_Fox_001', features: true, skyline: true, sleeperFilter: true,
    sleeperSpacing: 0.75, viewDistance: 1400, shadows: false, sceneryShadows: false });
  await world.build((p, label) => status.textContent = `${Math.round(p * 100)}% · ${label}`);
  document.querySelectorAll('[data-view]').forEach(b => { b.disabled = false; b.addEventListener('click', () => view(b.dataset.view)); });
  document.body.dataset.ready = 'true'; view('tunnel');
  window.addEventListener('resize', () => { resize(); view(selected); });
  function render(time) {
    const dt = previous ? Math.min(0.05, (time - previous) / 1000) : 0; previous = time;
    world.updateEnvironment(dt, 0, dt); renderer.render(scene, camera);
    document.body.dataset.drawCalls = String(renderer.info.render.calls); document.body.dataset.triangles = String(renderer.info.render.triangles);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}
init().catch(fail);
